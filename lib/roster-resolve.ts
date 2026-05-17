/**
 * Resolve patient references from roster (server-side).
 */

import type { DemoPatient } from "@/lib/demo-patients";

export type PatientResolveResult =
  | { status: "matched"; patient: DemoPatient }
  | { status: "ambiguous"; patients: DemoPatient[]; message: string }
  | { status: "not_found"; message: string };

function normalizeMrn(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeRoom(room: string): string {
  return room
    .trim()
    .toLowerCase()
    .replace(/^room\s+/, "")
    .replace(/\s+/g, " ");
}

function roomsMatch(patientRoom: string, queryRoom: string): boolean {
  const a = normalizeRoom(patientRoom);
  const b = normalizeRoom(queryRoom);
  return a === b || a.includes(b) || b.includes(a);
}

function nameMatches(patient: DemoPatient, hint: string): boolean {
  const h = hint.trim().toLowerCase();
  if (!h) return false;
  const full = patient.name.toLowerCase();
  const preferred = (patient.preferredName ?? "").toLowerCase();
  const parts = full.split(/\s+/);
  if (full.includes(h) || h.includes(full)) return true;
  if (preferred && (preferred === h || h.includes(preferred))) return true;
  if (parts.some((p) => p === h || h.includes(p))) return true;
  return false;
}

export function findPatientsByHint(
  roster: DemoPatient[],
  hint: {
    patientId?: string | null;
    patientName?: string | null;
    transcript?: string;
  }
): DemoPatient[] {
  const found = new Map<string, DemoPatient>();

  const patientId = hint.patientId?.trim();
  if (patientId) {
    const p = roster.find((x) => x.id === patientId);
    if (p) found.set(p.id, p);
  }

  const transcript = hint.transcript ?? "";
  const mrnMatch = transcript.match(/\bMRN[-\s]?(\d+)\b/i);
  if (mrnMatch) {
    const token = normalizeMrn(`MRN-${mrnMatch[1]}`);
    for (const p of roster) {
      if (normalizeMrn(p.mrn) === token) found.set(p.id, p);
    }
  }

  const roomMatch = transcript.match(
    /(?:room|bed|in)\s+([\w-]+(?:\s*[\w-]+)?)/i
  );
  if (roomMatch?.[1]) {
    for (const p of roster) {
      if (roomsMatch(p.room, roomMatch[1])) found.set(p.id, p);
    }
  }

  const nameHint = hint.patientName?.trim();
  if (nameHint) {
    for (const p of roster) {
      if (nameMatches(p, nameHint)) found.set(p.id, p);
    }
  }

  if (!found.size && transcript) {
    const tokens = transcript.toLowerCase().match(/\b[a-z][a-z'-]{2,}\b/g) ?? [];
    const skip = new Set([
      "give",
      "order",
      "prescribe",
      "patient",
      "chart",
      "open",
      "show",
      "the",
      "for",
      "with",
      "can",
      "you",
      "please",
      "start",
      "put",
      "pain",
      "meds",
      "medication",
      "medications",
    ]);
    for (const token of tokens) {
      if (skip.has(token)) continue;
      const matches = roster.filter((p) => {
        const first = p.name.toLowerCase().split(" ")[0] ?? "";
        const preferred = (p.preferredName ?? "").toLowerCase();
        return first === token || preferred === token;
      });
      for (const p of matches) found.set(p.id, p);
    }
  }

  return Array.from(found.values());
}

export function resolvePatient(
  roster: DemoPatient[],
  hint: {
    patientId?: string | null;
    patientName?: string | null;
    transcript?: string;
    activePatientId?: string | null;
  }
): PatientResolveResult {
  const matches = findPatientsByHint(roster, hint);

  if (matches.length === 1) {
    return { status: "matched", patient: matches[0] };
  }
  if (matches.length > 1) {
    const names = matches.map((p) => `${p.name} (${p.mrn}, ${p.room})`).join("; ");
    return {
      status: "ambiguous",
      patients: matches,
      message: `Multiple patients match. Which one did you mean: ${names}?`,
    };
  }

  if (hint.activePatientId) {
    const active = roster.find((p) => p.id === hint.activePatientId);
    if (active) return { status: "matched", patient: active };
  }

  return {
    status: "not_found",
    message: "I could not find a matching patient on the roster.",
  };
}

export const SECTION_ALIASES: Record<string, string> = {
  overview: "overview",
  demographics: "demographics",
  meds: "medications",
  medication: "medications",
  medications: "medications",
  allergies: "allergies",
  allergy: "allergies",
  vitals: "vitals",
  vital: "vitals",
  labs: "labs",
  lab: "labs",
  problems: "diagnoses",
  diagnoses: "diagnoses",
  diagnosis: "diagnoses",
  notes: "notes",
  note: "notes",
  plan: "plan",
  imaging: "imaging",
  history: "history",
  social: "social",
  chart: "overview",
};

export function mapRequestedSections(sections: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sections) {
    const key = SECTION_ALIASES[s.toLowerCase()] ?? s.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  if (!out.length) return ["overview", "medications", "allergies", "diagnoses"];
  return out;
}
