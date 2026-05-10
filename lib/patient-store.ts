/**
 * Local JSON persistence for chart roster (demo / single-tenant).
 * Not suitable for real PHI without encryption, auth, and a proper database.
 */

import { existsSync, mkdirSync } from "fs";
import { readFile, rename, writeFile } from "fs/promises";
import path from "path";

import {
  DEMO_PATIENTS,
  patientToSnapshot,
  type DemoPatient,
} from "@/lib/demo-patients";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "patients.json");

type StoreFileV1 = { version: 1; patients: DemoPatient[] };

let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function ensureDataDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

async function atomicWrite(data: StoreFileV1): Promise<void> {
  await ensureDataDir();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, STORE_FILE);
}

async function readStoreUnlocked(): Promise<StoreFileV1> {
  await ensureDataDir();
  if (!existsSync(STORE_FILE)) {
    const initial: StoreFileV1 = {
      version: 1,
      patients: structuredClone(DEMO_PATIENTS) as DemoPatient[],
    };
    await atomicWrite(initial);
    return initial;
  }
  try {
    const raw = await readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreFileV1>;
    if (!Array.isArray(parsed.patients)) {
      throw new Error("invalid shape");
    }
    return { version: 1, patients: parsed.patients as DemoPatient[] };
  } catch {
    const fallback: StoreFileV1 = {
      version: 1,
      patients: structuredClone(DEMO_PATIENTS) as DemoPatient[],
    };
    await atomicWrite(fallback);
    return fallback;
  }
}

async function withStore<T>(fn: (store: StoreFileV1) => Promise<T>): Promise<T> {
  return enqueue(async () => {
    const store = await readStoreUnlocked();
    return fn(store);
  });
}

export async function listPatients(): Promise<DemoPatient[]> {
  return withStore(async (s) => s.patients.slice());
}

export async function getPatientById(id: string): Promise<DemoPatient | undefined> {
  const idTrim = id.trim();
  return withStore(async (s) => s.patients.find((p) => p.id === idTrim));
}

export async function getPatientByMrn(mrn: string): Promise<DemoPatient | undefined> {
  const norm = mrn.trim().toUpperCase();
  return withStore(async (s) =>
    s.patients.find((p) => p.mrn.trim().toUpperCase() === norm)
  );
}

function slugFromName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 28);
  return s || "patient";
}

function newPatientId(name: string): string {
  return `pt-${slugFromName(name)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newMrn(): string {
  return `MRN-${Date.now().toString(36).toUpperCase()}`;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x).trim()).filter(Boolean);
}

function asMedList(
  v: unknown
): { name: string; sig: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: { name: string; sig: string }[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const name = String((item as { name?: unknown }).name ?? "").trim();
    const sig = String((item as { sig?: unknown }).sig ?? "").trim();
    if (name) out.push({ name, sig: sig || "sig not specified" });
  }
  return out.length ? out : [];
}

function asVitals(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    out[k] = String(val).trim();
  }
  return Object.keys(out).length ? out : {};
}

function asEmergencyContact(
  v: unknown
): DemoPatient["emergencyContact"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const name = String(o.name ?? "").trim();
  const relationship = String(o.relationship ?? "").trim();
  const phone = String(o.phone ?? "").trim();
  if (!name && !relationship && !phone) return undefined;
  return {
    name: name || "Not listed",
    relationship: relationship || "Not listed",
    phone: phone || "Not listed",
  };
}

export type PatientStoreEvent =
  | { action: "created"; patientId: string }
  | { action: "updated"; patientId: string }
  | { action: "deleted"; patientId: string }
  | { action: "listed" }
  | { action: "read"; patientId: string };

export async function createPatientFromPayload(
  body: unknown
): Promise<{ patient: DemoPatient; event: PatientStoreEvent }> {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = String(o.name ?? "").trim();
  if (!name) {
    throw new Error("name is required");
  }

  return withStore(async (store) => {
    const p: DemoPatient = {
      id: newPatientId(name),
      mrn: String(o.mrn ?? "").trim() || newMrn(),
      name,
      preferredName: o.preferredName
        ? String(o.preferredName).trim()
        : undefined,
      age: typeof o.age === "number" && Number.isFinite(o.age) ? o.age : 0,
      sex: String(o.sex ?? "?").trim().slice(0, 8) || "?",
      dob: String(o.dob ?? "").trim() || "Not listed",
      bloodType: String(o.bloodType ?? "").trim() || "Unknown",
      room: String(o.room ?? "").trim() || "Unassigned",
      triageAcuity: String(o.triageAcuity ?? "").trim() || "Not assigned",
      allergies: asStringArray(o.allergies) ?? [],
      chiefConcern: String(o.chiefConcern ?? "Not specified").trim(),
      symptoms: asStringArray(o.symptoms) ?? [],
      diagnoses: asStringArray(o.diagnoses) ?? [],
      medications: asMedList(o.medications) ?? [],
      vitals: asVitals(o.vitals) ?? {},
      recentLabs: o.recentLabs ? String(o.recentLabs).trim() : undefined,
      lastVisit:
        String(o.lastVisit ?? "").trim() ||
        new Date().toISOString().slice(0, 10),
      social: String(o.social ?? "").trim(),
      chartNote: String(o.chartNote ?? "").trim(),
      pcp: o.pcp ? String(o.pcp).trim() : undefined,
      codeStatus: o.codeStatus ? String(o.codeStatus).trim() : undefined,
      emergencyContact: asEmergencyContact(o.emergencyContact) ?? {
        name: "Not listed",
        relationship: "Not listed",
        phone: "Not listed",
      },
      address: String(o.address ?? "").trim() || "Not listed",
      insurance: String(o.insurance ?? "").trim() || "Not listed",
      familyHistory: o.familyHistory
        ? String(o.familyHistory).trim()
        : undefined,
      surgicalHistory: o.surgicalHistory
        ? String(o.surgicalHistory).trim()
        : undefined,
      immunizations: o.immunizations
        ? String(o.immunizations).trim()
        : undefined,
      imagingStudies: o.imagingStudies
        ? String(o.imagingStudies).trim()
        : undefined,
      cardiacStudies: o.cardiacStudies
        ? String(o.cardiacStudies).trim()
        : undefined,
      consultants: o.consultants ? String(o.consultants).trim() : undefined,
      edOrUrgentCourse: o.edOrUrgentCourse
        ? String(o.edOrUrgentCourse).trim()
        : undefined,
      functionalStatus: o.functionalStatus
        ? String(o.functionalStatus).trim()
        : undefined,
      riskFlags: o.riskFlags ? String(o.riskFlags).trim() : undefined,
      pharmacyNotes: o.pharmacyNotes
        ? String(o.pharmacyNotes).trim()
        : undefined,
      careTeam: asStringArray(o.careTeam) ?? [],
    };
    store.patients.push(p);
    await atomicWrite(store);
    return { patient: p, event: { action: "created", patientId: p.id } };
  });
}

export async function updatePatientById(
  id: string,
  patch: unknown
): Promise<{ patient: DemoPatient; event: PatientStoreEvent } | null> {
  const idTrim = id.trim();
  const o =
    patch && typeof patch === "object"
      ? (patch as Record<string, unknown>)
      : {};

  return withStore(async (store) => {
    const idx = store.patients.findIndex((p) => p.id === idTrim);
    if (idx < 0) return null;
    const cur = store.patients[idx];
    const next: DemoPatient = { ...cur };

    if (typeof o.name === "string" && o.name.trim()) next.name = o.name.trim();
    if (typeof o.mrn === "string" && o.mrn.trim()) next.mrn = o.mrn.trim();
    if (typeof o.preferredName === "string")
      next.preferredName = o.preferredName.trim() || undefined;
    if (typeof o.age === "number" && Number.isFinite(o.age)) next.age = o.age;
    if (typeof o.sex === "string" && o.sex.trim()) next.sex = o.sex.trim();
    if (typeof o.dob === "string") next.dob = o.dob.trim() || next.dob;
    if (typeof o.bloodType === "string")
      next.bloodType = o.bloodType.trim() || next.bloodType;
    if (typeof o.room === "string") next.room = o.room.trim() || next.room;
    if (typeof o.triageAcuity === "string")
      next.triageAcuity = o.triageAcuity.trim() || next.triageAcuity;
    const al = asStringArray(o.allergies);
    if (al) next.allergies = al;
    if (typeof o.chiefConcern === "string")
      next.chiefConcern = o.chiefConcern.trim();
    const symptoms = asStringArray(o.symptoms);
    if (symptoms) next.symptoms = symptoms;
    const dx = asStringArray(o.diagnoses);
    if (dx) next.diagnoses = dx;
    const meds = asMedList(o.medications);
    if (meds !== undefined) next.medications = meds;
    const vit = asVitals(o.vitals);
    if (vit !== undefined) next.vitals = vit;
    if (typeof o.recentLabs === "string")
      next.recentLabs = o.recentLabs.trim() || undefined;
    if (typeof o.lastVisit === "string") next.lastVisit = o.lastVisit.trim();
    if (typeof o.social === "string") next.social = o.social.trim();
    if (typeof o.chartNote === "string") next.chartNote = o.chartNote.trim();
    const ec = asEmergencyContact(o.emergencyContact);
    if (ec) next.emergencyContact = ec;
    if (typeof o.address === "string") next.address = o.address.trim() || next.address;
    if (typeof o.insurance === "string")
      next.insurance = o.insurance.trim() || next.insurance;
    const careTeam = asStringArray(o.careTeam);
    if (careTeam) next.careTeam = careTeam;

    const opt = (k: keyof DemoPatient) => {
      if (o[k] === undefined) return;
      const v = o[k as string];
      (next as unknown as Record<string, unknown>)[k as string] =
        typeof v === "string" ? v.trim() || undefined : v;
    };
    opt("pcp");
    opt("codeStatus");
    opt("familyHistory");
    opt("surgicalHistory");
    opt("immunizations");
    opt("imagingStudies");
    opt("cardiacStudies");
    opt("consultants");
    opt("edOrUrgentCourse");
    opt("functionalStatus");
    opt("riskFlags");
    opt("pharmacyNotes");

    store.patients[idx] = next;
    await atomicWrite(store);
    return { patient: next, event: { action: "updated", patientId: next.id } };
  });
}

export async function deletePatientById(
  id: string
): Promise<{ event: PatientStoreEvent } | null> {
  const idTrim = id.trim();
  return withStore(async (store) => {
    const before = store.patients.length;
    store.patients = store.patients.filter((p) => p.id !== idTrim);
    if (store.patients.length === before) return null;
    await atomicWrite(store);
    return { event: { action: "deleted", patientId: idTrim } };
  });
}

/** Compact roster line for tool results (keep tokens small). */
export function summarizePatientsForTools(patients: DemoPatient[]): string {
  if (!patients.length) return "No patients in roster.";
  return patients
    .map(
      (p) =>
        `${p.id} | ${p.mrn} | ${p.name} | ${p.age}${p.sex} | ${p.chiefConcern.slice(0, 80)}`
    )
    .join("\n");
}

export function summarizePatientDetail(p: DemoPatient): string {
  return patientToSnapshot(p);
}

function snakeToCreatePayload(
  a: Record<string, unknown>
): Record<string, unknown> {
  const g = (k: string) => a[k];
  return {
    name: g("name"),
    mrn: g("mrn"),
    preferredName: g("preferred_name"),
    age: g("age"),
    sex: g("sex"),
    dob: g("dob"),
    bloodType: g("blood_type") ?? g("bloodType"),
    room: g("room"),
    triageAcuity: g("triage_acuity") ?? g("triageAcuity"),
    allergies: g("allergies"),
    chiefConcern: g("chief_concern") ?? g("chiefConcern"),
    symptoms: g("symptoms"),
    diagnoses: g("diagnoses"),
    medications: g("medications"),
    vitals: g("vitals"),
    recentLabs: g("recent_labs") ?? g("recentLabs"),
    lastVisit: g("last_visit") ?? g("lastVisit"),
    social: g("social"),
    chartNote: g("chart_note") ?? g("chartNote"),
    pcp: g("pcp"),
    codeStatus: g("code_status") ?? g("codeStatus"),
    emergencyContact: g("emergency_contact") ?? g("emergencyContact"),
    address: g("address"),
    insurance: g("insurance"),
    familyHistory: g("family_history") ?? g("familyHistory"),
    surgicalHistory: g("surgical_history") ?? g("surgicalHistory"),
    immunizations: g("immunizations"),
    imagingStudies: g("imaging_studies") ?? g("imagingStudies"),
    cardiacStudies: g("cardiac_studies") ?? g("cardiacStudies"),
    consultants: g("consultants"),
    edOrUrgentCourse: g("ed_or_urgent_course") ?? g("edOrUrgentCourse"),
    functionalStatus: g("functional_status") ?? g("functionalStatus"),
    riskFlags: g("risk_flags") ?? g("riskFlags"),
    pharmacyNotes: g("pharmacy_notes") ?? g("pharmacyNotes"),
    careTeam: g("care_team") ?? g("careTeam"),
  };
}

function snakeToPatchPayload(
  a: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (snake: string, camel: string) => {
    if (a[snake] !== undefined) out[camel] = a[snake];
    if (a[camel] !== undefined) out[camel] = a[camel];
  };
  copy("name", "name");
  copy("mrn", "mrn");
  copy("preferred_name", "preferredName");
  copy("age", "age");
  copy("sex", "sex");
  copy("dob", "dob");
  copy("blood_type", "bloodType");
  copy("room", "room");
  copy("triage_acuity", "triageAcuity");
  copy("allergies", "allergies");
  copy("chief_concern", "chiefConcern");
  copy("symptoms", "symptoms");
  copy("diagnoses", "diagnoses");
  copy("medications", "medications");
  copy("vitals", "vitals");
  copy("recent_labs", "recentLabs");
  copy("last_visit", "lastVisit");
  copy("social", "social");
  copy("chart_note", "chartNote");
  copy("pcp", "pcp");
  copy("code_status", "codeStatus");
  copy("emergency_contact", "emergencyContact");
  copy("address", "address");
  copy("insurance", "insurance");
  copy("family_history", "familyHistory");
  copy("surgical_history", "surgicalHistory");
  copy("immunizations", "immunizations");
  copy("imaging_studies", "imagingStudies");
  copy("cardiac_studies", "cardiacStudies");
  copy("consultants", "consultants");
  copy("ed_or_urgent_course", "edOrUrgentCourse");
  copy("functional_status", "functionalStatus");
  copy("risk_flags", "riskFlags");
  copy("pharmacy_notes", "pharmacyNotes");
  copy("care_team", "careTeam");
  return out;
}

/**
 * Runs one tool call from the LLM. Returns JSON string content for the model + store events for the client.
 */
export async function executePatientToolCall(
  name: string,
  rawArgs: string
): Promise<{ content: string; events: PatientStoreEvent[] }> {
  let args: Record<string, unknown>;
  try {
    const parsed = rawArgs?.trim() ? JSON.parse(rawArgs) : {};
    args =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    return {
      content: JSON.stringify({ ok: false, error: "Invalid JSON in tool arguments." }),
      events: [],
    };
  }

  try {
    switch (name) {
      case "list_patients": {
        const pts = await listPatients();
        return {
          content: JSON.stringify({
            ok: true,
            count: pts.length,
            roster: summarizePatientsForTools(pts),
          }),
          events: [{ action: "listed" }],
        };
      }
      case "get_patient": {
        const pid = String(args.patient_id ?? args.patientId ?? "").trim();
        const mrn = String(args.mrn ?? "").trim();
        let p: DemoPatient | undefined;
        if (pid) p = await getPatientById(pid);
        if (!p && mrn) p = await getPatientByMrn(mrn);
        if (!p) {
          return {
            content: JSON.stringify({
              ok: false,
              error: "Patient not found for id/mrn provided.",
            }),
            events: [],
          };
        }
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: p.id,
            detail: summarizePatientDetail(p),
          }),
          events: [{ action: "read", patientId: p.id }],
        };
      }
      case "create_patient": {
        const payload = snakeToCreatePayload(args);
        const { patient, event } = await createPatientFromPayload(payload);
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: patient.id,
            mrn: patient.mrn,
            name: patient.name,
            message: "Created chart row.",
          }),
          events: [event],
        };
      }
      case "update_patient": {
        const pid = String(
          args.patient_id ?? args.patientId ?? ""
        ).trim();
        if (!pid) {
          return {
            content: JSON.stringify({
              ok: false,
              error: "patient_id is required.",
            }),
            events: [],
          };
        }
        const patch = snakeToPatchPayload(args);
        delete patch.patient_id;
        delete patch.patientId;
        const res = await updatePatientById(pid, patch);
        if (!res) {
          return {
            content: JSON.stringify({
              ok: false,
              error: `No patient with id ${pid}.`,
            }),
            events: [],
          };
        }
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: res.patient.id,
            message: "Updated chart row.",
          }),
          events: [res.event],
        };
      }
      case "delete_patient": {
        const pid = String(
          args.patient_id ?? args.patientId ?? ""
        ).trim();
        if (!pid) {
          return {
            content: JSON.stringify({
              ok: false,
              error: "patient_id is required.",
            }),
            events: [],
          };
        }
        const res = await deletePatientById(pid);
        if (!res) {
          return {
            content: JSON.stringify({
              ok: false,
              error: `No patient with id ${pid}.`,
            }),
            events: [],
          };
        }
        return {
          content: JSON.stringify({
            ok: true,
            patient_id: pid,
            message: "Removed chart row from local roster.",
          }),
          events: [res.event],
        };
      }
      default:
        return {
          content: JSON.stringify({ ok: false, error: `Unknown tool ${name}.` }),
          events: [],
        };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Tool failed.";
    return {
      content: JSON.stringify({ ok: false, error: msg }),
      events: [],
    };
  }
}
