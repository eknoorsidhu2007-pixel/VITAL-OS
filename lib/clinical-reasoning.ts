/**
 * Gemini-powered differential diagnosis / symptom analysis (structured).
 * Server-side only.
 */

import { Type } from "@google/genai";

import type { DemoPatient } from "@/lib/demo-patients";
import { patientToSnapshot } from "@/lib/demo-patients";
import { gemini, GEMINI_CLINICAL_MODEL } from "@/lib/gemini-client";

export type DiagnosisLikelihood = "high" | "moderate" | "low";

export interface PossibleDiagnosis {
  diagnosis: string;
  likelihood: DiagnosisLikelihood;
  supportingFindings: string[];
  missingOrContradictingFindings: string[];
  whyItMatters: string;
  suggestedNextChecks: string[];
}

export interface ClinicalReasoningResult {
  chiefConcern: string;
  symptomsUsed: string[];
  possibleDiagnoses: PossibleDiagnosis[];
  redFlags: string[];
  recommendedQuestions: string[];
  recommendedChecks: string[];
  safetyNote: string;
}

export interface ClinicalReasoningInput {
  patient?: DemoPatient | null;
  symptoms: string[];
  transcript: string;
}

const REASONING_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    chiefConcern: { type: Type.STRING },
    symptomsUsed: { type: Type.ARRAY, items: { type: Type.STRING } },
    possibleDiagnoses: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          diagnosis: { type: Type.STRING },
          likelihood: { type: Type.STRING },
          supportingFindings: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          missingOrContradictingFindings: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          whyItMatters: { type: Type.STRING },
          suggestedNextChecks: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          "diagnosis",
          "likelihood",
          "supportingFindings",
          "missingOrContradictingFindings",
          "whyItMatters",
          "suggestedNextChecks",
        ],
      },
    },
    redFlags: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendedQuestions: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendedChecks: { type: Type.ARRAY, items: { type: Type.STRING } },
    safetyNote: { type: Type.STRING },
  },
  required: [
    "chiefConcern",
    "symptomsUsed",
    "possibleDiagnoses",
    "redFlags",
    "recommendedQuestions",
    "recommendedChecks",
    "safetyNote",
  ],
};

const REASONING_SYSTEM = `You are a clinical reasoning assistant for licensed clinicians using VITAL OS.
Produce a structured differential diagnosis — NOT a final diagnosis.

Rules:
- Label outputs as possible diagnoses / differential considerations only.
- Explain why each diagnosis is being considered using supporting and missing/contradicting findings.
- Include dangerous diagnoses to rule out in redFlags.
- Suggest targeted history questions and objective checks.
- Use only chart data provided; do not invent labs, vitals, or imaging results.
- likelihood must be exactly: high, moderate, or low.
- End safetyNote reminding that clinical decision-making remains with the treating clinician.`;

function coerceLikelihood(v: string): DiagnosisLikelihood {
  const x = v.trim().toLowerCase();
  if (x === "high" || x === "moderate" || x === "low") return x;
  return "moderate";
}

function parseReasoningJson(text: string): ClinicalReasoningResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const raw = JSON.parse(body) as Record<string, unknown>;

  const possibleDiagnoses = Array.isArray(raw.possibleDiagnoses)
    ? raw.possibleDiagnoses.map((item) => {
        const o = item as Record<string, unknown>;
        return {
          diagnosis: String(o.diagnosis ?? "Unspecified"),
          likelihood: coerceLikelihood(String(o.likelihood ?? "moderate")),
          supportingFindings: Array.isArray(o.supportingFindings)
            ? o.supportingFindings.map((x) => String(x))
            : [],
          missingOrContradictingFindings: Array.isArray(
            o.missingOrContradictingFindings
          )
            ? o.missingOrContradictingFindings.map((x) => String(x))
            : [],
          whyItMatters: String(o.whyItMatters ?? ""),
          suggestedNextChecks: Array.isArray(o.suggestedNextChecks)
            ? o.suggestedNextChecks.map((x) => String(x))
            : [],
        };
      })
    : [];

  return {
    chiefConcern: String(raw.chiefConcern ?? "Not specified"),
    symptomsUsed: Array.isArray(raw.symptomsUsed)
      ? raw.symptomsUsed.map((x) => String(x))
      : [],
    possibleDiagnoses,
    redFlags: Array.isArray(raw.redFlags)
      ? raw.redFlags.map((x) => String(x))
      : [],
    recommendedQuestions: Array.isArray(raw.recommendedQuestions)
      ? raw.recommendedQuestions.map((x) => String(x))
      : [],
    recommendedChecks: Array.isArray(raw.recommendedChecks)
      ? raw.recommendedChecks.map((x) => String(x))
      : [],
    safetyNote: String(
      raw.safetyNote ??
        "This is a differential aid only; final clinical decisions remain with the clinician."
    ),
  };
}

export async function runClinicalReasoning(
  input: ClinicalReasoningInput,
  opts?: { signal?: AbortSignal }
): Promise<ClinicalReasoningResult> {
  const transcript = input.transcript.trim();
  const symptomList = input.symptoms.filter(Boolean);
  const patientBlock = input.patient
    ? `\nPATIENT CHART:\n${patientToSnapshot(input.patient)}\n`
    : "\nNo specific patient chart attached.\n";

  const response = await gemini.models.generateContent({
    model: GEMINI_CLINICAL_MODEL,
    contents: `${patientBlock}
SYMPTOMS MENTIONED: ${symptomList.length ? symptomList.join(", ") : "(from utterance)"}

CLINICIAN UTTERANCE:
"""${transcript}"""

Provide a structured differential diagnosis JSON.`,
    config: {
      systemInstruction: REASONING_SYSTEM,
      temperature: 0.45,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      responseJsonSchema: REASONING_SCHEMA,
      abortSignal: opts?.signal,
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned empty clinical reasoning.");
  }

  return parseReasoningJson(text);
}

export function formatClinicalReasoningForSpeech(
  result: ClinicalReasoningResult
): string {
  const lines: string[] = [];
  lines.push(
    `Differential for ${result.chiefConcern}. This is not a final diagnosis.`
  );
  if (result.possibleDiagnoses.length) {
    const top = result.possibleDiagnoses.slice(0, 4);
    for (const dx of top) {
      lines.push(
        `${dx.diagnosis} (${dx.likelihood} likelihood): ${dx.whyItMatters}`
      );
    }
  }
  if (result.redFlags.length) {
    lines.push(`Red flags to rule out: ${result.redFlags.slice(0, 4).join("; ")}.`);
  }
  if (result.recommendedChecks.length) {
    lines.push(
      `Suggested checks: ${result.recommendedChecks.slice(0, 4).join("; ")}.`
    );
  }
  lines.push(result.safetyNote);
  return lines.join(" ");
}
