/**
 * Deterministic local parser for voice-controlled patient chart updates.
 * Gemini is only used when intent remains unclear after this pass.
 */

import { cleanVoiceCommand } from "@/lib/admission-parser";

export type PatientCommandIntent =
  | "addMedication"
  | "removeMedication"
  | "replaceMedication"
  | "updateMedicationDosage"
  | "updateChiefConcern"
  | "moveRoom"
  | "updateStatus"
  | "addSymptom"
  | "removeSymptom"
  | "updateSymptomStatus"
  | "addChartNote"
  | "dischargePatient"
  | "patientSummary"
  | "undo"
  | "unknown";

export const ENCOUNTER_STATUSES = [
  "Stable",
  "Improving",
  "Worsening",
  "Critical",
  "Discharged",
] as const;

export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

export const SYMPTOM_STATUSES = [
  "Active",
  "Improving",
  "Worsening",
  "Resolved",
] as const;

export type SymptomStatus = (typeof SYMPTOM_STATUSES)[number];

export type ParsedPatientCommand = {
  intent: PatientCommandIntent;
  /** Raw patient name hint extracted from utterance */
  patientHint?: string;
  medication?: string;
  replaceWithMedication?: string;
  dosage?: string;
  chiefConcern?: string;
  room?: string;
  status?: EncounterStatus;
  symptom?: string;
  symptomStatus?: SymptomStatus;
  chartNote?: string;
  /** high = deterministic match; low = may need Gemini fallback */
  confidence: "high" | "low";
};

const MEDICATION_VERBS =
  /(?:add|start|prescribe|give|order|put on|begin)\s+/i;
const REMOVE_MED_RE =
  /(?:remove|stop|discontinue|hold|cancel)\s+(?:the\s+)?(.+?)(?:\s+(?:from|for)\b|$)/i;
const REPLACE_MED_RE =
  /(?:replace|switch|change|swap)\s+(.+?)\s+(?:with|to)\s+(.+)/i;
const DOSAGE_RE =
  /(?:increase|decrease|change|update|set)\s+(.+?)\s+(?:to|at)\s+(\d+(?:\.\d+)?)\s*(mg|milligrams?|mcg|g|grams?|units?|ml|milliliters?)?/i;

const CHIEF_CONCERN_RE =
  /(?:update|change|set)\s+chief\s+concern\s+(?:to|as|is)\s+(.+)/i;
const CHIEF_CONCERN_IS_RE = /chief\s+concern\s+(?:is\s+now|is)\s+(.+)/i;

const MOVE_ROOM_RE =
  /(?:move|transfer|assign)\s+(?:patient\s+)?(.+?)\s+(?:to|into)\s+(?:room\s+)?(.+)/i;
const ROOM_ONLY_RE =
  /(?:move|transfer|assign)\s+(?:to|into)\s+(?:room\s+)?(.+)/i;

const MARK_STATUS_RE =
  /mark\s+(?:patient\s+)?(.+?)\s+(stable|improving|worsening|critical|discharged)/i;
const MARK_STATUS_NO_NAME_RE =
  /mark\s+(?:patient\s+)?(stable|improving|worsening|critical|discharged)\b/i;

const ADD_SYMPTOM_RE = /^add\s+(?:symptom\s+)?(.+)/i;
const REMOVE_SYMPTOM_RE = /^remove\s+(?:symptom\s+)?(.+)/i;
const SYMPTOM_STATUS_RE =
  /mark\s+(?:symptom\s+)?(.+?)\s+(improving|worsening|resolved|active)/i;

const CHART_NOTE_RE =
  /(?:add\s+(?:chart\s+)?note(?:\s+that|\s+saying|\s+)?|add\s+note(?:\s+that|\s+saying|\s+)?)(.+)/i;

const DISCHARGE_RE = /discharge\s+(?:patient\s+)?(.+)/i;
const SUMMARY_RE =
  /(?:summarize|patient\s+summary|give\s+me\s+a\s+summary\s+of|summary\s+(?:for|of))\s+(?:patient\s+)?(.+)/i;

const ADD_MED_PATTERNS: RegExp[] = [
  /(?:add|start|prescribe|give)\s+(.+?)\s+(?:to|for)\s+(.+)/i,
  /(?:give|prescribe)\s+(.+?)\s+(.+)/i,
  /(?:add|start)\s+(.+?)\s+to\s+patient\s+(.+)/i,
];

const PATIENT_PREFIX_RE =
  /^(?:update|open|edit|change|modify)\s+(?:patient\s+)?(.+)$/i;

function normalizeIntentText(text: string): string {
  return cleanVoiceCommand(text).trim();
}

function titleCaseMedication(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function parseEncounterStatus(raw: string): EncounterStatus | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "stable") return "Stable";
  if (s === "improving") return "Improving";
  if (s === "worsening") return "Worsening";
  if (s === "critical") return "Critical";
  if (s === "discharged") return "Discharged";
  return undefined;
}

function parseSymptomStatus(raw: string): SymptomStatus | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "improving") return "Improving";
  if (s === "worsening") return "Worsening";
  if (s === "resolved") return "Resolved";
  if (s === "active") return "Active";
  return undefined;
}

function extractPatientFromMedCommand(
  med: string,
  patientPart: string
): { medication: string; patientHint: string } {
  return {
    medication: titleCaseMedication(med.replace(/\s+(?:mg|milligrams?)$/i, "").trim()),
    patientHint: patientPart.trim(),
  };
}

const SYMPTOM_HINTS =
  /\b(pain|fever|cough|breath|nausea|vomit|dizziness|headache|rash|swelling|bleeding|fatigue|weakness|anxiety|wheez)\b/i;

function looksLikePersonName(text: string): boolean {
  const t = text.trim();
  if (SYMPTOM_HINTS.test(t)) return false;
  return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/.test(t);
}

/**
 * Parse a voice utterance into a structured patient-management command.
 */
export function parsePatientCommand(transcript: string): ParsedPatientCommand {
  const raw = transcript.trim();
  if (!raw) return { intent: "unknown", confidence: "low" };

  const text = normalizeIntentText(raw);
  const lower = text.toLowerCase();

  if (/^undo(?:\s+last\s+change)?$/i.test(lower)) {
    return { intent: "undo", confidence: "high" };
  }

  const prefixMatch = text.match(PATIENT_PREFIX_RE);
  if (prefixMatch?.[1] && !/\b(medication|med|room|concern|symptom|note|discharge)\b/i.test(lower)) {
    return {
      intent: "unknown",
      patientHint: prefixMatch[1].trim(),
      confidence: "low",
    };
  }

  const summaryMatch = text.match(SUMMARY_RE);
  if (summaryMatch?.[1]) {
    return {
      intent: "patientSummary",
      patientHint: summaryMatch[1].trim(),
      confidence: "high",
    };
  }

  if (/^discharge\b/i.test(lower) || /\bdischarge\s+patient\b/i.test(lower)) {
    const dm = text.match(DISCHARGE_RE);
    return {
      intent: "dischargePatient",
      patientHint: dm?.[1]?.trim(),
      confidence: "high",
    };
  }

  const chartNoteMatch = text.match(CHART_NOTE_RE);
  if (chartNoteMatch?.[1]) {
    return {
      intent: "addChartNote",
      chartNote: chartNoteMatch[1].trim(),
      confidence: "high",
    };
  }

  const ccMatch = text.match(CHIEF_CONCERN_RE) ?? text.match(CHIEF_CONCERN_IS_RE);
  if (ccMatch?.[1]) {
    return {
      intent: "updateChiefConcern",
      chiefConcern: ccMatch[1].trim(),
      confidence: "high",
    };
  }

  const moveMatch = text.match(MOVE_ROOM_RE);
  if (moveMatch?.[1] && moveMatch[2]) {
    return {
      intent: "moveRoom",
      patientHint: moveMatch[1].trim(),
      room: moveMatch[2].trim(),
      confidence: "high",
    };
  }

  const roomOnly = text.match(ROOM_ONLY_RE);
  if (roomOnly?.[1] && /^(?:move|transfer|assign)\b/i.test(text)) {
    return {
      intent: "moveRoom",
      room: roomOnly[1].trim(),
      confidence: "high",
    };
  }

  const statusMatch = text.match(MARK_STATUS_RE);
  if (statusMatch?.[1] && statusMatch[2]) {
    const statusWord = statusMatch[2].trim().toLowerCase();
    const subject = statusMatch[1].trim();
    const symptomStatus = parseSymptomStatus(statusMatch[2]);
    if (
      symptomStatus &&
      /^(improving|worsening|resolved|active)$/.test(statusWord) &&
      !looksLikePersonName(subject)
    ) {
      return {
        intent: "updateSymptomStatus",
        symptom: subject,
        symptomStatus,
        confidence: "high",
      };
    }
    const status = parseEncounterStatus(statusMatch[2]);
    if (status) {
      return {
        intent: "updateStatus",
        patientHint: subject,
        status,
        confidence: "high",
      };
    }
  }

  const statusNoName = text.match(MARK_STATUS_NO_NAME_RE);
  if (statusNoName?.[1]) {
    const status = parseEncounterStatus(statusNoName[1]);
    if (status) {
      return {
        intent: "updateStatus",
        status,
        confidence: "high",
      };
    }
  }

  const symptomStatusMatch = text.match(SYMPTOM_STATUS_RE);
  if (symptomStatusMatch?.[1] && symptomStatusMatch[2]) {
    const symptomStatus = parseSymptomStatus(symptomStatusMatch[2]);
    if (symptomStatus) {
      return {
        intent: "updateSymptomStatus",
        symptom: symptomStatusMatch[1].trim(),
        symptomStatus,
        confidence: "high",
      };
    }
  }

  const removeSymptom = text.match(REMOVE_SYMPTOM_RE);
  if (removeSymptom?.[1] && /^remove\b/i.test(text) && !REMOVE_MED_RE.test(text)) {
    const symptom = removeSymptom[1].trim();
    if (!/\b(?:medication|med|aspirin|tylenol|ibuprofen)\b/i.test(symptom)) {
      return {
        intent: "removeSymptom",
        symptom,
        confidence: "high",
      };
    }
  }

  const addSymptom = text.match(ADD_SYMPTOM_RE);
  if (addSymptom?.[1] && /^add\b/i.test(text) && !MEDICATION_VERBS.test(text)) {
    const symptom = addSymptom[1].trim();
    if (!/\b(?:medication|med|aspirin|to)\b/i.test(symptom)) {
      return {
        intent: "addSymptom",
        symptom,
        confidence: "high",
      };
    }
  }

  const replaceMatch = text.match(REPLACE_MED_RE);
  if (replaceMatch?.[1] && replaceMatch[2]) {
    return {
      intent: "replaceMedication",
      medication: titleCaseMedication(replaceMatch[1].trim()),
      replaceWithMedication: titleCaseMedication(replaceMatch[2].trim()),
      confidence: "high",
    };
  }

  const dosageMatch = text.match(DOSAGE_RE);
  if (dosageMatch?.[1] && dosageMatch[2]) {
    const unit = dosageMatch[3] ?? "mg";
    return {
      intent: "updateMedicationDosage",
      medication: titleCaseMedication(dosageMatch[1].trim()),
      dosage: `${dosageMatch[2].trim()} ${unit}`.trim(),
      confidence: "high",
    };
  }

  if (/^(?:remove|stop|discontinue)\b/i.test(text)) {
    const rm = text.match(REMOVE_MED_RE);
    if (rm?.[1]) {
      return {
        intent: "removeMedication",
        medication: titleCaseMedication(rm[1].trim()),
        confidence: "high",
      };
    }
  }

  for (const pattern of ADD_MED_PATTERNS) {
    const m = text.match(pattern);
    if (m?.[1] && m[2]) {
      const { medication, patientHint } = extractPatientFromMedCommand(m[1], m[2]);
      return {
        intent: "addMedication",
        medication,
        patientHint,
        confidence: "high",
      };
    }
  }

  if (MEDICATION_VERBS.test(text)) {
    const medOnly = text
      .replace(MEDICATION_VERBS, "")
      .replace(/\s+(?:to|for)\s+.+$/i, "")
      .trim();
    if (medOnly) {
      const patientTail = text.match(/\s+(?:to|for)\s+(.+)$/i);
      if (!patientTail) {
        return { intent: "unknown", confidence: "low" };
      }
      return {
        intent: "addMedication",
        medication: titleCaseMedication(medOnly),
        patientHint: patientTail[1].trim(),
        confidence: "high",
      };
    }
  }

  return { intent: "unknown", confidence: "low" };
}
