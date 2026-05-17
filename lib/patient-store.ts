/**
 * Patient roster persistence via Supabase (demo / single-tenant).
 */

import {
  DEMO_PATIENTS,
  patientToSnapshot,
  type DemoPatient,
} from "@/lib/demo-patients";
import {
  demoPatientToRow,
  patchToRowUpdate,
  payloadToDemoPatient,
  rowToDemoPatient,
  type PatientRow,
} from "@/lib/patient-db";
import { getSupabase } from "@/lib/supabase";

export type PatientStoreEvent =
  | { action: "created"; patientId: string }
  | { action: "updated"; patientId: string }
  | { action: "deleted"; patientId: string }
  | { action: "listed" }
  | { action: "read"; patientId: string };

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

async function seedDemoPatientsIfEmpty(): Promise<void> {
  const supabase = getSupabase();
  const { count, error: countError } = await supabase
    .from("patients")
    .select("id", { count: "exact", head: true });

  if (countError) throw countError;
  if ((count ?? 0) > 0) return;

  const rows = (DEMO_PATIENTS as DemoPatient[]).map((p) => demoPatientToRow(p));
  const { error } = await supabase.from("patients").insert(rows);
  if (error) throw error;
}

async function fetchAllRows(): Promise<PatientRow[]> {
  const supabase = getSupabase();
  await seedDemoPatientsIfEmpty();

  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []) as PatientRow[];
}

export async function listPatients(): Promise<DemoPatient[]> {
  const rows = await fetchAllRows();
  return rows.map(rowToDemoPatient);
}

export async function getPatientById(id: string): Promise<DemoPatient | undefined> {
  const idTrim = id.trim();
  const supabase = getSupabase();
  await seedDemoPatientsIfEmpty();

  const { data, error } = await supabase
    .from("patients")
    .select("*")
    .eq("id", idTrim)
    .maybeSingle();

  if (error) throw error;
  if (!data) return undefined;
  return rowToDemoPatient(data as PatientRow);
}

export async function getPatientByMrn(mrn: string): Promise<DemoPatient | undefined> {
  const norm = mrn.trim().toUpperCase();
  const patients = await listPatients();
  return patients.find((p) => p.mrn.trim().toUpperCase() === norm);
}

export async function createPatientFromPayload(
  body: unknown
): Promise<{ patient: DemoPatient; event: PatientStoreEvent }> {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = String(o.name ?? "").trim();
  if (!name) {
    throw new Error("name is required");
  }

  const id = newPatientId(name);
  const mrn = String(o.mrn ?? "").trim() || newMrn();
  const patient = payloadToDemoPatient(o, id, mrn);
  const row = demoPatientToRow(patient);

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("patients")
    .insert(row)
    .select("*")
    .single();

  if (error) throw error;
  const created = rowToDemoPatient(data as PatientRow);
  return { patient: created, event: { action: "created", patientId: created.id } };
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

  const current = await getPatientById(idTrim);
  if (!current) return null;

  const rowPatch = patchToRowUpdate(o, current);
  if (Object.keys(rowPatch).length === 0) {
    return { patient: current, event: { action: "updated", patientId: current.id } };
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("patients")
    .update(rowPatch)
    .eq("id", idTrim)
    .select("*")
    .single();

  if (error) throw error;
  const updated = rowToDemoPatient(data as PatientRow);
  return { patient: updated, event: { action: "updated", patientId: updated.id } };
}

export async function deletePatientById(
  id: string
): Promise<{ event: PatientStoreEvent } | null> {
  const idTrim = id.trim();
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("patients")
    .delete()
    .eq("id", idTrim)
    .select("id");

  if (error) throw error;
  if (!data?.length) return null;
  return { event: { action: "deleted", patientId: idTrim } };
}

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
    triageAcuity: g("triage_acuity") ?? g("triageAcuity") ?? g("acuity"),
    allergies: g("allergies"),
    chiefConcern: g("chief_concern") ?? g("chiefConcern"),
    diagnoses: g("diagnoses"),
    problems: g("problems"),
    medications: g("medications"),
    lastVisit: g("last_visit") ?? g("lastVisit"),
    pcp: g("pcp") ?? g("provider"),
    emergencyContact: g("emergency_contact") ?? g("emergencyContact"),
    primaryContactLine: g("primary_contact_line") ?? g("primaryContactLine"),
    status: g("status"),
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
  copy("age", "age");
  copy("sex", "sex");
  copy("dob", "dob");
  copy("blood_type", "bloodType");
  copy("room", "room");
  copy("triage_acuity", "triageAcuity");
  copy("acuity", "triageAcuity");
  copy("allergies", "allergies");
  copy("chief_concern", "chiefConcern");
  copy("diagnoses", "diagnoses");
  copy("problems", "problems");
  copy("medications", "medications");
  copy("last_visit", "lastVisit");
  copy("pcp", "pcp");
  copy("provider", "pcp");
  copy("emergency_contact", "emergencyContact");
  copy("primary_contact_line", "primaryContactLine");
  copy("status", "status");
  return out;
}

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
            message: "Removed chart row from roster.",
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
