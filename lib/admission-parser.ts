import type { DemoMedication } from "@/lib/demo-patients";

export type ParsedAdmissionMedication = {
  name: string;
  dose?: string;
  status?: string;
};

export type ParsedAdmission = {
  name?: string;
  age?: number;
  sex?: string;
  room?: string;
  chiefConcern?: string;
  medication?: ParsedAdmissionMedication;
  acuity?: string;
  allergies?: string[];
};

const WAKE_PREFIXES = [
  /^hey\s+vital[s]?\s*,?\s*/i,
  /^okay\s+vital[s]?\s*,?\s*/i,
  /^ok\s+vital[s]?\s*,?\s*/i,
  /^hey\s+vido\s*,?\s*/i,
  /^hey\s+final[s]?\s*,?\s*/i,
  /^vital[s]?\s*,?\s*/i,
];

const POLITE_PREFIXES = [
  /^can you\s+/i,
  /^could you\s+/i,
  /^please\s+/i,
  /^i need you to\s+/i,
  /^i'd like to\s+/i,
  /^i would like to\s+/i,
  /^let's\s+/i,
];

const INVALID_NAME_PHRASES = new Set([
  "hey vital",
  "vital",
  "admit patient",
  "admit a patient",
  "i'd like to admit a patient",
  "i would like to admit a patient",
  "can you admit patient",
  "please admit patient",
  "patient",
  "new patient",
  "a patient",
  "he needs",
  "she needs",
  "they need",
  "needs medication",
  "needs aspirin",
  "needs aspers",
  "he needs aspers",
  "she needs aspers",
  "he",
  "she",
  "they",
  "him",
  "her",
  "them",
]);

const ADMIT_PHRASE_RE =
  /\b(?:admit(?:\s+a)?(?:\s+new)?\s+patient|add(?:\s+a)?(?:\s+new)?\s+patient|create(?:\s+a)?(?:\s+new)?\s+patient|new patient|patient named|named)\b/gi;

const NAME_STOP_RE =
  /\b(?:age|years?\s+old|year\s+old|male|female|man|woman|boy|girl|room|to room|in room|with|for|complaining of|presenting with|chief concern|concern is|needs|medication|med|give|prescribe|aspirin|advil|tylenol|ibuprofen|acetaminophen|acuity|urgency|ctas|level|priority|and give|and needs)\b/i;

const CONCERN_STOP_RE =
  /\b(?:room|in room|to room|age|years?\s+old|year\s+old|male|female|medication|med|give|prescribe|needs|acuity|ctas|priority|urgency|and give|and needs)\b/i;

const MEDICATION_ALIASES: Record<string, string> = {
  aspers: "Aspirin",
  asprin: "Aspirin",
  asperin: "Aspirin",
  aspirin: "Aspirin",
  tylanol: "Tylenol",
  tylenol: "Tylenol",
  advil: "Advil",
  ibuprofen: "Ibuprofen",
  acetaminophen: "Acetaminophen",
};

const ALLERGY_EXPLICIT_RE =
  /\b(?:allergic to|allergy to|has allergy(?: to)?|allergies are|no known allergies|nkda|nka)\b/i;

const EMERGENCY_CONTACT_EXPLICIT_RE =
  /\b(?:emergency contact is|contact is|primary contact is|phone number is)\b/i;

function normalizeSpaces(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function normalizeNameKey(name: string): string {
  return normalizeSpaces(name).toLowerCase();
}

export function cleanVoiceCommand(transcript: string): string {
  let text = normalizeSpaces(transcript);
  let changed = true;
  while (changed) {
    changed = false;
    for (const rx of WAKE_PREFIXES) {
      if (rx.test(text)) {
        text = text.replace(rx, "");
        changed = true;
      }
    }
    for (const rx of POLITE_PREFIXES) {
      if (rx.test(text)) {
        text = text.replace(rx, "");
        changed = true;
      }
    }
    text = normalizeSpaces(text);
  }
  return text;
}

function titleCaseWord(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function normalizeMedicationName(raw: string): string {
  const key = raw.trim().toLowerCase();
  return MEDICATION_ALIASES[key] ?? titleCaseWord(raw.trim());
}

function normalizeSexToken(token: string): string | undefined {
  const t = token.toLowerCase();
  if (t === "m" || t === "male" || t === "man" || t === "boy") return "M";
  if (t === "f" || t === "female" || t === "woman" || t === "girl") return "F";
  return undefined;
}

function normalizeRoom(raw: string, prefix?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (prefix) {
    const p = prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();
    return `${p} ${trimmed.toUpperCase()}`;
  }
  if (/^room\b/i.test(trimmed)) {
    const rest = trimmed.replace(/^room\s*/i, "").trim();
    return `Room ${rest.toUpperCase()}`;
  }
  return `Room ${trimmed.toUpperCase()}`;
}

function normalizeAcuity(text: string): string | undefined {
  const q = text.toLowerCase();
  const explicit = q.match(/\b(?:acuity|ctas|urgency|level|priority)\s*([1-5])\b/);
  if (explicit) return `CTAS ${explicit[1]}`;
  if (/\bcritical\b/.test(q)) return "CTAS 1";
  if (/\b(?:emergent|emergency)\b/.test(q)) return "CTAS 2";
  if (/\burgent\b/.test(q)) return "CTAS 3";
  if (/\bnon[-\s]?urgent\b/.test(q)) return "CTAS 5";
  return undefined;
}

export function isInvalidAdmissionName(name: string): boolean {
  const key = normalizeNameKey(name);
  if (!key) return true;
  if (INVALID_NAME_PHRASES.has(key)) return true;
  if (
    /^(?:hey|ok|okay|please|can|could|i|we|the|a|an|patient|admit|needs?|give|prescribe)\b/i.test(
      key
    )
  ) {
    return true;
  }
  if (/\b(?:vital|admit|patient|needs?|aspirin|aspers|medication)\b/i.test(key)) {
    return true;
  }
  if (key.split(/\s+/).length > 6) return true;
  return false;
}

function sanitizeName(raw: string): string | undefined {
  const name = normalizeSpaces(raw.replace(/[?.!,;:]+$/, ""));
  if (!name || isInvalidAdmissionName(name)) return undefined;
  const words = name.split(/\s+/);
  if (words.length === 1 && /^(?:he|she|they|him|her|them|a|an|the)$/i.test(words[0])) {
    return undefined;
  }
  if (!/^[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]+)*$/.test(name)) {
    return undefined;
  }
  return words.map((part) => titleCaseWord(part)).join(" ");
}

function extractExplicitName(text: string): string | undefined {
  const patterns = [
    /\bpatient named\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]+)*)/i,
    /\bnamed\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]+)*)/i,
    /\bcalled\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]+)*)/i,
    /\bpatient is\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]+)*)/i,
    /\bname is\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]+)*)/i,
  ];
  for (const rx of patterns) {
    const match = text.match(rx);
    if (match?.[1]) {
      const beforeStop = match[1].split(NAME_STOP_RE)[0]?.trim();
      const name = sanitizeName(beforeStop ?? match[1]);
      if (name) return name;
    }
  }
  return undefined;
}

function extractNameAfterAdmitPhrase(text: string): string | undefined {
  let rest = text.replace(ADMIT_PHRASE_RE, " ").trim();
  rest = rest.replace(/^[,:]\s*/, "").trim();

  if (/^admit\s+/i.test(text) && !/^admit\s+(?:a\s+)?patient\b/i.test(text)) {
    const direct = text.replace(/^admit\s+/i, "").trim();
    const segment = direct.split(NAME_STOP_RE)[0]?.trim();
    const name = sanitizeName(segment ?? "");
    if (name) return name;
  }

  if (!rest) return undefined;

  const commaParts = rest.split(",").map((p) => p.trim()).filter(Boolean);
  if (commaParts.length > 1) {
    const first = sanitizeName(commaParts[0].split(NAME_STOP_RE)[0]?.trim() ?? "");
    if (first) return first;
  }

  const segment = rest.split(NAME_STOP_RE)[0]?.trim();
  if (!segment) return undefined;
  if (segment.split(/\s+/).length > 4) return undefined;
  return sanitizeName(segment);
}

function extractAgeSex(text: string): { age?: number; sex?: string } {
  const out: { age?: number; sex?: string } = {};
  const agePatterns = [
    /\b(?:age|aged)\s*(\d{1,3})\b/i,
    /\b(\d{1,3})\s*[- ]?\s*year[s]?\s*[- ]?\s*old\b/i,
    /\b(\d{1,3})\s*(?:yo|y\.?o\.?)\b/i,
    /\b(\d{1,3})\s*([mf])\b/i,
    /\b(\d{1,3})\s*(?:year[s]?\s*old\s*)?(male|female|man|woman|boy|girl)\b/i,
  ];
  for (const rx of agePatterns) {
    const match = text.match(rx);
    if (match?.[1]) {
      out.age = Number(match[1]);
      if (match[2]) {
        const sex = normalizeSexToken(match[2]);
        if (sex) out.sex = sex;
      }
      break;
    }
  }
  if (!out.sex) {
    const sexOnly =
      text.match(/\b(male|female|man|woman|boy|girl)\b/i) ??
      text.match(/\b([mf])\b/i);
    if (sexOnly?.[1]) {
      const sex = normalizeSexToken(sexOnly[1]);
      if (sex) out.sex = sex;
    }
  }
  return out;
}

function extractRoom(text: string): string | undefined {
  const patterns: Array<{ rx: RegExp; prefix?: string }> = [
    { rx: /\b(?:to room|in room|assign(?:ed)? to room|room)\s+([A-Za-z0-9-]+)\b/i },
    { rx: /\bbed\s+(\d+[A-Za-z]?)\b/i, prefix: "Bed" },
    { rx: /\bbay\s+(\d+[A-Za-z]?)\b/i, prefix: "Bay" },
    { rx: /\bisolation\s+(\d+[A-Za-z]?)\b/i, prefix: "Isolation" },
    { rx: /\bpeds\s+(\d+[A-Za-z]?)\b/i, prefix: "Peds" },
    { rx: /\btrauma\s+(\d+[A-Za-z]?)\b/i, prefix: "Trauma" },
  ];
  for (const { rx, prefix } of patterns) {
    const match = text.match(rx);
    if (match?.[1]) return normalizeRoom(match[1], prefix);
  }
  return undefined;
}

function extractMedication(text: string): ParsedAdmissionMedication | undefined {
  const patterns = [
    /\b(?:and\s+)?(?:give|prescribe|start|needs?|medication|meds?)\s+(?:him|her|them|the patient|patient)?\s*([a-z][a-z0-9-]*)\b/i,
    /\b(?:he|she|they)\s+needs?\s+([a-z][a-z0-9-]*)\b/i,
  ];
  for (const rx of patterns) {
    const match = text.match(rx);
    if (match?.[1]) {
      const token = match[1].toLowerCase();
      if (MEDICATION_ALIASES[token] || /^[a-z]{3,}$/i.test(match[1])) {
        return {
          name: normalizeMedicationName(match[1]),
          dose: "As directed",
          status: "Active",
        };
      }
    }
  }
  return undefined;
}

function extractChiefConcern(text: string, hasMedication: boolean): string | undefined {
  const patterns = [
    /\bchief concern(?: is)?\s+(.+?)(?=$|\b(?:room|in room|to room|age|years?\s+old|male|female|medication|med|give|prescribe|needs|acuity|ctas|priority|urgency|and give|and needs)\b)/i,
    /\bconcern is\s+(.+?)(?=$|\b(?:room|in room|to room|age|years?\s+old|male|female|medication|med|give|prescribe|needs|acuity|ctas|priority|urgency|and give|and needs)\b)/i,
    /\b(?:complaining of|presenting with|due to|came in for)\s+(.+?)(?=$|\b(?:room|in room|to room|age|years?\s+old|male|female|medication|med|give|prescribe|needs|acuity|ctas|priority|urgency|and give|and needs)\b)/i,
    /\b(?:with|for)\s+(.+?)(?=$|\b(?:room|in room|to room|age|years?\s+old|male|female|medication|med|give|prescribe|needs|acuity|ctas|priority|urgency|and give|and needs)\b)/i,
    /\b(?:he|she|they)\s+have\s+(.+?)(?=$|\b(?:room|in room|to room|age|years?\s+old|male|female|medication|med|give|prescribe|needs|acuity|ctas|priority|urgency|and give|and needs)\b)/i,
    /\bhas\s+(.+?)(?=$|\b(?:room|in room|to room|age|years?\s+old|male|female|medication|med|give|prescribe|needs|acuity|ctas|priority|urgency|and give|and needs)\b)/i,
  ];
  for (const rx of patterns) {
    const match = text.match(rx);
    if (match?.[1]) {
      let concern = normalizeSpaces(match[1].replace(/[?.!,;:]+$/, ""));
      concern = concern.replace(/,\s*$/, "").trim();
      if (!concern) continue;
      if (/\b(?:needs?|give|prescribe|aspirin|aspers|medication)\b/i.test(concern)) {
        concern = concern.split(CONCERN_STOP_RE)[0]?.trim() ?? "";
      }
      if (concern && !/\b(?:needs?|aspirin|aspers|medication)\b/i.test(concern)) {
        return concern;
      }
    }
  }
  if (hasMedication) return undefined;
  if (
    /\b(?:pain|fever|nausea|injury|bleeding|shortness|breath|chest|abdominal|seizure|trauma|migraine|dizziness|vomiting|aura)\b/i.test(
      text
    )
  ) {
    const maybe = text.split(CONCERN_STOP_RE)[0]?.trim();
    if (
      maybe &&
      !isInvalidAdmissionName(maybe) &&
      !/\b(?:needs?|aspirin|aspers)\b/i.test(maybe)
    ) {
      return maybe;
    }
  }
  return undefined;
}

function extractAllergies(text: string): string[] | undefined {
  if (!ALLERGY_EXPLICIT_RE.test(text)) return undefined;
  if (/\b(?:no known allergies|nkda|nka|no allergies|none known)\b/i.test(text)) {
    return [];
  }
  const match = text.match(
    /\b(?:allergic to|allergy to|allergies are)\s+(.+?)(?=$|\b(?:room|medication|med|give|prescribe|needs|acuity|ctas)\b)/i
  );
  if (!match?.[1]) return undefined;
  return match[1]
    .split(/\s*,\s*|\s+and\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAdmissionCommand(transcript: string): ParsedAdmission {
  const cleaned = cleanVoiceCommand(transcript);
  const result: ParsedAdmission = {};

  const medication = extractMedication(cleaned);
  if (medication) result.medication = medication;

  const allergies = extractAllergies(cleaned);
  if (allergies !== undefined) result.allergies = allergies;

  const acuity = normalizeAcuity(cleaned);
  if (acuity) result.acuity = acuity;

  const ageSex = extractAgeSex(cleaned);
  if (ageSex.age !== undefined) result.age = ageSex.age;
  if (ageSex.sex) result.sex = ageSex.sex;

  const room = extractRoom(cleaned);
  if (room) result.room = room;

  const explicitName = extractExplicitName(cleaned);
  const inferredName = explicitName ?? extractNameAfterAdmitPhrase(cleaned);
  if (inferredName) result.name = inferredName;

  const chiefConcern = extractChiefConcern(cleaned, Boolean(medication));
  if (chiefConcern) result.chiefConcern = chiefConcern;

  if (!result.name) {
    const bareName = sanitizeName(cleaned);
    const hasStructuredFields =
      Boolean(result.room) ||
      Boolean(result.chiefConcern) ||
      Boolean(result.age) ||
      Boolean(result.sex) ||
      Boolean(result.acuity);
    if (bareName && !hasStructuredFields && cleaned.split(/\s+/).length <= 4) {
      result.name = bareName;
    }
  }

  return result;
}

export function parsedAdmissionToPatientFields(parsed: ParsedAdmission): {
  name?: string;
  age?: number;
  sex?: string;
  room?: string;
  chiefConcern?: string;
  triageAcuity?: string;
  allergies?: string[];
  medications?: DemoMedication[];
} {
  const out: ReturnType<typeof parsedAdmissionToPatientFields> = {};
  if (parsed.name) out.name = parsed.name;
  if (parsed.age !== undefined) out.age = parsed.age;
  if (parsed.sex) out.sex = parsed.sex;
  if (parsed.room) out.room = parsed.room;
  if (parsed.chiefConcern) out.chiefConcern = parsed.chiefConcern;
  if (parsed.acuity) out.triageAcuity = parsed.acuity;
  if (parsed.allergies !== undefined) out.allergies = parsed.allergies;
  if (parsed.medication) {
    out.medications = [
      {
        name: parsed.medication.name,
        sig: parsed.medication.dose ?? "As directed",
      },
    ];
  }
  return out;
}

export function hasRequiredAdmissionFields(data: {
  name?: string;
  room?: string;
  chiefConcern?: string;
}): boolean {
  return Boolean(
    data.name?.trim() && data.room?.trim() && data.chiefConcern?.trim()
  );
}

export function isExplicitEmergencyContactAnswer(text: string): boolean {
  return EMERGENCY_CONTACT_EXPLICIT_RE.test(text);
}

export function isExplicitAllergyAnswer(text: string): boolean {
  return ALLERGY_EXPLICIT_RE.test(text);
}

export function mergeParsedIntoPatientData(
  existing: Partial<import("@/lib/demo-patients").DemoPatient>,
  parsed: ParsedAdmission
): Partial<import("@/lib/demo-patients").DemoPatient> {
  const fields = parsedAdmissionToPatientFields(parsed);
  const merged = { ...existing };
  if (fields.name) merged.name = fields.name;
  if (fields.age !== undefined) merged.age = fields.age;
  if (fields.sex) merged.sex = fields.sex;
  if (fields.room) merged.room = fields.room;
  if (fields.chiefConcern) merged.chiefConcern = fields.chiefConcern;
  if (fields.triageAcuity) merged.triageAcuity = fields.triageAcuity;
  if (fields.allergies !== undefined) merged.allergies = fields.allergies;
  if (fields.medications?.length) {
    const existingMeds = merged.medications ?? [];
    const names = new Set(existingMeds.map((m) => m.name.toLowerCase()));
    const toAdd = fields.medications.filter((m) => !names.has(m.name.toLowerCase()));
    if (toAdd.length) merged.medications = [...existingMeds, ...toAdd];
  }
  return merged;
}
