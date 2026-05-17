import type { DemoMedication, DemoPatient, PatientProblem } from "@/lib/demo-patients";

export type DbAllergy = {
  allergen: string;
  reaction: string;
  severity: string;
};

export type DbMedication = {
  name: string;
  dose: string;
  status: string;
};

export type DbProblem = {
  name: string;
  status: string;
  since: string;
};

export type DbEmergencyContact = {
  name: string;
  relationship: string;
  phone: string;
};

export type PatientRow = {
  id: string;
  mrn: string;
  name: string;
  age: number;
  sex: string;
  dob: string | null;
  blood_type: string | null;
  last_visit: string | null;
  provider: string | null;
  room: string | null;
  chief_concern: string | null;
  acuity: string | null;
  status: string | null;
  allergies: DbAllergy[] | null;
  medications: DbMedication[] | null;
  problems: DbProblem[] | null;
  emergency_contact: DbEmergencyContact | null;
  primary_contact_line: string | null;
  created_at?: string;
  updated_at?: string;
};

function isoDateOnly(value: string | null | undefined): string {
  if (!value) return "Not listed";
  return value.slice(0, 10);
}

function toDbDate(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || /^not listed$/i.test(trimmed) || trimmed === "?") {
    return null;
  }
  const match = trimmed.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function normalizeProblemName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseAllergyString(entry: string): DbAllergy {
  const [allergen, reaction] = entry.split(/[—–-]/).map((s) => s.trim());
  const text = entry.toLowerCase();
  const severity = /anaphylaxis|severe|confusion|swelling/i.test(text)
    ? "Severe"
    : /rash|hives|vomiting|gi bleeding/i.test(text)
      ? "Moderate"
      : /no known|none/i.test(text)
        ? "None"
        : "Mild";
  return {
    allergen: allergen || entry,
    reaction: reaction || "Noted",
    severity,
  };
}

function allergiesToDb(allergies: unknown): DbAllergy[] {
  if (!Array.isArray(allergies)) return [];
  const out: DbAllergy[] = [];
  for (const item of allergies) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) out.push(parseAllergyString(trimmed));
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const allergen = String(o.allergen ?? "").trim();
    if (!allergen) continue;
    out.push({
      allergen,
      reaction: String(o.reaction ?? "Noted").trim() || "Noted",
      severity: String(o.severity ?? "Mild").trim() || "Mild",
    });
  }
  return out;
}

function allergiesFromDb(allergies: DbAllergy[] | null | undefined): string[] {
  if (!allergies?.length) return [];
  return allergies.map((a) =>
    a.reaction && a.reaction !== "Noted"
      ? `${a.allergen} — ${a.reaction}`
      : a.allergen
  );
}

function medicationsToDb(medications: unknown): DbMedication[] {
  if (!Array.isArray(medications)) return [];
  const out: DbMedication[] = [];
  for (const item of medications) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    if (!name) continue;
    const dose =
      String(o.dose ?? o.sig ?? "").trim() || "sig not specified";
    out.push({
      name,
      dose,
      status: String(o.status ?? "Active").trim() || "Active",
    });
  }
  return out;
}

function medicationsFromDb(
  medications: DbMedication[] | null | undefined
): DemoMedication[] {
  if (!medications?.length) return [];
  return medications.map((m) => ({
    name: m.name,
    sig: m.dose || "sig not specified",
  }));
}

function problemItemToDb(item: unknown): DbProblem | null {
  if (typeof item === "string") {
    const name = item.trim();
    if (!name) return null;
    return { name, status: "Active", since: "Chart" };
  }
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    status: String(o.status ?? "Active").trim() || "Active",
    since: String(o.since ?? "Chart").trim() || "Chart",
  };
}

/** Problems column only — from problems list and/or diagnoses (never symptoms). */
function problemsToDb(problems: unknown, diagnoses?: string[]): DbProblem[] {
  const byName = new Map<string, DbProblem>();

  const add = (item: unknown) => {
    const row = problemItemToDb(item);
    if (!row) return;
    const key = normalizeProblemName(row.name);
    if (!key) return;
    if (!byName.has(key)) byName.set(key, row);
  };

  if (Array.isArray(problems)) {
    for (const item of problems) add(item);
  }
  if (Array.isArray(diagnoses)) {
    for (const name of diagnoses) add(name);
  }

  return Array.from(byName.values());
}

function problemsFromDb(problems: DbProblem[] | null | undefined): PatientProblem[] {
  if (!problems?.length) return [];
  return problems.map((p) => ({
    name: p.name,
    status: p.status,
    since: p.since || "Chart",
  }));
}

function emergencyContactToDb(
  contact: unknown,
  primaryLine?: string | null
): DbEmergencyContact {
  if (contact && typeof contact === "object") {
    const o = contact as Record<string, unknown>;
    return {
      name: String(o.name ?? "Not listed").trim() || "Not listed",
      relationship:
        String(o.relationship ?? "Not listed").trim() || "Not listed",
      phone: String(o.phone ?? primaryLine ?? "Not listed").trim() || "Not listed",
    };
  }
  return {
    name: "Not listed",
    relationship: "Not listed",
    phone: primaryLine?.trim() || "Not listed",
  };
}

function buildProblemsForPatient(p: DemoPatient): DbProblem[] {
  if (p.problems?.length) {
    return problemsToDb(p.problems, p.diagnoses);
  }
  return problemsToDb(undefined, p.diagnoses);
}

export function demoPatientToRow(p: DemoPatient): Omit<PatientRow, "created_at" | "updated_at"> {
  const problems = buildProblemsForPatient(p);
  const ec = emergencyContactToDb(p.emergencyContact, p.emergencyContact?.phone);

  return {
    id: p.id,
    mrn: p.mrn,
    name: p.name,
    age: p.age,
    sex: p.sex,
    dob: toDbDate(p.dob),
    blood_type: p.bloodType || null,
    last_visit: toDbDate(p.lastVisit),
    provider: p.pcp ?? null,
    room: p.room || null,
    chief_concern: p.chiefConcern || null,
    acuity: p.triageAcuity || null,
    status: deriveStatusFromPatient(p),
    allergies: allergiesToDb(p.allergies),
    medications: medicationsToDb(p.medications),
    problems,
    emergency_contact: ec,
    primary_contact_line: ec.phone !== "Not listed" ? ec.phone : null,
  };
}

function deriveStatusFromPatient(p: DemoPatient): string {
  if (/discharge|improv/i.test(p.edOrUrgentCourse ?? "")) return "Discharge planning";
  if (/observe|watch/i.test(p.edOrUrgentCourse ?? "")) return "Observation";
  if (/pending|awaiting/i.test(p.recentLabs ?? "")) return "Labs pending";
  if (/ordered|pending/i.test(p.imagingStudies ?? "")) return "Imaging ordered";
  if (/consult|requested/i.test(p.consultants ?? "")) return "Consult requested";
  if (/ctas\s*[12]/i.test(p.triageAcuity)) return "Awaiting physician";
  return "In triage";
}

export function rowToDemoPatient(row: PatientRow): DemoPatient {
  const problems = problemsFromDb(row.problems);
  const problemNames = problems.map((p) => p.name);
  const emergencyContact = row.emergency_contact ?? {
    name: "Not listed",
    relationship: "Not listed",
    phone: "Not listed",
  };
  const phone =
    row.primary_contact_line?.trim() ||
    emergencyContact.phone ||
    "Not listed";

  return {
    id: row.id,
    mrn: row.mrn,
    name: row.name,
    age: row.age ?? 0,
    sex: row.sex || "?",
    dob: isoDateOnly(row.dob),
    bloodType: row.blood_type?.trim() || "Unknown",
    room: row.room?.trim() || "Unassigned",
    triageAcuity: row.acuity?.trim() || "Not assigned",
    allergies: allergiesFromDb(row.allergies),
    chiefConcern: row.chief_concern?.trim() || "Not specified",
    symptoms: [],
    diagnoses: problemNames,
    problems,
    medications: medicationsFromDb(row.medications),
    vitals: {},
    lastVisit: isoDateOnly(row.last_visit),
    social: "",
    chartNote: "",
    pcp: row.provider?.trim() || undefined,
    emergencyContact: {
      name: emergencyContact.name,
      relationship: emergencyContact.relationship,
      phone,
    },
    address: "Not listed",
    insurance: "Not listed",
    careTeam: [],
  };
}

export function patchToRowUpdate(
  patch: Record<string, unknown>,
  current: DemoPatient
): Partial<PatientRow> {
  const out: Partial<PatientRow> = {};
  const merged: DemoPatient = { ...current };

  if (typeof patch.name === "string" && patch.name.trim()) {
    merged.name = patch.name.trim();
    out.name = merged.name;
  }
  if (typeof patch.mrn === "string" && patch.mrn.trim()) {
    merged.mrn = patch.mrn.trim();
    out.mrn = merged.mrn;
  }
  if (typeof patch.age === "number" && Number.isFinite(patch.age)) {
    merged.age = patch.age;
    out.age = merged.age;
  }
  if (typeof patch.sex === "string" && patch.sex.trim()) {
    merged.sex = patch.sex.trim();
    out.sex = merged.sex;
  }
  if (typeof patch.dob === "string") {
    merged.dob = patch.dob.trim() || merged.dob;
    out.dob = toDbDate(merged.dob);
  }
  if (typeof patch.bloodType === "string") {
    merged.bloodType = patch.bloodType.trim() || merged.bloodType;
    out.blood_type = merged.bloodType;
  }
  if (typeof patch.room === "string") {
    merged.room = patch.room.trim() || merged.room;
    out.room = merged.room;
  }
  if (typeof patch.triageAcuity === "string") {
    merged.triageAcuity = patch.triageAcuity.trim() || merged.triageAcuity;
    out.acuity = merged.triageAcuity;
  }
  if (typeof patch.pcp === "string") {
    merged.pcp = patch.pcp.trim() || undefined;
    out.provider = merged.pcp ?? null;
  }
  if (typeof patch.chiefConcern === "string") {
    merged.chiefConcern = patch.chiefConcern.trim();
    out.chief_concern = merged.chiefConcern;
  }
  if (typeof patch.lastVisit === "string") {
    merged.lastVisit = patch.lastVisit.trim();
    out.last_visit = toDbDate(merged.lastVisit);
  }
  if (patch.allergies !== undefined) {
    merged.allergies = allergiesFromDb(allergiesToDb(patch.allergies));
    out.allergies = allergiesToDb(patch.allergies);
  }
  if (patch.medications !== undefined) {
    merged.medications = medicationsFromDb(medicationsToDb(patch.medications));
    out.medications = medicationsToDb(patch.medications);
  }

  const problemsTouched =
    patch.problems !== undefined || patch.diagnoses !== undefined;

  if (problemsTouched) {
    const dx = Array.isArray(patch.diagnoses)
      ? patch.diagnoses.map((x) => String(x).trim()).filter(Boolean)
      : merged.diagnoses;
    const dbProblems = problemsToDb(patch.problems ?? merged.problems, dx);
    merged.problems = problemsFromDb(dbProblems);
    merged.diagnoses = merged.problems.map((p) => p.name);
    merged.symptoms = [];
    out.problems = dbProblems;
  }

  if (patch.emergencyContact !== undefined) {
    merged.emergencyContact = emergencyContactToDb(patch.emergencyContact);
    out.emergency_contact = emergencyContactToDb(patch.emergencyContact);
    out.primary_contact_line =
      merged.emergencyContact.phone !== "Not listed"
        ? merged.emergencyContact.phone
        : null;
  }
  if (typeof patch.primaryContactLine === "string") {
    out.primary_contact_line = patch.primaryContactLine.trim() || null;
    merged.emergencyContact = {
      ...merged.emergencyContact,
      phone: patch.primaryContactLine.trim() || merged.emergencyContact.phone,
    };
    out.emergency_contact = emergencyContactToDb(merged.emergencyContact);
  }

  return out;
}

export function payloadToDemoPatient(
  body: Record<string, unknown>,
  id: string,
  mrn: string
): DemoPatient {
  const allergies = allergiesFromDb(allergiesToDb(body.allergies));
  const medications = medicationsFromDb(medicationsToDb(body.medications));
  const diagnoses = Array.isArray(body.diagnoses)
    ? body.diagnoses.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const problems = problemsFromDb(problemsToDb(body.problems, diagnoses));
  const names = problems.map((p) => p.name);
  const ec = emergencyContactToDb(body.emergencyContact);

  return {
    id,
    mrn,
    name: String(body.name ?? "").trim(),
    age: typeof body.age === "number" && Number.isFinite(body.age) ? body.age : 0,
    sex: String(body.sex ?? "?").trim().slice(0, 8) || "?",
    dob: String(body.dob ?? "").trim() || "Not listed",
    bloodType: String(body.bloodType ?? "").trim() || "Unknown",
    room: String(body.room ?? "").trim() || "Unassigned",
    triageAcuity: String(body.triageAcuity ?? "").trim() || "CTAS 3",
    allergies,
    chiefConcern: String(body.chiefConcern ?? "Not specified").trim(),
    symptoms: [],
    diagnoses: names,
    problems: problems.length
      ? problems
      : diagnoses.map((name) => ({ name, status: "Active", since: "Chart" })),
    medications,
    vitals: {},
    lastVisit:
      String(body.lastVisit ?? "").trim() ||
      new Date().toISOString().slice(0, 10),
    social: "",
    chartNote: "In triage",
    pcp: body.pcp ? String(body.pcp).trim() : undefined,
    emergencyContact: ec,
    address: "Not listed",
    insurance: "Not listed",
    careTeam: [],
  };
}
