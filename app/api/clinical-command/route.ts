import { NextResponse } from "next/server";

import { ACCESS_RESTRICTED_MESSAGE, type VitalRole } from "@/lib/auth";
import {
  parseClinicalIntent,
  type ConversationTurn,
  type ParsedClinicalIntent,
} from "@/lib/clinical-intent";
import {
  formatClinicalReasoningForSpeech,
  runClinicalReasoning,
  type ClinicalReasoningResult,
} from "@/lib/clinical-reasoning";
import { listPatients } from "@/lib/patient-store";
import {
  mapRequestedSections,
  resolvePatient,
  type PatientResolveResult,
} from "@/lib/roster-resolve";
import type { VitalMode } from "@/lib/vital-llm";
import type { DemoPatient } from "@/lib/demo-patients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOW_CONFIDENCE = 0.55;

const PATIENT_SPECIFIC_INTENTS = new Set([
  "open_patient_chart",
  "patient_summary",
  "medication_order",
  "update_problem_status",
  "discharge_patient",
  "differential_diagnosis",
  "symptom_analysis",
]);

interface ClinicalCommandBody {
  transcript?: unknown;
  activePatientId?: unknown;
  role?: unknown;
  mode?: unknown;
  conversationHistory?: unknown;
}

export type ClinicalAction =
  | {
      type: "open_patient_chart";
      payload: {
        patientId: string;
        patientName: string;
        sections: string[];
      };
    }
  | {
      type: "medication_order_draft";
      payload: {
        patientId: string;
        patientName: string;
        medication: string;
        dose: string | null;
        route: string | null;
        frequency: string | null;
      };
    }
  | {
      type: "discharge_confirm";
      payload: { patientId: string; patientName: string };
    }
  | {
      type: "update_problem_status";
      payload: {
        patientId: string;
        patientName: string;
        problem: string;
        status: string;
      };
    }
  | {
      type: "clinical_reasoning";
      payload: { patientId: string | null; reasoning: ClinicalReasoningResult };
    }
  | {
      type: "roster_answer";
      payload: { text: string };
    }
  | { type: "admit_patient"; payload: Record<string, never> }
  | { type: "clarification"; payload: { question: string } }
  | { type: "unknown"; payload: Record<string, never> };

export interface ClinicalCommandResponse {
  parsedIntent: ParsedClinicalIntent;
  assistantResponse: string;
  action: ClinicalAction | null;
  requiresConfirmation: boolean;
}

function parseHistory(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ConversationTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    out.push({ role, content: content.trim() });
  }
  return out;
}

function parseRole(raw: unknown): VitalRole | null {
  return raw === "doctor" || raw === "staff" ? raw : null;
}

function isStaffRestricted(intent: ParsedClinicalIntent): boolean {
  return PATIENT_SPECIFIC_INTENTS.has(intent.intent);
}

function buildMedicationConfirmMessage(
  patient: DemoPatient,
  intent: ParsedClinicalIntent
): string {
  const med = intent.medication ?? "medication";
  let msg = `Confirm order for ${patient.name}: ${med}.`;
  const hasDetails = intent.dose || intent.route || intent.frequency;
  if (!hasDetails) {
    msg +=
      " Dose, route, and frequency were not specified. Would you like to specify them before placing the order?";
  } else {
    const parts = [
      intent.dose ? `dose ${intent.dose}` : null,
      intent.route ? `route ${intent.route}` : null,
      intent.frequency ? `frequency ${intent.frequency}` : null,
    ].filter(Boolean);
    msg += ` ${parts.join("; ")}. Say yes to place the order.`;
  }
  return msg;
}

function resolveForIntent(
  roster: DemoPatient[],
  intent: ParsedClinicalIntent,
  activePatientId: string | null,
  transcript: string
): PatientResolveResult {
  return resolvePatient(roster, {
    patientId: intent.patientId,
    patientName: intent.patientName,
    transcript,
    activePatientId,
  });
}

async function buildResponse(
  intent: ParsedClinicalIntent,
  roster: DemoPatient[],
  activePatientId: string | null,
  transcript: string
): Promise<ClinicalCommandResponse> {
  if (
    intent.confidence < LOW_CONFIDENCE ||
    (intent.clarificationQuestion && intent.needsConfirmation)
  ) {
    const question =
      intent.clarificationQuestion ??
      "Could you clarify what you would like me to do?";
    return {
      parsedIntent: intent,
      assistantResponse: question,
      action: { type: "clarification", payload: { question } },
      requiresConfirmation: false,
    };
  }

  switch (intent.intent) {
    case "unknown":
      return {
        parsedIntent: intent,
        assistantResponse:
          intent.reasoningSummary ??
          "I did not recognize a structured command.",
        action: { type: "unknown", payload: {} },
        requiresConfirmation: false,
      };

    case "roster_question": {
      const n = roster.length;
      const roomMatch = transcript.match(
        /(?:who|anyone|patients?).{0,20}(?:in|at)\s+(.+?)(?:\?|$)/i
      );
      if (roomMatch?.[1]) {
        const q = roomMatch[1].trim().toLowerCase();
        const inRoom = roster.filter((p) =>
          p.room.toLowerCase().includes(q.replace(/^room\s+/, ""))
        );
        const text =
          inRoom.length === 0
            ? `No patients listed in ${roomMatch[1]}.`
            : `Patients in ${roomMatch[1]}: ${inRoom
                .map((p) => `${p.name} (${p.mrn})`)
                .join("; ")}.`;
        return {
          parsedIntent: intent,
          assistantResponse: text,
          action: { type: "roster_answer", payload: { text } },
          requiresConfirmation: false,
        };
      }
      const text = `There are ${n} patient${n === 1 ? "" : "s"} on the roster.`;
      return {
        parsedIntent: intent,
        assistantResponse: text,
        action: { type: "roster_answer", payload: { text } },
        requiresConfirmation: false,
      };
    }

    case "analytics_question":
      return {
        parsedIntent: intent,
        assistantResponse:
          intent.reasoningSummary ??
          "Analytics questions are best answered from the Analytics view or a free-text query.",
        action: { type: "unknown", payload: {} },
        requiresConfirmation: false,
      };

    case "admit_patient":
      return {
        parsedIntent: intent,
        assistantResponse:
          "Starting admission workflow. What is the patient's name and chief concern?",
        action: { type: "admit_patient", payload: {} },
        requiresConfirmation: false,
      };

    case "open_patient_chart":
    case "patient_summary": {
      const resolved = resolveForIntent(
        roster,
        intent,
        activePatientId,
        transcript
      );
      if (resolved.status === "ambiguous") {
        return {
          parsedIntent: intent,
          assistantResponse: resolved.message,
          action: {
            type: "clarification",
            payload: { question: resolved.message },
          },
          requiresConfirmation: false,
        };
      }
      if (resolved.status === "not_found") {
        return {
          parsedIntent: intent,
          assistantResponse: resolved.message,
          action: {
            type: "clarification",
            payload: { question: resolved.message },
          },
          requiresConfirmation: false,
        };
      }
      const sections = mapRequestedSections(intent.requestedSections);
      const patient = resolved.patient;
      return {
        parsedIntent: { ...intent, patientId: patient.id, patientName: patient.name },
        assistantResponse: `Opening chart for ${patient.name}.`,
        action: {
          type: "open_patient_chart",
          payload: {
            patientId: patient.id,
            patientName: patient.name,
            sections,
          },
        },
        requiresConfirmation: false,
      };
    }

    case "medication_order": {
      const resolved = resolveForIntent(
        roster,
        intent,
        activePatientId,
        transcript
      );
      if (resolved.status !== "matched") {
        const msg =
          resolved.status === "ambiguous"
            ? resolved.message
            : "Please confirm which patient should receive the medication.";
        return {
          parsedIntent: intent,
          assistantResponse: msg,
          action: { type: "clarification", payload: { question: msg } },
          requiresConfirmation: false,
        };
      }
      if (!intent.medication) {
        const msg =
          "Which medication should I order? Please name the drug and patient.";
        return {
          parsedIntent: intent,
          assistantResponse: msg,
          action: { type: "clarification", payload: { question: msg } },
          requiresConfirmation: false,
        };
      }
      const patient = resolved.patient;
      const assistantResponse = buildMedicationConfirmMessage(patient, intent);
      return {
        parsedIntent: {
          ...intent,
          patientId: patient.id,
          patientName: patient.name,
          needsConfirmation: true,
        },
        assistantResponse,
        action: {
          type: "medication_order_draft",
          payload: {
            patientId: patient.id,
            patientName: patient.name,
            medication: intent.medication,
            dose: intent.dose,
            route: intent.route,
            frequency: intent.frequency,
          },
        },
        requiresConfirmation: true,
      };
    }

    case "discharge_patient": {
      const resolved = resolveForIntent(
        roster,
        intent,
        activePatientId,
        transcript
      );
      if (resolved.status !== "matched") {
        const msg =
          resolved.status === "ambiguous"
            ? resolved.message
            : "Please confirm which patient should be discharged.";
        return {
          parsedIntent: intent,
          assistantResponse: msg,
          action: { type: "clarification", payload: { question: msg } },
          requiresConfirmation: false,
        };
      }
      const patient = resolved.patient;
      return {
        parsedIntent: {
          ...intent,
          patientId: patient.id,
          patientName: patient.name,
          needsConfirmation: true,
        },
        assistantResponse: `Confirm discharge for ${patient.name}? This will remove them from the roster.`,
        action: {
          type: "discharge_confirm",
          payload: { patientId: patient.id, patientName: patient.name },
        },
        requiresConfirmation: true,
      };
    }

    case "update_problem_status": {
      const resolved = resolveForIntent(
        roster,
        intent,
        activePatientId,
        transcript
      );
      if (resolved.status !== "matched") {
        const msg =
          resolved.status === "ambiguous"
            ? resolved.message
            : "Please confirm the patient, problem, and status.";
        return {
          parsedIntent: intent,
          assistantResponse: msg,
          action: { type: "clarification", payload: { question: msg } },
          requiresConfirmation: false,
        };
      }
      if (!intent.problem || !intent.status) {
        const msg = "Please specify which problem and what status to set.";
        return {
          parsedIntent: intent,
          assistantResponse: msg,
          action: { type: "clarification", payload: { question: msg } },
          requiresConfirmation: false,
        };
      }
      const patient = resolved.patient;
      return {
        parsedIntent: {
          ...intent,
          patientId: patient.id,
          patientName: patient.name,
        },
        assistantResponse: `I will mark ${intent.problem} as ${intent.status} for ${patient.name}.`,
        action: {
          type: "update_problem_status",
          payload: {
            patientId: patient.id,
            patientName: patient.name,
            problem: intent.problem,
            status: intent.status,
          },
        },
        requiresConfirmation: false,
      };
    }

    case "differential_diagnosis":
    case "symptom_analysis": {
      const resolved = resolveForIntent(
        roster,
        intent,
        activePatientId,
        transcript
      );
      const patient =
        resolved.status === "matched" ? resolved.patient : undefined;
      const symptoms =
        intent.symptoms.length > 0
          ? intent.symptoms
          : patient?.symptoms ?? [];

      const reasoning = await runClinicalReasoning({
        patient: patient ?? null,
        symptoms,
        transcript,
      });

      const assistantResponse = formatClinicalReasoningForSpeech(reasoning);
      return {
        parsedIntent: intent,
        assistantResponse,
        action: {
          type: "clinical_reasoning",
          payload: {
            patientId: patient?.id ?? null,
            reasoning,
          },
        },
        requiresConfirmation: false,
      };
    }

    default:
      return {
        parsedIntent: intent,
        assistantResponse: "Command not mapped.",
        action: { type: "unknown", payload: {} },
        requiresConfirmation: false,
      };
  }
}

export async function POST(req: Request) {
  let body: ClinicalCommandBody;
  try {
    body = (await req.json()) as ClinicalCommandBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return NextResponse.json(
      { error: "Missing 'transcript' in request body." },
      { status: 400 }
    );
  }

  const role = parseRole(body.role);
  const activePatientId =
    typeof body.activePatientId === "string" && body.activePatientId.trim()
      ? body.activePatientId.trim()
      : null;

  const mode =
    typeof body.mode === "string" ? (body.mode as VitalMode) : "general";
  const conversationHistory = parseHistory(body.conversationHistory);

  if (!process.env.GEMINI_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "GEMINI_API_KEY is not set on the server. Add it to .env.local and restart.",
        code: "MISSING_API_KEY",
      },
      { status: 503 }
    );
  }

  try {
    const roster = await listPatients();
    const activePatient = activePatientId
      ? roster.find((p) => p.id === activePatientId)
      : undefined;

    const parsedIntent = await parseClinicalIntent({
      transcript,
      roster,
      activePatient,
      mode,
      conversationHistory,
    });

    if (role === "staff" && isStaffRestricted(parsedIntent)) {
      return NextResponse.json({
        parsedIntent,
        assistantResponse: ACCESS_RESTRICTED_MESSAGE,
        action: null,
        requiresConfirmation: false,
      } satisfies ClinicalCommandResponse);
    }

    const result = await buildResponse(
      parsedIntent,
      roster,
      activePatientId,
      transcript
    );

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Clinical command parsing failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
