/**
 * Post-parse normalization for clinical intents (synonyms → canonical terms).
 */

import type { ParsedClinicalIntent } from "@/lib/clinical-intent";

const MEDICATION_ALIASES: Record<string, string> = {
  advil: "ibuprofen",
  motrin: "ibuprofen",
  nuprin: "ibuprofen",
  brufen: "ibuprofen",
  tylenol: "acetaminophen",
  paracetamol: "acetaminophen",
  panadol: "acetaminophen",
  aleve: "naproxen",
  naprosyn: "naproxen",
  benadryl: "diphenhydramine",
  zofran: "ondansetron",
  lasix: "furosemide",
  nitro: "nitroglycerin",
  asa: "aspirin",
};

const SYMPTOM_ALIASES: Record<string, string> = {
  "short of breath": "dyspnea",
  "shortness of breath": "dyspnea",
  sob: "dyspnea",
  "trouble breathing": "dyspnea",
  "difficulty breathing": "dyspnea",
  "can't breathe": "dyspnea",
  "cant breathe": "dyspnea",
  vomiting: "vomiting",
  "throwing up": "vomiting",
  puking: "vomiting",
  emesis: "vomiting",
  "chest tightness": "chest pressure",
  "tight chest": "chest pressure",
  "heart attack": "myocardial infarction",
  mi: "myocardial infarction",
  stemi: "st-elevation myocardial infarction",
  nstemi: "non-st-elevation myocardial infarction",
  "high blood pressure": "hypertension",
  htn: "hypertension",
  fever: "fever",
  "neck stiffness": "neck stiffness",
  nuchal: "neck stiffness",
};

const PROBLEM_ALIASES: Record<string, string> = {
  "high blood pressure": "hypertension",
  htn: "hypertension",
  "heart attack": "myocardial infarction",
  mi: "myocardial infarction",
  diabetes: "diabetes mellitus",
  dm: "diabetes mellitus",
};

const ROUTE_ALIASES: Record<string, string> = {
  po: "PO",
  oral: "PO",
  "by mouth": "PO",
  iv: "IV",
  intravenous: "IV",
  im: "IM",
  intramuscular: "IM",
  subq: "SC",
  sc: "SC",
  subcutaneous: "SC",
  pr: "PR",
  sl: "SL",
  sublingual: "SL",
  inh: "INH",
  inhaled: "INH",
  neb: "NEB",
  nebulized: "NEB",
};

function normalizeToken(
  value: string | null | undefined,
  map: Record<string, string>
): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (map[lower]) return map[lower];
  for (const [alias, canonical] of Object.entries(map)) {
    if (lower === alias || lower.includes(alias)) {
      return canonical;
    }
  }
  return trimmed;
}

function normalizeMedicationName(value: string | null): string | null {
  if (!value?.trim()) return null;
  const lower = value.trim().toLowerCase();
  if (MEDICATION_ALIASES[lower]) return MEDICATION_ALIASES[lower];
  for (const [alias, canonical] of Object.entries(MEDICATION_ALIASES)) {
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower)) {
      return lower.replace(re, canonical);
    }
  }
  return value.trim();
}

function normalizeSymptomList(symptoms: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of symptoms) {
    if (!raw?.trim()) continue;
    const lower = raw.trim().toLowerCase();
    let normalized = lower;
    for (const [alias, canonical] of Object.entries(SYMPTOM_ALIASES)) {
      if (lower.includes(alias)) {
        normalized = canonical;
        break;
      }
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function normalizeRoute(route: string | null): string | null {
  if (!route?.trim()) return null;
  const lower = route.trim().toLowerCase();
  return ROUTE_ALIASES[lower] ?? route.trim();
}

/** Apply synonym normalization after Gemini returns structured intent. */
export function normalizeClinicalIntent(
  intent: ParsedClinicalIntent
): ParsedClinicalIntent {
  return {
    ...intent,
    medication: normalizeMedicationName(intent.medication),
    problem: normalizeToken(intent.problem, PROBLEM_ALIASES),
    symptoms: normalizeSymptomList(intent.symptoms ?? []),
    route: normalizeRoute(intent.route),
  };
}
