/**
 * Strict patient identification for voice modification commands.
 * Never uses partial/first-name matching when a full name is supplied.
 */

import type { DemoPatient } from "@/lib/demo-patients";

export type PatientMatchResult =
  | { status: "matched"; patient: DemoPatient }
  | { status: "ambiguous"; patients: DemoPatient[]; message: string }
  | { status: "not_found"; message?: string };

export function normalizePatientName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Strip voice filler / punctuation that break exact roster matching. */
function sanitizeExtractedPatientName(raw: string): string {
  let name = raw.trim();
  if (!name) return name;
  name = name.replace(/^(?:the\s+)?(?:patient\s+)?/i, "").trim();
  name = name.replace(
    /\s+from\s+(?:the\s+)?(?:board|roster|list|chart|ed)\b.*$/i,
    ""
  );
  name = name.replace(
    /\s+(?:please|now|thanks|thank you)(?:\s+.*)?$/i,
    ""
  );
  name = name.replace(/[.?!,:;]+$/g, "").trim();
  return name;
}

function normalizeMrnToken(raw: string): string {
  const t = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (/^\d+$/.test(t)) return `MRN-${t}`;
  return t.replace(/^MRN-?/i, "MRN-");
}

function extractMrnFromText(text: string): string | null {
  const mrnToken =
    text.match(/\bmrn[-\s]?(\d{3,})\b/i)?.[1] ??
    text.match(/\b(MRN[-\s]?\d{3,})\b/i)?.[1];
  if (mrnToken) return normalizeMrnToken(mrnToken);
  const longNum = text.match(/\b(\d{6,})\b/)?.[1];
  return longNum ? normalizeMrnToken(longNum) : null;
}

const MODIFICATION_NAME_PATTERNS: RegExp[] = [
  /discharge\s+(?:patient\s+)?(.+?)$/i,
  /(?:move|transfer|assign)\s+(?:patient\s+)?(.+?)\s+(?:to|into)\s+(?:room\s+)?/i,
  /(?:add|start|prescribe|give)\s+patient\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]+)*?)\s+(?:with|to|for)\b/i,
  /(?:add|start|prescribe|give)\s+.+?\s+(?:to|for)\s+(.+?)$/i,
  /(?:summarize|summary\s+(?:for|of))\s+(?:patient\s+)?(.+?)$/i,
  /mark\s+(?:patient\s+)?([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)+)\s+(?:stable|improving|worsening|critical|discharged)/i,
];

/** Extract an explicit patient name from a modification utterance. */
export function extractModificationPatientName(
  transcript: string,
  patientHint?: string | null
): string | null {
  const hinted = patientHint?.trim();
  if (hinted) {
    const cleanedHint = sanitizeExtractedPatientName(hinted);
    return cleanedHint || null;
  }

  const cleaned = transcript.trim();
  for (const rx of MODIFICATION_NAME_PATTERNS) {
    const m = cleaned.match(rx);
    const name = m?.[1] ? sanitizeExtractedPatientName(m[1]) : "";
    if (name && !/^(?:patient|the|a|an)$/i.test(name)) {
      return (
        sanitizeExtractedPatientName(
          name.replace(/\s+(?:to|for|in)\s+room.*$/i, "")
        ) || null
      );
    }
  }

  const fullName = cleaned.match(
    /\b([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+)+)\b/
  );
  return fullName?.[1]
    ? sanitizeExtractedPatientName(fullName[1]) || null
    : null;
}

function exactNameMatches(patients: DemoPatient[], requestedName: string): DemoPatient[] {
  const target = normalizePatientName(sanitizeExtractedPatientName(requestedName));
  if (!target) return [];
  return patients.filter((p) => {
    const names = [p.name, p.preferredName ?? ""]
      .map(normalizePatientName)
      .filter(Boolean);
    return names.some(
      (name) => name === target || target.startsWith(`${name} `)
    );
  });
}

function firstNameMatches(patients: DemoPatient[], requestedName: string): DemoPatient[] {
  const parts = normalizePatientName(sanitizeExtractedPatientName(requestedName))
    .split(" ")
    .filter(Boolean);
  if (parts.length !== 1) return [];
  const first = parts[0];
  return patients.filter((p) => {
    const nameParts = normalizePatientName(p.name).split(" ").filter(Boolean);
    const preferred = p.preferredName ? normalizePatientName(p.preferredName) : "";
    return nameParts[0] === first || preferred === first;
  });
}

function matchByMrn(patients: DemoPatient[], mrn: string): DemoPatient[] {
  const target = normalizeMrnToken(mrn);
  return patients.filter((p) => normalizeMrnToken(p.mrn) === target);
}

function matchById(patients: DemoPatient[], patientId: string): DemoPatient[] {
  const id = patientId.trim();
  if (!id) return [];
  const p = patients.find((x) => x.id === id);
  return p ? [p] : [];
}

export function formatAmbiguousPatientPrompt(patients: DemoPatient[]): string {
  const sharedFirst =
    patients[0]?.name.split(/\s+/)[0] ?? "that name";
  const lines = patients.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  return `I found multiple patients with the name ${sharedFirst}.\n\n${lines}\n\nWhich patient would you like to update?`;
}

export const MULTIPLE_PATIENTS_MESSAGE =
  "I found multiple patients with similar names. Which patient would you like to update?";

export type ResolvePatientOptions = {
  patientHint?: string | null;
  patientId?: string | null;
  mrn?: string | null;
  transcript?: string;
  /** Only used when no name/MRN/ID is present in the command */
  activePatientId?: string | null;
};

/**
 * Resolve exactly one patient for modification commands.
 * Priority: exact full name → exact MRN → exact patient ID → clarification.
 * Never uses substring, ILIKE, or first-name-only matching when a full name is given.
 */
export function resolvePatientForModification(
  patients: DemoPatient[],
  options: ResolvePatientOptions
): PatientMatchResult {
  const transcript = options.transcript ?? "";
  const requestedName = extractModificationPatientName(
    transcript,
    options.patientHint
  );
  const hasExplicitName = Boolean(requestedName?.trim());

  if (options.patientId?.trim()) {
    const byId = matchById(patients, options.patientId);
    if (byId.length === 1) return { status: "matched", patient: byId[0] };
    if (byId.length === 0) {
      return { status: "not_found", message: "Patient not found on the roster." };
    }
  }

  const mrn =
    options.mrn?.trim() || extractMrnFromText(transcript) || null;
  if (mrn) {
    const byMrn = matchByMrn(patients, mrn);
    if (byMrn.length === 1) return { status: "matched", patient: byMrn[0] };
    if (byMrn.length > 1) {
      return {
        status: "ambiguous",
        patients: byMrn,
        message: formatAmbiguousPatientPrompt(byMrn),
      };
    }
    if (hasExplicitName) {
      return { status: "not_found", message: "No patient with that MRN was found." };
    }
  }

  if (requestedName) {
    const wordCount = normalizePatientName(requestedName).split(" ").filter(Boolean)
      .length;

    if (wordCount >= 2) {
      const exact = exactNameMatches(patients, requestedName);
      if (exact.length === 1) return { status: "matched", patient: exact[0] };
      if (exact.length > 1) {
        return {
          status: "ambiguous",
          patients: exact,
          message: formatAmbiguousPatientPrompt(exact),
        };
      }
      return {
        status: "not_found",
        message: `No patient named "${requestedName.trim()}" was found on the roster.`,
      };
    }

    const byFirst = firstNameMatches(patients, requestedName);
    if (byFirst.length === 1) return { status: "matched", patient: byFirst[0] };
    if (byFirst.length > 1) {
      return {
        status: "ambiguous",
        patients: byFirst,
        message: formatAmbiguousPatientPrompt(byFirst),
      };
    }
    return {
      status: "not_found",
      message: `No patient named "${requestedName.trim()}" was found on the roster.`,
    };
  }

  if (options.activePatientId) {
    const active = patients.find((p) => p.id === options.activePatientId);
    if (active) return { status: "matched", patient: active };
  }

  return {
    status: "not_found",
    message: "Please specify which patient you would like to update.",
  };
}

/** @deprecated Use resolvePatientForModification for chart updates. */
export function resolvePatientFromVoice(
  transcript: string,
  patients: DemoPatient[],
  options?: { patientHint?: string; activePatientId?: string | null }
): PatientMatchResult {
  return resolvePatientForModification(patients, {
    transcript,
    patientHint: options?.patientHint,
    activePatientId: options?.activePatientId,
  });
}
