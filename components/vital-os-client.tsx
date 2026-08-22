"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookText,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Eraser,
  FileBarChart2,
  FileText,
  Home,
  Keyboard,
  Loader2,
  LogOut,
  MessageCircle,
  Mic,
  MicOff,
  NotebookTabs,
  PanelRight,
  Pause,
  Phone,
  Settings,
  ShieldAlert,
  Siren,
  Sparkles,
  Users,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  EditableAllergyTable,
  EditableMedicationTable,
  EditableNoteList,
  EditableProblemTable,
  EditableStringList,
  InlineField,
  InlineSelect,
  joinRiskFlags,
  notesFromPatient,
  splitRiskFlags,
} from "@/components/chart-inline-edit";
import { ThemeAppearanceControl } from "@/components/theme-appearance-control";
import {
  VoiceHeroVisual,
  type VoiceHeroVisualHandle,
} from "@/components/voice-hero-visual";
import { VitalLogo } from "@/components/vital-logo";
import { useAuth } from "@/components/auth-provider";
import { useUtteranceRecorder } from "@/hooks/use-utterance-recorder";
import { chooseTranscript, type TranscriptChoice } from "@/lib/whisper-stt";
import {
  ACCESS_RESTRICTED_MESSAGE,
  AI_ASSISTANT_RESTRICTED_MESSAGE,
  formatDoctorDisplayName,
  type VitalRole,
} from "@/lib/auth";
import type { ConversationTurn } from "@/lib/vital-llm";
import type { ClinicalReasoningResult } from "@/lib/clinical-reasoning";
import type { ClinicalCommandResponse } from "@/app/api/clinical-command/route";
import type { IntentProvider } from "@/lib/clinical-intent";
import type { DemoMedication, DemoPatient } from "@/lib/demo-patients";
import { patientToSnapshot } from "@/lib/demo-patients";
import {
  hasRequiredAdmissionFields,
  isExplicitAllergyAnswer,
  isExplicitEmergencyContactAnswer,
  mergeParsedIntoPatientData,
  parseAdmissionCommand,
} from "@/lib/admission-parser";
import {
  extractModificationPatientName,
  formatAmbiguousPatientPrompt,
  resolvePatientForModification,
} from "@/lib/patient-identification";
import {
  applyParsedCommandToPatient,
  parseDischargeReason,
  type UndoSnapshot,
} from "@/lib/patient-voice-handler";
import {
  parsePatientCommand,
  PERMISSION_DENIED_MESSAGE,
  type PatientCommandIntent,
} from "@/lib/patient-command-parser";

/* ──────────────────────────────────────────────────────────────────────────
 * Types
 * ────────────────────────────────────────────────────────────────────────── */

type VitalMode = "general" | "soap" | "summary" | "emergency";
type SystemState = "idle" | "listening" | "processing" | "speaking" | "error";

interface AuditEntry {
  id: string;
  at: number;
  mode: VitalMode;
  command: string;
  response: string;
  model?: string;
  latencyMs?: number;
  kind: "exchange" | "system";
}

interface VitalApiResponse {
  text: string;
  mode: VitalMode;
  model: string;
  latencyMs: number;
  rosterChanged?: boolean;
}

interface VitalApiError {
  error: string;
  code?: string;
}

/* Minimal SpeechRecognition typing — browser API isn't in standard DOM lib. */
interface SRAlt {
  transcript: string;
  confidence: number;
}
interface SRResult {
  0: SRAlt;
  isFinal: boolean;
  length: number;
}
interface SREvent {
  results: ArrayLike<SRResult> & { [k: number]: SRResult };
  resultIndex: number;
}
interface SRErrorEvent {
  error: string;
  message?: string;
}
interface SR {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SREvent) => void) | null;
  onerror: ((ev: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}
type SRCtor = new () => SR;

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

const MODE_LABEL: Record<VitalMode, string> = {
  general: "General",
  soap: "SOAP Note",
  summary: "Patient Summary",
  emergency: "Emergency",
};

/** During TTS, only treat finalized recognition as a real interrupt (avoids speaker echo / noise). */
const MIN_FINAL_CHARS_TO_BARGE_TTS = 4;
const MIN_INTERIM_CHARS_TO_BARGE_TTS = 8;

const MODE_BADGE: Record<VitalMode, "clinical" | "cyan" | "warn" | "danger"> = {
  general: "clinical",
  soap: "cyan",
  summary: "cyan",
  emergency: "danger",
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function readRecognitionTranscripts(ev: SREvent): {
  interim: string;
  finalDelta: string;
} {
  let interim = "";
  let finalDelta = "";
  for (let i = 0; i < ev.results.length; i++) {
    const result = ev.results[i];
    if (!result) continue;
    const transcript = result[0]?.transcript ?? "";
    if (result.isFinal) {
      if (i >= ev.resultIndex) {
        finalDelta += transcript;
      }
    } else {
      interim += transcript;
    }
  }
  return { interim, finalDelta };
}

type EncounterStatus =
  | "In triage"
  | "Labs pending"
  | "Imaging ordered"
  | "Awaiting physician"
  | "Observation"
  | "Discharge planning"
  | "Consult requested";

type EncounterFilter =
  | "all"
  | "high_acuity"
  | "pediatrics"
  | "allergies"
  | "imaging_pending"
  | "labs_pending";

function asUnitLabel(room: string): string {
  if (/^peds/i.test(room)) return "Pediatrics";
  if (/^trauma/i.test(room)) return "Trauma";
  if (/^observation/i.test(room)) return "Observation";
  if (/^isolation/i.test(room)) return "Isolation";
  return "Emergency";
}

function isPediatric(patient: DemoPatient): boolean {
  return patient.age < 18 || /^peds/i.test(patient.room);
}

function hasPendingLabs(patient: DemoPatient): boolean {
  return /pending|awaiting/i.test(patient.recentLabs ?? "");
}

function hasImagingOrdered(patient: DemoPatient): boolean {
  return /ordered|pending/i.test(patient.imagingStudies ?? "");
}

function hasConsultRequested(patient: DemoPatient): boolean {
  return /consult|requested|review/i.test(patient.consultants ?? "");
}

function getHighAcuityPatients(patients: DemoPatient[]): DemoPatient[] {
  return patients.filter((p) => /ctas\s*[12]/i.test(p.triageAcuity));
}

function getPatientsWithAllergies(patients: DemoPatient[]): DemoPatient[] {
  return patients.filter(
    (p) => p.allergies.length > 0 && !/no known|none/i.test(p.allergies.join(" "))
  );
}

function getPendingLabs(patients: DemoPatient[]): DemoPatient[] {
  return patients.filter(hasPendingLabs);
}

function getImagingOrdered(patients: DemoPatient[]): DemoPatient[] {
  return patients.filter(hasImagingOrdered);
}

function getConsultRequested(patients: DemoPatient[]): DemoPatient[] {
  return patients.filter(hasConsultRequested);
}

function getAcuityDistribution(
  patients: DemoPatient[]
): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const p of patients) {
    const key = (p.triageAcuity.match(/CTAS\s*\d/i)?.[0] ?? p.triageAcuity).toUpperCase();
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));
}

function getAgeDistribution(
  patients: DemoPatient[]
): Array<{ label: string; value: number }> {
  const buckets = [
    { label: "0-17", min: 0, max: 17 },
    { label: "18-39", min: 18, max: 39 },
    { label: "40-64", min: 40, max: 64 },
    { label: "65+", min: 65, max: Number.POSITIVE_INFINITY },
  ];
  return buckets.map((b) => ({
    label: b.label,
    value: patients.filter((p) => p.age >= b.min && p.age <= b.max).length,
  }));
}

function getUnitDistribution(
  patients: DemoPatient[]
): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const p of patients) {
    const unit = asUnitLabel(p.room);
    map.set(unit, (map.get(unit) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([label, value]) => ({ label, value }));
}

function getTopConcernCategories(
  patients: DemoPatient[],
  limit = 5
): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const p of patients) {
    const label = p.chiefConcern.split(" and ")[0].trim();
    map.set(label, (map.get(label) ?? 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function getRiskCategoryDistribution(
  patients: DemoPatient[],
  limit = 6
): Array<{ label: string; value: number }> {
  const map = new Map<string, number>();
  for (const p of patients) {
    const chunks = (p.riskFlags ?? "")
      .split(/[.;]/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const c of chunks) {
      map.set(c, (map.get(c) ?? 0) + 1);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({ label, value }));
}

function deriveEncounterStatus(patient: DemoPatient): EncounterStatus {
  if (hasConsultRequested(patient)) return "Consult requested";
  if (hasPendingLabs(patient)) return "Labs pending";
  if (hasImagingOrdered(patient)) return "Imaging ordered";
  if (/observe|watch/i.test(patient.edOrUrgentCourse ?? "")) return "Observation";
  if (/improv|discharge/i.test(patient.edOrUrgentCourse ?? "")) return "Discharge planning";
  if (/ctas\s*[12]/i.test(patient.triageAcuity)) return "Awaiting physician";
  return "In triage";
}

function statusBadgeVariant(
  status: EncounterStatus
): "allergies" | "medications" | "problems" | "notes" | "risk" {
  if (status === "Consult requested") return "risk";
  if (status === "Labs pending") return "problems";
  if (status === "Imaging ordered") return "medications";
  if (status === "Awaiting physician") return "allergies";
  return "notes";
}

function acuityBadgeVariant(
  acuity: string
): "ctas1" | "ctas2" | "ctas3" | "ctas4" | "ctas5" | "default" {
  if (/ctas\s*1/i.test(acuity)) return "ctas1";
  if (/ctas\s*2/i.test(acuity)) return "ctas2";
  if (/ctas\s*3/i.test(acuity)) return "ctas3";
  if (/ctas\s*4/i.test(acuity)) return "ctas4";
  if (/ctas\s*5/i.test(acuity)) return "ctas5";
  return "default";
}

function normalizeProblemKey(problem: string): string {
  return problem.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function problemsToEditable(
  patientId: string,
  problems: DemoPatient["problems"],
  diagnoses: string[]
): EditableProblem[] {
  if (problems?.length) {
    return problems.map((problem) => ({
      id: `${patientId}-${normalizeProblemKey(problem.name)}`,
      name: problem.name,
      status: problem.status as ProblemStatus,
      since: problem.since || "Chart",
    }));
  }
  return diagnoses.map((name) => ({
    id: `${patientId}-${normalizeProblemKey(name)}`,
    name,
    status: "Active" as const,
    since: "Chart",
  }));
}

async function persistPatientProblems(
  patientId: string,
  problems: EditableProblem[]
): Promise<boolean> {
  const payload = problems.map(({ name, status, since }) => ({
    name,
    status,
    since,
  }));
  const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ problems: payload }),
  });
  return res.ok;
}

async function persistPatientPatch(
  patientId: string,
  patch: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; patient?: DemoPatient }> {
  const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => ({}))) as {
    patient?: DemoPatient;
    error?: string;
  };
  if (res.ok) {
    return { ok: true, patient: body.patient };
  }
  if (process.env.NODE_ENV === "development") {
    console.warn("Patient patch failed:", body.error ?? res.status);
  }
  return {
    ok: false,
    error: body.error?.trim() || `Unable to save (HTTP ${res.status})`,
  };
}

function requiresDoctorRole(intent: PatientCommandIntent): boolean {
  return intent !== "unknown" && intent !== "patientSummary";
}

function detectOrderMedication(command: string): string | null {
  const q = command.trim();
  const patterns = [
    /(?:prescribe|give|order|send)\s+(.+?)\s+(?:to|for)\s+/i,
    /(?:prescribe|give|order|send)\s+(.+)$/i,
  ];
  for (const rx of patterns) {
    const match = q.match(rx);
    if (!match?.[1]) continue;
    const med = match[1]
      .replace(/\b(patient|chart|please|now)\b/gi, "")
      .trim();
    if (med && !/^(medication|medicine|meds?)$/i.test(med)) return med;
  }
  return null;
}

function normalizeMedicationToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getKnownMedicationNames(patients: DemoPatient[]): string[] {
  const set = new Set<string>();
  for (const p of patients) {
    for (const m of p.medications) {
      const normalized = normalizeMedicationToken(m.name);
      if (normalized) set.add(normalized);
      const firstWord = normalized.split(" ")[0];
      if (firstWord) set.add(firstWord);
    }
  }
  // Common emergency/ED meds we still want recognized if not in demo roster meds.
  for (const fallback of ["aspirin", "epinephrine", "salbutamol"]) {
    set.add(fallback);
  }
  return Array.from(set);
}

function extractMedicationOrderIntent(
  command: string,
  patients: DemoPatient[]
): { medication: string; uncertain: boolean } | null {
  const q = command.trim().toLowerCase();
  if (!q) return null;

  if (
    /^(give me|get me|show me|display|pull up|bring up|open)\b/.test(q) ||
    /\bgive me\b/.test(q)
  ) {
    return null;
  }

  const knownMeds = getKnownMedicationNames(patients);
  const medication = detectOrderMedication(command);
  const hasOrderVerb =
    /\b(prescribe|administer|queue medication|medication order|order medication|send medication|pharmacy|give)\b/.test(
      q
    );
  if (!hasOrderVerb || !medication) return null;

  const normalizedMed = normalizeMedicationToken(medication);
  if (!normalizedMed) return null;
  const looksLikeRouteDose =
    /\b(\d+(\.\d+)?\s?(mg|mcg|g|ml|units?)|po|iv|im|neb|prn|bid|tid|qid|tablet|capsule|inhaler)\b/.test(
      normalizedMed
    );
  const inKnownList = knownMeds.some(
    (m) => normalizedMed.includes(m) || m.includes(normalizedMed)
  );

  // For "give X to Y", require stronger proof that X is actually a medication.
  if (/\bgive\b/.test(q) && !inKnownList && !looksLikeRouteDose) {
    return { medication, uncertain: true };
  }
  if (!inKnownList && !looksLikeRouteDose) {
    return { medication, uncertain: true };
  }
  return { medication, uncertain: false };
}

function detectStatusValue(command: string): ProblemStatus | null {
  const q = command.toLowerCase();
  if (
    /\b(ruled\s*out|rule\s*out|not the issue|not the problem|eliminated|excluded|negative for|clear of)\b/.test(
      q
    )
  ) {
    return "Ruled out";
  }
  if (
    /\b(resolve|resolved|fixed|cleared|treated|better|no longer active|done|finished|handled|taken care of|all good|healed|cured|closed|close out|clear)\b/.test(
      q
    )
  ) {
    return "Resolved";
  }
  if (
    /\b(monitor|monitoring|watch|watching|keep an eye on|observe|observing|under observation|stable but watching)\b/.test(
      q
    )
  ) {
    return "Monitoring";
  }
  if (
    /\b(pending|uncertain|unsure|unclear|needs workup|waiting on results|inconclusive|undetermined)\b/.test(
      q
    )
  ) {
    return "Pending";
  }
  if (
    /\b(active|reactivate|mark active|still ongoing|flaring|worsening|active again|open)\b/.test(
      q
    )
  ) {
    return "Active";
  }
  return null;
}

function matchesStatusIntent(command: string): boolean {
  const q = command.toLowerCase();
  return (
    /\b(deactivate|reactivate|close out|clear|mark as|set to|change to|flag as|update status|make|mark|change status|resolve|resolved|monitoring|ruled out|pending|active)\b/.test(
      q
    ) &&
    /\b(diagnos|problem|status|hypertension|condition|fixed|diabetes|issues?)\b/.test(q)
  );
}

function findProblemsInCommand(
  command: string,
  problems: EditableProblem[]
): EditableProblem[] {
  const normalized = normalizeProblemKey(command);
  const matched = problems.filter((problem) =>
    normalized.includes(normalizeProblemKey(problem.name))
  );
  if (matched.length > 0) return matched;
  const segments = command
    .split(/\band\b|,|;/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const fromSegments = new Map<string, EditableProblem>();
  for (const segment of segments) {
    const segmentKey = normalizeProblemKey(segment);
    for (const problem of problems) {
      const problemKey = normalizeProblemKey(problem.name);
      if (segmentKey.includes(problemKey) || problemKey.includes(segmentKey)) {
        fromSegments.set(problem.id, problem);
      }
    }
  }
  return Array.from(fromSegments.values());
}

function findAllPatientMatches(
  transcript: string,
  patients: DemoPatient[]
): DemoPatient[] {
  const found = new Map<string, DemoPatient>();
  const segments = transcript
    .split(/\s+and\s+|,\s*|\s*;\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const queries = segments.length > 1 ? segments : [transcript];
  for (const query of queries) {
    for (const patient of findPatientMatches(query, patients)) {
      found.set(patient.id, patient);
    }
  }
  return Array.from(found.values());
}

function findFocusedPatientFromCommand(
  command: string,
  patients: DemoPatient[]
): DemoPatient | null {
  const backMatch = command.match(
    /(?:go back to|return to|back to|switch to)\s+(.+)$/i
  );
  if (backMatch?.[1]) {
    return findPatientMatches(backMatch[1], patients)[0] ?? null;
  }
  const matches = findAllPatientMatches(command, patients);
  if (matches.length === 1) return matches[0];
  return findPatientMatches(command, patients)[0] ?? null;
}

const ORDER_WORKFLOW_STEPS: Array<{ status: MedicationWorkflowStatus; delayMs: number }> = [
  { status: "Order Queued", delayMs: 1000 },
  { status: "Pharmacy Preparing", delayMs: 2000 },
  { status: "Ready for Pickup", delayMs: 2000 },
  { status: "Nurse Assigned", delayMs: 2000 },
  { status: "In Transit", delayMs: 2000 },
  { status: "Delivered", delayMs: 0 },
];

const MOCK_NURSES = [
  "Nurse Emily Carter",
  "Nurse David Kim",
  "Nurse Sophia Patel",
  "Nurse Liam Hughes",
];

const MOCK_PHARMACY = ["Pharmacy Station B", "Central Pharmacy", "Satellite Pharmacy A"];

function pickBySeed<T>(items: T[], seed: string): T {
  const hash = seed.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return items[Math.abs(hash) % items.length];
}

type PatientFieldKey =
  | "overview"
  | "demographics"
  | "chief_concern"
  | "emergency_contact"
  | "care_team"
  | "risk_flags"
  | "notes"
  | "medications"
  | "allergies"
  | "vitals"
  | "labs"
  | "diagnoses"
  | "imaging"
  | "social"
  | "history"
  | "plan";

type RequestedPatientView = {
  patientId: string;
  title: string;
  fields: PatientFieldKey[];
  patient: DemoPatient;
  lines: string[];
};

type PendingMedicationDraft = {
  patientId: string;
  patientName: string;
  medication: string;
  dose: string | null;
  route: string | null;
  frequency: string | null;
};

const VALID_CHART_SECTIONS = new Set<PatientFieldKey>([
  "overview",
  "demographics",
  "chief_concern",
  "emergency_contact",
  "care_team",
  "risk_flags",
  "notes",
  "medications",
  "allergies",
  "vitals",
  "labs",
  "diagnoses",
  "imaging",
  "social",
  "history",
  "plan",
]);

function isAffirmativeCommand(text: string): boolean {
  return /^(yes|yeah|yep|yup|confirm|confirmed|place it|go ahead|do it|proceed|ok|okay|sure)\b/i.test(
    text.trim()
  );
}

function isNegativeCommand(text: string): boolean {
  return /^(no|nope|cancel|stop|never mind|nevermind|don't|dont)\b/i.test(
    text.trim()
  );
}

function apiSectionsToFields(sections: string[]): PatientFieldKey[] {
  const out: PatientFieldKey[] = [];
  for (const s of sections) {
    const key = s.trim().toLowerCase() as PatientFieldKey;
    if (VALID_CHART_SECTIONS.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out.length
    ? out
    : (["overview", "medications", "allergies", "diagnoses"] as PatientFieldKey[]);
}

type ProblemStatus = "Active" | "Resolved" | "Monitoring" | "Pending" | "Ruled out";

const PROBLEM_STATUS_OPTIONS: ProblemStatus[] = [
  "Active",
  "Resolved",
  "Monitoring",
  "Pending",
  "Ruled out",
];

function problemStatusBadgeVariant(status: ProblemStatus) {
  if (status === "Resolved") return "notes" as const;
  if (status === "Monitoring") return "problems" as const;
  if (status === "Pending") return "allergies" as const;
  if (status === "Ruled out") return "outline" as const;
  return "medications" as const;
}

function patientHasClinicalRisk(patient: Pick<DemoPatient, "riskFlags">): boolean {
  return Boolean(patient.riskFlags?.trim());
}

function patientHasAllergyIndicators(patient: Pick<DemoPatient, "allergies">): boolean {
  return patient.allergies.length > 0;
}

function PatientClinicalIndicator({
  patient,
}: {
  patient: Pick<DemoPatient, "riskFlags" | "allergies">;
}) {
  if (patientHasClinicalRisk(patient)) {
    return <span className="ml-1 text-xs text-rose-600">●</span>;
  }
  if (patientHasAllergyIndicators(patient)) {
    return <span className="ml-1 text-xs text-amber-400">●</span>;
  }
  return null;
}

type AdmissionStep =
  | "name"
  | "confirmName"
  | "spellNameCorrection"
  | "ageSex"
  | "chiefConcern"
  | "room"
  | "medications"
  | "confirmation"
  | "done";

type AdmissionDraft = {
  active: boolean;
  data: Partial<DemoPatient>;
  currentStep: AdmissionStep;
  lastQuestionAsked?: string;
  missingFields: string[];
  nameConfirmed: boolean;
  medicationsCaptured: boolean;
  nameSpellParseError?: boolean;
  awaitingCorrectionField?: boolean;
};

const EMPTY_ADMISSION: AdmissionDraft = {
  active: false,
  data: {},
  currentStep: "name",
  nameConfirmed: false,
  medicationsCaptured: false,
  missingFields: [],
  lastQuestionAsked: "",
};

type EditableProblem = {
  id: string;
  name: string;
  status: ProblemStatus;
  since: string;
};

type MedicationWorkflowStatus =
  | "Order Queued"
  | "Pharmacy Preparing"
  | "Ready for Pickup"
  | "Nurse Assigned"
  | "In Transit"
  | "Delivered";

type PendingOrder = {
  id: string;
  patientId: string;
  patientName: string;
  room: string;
  medication: string;
  status: MedicationWorkflowStatus;
  nurseName: string;
  pharmacyStation: string;
  stepIndex: number;
  completedAt?: number;
  createdAt: number;
};

type VoiceCommandAction =
  | { kind: "none" }
  | { kind: "clear_session" }
  | { kind: "patient_ambiguous"; matches: DemoPatient[] }
  | { kind: "patient_not_found"; query: string }
  | { kind: "close_chart" }
  | { kind: "room_occupancy"; room: string; patients: DemoPatient[] }
  | { kind: "switch_patient"; patientId: string; sections: PatientFieldKey[] }
  | { kind: "open_sections"; patientId: string; sections: PatientFieldKey[] };

type ActivePage =
  | "dashboard"
  | "patients"
  | "encounters"
  | "reports"
  | "analytics"
  | "settings";

function normalizeRoomLabel(room: string): string {
  return room
    .trim()
    .toLowerCase()
    .replace(/^room\s+/, "")
    .replace(/\s+/g, " ");
}

function roomsMatch(patientRoom: string, queryRoom: string): boolean {
  const a = normalizeRoomLabel(patientRoom);
  const b = normalizeRoomLabel(queryRoom);
  return a === b || a.includes(b) || b.includes(a);
}

function extractRoomQuery(transcript: string): string | null {
  const q = transcript.trim();
  const patterns = [
    /(?:who(?:'s| is)|who's|who is|anyone|patients?)\s+(?:in|at)\s+(.+?)(?:\?|$)/i,
    /(?:in|at)\s+((?:peds|pediatrics|room|trauma|isolation|observation)\s*[\w-]+)/i,
    /(?:room|unit|bed)\s+([\w-]+(?:\s*[\w-]+)?)/i,
  ];
  for (const rx of patterns) {
    const match = q.match(rx);
    const room = match?.[1]?.trim();
    if (room) return room;
  }
  return null;
}

function findPatientsByRoom(
  patients: DemoPatient[],
  roomQuery: string
): DemoPatient[] {
  return patients.filter((p) => roomsMatch(p.room, roomQuery));
}

function normalizeMrnToken(raw: string): string {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (/^MRN-?\d+$/i.test(compact)) {
    return compact.replace(/^MRN-?/i, "MRN-");
  }
  return compact;
}

function extractPatientNameHint(transcript: string): string | null {
  const q = transcript.trim();
  const patterns = [
    /\b([a-z][a-z'-]+)'s\s+(?:chart|record|file|meds?|medications?|vitals?|allergies|labs?|notes?|encounter|symptoms?|problems?|conditions?)/i,
    /(?:what(?:'s| is| are)|how is)\s+([a-z][a-z'-]+)\s+(?:on|for|taking|having|suffering from)/i,
    /(?:pull up|open|show|display|bring up|view|get|find)\s+([a-z][a-z'-]+)(?:'s)?(?:\s+(?:chart|record|file))?/i,
    /(?:for|about|on)\s+([a-z][a-z'-]+)(?:'s)?(?:\s+(?:chart|record|meds?|medications?|symptoms?|problems?))?$/i,
    /\bpatient\s+([a-z][a-z'-]+)\b/i,
    /what(?:'s| is) wrong with\s+([a-z][a-z'-]+)/i,
    /what does\s+([a-z][a-z'-]+)\s+have/i,
  ];
  for (const rx of patterns) {
    const match = q.match(rx);
    const name = match?.[1]?.trim();
    if (name && !/^(the|a|an|patient|chart|record|mrn)$/i.test(name)) {
      return name;
    }
  }
  return null;
}

function hasClinicalDataIntent(q: string): boolean {
  if (
    /pull up|show|open|find|view|bring up|display|review|what(?:'s| is| are)|whats|tell me|get|give me|i need|i want|how old|list|read|look up|load|check|who(?:'s| is)|anyone|patients? in|in peds|in room|show me|what(?:'s| is) wrong|suffering from|allergic to|blood work|test results|vital signs|clinical notes|what(?:'s| is) documented/.test(
      q
    )
  ) {
    return true;
  }
  return /chart|file|record|allerg|med|drug|prescription|problem|condition|symptom|note|vital|lab|emergency|care team|risk|patient|age|dob|blood|room|chief concern|mrn|triage|acuity|demographic|contact|consultant|encounter|visit|course|board|census|roster|treatment|numbers|stats|oxygen|reaction|everything|all info/.test(
    q
  );
}

const FIELD_INTENT_GROUPS: Array<{
  key: PatientFieldKey;
  patterns: RegExp[];
}> = [
  {
    key: "diagnoses",
    patterns: [
      /\bproblems?\b/,
      /\bdiagnos/i,
      /\bconditions?\b/,
      /\bsymptoms?\b/,
      /what(?:'s| is) wrong/,
      /what does .+ have/,
      /what is .+ suffering from/,
      /medical issues/,
      /what(?:'s| are) .+ having/,
    ],
  },
  {
    key: "medications",
    patterns: [
      /\bmeds?\b/,
      /\bmedications?\b/,
      /\bdrugs?\b/,
      /\bprescriptions?\b/,
      /what is .+ taking/,
      /what(?:'s| is) .+ on\b/,
      /\btreatment\b/,
    ],
  },
  {
    key: "vitals",
    patterns: [
      /\bvitals?\b/,
      /vital signs/,
      /\bnumbers\b/,
      /\bstats\b/,
      /how is .+ doing/,
      /blood pressure/,
      /heart rate/,
      /temperature/,
      /\boxygen\b/,
      /\bspo2\b/,
      /\bpulse\b/,
    ],
  },
  {
    key: "allergies",
    patterns: [
      /\ballerg/i,
      /allergic to/,
      /what can(?:'|no)t .+ take/,
      /drug reactions?/,
    ],
  },
  {
    key: "labs",
    patterns: [
      /\blabs?\b/,
      /lab results/,
      /blood work/,
      /test results/,
      /\bresults\b/,
      /\bcbc\b/,
      /\bbmp\b/,
      /\bcreatinine\b/,
      /\bbnp\b/,
    ],
  },
  {
    key: "notes",
    patterns: [
      /chart notes/,
      /clinical notes/,
      /what(?:'s| is) documented/,
      /\bnotes\b/,
    ],
  },
  {
    key: "imaging",
    patterns: [/\bimag/i, /\bxray\b/, /\bct\b/, /\bmri\b/, /\becho\b/, /\bekg\b/],
  },
  {
    key: "social",
    patterns: [/\bsocial\b/, /\bsmok/i, /\balcohol\b/],
  },
  {
    key: "history",
    patterns: [/family history/, /surgical history/, /immunization/],
  },
  {
    key: "plan",
    patterns: [
      /\bplan\b/,
      /next step/,
      /\bconsult/i,
      /follow[- ]?up/,
      /\brisk\b/,
      /\bencounter\b/,
      /\bvisit\b/,
      /ed course/,
      /urgent course/,
      /\bcourse\b/,
    ],
  },
  {
    key: "emergency_contact",
    patterns: [/emergency contact/, /next of kin/, /contact info/],
  },
  {
    key: "care_team",
    patterns: [/care team/, /\bconsultants?\b/],
  },
  {
    key: "risk_flags",
    patterns: [/risk flags?/, /high risk/, /safety risk/],
  },
  {
    key: "chief_concern",
    patterns: [/chief concern/, /presenting complaint/, /chief complaint/],
  },
  {
    key: "demographics",
    patterns: [
      /\bage\b/,
      /how old/,
      /years old/,
      /\bdob\b/,
      /date of birth/,
      /birthday/,
      /\bmrn\b/,
      /medical record/,
      /\broom\b/,
      /blood type/,
      /triag/,
      /\bctas\b/,
      /acuity/,
      /code status/,
      /\bpcp\b/,
      /primary care/,
      /insurance/,
      /address/,
    ],
  },
];

function detectRequestedFields(transcript: string): PatientFieldKey[] {
  const q = transcript.toLowerCase();
  const hasInfoIntent =
    /pull up|show|display|open|review|give me|i need|i want|tell me|what is|what are|what's|whats|chart|file|record|patient|mrn|info|how old|list|read (me|out)|look up|load|check|who(?:'s| is)|on for|taking|what(?:'s| is) wrong|suffering from|allergic to|blood work|test results|vital signs|clinical notes|what(?:'s| is) documented|everything|all info/.test(
      q
    );
  if (!hasInfoIntent) return [];

  const out = new Set<PatientFieldKey>();
  for (const group of FIELD_INTENT_GROUPS) {
    if (group.patterns.some((pattern) => pattern.test(q))) {
      out.add(group.key);
    }
  }

  if (
    /full chart|entire chart|complete chart|open (the )?full|everything|all info|full file|full record|all (of )?(the )?(chart|record|file)/.test(
      q
    )
  ) {
    out.add("overview");
  }

  if (out.size === 0) out.add("overview");
  return Array.from(out);
}

function isPatientDataRequest(command: string): boolean {
  const q = command.trim().toLowerCase();
  if (!q || isResetCommand(q) || /logout/.test(q)) return false;
  if (isAdmitIntent(q) || isDischargeIntent(q)) return true;
  if (
    /how many patients|number of patients|patient count|roster|census|patients (on|in)|total patients/.test(
      q
    )
  ) {
    return true;
  }
  if (extractRoomQuery(command)) return true;
  if (extractPatientNameHint(command)) return true;
  if (/mrn[-\s]?\d+/i.test(command)) return true;
  return hasClinicalDataIntent(q);
}

function isDischargeIntent(q: string): boolean {
  return (
    /\bdischarge\b/.test(q) ||
    /\bsend\b.+\bhome\b/.test(q) ||
    /\bbeing discharged\b/.test(q) ||
    /\bremove\b.+\bfrom (the )?board\b/.test(q)
  );
}

function isAdmitIntent(q: string): boolean {
  return /^(?:admit|add patient|new patient)\b/.test(q) || /\badmit\b/.test(q);
}

function isAdmissionFinalizePhrase(command: string): boolean {
  return /\b(that'?s all(?: i know)?(?: for now)?|that is all(?: i know)?(?: for now)?|that'?s it|nothing else|just admit(?: them)?|stop asking|go ahead and admit)\b/i.test(
    command
  );
}

function admissionFirstName(data: Partial<DemoPatient>): string {
  return data.name?.trim().split(/\s+/)[0] ?? "the patient";
}

function normalizeMedicationSig(sig: string): string {
  return sig
    .replace(/\bonce a day\b/i, "PO daily")
    .replace(/\btwice a day\b/i, "PO BID")
    .replace(/\bthree times a day\b/i, "PO TID");
}

function spellName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z\s]/g, " ").trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.toUpperCase().split("").join("-"))
    .join(" ");
}

function lettersToSpelledWord(letters: string[]): string {
  if (!letters.length) return "";
  const upper = letters[0].toUpperCase();
  const rest = letters.slice(1).join("").toLowerCase();
  return upper + rest;
}

function splitSpelledLettersIntoName(
  letters: string[],
  previousName?: string
): string {
  if (!letters.length) return "";
  if (letters.length === 1) return lettersToSpelledWord(letters);

  const prevParts = previousName
    ?.trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean);
  if (prevParts && prevParts.length >= 2) {
    const firstLen = prevParts[0].length;
    const lastLen = prevParts[prevParts.length - 1].length;
    if (firstLen > 0 && lastLen > 0 && firstLen + lastLen === letters.length) {
      return [
        lettersToSpelledWord(letters.slice(0, firstLen)),
        lettersToSpelledWord(letters.slice(firstLen)),
      ]
        .filter(Boolean)
        .join(" ");
    }
  }

  if (letters.length >= 6) {
    const half = Math.floor(letters.length / 2);
    return [lettersToSpelledWord(letters.slice(0, half)), lettersToSpelledWord(letters.slice(half))]
      .filter(Boolean)
      .join(" ");
  }

  return lettersToSpelledWord(letters);
}

function parseSpelledName(input: string, previousName?: string): string | undefined {
  let text = input.trim();
  if (!text) return undefined;

  const titleCaseWord = (w: string): string =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

  text = text
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text
    .replace(/\bfirst name\b/gi, "<FIRST>")
    .replace(/\blast name\b/gi, "<LAST>");

  text = text.replace(
    /\b(spell(?:ing)?(?:\s+it)?|name is|it is|the name is|patient is)\b/gi,
    " "
  );
  text = text.replace(/\b([A-Za-z])\s+as\s+in\s+[A-Za-z]+\b/gi, "$1");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  const letterFromToken = (tok: string): string | null => {
    const c = tok.replace(/[^A-Za-z]/g, "");
    return c.length === 1 ? c.toUpperCase() : null;
  };

  const lettersFromHyphenToken = (tok: string): string[] | null => {
    const parts = tok.split("-").filter(Boolean);
    if (parts.length > 1 && parts.every((p) => letterFromToken(p))) {
      return parts.map((p) => letterFromToken(p)!);
    }
    return null;
  };

  const parseSegmentToWord = (segTokens: string[]): string => {
    const letters: string[] = [];
    for (const tok of segTokens) {
      const hyphenLetters = lettersFromHyphenToken(tok);
      if (hyphenLetters) {
        letters.push(...hyphenLetters);
        continue;
      }
      const letter = letterFromToken(tok);
      if (letter) {
        letters.push(letter);
        continue;
      }
      const cleaned = tok.replace(/[^A-Za-z]/g, "");
      if (cleaned.length > 1) {
        return titleCaseWord(cleaned);
      }
    }
    return lettersToSpelledWord(letters);
  };

  const tokens = text.split(" ").filter(Boolean);
  const firstIdx = tokens.indexOf("<FIRST>");
  const lastIdx = tokens.indexOf("<LAST>");
  if (firstIdx !== -1 && lastIdx !== -1 && firstIdx < lastIdx) {
    const first = parseSegmentToWord(tokens.slice(firstIdx + 1, lastIdx));
    const last = parseSegmentToWord(tokens.slice(lastIdx + 1));
    const full = [first, last].filter(Boolean).join(" ").trim();
    return full || undefined;
  }

  const words: string[] = [];
  let letterBuf: string[] = [];

  const flushLetterBuf = () => {
    if (!letterBuf.length) return;
    words.push(lettersToSpelledWord(letterBuf));
    letterBuf = [];
  };

  for (const tok of tokens) {
    const hyphenLetters = lettersFromHyphenToken(tok);
    if (hyphenLetters) {
      flushLetterBuf();
      words.push(lettersToSpelledWord(hyphenLetters));
      continue;
    }
    const letter = letterFromToken(tok);
    if (letter) {
      letterBuf.push(letter);
      continue;
    }
    const cleaned = tok.replace(/[^A-Za-z]/g, "");
    if (cleaned.length > 1) {
      flushLetterBuf();
      words.push(titleCaseWord(cleaned));
    }
  }
  flushLetterBuf();

  if (words.length === 1 && words[0].length > 1) {
    return words[0];
  }

  if (words.length >= 2 && words.every((w) => w.length > 1)) {
    return words.join(" ").trim();
  }

  if (words.every((w) => w.length === 1)) {
    const letters = words.map((w) => w.toUpperCase());
    const full = splitSpelledLettersIntoName(letters, previousName);
    return full || undefined;
  }

  const allLetters: string[] = [];
  for (const tok of tokens) {
    const hyphenLetters = lettersFromHyphenToken(tok);
    if (hyphenLetters) {
      allLetters.push(...hyphenLetters);
      continue;
    }
    const letter = letterFromToken(tok);
    if (letter) allLetters.push(letter);
  }
  if (allLetters.length >= 2) {
    return splitSpelledLettersIntoName(allLetters, previousName) || undefined;
  }

  return words.join(" ").trim() || undefined;
}

function parseAllergiesAnswer(text: string): string[] | null {
  const q = text.trim();
  if (!q) return null;
  if (/^(no|none|no allergies|none known|nkda|nka|not aware of any)\b/i.test(q)) {
    return [];
  }
  if (!isExplicitAllergyAnswer(q)) return null;
  const match = q.match(
    /\b(?:allergic to|allergy to|allergies are)\s+(.+)$/i
  );
  if (match?.[1]) {
    return match[1]
      .split(/\s*,\s*|\s+and\s+/i)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return null;
}

function parseMedicationsAnswer(text: string): DemoMedication[] | null {
  const q = text.trim();
  if (!q) return null;
  if (/^(no|none|no medications|not on any|nkda|n\/a)\b/i.test(q)) return [];
  const parsed = parseAdmissionCommand(q);
  if (parsed.medication) {
    return [
      {
        name: parsed.medication.name,
        sig: parsed.medication.dose ?? "As directed",
      },
    ];
  }
  const segment = q.replace(/^(?:just|only)\s+/i, "").trim();
  const meds: DemoMedication[] = [];
  const parts = segment.split(/\s*,\s*|\s+and\s+/i).filter(Boolean);
  for (const part of parts) {
    const medMatch =
      part.match(/^(.+?)\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|units?).*)$/i) ??
      part.match(/^(.+?)\s*[-–:]\s*(.+)$/);
    if (medMatch) {
      meds.push({
        name: medMatch[1].trim(),
        sig: normalizeMedicationSig(medMatch[2].trim()),
      });
    } else if (!/\b(?:needs?|he|she|they)\b/i.test(part)) {
      meds.push({ name: part.trim(), sig: "As directed" });
    }
  }
  return meds.length ? meds : null;
}

function parseEmergencyContactAnswer(
  text: string
): DemoPatient["emergencyContact"] | null {
  if (!isExplicitEmergencyContactAnswer(text)) return null;
  const trimmed = text.trim();
  if (/^(no|none|not at this time|unknown)\b/i.test(trimmed)) {
    return { name: "Not listed", relationship: "Not listed", phone: "Not listed" };
  }
  const phoneMatch = trimmed.match(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  const relationshipMatch = trimmed.match(
    /\b(spouse|partner|parent|mother|father|sibling|child|friend)\b/i
  );
  const namePart = trimmed
    .replace(phoneMatch?.[0] ?? "", "")
    .replace(relationshipMatch?.[0] ?? "", "")
    .replace(/\b(?:emergency contact is|contact is|primary contact is|phone number is|contact|is|the)\b/gi, "")
    .trim();
  return {
    name: namePart || "Not listed",
    relationship: relationshipMatch?.[1] ?? "Contact",
    phone: phoneMatch?.[1] ?? "Not listed",
  };
}

function cleanVoiceCommand(input: string): string {
  let t = input.trim();
  if (!t) return "";

  // Wake words / common openings (beginning only).
  t = t.replace(
    /^(?:hey\s+vital[s]?\s*,?\s*|vital\s*,?\s*|okay\s+vital[s]?\s*,?\s*|ok\s+vital[s]?\s*,?\s*|hey\s+vitals\s*,?\s*|hey\s+vido\s*,?\s*|hey\s+final[s]?\s*,?\s*|vital[s]?\s*,?\s*|can you\s+|could you\s+|please\s+|i need you to\s+|i'd like to\s+|i would like to\s+|let's\s+)/i,
    ""
  );

  // Collapse repeated spaces.
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function isAffirmative(input: string): boolean {
  return /^(?:yes|yeah|yep|yup|correct|that's correct|that is correct|right|confirm(?:ed)?|go ahead|do it|create(?: the)? patient|admit(?: the)? patient|proceed|ok|okay|sure)\b/i.test(
    input.trim()
  );
}

function isNegative(input: string): boolean {
  return /^(?:no|nope|incorrect|wrong|not correct|that's wrong|that is wrong|cancel|don't create|dont create|stop|never mind|nevermind)\b/i.test(
    input.trim()
  );
}

function isSkipLike(input: string): boolean {
  return /^(?:unknown|skip|not sure|n\/a|na|don't know|do not know)\b/i.test(
    input.trim()
  );
}

function titleCaseNameWord(word: string): string {
  if (!word) return "";
  // Very small helper; we keep internal apostrophes/hyphens and titlecase the full word.
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

const GENERIC_ADMISSION_INTENT_PHRASES = new Set([
  "patient",
  "a patient",
  "new patient",
  "the patient",
  "admit patient",
  "admit a patient",
  "admit new patient",
  "admit the patient",
  "i'd like to admit a patient",
  "i would like to admit a patient",
  "i want to admit a patient",
  "can you admit a patient",
  "please admit a patient",
  "create a patient",
  "create new patient",
  "create a new patient",
  "add a patient",
  "add new patient",
  "add a new patient",
]);

function normalizeAdmissionIntentKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+/g, "")
    .replace(/\s+/g, " ");
}

function isGenericAdmissionIntentOnly(text: string): boolean {
  const key = normalizeAdmissionIntentKey(text);
  if (!key) return true;
  if (GENERIC_ADMISSION_INTENT_PHRASES.has(key)) return true;
  return false;
}

function stripAdmissionIntentPhrases(text: string): string {
  let t = text.trim();
  const intentPrefix =
    /^(?:i(?:'d| would| want to)\s+(?:like to\s+)?|can you\s+|could you\s+|please\s+|let's\s+)?(?:admit|add|create)(?:\s+a)?(?:\s+new)?(?:\s+patient)?\b/i;
  while (intentPrefix.test(t)) {
    t = t.replace(intentPrefix, "").trim();
  }
  t = t.replace(/^(?:admit|add|create)(?:\s+a)?(?:\s+new)?(?:\s+patient)?\b/i, "").trim();
  return t.replace(/\s+/g, " ").trim();
}

function isInvalidGenericPatientName(candidate: string): boolean {
  const key = normalizeAdmissionIntentKey(candidate);
  if (!key) return true;
  if (GENERIC_ADMISSION_INTENT_PHRASES.has(key)) return true;
  if (/^(?:a|an|the|new)\s+patient$/i.test(key)) return true;
  if (key === "patient" || key === "admit" || key === "create" || key === "add") return true;
  const words = key.split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0] === "patient") return true;
  if (words.every((w) => ["a", "an", "the", "new", "patient", "admit", "add", "create"].includes(w))) {
    return true;
  }
  return false;
}

function parsePatientName(input: string): string | undefined {
  const q0 = cleanVoiceCommand(input);
  const q = q0
    .replace(/[.,!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!q) return undefined;
  if (isGenericAdmissionIntentOnly(q)) return undefined;

  if (isNegative(q) || isAffirmative(q) || isSkipLike(q)) return undefined;

  // Pull candidate after explicit name cues.
  const explicit =
    q.match(
      /\b(?:patient\s+is|name\s+is|called|named)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i
    )?.[1] ?? undefined;

  let candidate = explicit;
  if (!candidate) {
    // Name immediately after "admit patient" / "admit a patient" (must not be generic).
    const afterAdmitPatient = q.match(
      /\b(?:admit|add|create)(?:\s+a)?(?:\s+new)?\s+patient\s+(?!named|called|name\s+is)([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,3})/i
    )?.[1];
    if (afterAdmitPatient) {
      const stopRx =
        /\b(?:\d{1,3}\s*(?:year[s]?\s*old|yo)?\s*(?:male|female)?|male|female|room|bed|bay|acuity|chief\s+concern|allergies?|medications?|needs?|give|start|order|emergency\s*contact)\b/i;
      candidate = afterAdmitPatient.split(stopRx)[0]?.trim();
    }
  }

  // Allow direct name responses (e.g. "Vithu Patel") during the name step.
  if (!candidate) {
    const stripped = stripAdmissionIntentPhrases(q);
    if (stripped && !isGenericAdmissionIntentOnly(stripped)) {
      candidate = stripped.split(",")[0]?.trim();
    }
  }

  if (!candidate || isInvalidGenericPatientName(candidate)) return undefined;
  candidate = candidate.replace(/^[,:]\s*/g, "").replace(/[^A-Za-z\s'-]/g, " ").trim();
  candidate = candidate.replace(/\s+/g, " ");

  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return undefined;
  if (words.some((w) => !/^[A-Za-z][A-Za-z'-]*$/.test(w))) return undefined;
  if (words.every((w) => w.length < 2)) return undefined;
  if (isInvalidGenericPatientName(words.join(" "))) return undefined;

  const lowered = candidate.toLowerCase();
  if (
    /\b(?:aspirin|ibuprofen|tylenol|advil|acetaminophen|penicillin|amoxicillin|codeine|allerg(?:y|ies)|nkda|nk?a|nka|room|bed|bay|acuity|chief|concern|broken|limb|chest|pain|shortness|breath|abdominal|migraine|fever|vomiting|fall)\b/i.test(
      lowered
    )
  ) {
    return undefined;
  }

  return words.map(titleCaseNameWord).join(" ");
}

function parseAgeSex(input: string): { age?: number; sex?: "M" | "F" | "U" } {
  const q = cleanVoiceCommand(input).trim();
  const low = q.toLowerCase();

  if (!q) return {};
  if (isSkipLike(q) || isNegative(q) || isAffirmative(q)) return {};
  if (
    /\b(chest pain|broken limb|room|aspirin|ibuprofen|tylenol|advil)\b/i.test(low)
  ) {
    return {};
  }

  const out: { age?: number; sex?: "M" | "F" | "U" } = {};

  const compact = q.match(/\b(\d{1,3})\s*([mf])\b/i);
  if (compact?.[1] && compact[2]) {
    out.age = Number(compact[1]);
    out.sex = compact[2].toUpperCase() === "M" ? "M" : "F";
    return out;
  }

  const agePatterns = [
    /\b(?:age|aged)\s*(\d{1,3})\b/i,
    /\b(\d{1,3})\s*[- ]?\s*year[s]?\s*[- ]?\s*old\b/i,
    /\b(\d{1,3})\s*[- ]?\s*year[s]?\s*[- ]?\s*old\s*(male|female|man|woman|boy|girl)\b/i,
    /\b(\d{1,3})\s*(?:yo|y\.?o\.?)\b/i,
    /\b(\d{1,3})\s*(male|female|man|woman|boy|girl)\b/i,
    /\b(male|female|man|woman|boy|girl)\s+age\s+(\d{1,3})\b/i,
    /\b(\d{1,3})\b/,
  ];
  for (const rx of agePatterns) {
    const match = q.match(rx);
    if (match?.[1]) {
      const age = Number(match[1]);
      if (age >= 0 && age <= 130) out.age = age;
      const sexWord = match[2];
      if (sexWord) {
        const tok = sexWord.toLowerCase();
        if (tok === "m" || tok === "male" || tok === "man" || tok === "boy") out.sex = "M";
        else if (tok === "f" || tok === "female" || tok === "woman" || tok === "girl") {
          out.sex = "F";
        }
      }
      break;
    }
  }

  if (!out.sex) {
    const sexToken =
      q.match(/\b(male|man|boy)\b/i)?.[1] ||
      q.match(/\b(female|woman|girl)\b/i)?.[1] ||
      q.match(/\b([mf])\b/i)?.[1];
    if (sexToken) {
      const tok = sexToken.toLowerCase();
      if (tok === "m" || tok === "male" || tok === "man" || tok === "boy") out.sex = "M";
      else if (tok === "f" || tok === "female" || tok === "woman" || tok === "girl") {
        out.sex = "F";
      }
    }
  }

  if (out.age === undefined || !out.sex) return {};
  return out;
}

function parseRoom(input: string): string | undefined {
  const q = cleanVoiceCommand(input).trim();
  if (!q) return undefined;
  if (isNegative(q) || isAffirmative(q) || isSkipLike(q)) return undefined;

  const low = q.toLowerCase();
  if (/\b(chest pain|shortness of breath|broken limb|fever|vomiting|migraine|abdominal pain)\b/i.test(low)) {
    return undefined;
  }

  const patterns: Array<{ rx: RegExp; prefix: string }> = [
    { rx: /\b(?:room)\s+(\d+[A-Za-z]?)\b/i, prefix: "Room" },
    { rx: /\b(?:bed)\s+(\d+[A-Za-z]?)\b/i, prefix: "Bed" },
    { rx: /\b(?:bay)\s+(\d+[A-Za-z]?)\b/i, prefix: "Bay" },
    { rx: /\b(?:isolation)\s+(\d+[A-Za-z]?)\b/i, prefix: "Isolation" },
    { rx: /\b(?:peds)\s+(\d+[A-Za-z]?)\b/i, prefix: "Peds" },
    { rx: /\b(?:trauma)\s+(\d+[A-Za-z]?)\b/i, prefix: "Trauma" },
  ];
  for (const { rx, prefix } of patterns) {
    const m = q.match(rx);
    const unit = m?.[1];
    if (unit) return `${prefix} ${unit.toUpperCase()}`;
  }

  const bare = q.match(/^(\d+[A-Za-z]?)$/);
  if (bare?.[1]) return `Room ${bare[1].toUpperCase()}`;

  return undefined;
}

function isInvalidChiefConcernInput(q: string): boolean {
  const low = q.toLowerCase().trim();
  if (!low) return true;
  if (isNegative(q) || isAffirmative(q) || isSkipLike(q)) return true;
  if (low === "no" || low === "none" || low === "unknown" || low === "skip") return true;
  if (low === "chief concern" || low === "chief" || low === "concern") return true;
  if (parseRoom(q)) return true;
  if (parseAgeSex(q).age !== undefined && parseAgeSex(q).sex) return true;
  if (/\b(?:\d{1,3}\s*(?:year[s]?\s*old|yo)?\s*)?(?:male|female|man|woman|boy|girl)\b/i.test(low)) {
    return true;
  }
  
  const looksMedication =
    /\b(needs?|give|start|order|prescribe|medication|meds?)\b/i.test(q) &&
    /\b(aspirin|ibuprofen|tylenol|advil|acetaminophen|metformin|salbutamol|amoxicillin|penicillin|codeine)\b/i.test(
      q
    );
  if (looksMedication) return true;
  if (/^(?:aspirin|ibuprofen|tylenol|advil|acetaminophen)\b/i.test(low)) return true;
  if (/\b(?:he|she|they)\s+needs?\s+/i.test(low)) return true;
  return false;
}

function parseChiefConcern(
  input: string,
  options?: { directAnswer?: boolean }
): string | undefined {
  const q0 = cleanVoiceCommand(input).trim();
  const q = q0.replace(/[?.!,;:]+$/g, "").trim();
  if (!q || isInvalidChiefConcernInput(q)) return undefined;

  const hasExplicitCue =
    /\bchief\s+concern\b/i.test(q) ||
    /\bconcern\s+is\b/i.test(q) ||
    /\bpresenting\s+with\b/i.test(q) ||
    /\bcomplaining\s+of\b/i.test(q) ||
    /\bcame\s+in\s+for\b/i.test(q);

  if (!options?.directAnswer && !hasExplicitCue) {
    return undefined;
  }

  let concern = q;
  if (hasExplicitCue) {
    const extractRx =
      /\b(?:chief\s+concern(?:\s+is)?|concern\s+is|presenting\s+with|complaining\s+of|came\s+in\s+for)\b\s+(.+)/i;
    const m = q.match(extractRx);
    if (m?.[1]) concern = m[1].trim();
  } else if (options?.directAnswer) {
    if (/^\s*for\s+/i.test(q)) {
      concern = q.replace(/^\s*for\s+/i, "").trim();
    } else if (/^\s*with\s+/i.test(q)) {
      concern = q.replace(/^\s*with\s+/i, "").trim();
    } else {
      concern = q;
    }
  }

  const stopRx =
    /\b(?:needs?|give|start|order|medications?|room|bed|bay|\d{1,3}\s*(?:year|yo|male|female)|male|female)\b/i;
  concern = concern.split(stopRx)[0]?.trim() ?? concern;
  if (concern.length < 2 || concern.toLowerCase() === "chief concern") return undefined;
  if (isInvalidChiefConcernInput(concern)) return undefined;

  concern = concern.replace(/\s+/g, " ");
  return concern.charAt(0).toUpperCase() + concern.slice(1);
}

function parseChiefConcernFromBootstrap(command: string): string | undefined {
  const cleaned = cleanVoiceCommand(command);
  const hasCue =
    /\bchief\s+concern\b/i.test(cleaned) ||
    /\bconcern\s+is\b/i.test(cleaned) ||
    /\bpresenting\s+with\b/i.test(cleaned) ||
    /\bcomplaining\s+of\b/i.test(cleaned) ||
    /\bcame\s+in\s+for\b/i.test(cleaned);
  if (!hasCue) return undefined;
  return parseChiefConcern(cleaned, { directAnswer: true });
}

function normalizeMedicationName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9/+-]/g, " ").replace(/\s+/g, " ");
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")
    .replace(/\s+/g, " ");
}

function parseMedication(input: string): DemoMedication[] {
  const q = cleanVoiceCommand(input).trim();
  if (!q) return [];
  const low = q.toLowerCase();

  // Hard negation for meds.
  const isMedsDenial =
    /^(?:no|none|no meds?|no medications?)\b/i.test(q) ||
    /\bnot\s+(?:on\s+any|taking\s+any)\b/i.test(q) ||
    /\bno\s+current\s+medications?\b/i.test(q);
  if (isMedsDenial) return [];

  // If it doesn't look like medication text, don't accidentally fill the field.
  const looksLikeMeds =
    /\b(needs?|give|start|order|prescribe|medication|meds?|aspirin|ibuprofen|tylenol|advil|acetaminophen|codeine|penicillin|amoxicillin)\b/i.test(
      low
    ) ||
    /\b(\d+(?:\.\d+)?\s*(?:mg|mcg|g|units?))\b/i.test(low);
  if (!looksLikeMeds) return [];

  let normalized = q
    .replace(/\baspers\b/gi, "aspirin")
    .replace(/\basprin\b/gi, "aspirin")
    .replace(/\basperin\b/gi, "aspirin")
    .replace(/\btylanol\b/gi, "tylenol")
    .replace(/\btyl?enol\b/gi, "tylenol")
    .replace(/\badvil\b/gi, "Advil")
    .replace(/\bibuprofen\b/gi, "Ibuprofen")
    .replace(/\bacetaminophen\b/gi, "Acetaminophen");

  normalized = normalized.replace(/\b(?:needs?|give|start|order|prescribe|medication|meds?)\b/gi, "");
  normalized = normalized.replace(/\s+/g, " ").trim();

  const parts = normalized
    .split(/\s*,\s*|\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: DemoMedication[] = [];
  for (const part of parts) {
    if (!part) continue;
    const doseMatch = part.match(/^(.+?)\s+(.*)$/);
    if (doseMatch?.[1] && doseMatch?.[2]) {
      const name = normalizeMedicationName(doseMatch[1]);
      const sig = normalizeMedicationSig(doseMatch[2]);
      if (name) out.push({ name, sig: sig || "As directed" });
    } else {
      const name = normalizeMedicationName(part);
      if (name) out.push({ name, sig: "As directed" });
    }
  }
  return out.length ? out : [];
}

function parseAllergies(input: string): string[] {
  const q = cleanVoiceCommand(input).trim();
  if (!q) return [];
  const low = q.toLowerCase();

  if (
    /^(?:no|none)\b/i.test(q) ||
    /^(?:no allergies|no known allergies|nkda|nka|none known)\b/i.test(q) ||
    /\bno known drug allergies\b/i.test(q)
  ) {
    return [];
  }

  // If it's clearly complaint text (chief concern), don't save it as allergy.
  if (
    /\b(broken limb|chest pain|shortness of breath|fever|vomiting|migraine|abdominal pain|dizziness)\b/i.test(
      low
    )
  ) {
    return [];
  }

  // If the utterance looks like a medication request/order, do not store it as an allergy.
  const looksLikeMedication =
    /\b(needs?|give|start|order|prescribe|medication|meds?)\b/i.test(q) ||
    /\b(\d+(?:\.\d+)?\s*(?:mg|mcg|g|units?))\b/i.test(q) ||
    /\b(aspirin|ibuprofen|tylenol|advil|acetaminophen|codeine|penicillin|amoxicillin)\b/i.test(
      low
    );
  if (looksLikeMedication && !/\ballergic to\b/i.test(low)) {
    return [];
  }

  const extractRx = /\b(?:allergic to|allergy to|allergies are)\s+(.+)$/i;
  const m = q.match(extractRx);
  const body = (m?.[1] ?? q).trim();
  const allergyText = body.replace(/[?.!,;:]+$/g, "").trim();
  if (!allergyText) return [];

  return allergyText
    .split(/\s*,\s*|\s+and\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseAcuity(input: string): string | undefined {
  const q = cleanVoiceCommand(input).trim();
  if (!q) return undefined;
  const low = q.toLowerCase();

  if (isSkipLike(q) || /^(?:unknown|skip)\b/i.test(q)) return "CTAS 3";
  if (/^(?:no|none|nope)\b/i.test(q)) return undefined;

  const explicit = low.match(/\b(?:ctas|acuity|urgency|level|priority)\s*([1-5])\b/);
  if (explicit?.[1]) return `CTAS ${explicit[1]}`;
  if (/\bcritical\b/.test(low)) return "CTAS 1";
  if (/\b(?:emergent|emergency)\b/.test(low)) return "CTAS 2";
  if (/\burgent\b/.test(low)) return "CTAS 3";
  if (/\bnon[-\s]?urgent\b/.test(low)) return "CTAS 5";
  return undefined;
}

function parseEmergencyContact(input: string): DemoPatient["emergencyContact"] | undefined {
  const q = cleanVoiceCommand(input).trim();
  if (!q) return undefined;

  if (isNegative(q) || isSkipLike(q) || /^(?:none|not at this time)\b/i.test(q)) {
    return undefined;
  }

  const phoneMatch = q.match(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  const relationshipMatch = q.match(
    /\b(spouse|partner|parent|mother|father|sibling|child|friend)\b/i
  );

  // Remove phone and relationship tokens to get the name-ish remaining.
  const namePart = q
    .replace(phoneMatch?.[0] ?? "", "")
    .replace(relationshipMatch?.[0] ?? "", "")
    .replace(/\b(?:emergency\s*contact\s+is|contact\s+is|primary\s*contact\s+is|phone\s+number\s+is|emergency\s*contact|contact|is|the)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!namePart && !phoneMatch) return undefined;
  return {
    name: namePart || "Not listed",
    relationship: relationshipMatch?.[1] ?? "Contact",
    phone: phoneMatch?.[1] ?? "Not listed",
  };
}

function computeMissingFields(draft: AdmissionDraft): string[] {
  const missing: string[] = [];
  const d = draft.data;

  if (!d.name?.trim()) missing.push("name");
  if (!draft.nameConfirmed) missing.push("nameConfirmed");
  if (typeof d.age !== "number" || !Number.isFinite(d.age)) missing.push("age");
  if (!d.sex?.trim() || !["M", "F", "U"].includes(d.sex)) missing.push("sex");
  if (!d.room?.trim()) missing.push("room");
  if (!d.chiefConcern?.trim()) missing.push("chiefConcern");
  return missing;
}

function formatMedicationSummary(medications: DemoMedication[] | undefined): string {
  if (!medications?.length) return "none";
  return medications.map((m) => m.name).join(", ");
}

function getNextAdmissionStep(draft: AdmissionDraft): AdmissionStep {
  const d = draft.data;

  if (!d.name?.trim()) return "name";
  if (!draft.nameConfirmed) return "confirmName";

  if (
    typeof d.age !== "number" ||
    !Number.isFinite(d.age) ||
    !d.sex?.trim() ||
    !["M", "F", "U"].includes(d.sex)
  ) {
    return "ageSex";
  }

  if (!d.chiefConcern?.trim()) return "chiefConcern";
  if (!d.room?.trim()) return "room";
  if (!draft.medicationsCaptured) return "medications";

  return "confirmation";
}

const CORRECTION_FIELD_PROMPT =
  "Okay. What would you like to change? Name, age and sex, chief concern, room, or medications?";

function parseCorrectionFieldChoice(input: string): AdmissionStep | null {
  const low = input.toLowerCase();
  if (/\b(name|patient\s+name)\b/.test(low)) return "name";
  if (/\b(age|sex|age\s+and\s+sex)\b/.test(low)) return "ageSex";
  if (/\b(chief\s+concern|concern)\b/.test(low)) return "chiefConcern";
  if (/\broom\b/.test(low)) return "room";
  if (/\b(medication|medications|meds?)\b/.test(low)) return "medications";
  return null;
}

function getPromptForStep(step: AdmissionStep, draft: AdmissionDraft): string {
  if (draft.awaitingCorrectionField) {
    return CORRECTION_FIELD_PROMPT;
  }

  const name = draft.data.name?.trim() || "";
  switch (step) {
    case "name":
      return "Who is the patient you want to admit?";
    case "confirmName":
      return `I heard the patient name as ${name}. Spelled ${spellName(name)}. Is that correct?`;
    case "spellNameCorrection":
      if (draft.nameSpellParseError) {
        return "I could not understand the spelling. Please spell the patient’s first and last name slowly.";
      }
      return "Please spell the patient’s full name.";
    case "ageSex":
      return "What is the patient’s age and sex?";
    case "chiefConcern":
      return "What is the patient’s chief concern?";
    case "room":
      return "What room should the patient be assigned to?";
    case "medications":
      return "Is the patient taking any medications or do they need any medication orders?";
    case "confirmation": {
      const age = typeof draft.data.age === "number" ? draft.data.age : 0;
      const sex = draft.data.sex?.trim() || "U";
      const room = draft.data.room?.trim() || "Unassigned";
      const chief = draft.data.chiefConcern?.trim() || "";
      const meds = formatMedicationSummary(draft.data.medications);
      return `Confirm admission for ${name}: ${age}${sex}, ${room}, chief concern ${chief}, medications ${meds}. Should I create this patient?`;
    }
    case "done":
      return "";
    default:
      return "";
  }
}

function admissionPromptForStep(draft: AdmissionDraft): string {
  return getPromptForStep(draft.currentStep, draft);
}

function parseAdmissionBootstrap(command: string): Partial<DemoPatient> {
  const cleaned = cleanVoiceCommand(command);
  const data: Partial<DemoPatient> = {};

  const name = parsePatientName(cleaned);
  if (name) data.name = name;

  const ageSex = parseAgeSex(cleaned);
  if (ageSex.age !== undefined) data.age = ageSex.age;
  if (ageSex.sex) data.sex = ageSex.sex;

  const concern = parseChiefConcernFromBootstrap(cleaned);
  if (concern) data.chiefConcern = concern;

  const room = parseRoom(cleaned);
  if (room) data.room = room;

  const medsMentioned =
    /^(?:no|none)\b/i.test(cleaned) ||
    /\bno\s+meds?\b/i.test(cleaned) ||
    /\bno\s+medications?\b/i.test(cleaned) ||
    /\bnot\s+(?:on\s+any|taking\s+any)\b/i.test(cleaned) ||
    /\bno\s+current\s+medications?\b/i.test(cleaned) ||
    /\b(needs?|give|start|order|prescribe|medication|meds?)\b/i.test(cleaned) ||
    /\b(aspirin|ibuprofen|tylenol|advil|acetaminophen|codeine|metformin|salbutamol)\b/i.test(
      cleaned
    ) ||
    /\b(\d+(?:\.\d+)?\s*(?:mg|mcg|g|units?))\b/i.test(cleaned);
  if (medsMentioned) {
    data.medications = parseMedication(cleaned);
  }

  return data;
}

/** Only skip the medications step when the utterance explicitly denies meds (one-shot). */
function bootstrapExplicitMedicationsCaptured(cleaned: string): boolean {
  return (
    /\bno\s+medications?\b/i.test(cleaned) ||
    /\bno\s+meds?\b/i.test(cleaned) ||
    /\bnot\s+(?:on\s+any|taking\s+any)\b/i.test(cleaned) ||
    /\bno\s+current\s+medications?\b/i.test(cleaned)
  );
}

function repromptAdmission(draft: AdmissionDraft): AdmissionDraft {
  return {
    ...draft,
    lastQuestionAsked: admissionPromptForStep(draft),
    missingFields: computeMissingFields(draft),
  };
}

function mergeAdmissionAnswer(draft: AdmissionDraft, command: string): AdmissionDraft {
  const cleaned = cleanVoiceCommand(command);
  const trimmed = cleaned.trim();

  const data: Partial<DemoPatient> = { ...draft.data };
  const next: AdmissionDraft = {
    ...draft,
    data,
    nameSpellParseError: false,
  };

  if (draft.awaitingCorrectionField) {
    const field = parseCorrectionFieldChoice(trimmed);
    if (!field) {
      return { ...next, awaitingCorrectionField: true, ...repromptAdmission(next) };
    }
    if (field === "name") {
      next.nameConfirmed = false;
      delete next.data.name;
    }
    if (field === "ageSex") {
      delete next.data.age;
      delete next.data.sex;
    }
    if (field === "chiefConcern") {
      delete next.data.chiefConcern;
    }
    if (field === "room") {
      delete next.data.room;
    }
    if (field === "medications") {
      next.medicationsCaptured = false;
      next.data.medications = [];
    }
    next.awaitingCorrectionField = false;
    next.currentStep = field;
    next.missingFields = computeMissingFields(next);
    next.lastQuestionAsked = admissionPromptForStep(next);
    return next;
  }

  switch (draft.currentStep) {
    case "name": {
      const name = parsePatientName(trimmed);
      if (!name) return repromptAdmission(draft);
      next.data.name = name;
      next.nameConfirmed = false;
      next.currentStep = "confirmName";
      break;
    }

    case "confirmName": {
      if (isAffirmative(trimmed)) {
        next.nameConfirmed = true;
        next.currentStep = getNextAdmissionStep(next);
      } else if (isNegative(trimmed)) {
        next.nameConfirmed = false;
        next.currentStep = "spellNameCorrection";
      } else {
        return repromptAdmission(draft);
      }
      break;
    }

    case "spellNameCorrection": {
      const spelled = parseSpelledName(trimmed, draft.data.name);
      if (!spelled) {
        next.nameSpellParseError = true;
        next.currentStep = "spellNameCorrection";
        return { ...next, ...repromptAdmission(next) };
      }
      next.data.name = spelled;
      next.nameConfirmed = false;
      next.nameSpellParseError = false;
      next.currentStep = "confirmName";
      break;
    }

    case "ageSex": {
      const parsed = parseAgeSex(trimmed);
      if (!parsed.age && parsed.age !== 0) {
        return repromptAdmission(draft);
      }
      if (!parsed.sex) {
        return repromptAdmission(draft);
      }
      next.data.age = parsed.age;
      next.data.sex = parsed.sex;
      next.currentStep = getNextAdmissionStep(next);
      break;
    }

    case "chiefConcern": {
      const concern = parseChiefConcern(trimmed, { directAnswer: true });
      if (!concern) {
        return repromptAdmission(draft);
      }
      next.data.chiefConcern = concern;
      next.currentStep = getNextAdmissionStep(next);
      break;
    }

    case "room": {
      const room = parseRoom(trimmed);
      if (!room) {
        return repromptAdmission(draft);
      }
      next.data.room = room;
      next.currentStep = getNextAdmissionStep(next);
      break;
    }

    case "medications": {
      const meds = parseMedication(trimmed);
      const medsDenial =
        /^(?:no|none|no meds?|no medications?)\b/i.test(trimmed) ||
        /\bnot\s+(?:on\s+any|taking\s+any)\b/i.test(trimmed) ||
        /\bno\s+current\s+medications?\b/i.test(trimmed);

      if (!medsDenial && meds.length === 0) {
        return repromptAdmission(draft);
      }
      next.data.medications = meds;
      next.medicationsCaptured = true;
      next.currentStep = getNextAdmissionStep(next);
      break;
    }

    case "confirmation": {
      if (isAffirmative(trimmed)) {
        next.currentStep = "done";
      } else if (isNegative(trimmed)) {
        next.awaitingCorrectionField = true;
        next.currentStep = "confirmation";
        next.lastQuestionAsked = CORRECTION_FIELD_PROMPT;
        next.missingFields = computeMissingFields(next);
        return next;
      } else {
        return repromptAdmission(draft);
      }
      break;
    }

    case "done":
      return draft;
  }

  next.missingFields = computeMissingFields(next);
  next.lastQuestionAsked = admissionPromptForStep(next);
  return next;
}

function buildAdmissionPayload(data: Partial<DemoPatient>): Record<string, unknown> {
  return {
    name: data.name?.trim(),
    room: data.room?.trim(),
    chiefConcern: data.chiefConcern?.trim(),
    age: typeof data.age === "number" && Number.isFinite(data.age) ? data.age : 0,
    sex: data.sex?.trim() || "Unknown",
    allergies: [],
    medications: data.medications ?? [],
    triageAcuity: "CTAS 3",
    lastVisit: new Date().toISOString().slice(0, 10),
  };
}

function buildAdmissionFinalizeMessage(
  _patient: DemoPatient,
  _opts: { early: boolean; roomLabel: string }
): string {
  return "Patient successfully admitted.";
}

function missingAdmissionFieldPrompt(draft: AdmissionDraft): string | null {
  const d = draft.data;
  if (!d.name?.trim() || !draft.nameConfirmed) {
    return "I still need the patient's name before I can create the chart.";
  }
  if (!(typeof d.age === "number" && Number.isFinite(d.age)) || !d.sex) {
    return "I still need the patient's age and sex before I can create the chart.";
  }
  if (!d.chiefConcern?.trim()) {
    return "I still need the patient's chief concern before I can create the chart.";
  }
  if (!d.room?.trim()) {
    return "I still need the patient's room before I can create the chart.";
  }
  return null;
}

function parseAdmitDetails(command: string): { name: string; room?: string } | null {
  const boot = parseAdmissionBootstrap(command);
  if (!boot.name?.trim()) return null;
  return { name: boot.name.trim(), room: boot.room };
}

function matchUniqueFirstName(
  transcript: string,
  patients: DemoPatient[]
): DemoPatient[] {
  const skip = new Set([
    "patient",
    "the",
    "what",
    "whats",
    "show",
    "pull",
    "open",
    "find",
    "view",
    "give",
    "tell",
    "read",
    "check",
    "load",
    "room",
    "chart",
    "record",
    "file",
    "meds",
    "medications",
    "vitals",
    "labs",
    "notes",
    "problems",
    "symptoms",
    "allergies",
    "doctor",
    "staff",
    "board",
    "roster",
    "home",
    "being",
    "from",
    "with",
    "about",
    "does",
    "have",
    "having",
    "wrong",
    "taking",
  ]);
  const tokens = transcript.toLowerCase().match(/\b[a-z][a-z'-]{2,}\b/g) ?? [];
  for (const token of tokens) {
    if (skip.has(token)) continue;
    const matches = patients.filter((p) => {
      const first = p.name.toLowerCase().split(" ")[0] ?? "";
      const preferred = (p.preferredName ?? "").toLowerCase();
      return first === token || preferred === token;
    });
    if (matches.length === 1) return matches;
  }
  return [];
}

function buildRequestedPatientView(
  patient: DemoPatient,
  fields: PatientFieldKey[]
): RequestedPatientView {
  const lines: string[] = [];
  const wantsOverview = fields.includes("overview");
  if (wantsOverview) {
    lines.push(
      `${patient.name}: age ${patient.age} ${patient.sex}; DOB ${patient.dob}; room ${patient.room}; MRN ${patient.mrn}; acuity ${patient.triageAcuity}; chief concern: ${patient.chiefConcern}.`
    );
  }
  if (wantsOverview || fields.includes("diagnoses")) {
    lines.push(`Problems: ${patient.diagnoses.join("; ") || "(not listed)"}`);
  }
  if (wantsOverview || fields.includes("medications")) {
    lines.push(
      `Medications: ${
        patient.medications.length
          ? patient.medications.map((m) => `${m.name} (${m.sig})`).join("; ")
          : "(not listed)"
      }`
    );
  }
  if (wantsOverview || fields.includes("allergies")) {
    lines.push(`Allergies: ${patient.allergies.join("; ") || "(not listed)"}`);
  }
  if (wantsOverview || fields.includes("vitals")) {
    const vitals = Object.entries(patient.vitals)
      .map(([k, v]) => `${k} ${v}`)
      .join(" | ");
    lines.push(`Vitals: ${vitals || "(not listed)"}`);
  }
  if (wantsOverview || fields.includes("labs")) {
    lines.push(`Labs: ${patient.recentLabs || "(not listed)"}`);
  }
  if (fields.includes("imaging")) {
    lines.push(
      `Imaging/Cardiac: ${patient.imagingStudies || patient.cardiacStudies || "(not listed)"}`
    );
  }
  if (fields.includes("social")) {
    lines.push(`Social: ${patient.social || "(not listed)"}`);
  }
  if (fields.includes("history")) {
    lines.push(
      `History: ${
        [patient.familyHistory, patient.surgicalHistory, patient.immunizations]
          .filter(Boolean)
          .join(" | ") || "(not listed)"
      }`
    );
  }
  if (fields.includes("plan")) {
    lines.push(
      `Plan/Risk: ${
        [patient.consultants, patient.riskFlags, patient.edOrUrgentCourse]
          .filter(Boolean)
          .join(" | ") || "(not listed)"
      }`
    );
  }
  if (fields.includes("emergency_contact")) {
    lines.push(
      `Emergency contact: ${patient.emergencyContact.name} (${patient.emergencyContact.relationship}) ${patient.emergencyContact.phone}.`
    );
  }
  if (fields.includes("care_team")) {
    lines.push(
      `Care team: ${
        patient.careTeam?.join(", ") || patient.consultants || "(not listed)"
      }`
    );
  }
  if (fields.includes("risk_flags")) {
    lines.push(`Risk flags: ${patient.riskFlags || "(not listed)"}`);
  }
  if (fields.includes("chief_concern")) {
    lines.push(`Chief concern: ${patient.chiefConcern}`);
  }
  if (fields.includes("notes")) {
    lines.push(`Notes: ${patient.chartNote || "(not listed)"}`);
  }
  if (fields.includes("demographics") && !wantsOverview) {
    lines.push(
      `Demographics: ${patient.name}; age ${patient.age} ${patient.sex}; DOB ${patient.dob}; MRN ${patient.mrn}; room ${patient.room}; blood ${patient.bloodType}; acuity ${patient.triageAcuity}; chief concern: ${patient.chiefConcern}.`
    );
    if (patient.symptoms?.length) {
      lines.push(`Symptoms: ${patient.symptoms.join(", ")}.`);
    }
  }

  return {
    patientId: patient.id,
    title: `${patient.name} (${patient.mrn})`,
    fields,
    patient,
    lines,
  };
}

function findPatientByQuery(patients: DemoPatient[], query: string): DemoPatient | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    patients.find(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.preferredName ?? "").toLowerCase().includes(q) ||
        p.mrn.toLowerCase().includes(q)
    ) ?? null
  );
}

function isResetCommand(q: string): boolean {
  return /end session|close session|clear screen|clear chart|delete that|remove that|remove patient data|stop session|reset session|didn'?t ask.*delete/.test(
    q
  );
}

function findPatientMatches(transcript: string, patients: DemoPatient[]): DemoPatient[] {
  const q = transcript.toLowerCase();
  if (/first male patient/.test(q)) {
    return patients.filter((p) => p.sex.toLowerCase().startsWith("m")).slice(0, 1);
  }
  if (/first female patient/.test(q)) {
    return patients.filter((p) => p.sex.toLowerCase().startsWith("f")).slice(0, 1);
  }
  if (/first pediatric patient/.test(q)) {
    return patients.filter((p) => p.age < 18).slice(0, 1);
  }

  const roomQuery = extractRoomQuery(transcript);
  if (roomQuery) {
    const roomMatches = findPatientsByRoom(patients, roomQuery);
    if (roomMatches.length) return roomMatches;
  }

  const roomMatch = q.match(/(?:patient|anyone|who(?:'s| is))\s+(?:in|at)\s+(.+?)(?:\?|$)/i);
  if (roomMatch?.[1]) {
    const roomMatches = findPatientsByRoom(patients, roomMatch[1]);
    if (roomMatches.length) return roomMatches;
  }

  const mrnToken =
    transcript.match(/\bmrn[-\s]?\d{3,}\b/i)?.[0] ??
    transcript.match(/\b\d{6,}\b/)?.[0];
  if (mrnToken) {
    const normalized = normalizeMrnToken(mrnToken);
    return patients.filter(
      (p) =>
        normalizeMrnToken(p.mrn) === normalized ||
        p.mrn.toLowerCase().replace(/\s+/g, "") === normalized.toLowerCase()
    );
  }

  const nameHint = extractPatientNameHint(transcript);
  if (nameHint) {
    const hint = nameHint.toLowerCase();
    const hinted = patients.filter((p) => {
      const names = [p.name, p.preferredName ?? ""].map((n) => n.toLowerCase());
      return names.some(
        (name) =>
          name.includes(hint) ||
          name.split(" ").some((part) => part === hint || part.startsWith(hint))
      );
    });
    if (hinted.length) return hinted;
  }

  const fullMatches = patients.filter((p) => q.includes(p.name.toLowerCase()));
  if (fullMatches.length) return fullMatches;

  const uniqueFirst = matchUniqueFirstName(transcript, patients);
  if (uniqueFirst.length) return uniqueFirst;

  const tokenMatches = patients.filter((p) => {
    const parts = [
      ...p.name.toLowerCase().split(" "),
      ...(p.preferredName ?? "").toLowerCase().split(" "),
    ].filter(Boolean);
    return parts.some((part) => part.length > 2 && q.includes(part));
  });
  return tokenMatches;
}

function buildVoiceSummaryForChartOpen(
  transcript: string,
  patient: DemoPatient,
  sections: PatientFieldKey[],
  editableProblems: EditableProblem[]
): string {
  const q = transcript.toLowerCase();
  const sentences: string[] = [];
  const add = (s: string) => {
    if (s && !sentences.includes(s)) sentences.push(s);
  };

  const sayDemographics = () =>
    `${patient.name} is ${patient.age} years old, ${patient.sex}. Date of birth ${patient.dob}. MRN ${patient.mrn}. Room ${patient.room}. Blood type ${patient.bloodType}. Triage acuity ${patient.triageAcuity}. Chief concern: ${patient.chiefConcern}.`;

  const wantsFull =
    /full chart|entire chart|complete chart|everything|all info|full file|full record|all (of )?(the )?(chart|record|file)/.test(
      q
    ) || (sections.includes("overview") && sections.length > 1);

  if (wantsFull) {
    add(sayDemographics());
    add(`Allergies: ${patient.allergies.join(", ") || "none listed"}.`);
    const medNames = patient.medications.map((m) => `${m.name}, ${m.sig}`).join("; ");
    add(`Medications: ${medNames || "none listed"}.`);
    const probLines = editableProblems
      .map((x) => `${x.name} (${x.status})`)
      .join("; ");
    add(`Problems: ${probLines || "none listed"}.`);
    const vit = Object.entries(patient.vitals)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    add(`Vitals: ${vit || "not documented"}.`);
    add(`Recent labs: ${patient.recentLabs || "not listed"}.`);
    const planBits = [patient.consultants, patient.riskFlags, patient.edOrUrgentCourse]
      .filter(Boolean)
      .join(" ");
    add(`Plan context: ${planBits || "not listed"}.`);
    return sentences.join(" ");
  }

  if (sections.includes("demographics")) {
    const specific =
      /\bage\b|how old|years old|\bdob\b|date of birth|birthday|\bmrn\b|medical record|\broom\b|\bblood type\b|triag|ctas|acuity|chief concern|presenting|complaint|\bsymptoms?\b|\bdemographic/.test(
        q
      );
    const narrowDemoFact =
      /\bage\b|how old|years old|\bdob\b|date of birth|birthday|\bmrn\b|medical record|\broom\b|\bblood type\b|triag|ctas|acuity|chief concern|presenting|complaint|\bsymptoms?\b/.test(
        q
      );
    if (/\bage\b|how old|years old/.test(q)) {
      add(`${patient.name} is ${patient.age} years old, ${patient.sex}.`);
    }
    if (/\bdob\b|date of birth|birthday/.test(q)) {
      add(`${patient.name}'s date of birth is ${patient.dob}.`);
    }
    if (/\bmrn\b|medical record/.test(q)) add(`Medical record number is ${patient.mrn}.`);
    if (/\broom\b/.test(q)) add(`Room assignment is ${patient.room}.`);
    if (/\bblood type\b/.test(q)) add(`Blood type is ${patient.bloodType}.`);
    if (/triag|ctas|acuity/i.test(q)) add(`Triage acuity is ${patient.triageAcuity}.`);
    if (/chief concern|presenting|complaint/i.test(q))
      add(`Chief concern: ${patient.chiefConcern}.`);
    if (/\bsymptoms?\b/.test(q) && patient.symptoms?.length) {
      add(`Symptoms include: ${patient.symptoms.join(", ")}.`);
    }
    if (!specific) {
      add(sayDemographics());
    } else if (/demographic/.test(q) && !narrowDemoFact) {
      add(sayDemographics());
    }
  }

  if (sections.includes("vitals")) {
    const vit = Object.entries(patient.vitals)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    add(`Vitals for ${patient.name}: ${vit || "not documented"}.`);
  }
  if (sections.includes("medications")) {
    const m = patient.medications.map((x) => `${x.name}, ${x.sig}`).join("; ");
    add(`Medications: ${m || "none listed"}.`);
  }
  if (sections.includes("allergies")) {
    add(`Allergies: ${patient.allergies.join("; ") || "none listed"}.`);
  }
  if (sections.includes("labs")) {
    add(`Labs: ${patient.recentLabs || "not listed"}.`);
  }
  if (sections.includes("diagnoses")) {
    const probLines = editableProblems
      .map((x) => `${x.name}, status ${x.status}`)
      .join("; ");
    add(`Problem list: ${probLines || "none listed"}.`);
  }
  if (sections.includes("imaging")) {
    add(
      `Imaging: ${patient.imagingStudies || patient.cardiacStudies || "not listed"}.`
    );
  }
  if (sections.includes("plan")) {
    const planBits = [patient.consultants, patient.riskFlags, patient.edOrUrgentCourse]
      .filter(Boolean)
      .join(" ");
    add(`Plan and risk: ${planBits || "not listed"}.`);
  }
  if (sections.includes("emergency_contact")) {
    add(
      `Emergency contact for ${patient.name}: ${patient.emergencyContact.name}, ${patient.emergencyContact.relationship}, ${patient.emergencyContact.phone}.`
    );
  }
  if (sections.includes("care_team")) {
    add(
      `Care team: ${
        patient.careTeam?.join(", ") || patient.consultants || "not listed"
      }.`
    );
  }
  if (sections.includes("risk_flags")) {
    add(`Risk flags: ${patient.riskFlags || "none listed"}.`);
  }
  if (sections.includes("chief_concern")) {
    add(`Chief concern: ${patient.chiefConcern}.`);
  }
  if (sections.includes("notes")) {
    add(`Chart notes: ${patient.chartNote || "not listed"}.`);
  }

  if (sentences.length === 0) {
    return `Chart opened for ${patient.name}.`;
  }
  return sentences.join(" ");
}

function parseVoiceCommand(
  transcript: string,
  patients: DemoPatient[],
  selectedPatientId: string | null
): VoiceCommandAction {
  const q = transcript.trim().toLowerCase();
  if (!q) return { kind: "none" };

  if (isResetCommand(q)) {
    return { kind: "clear_session" };
  }

  if (/close chart|close patient|dismiss chart/.test(q)) {
    return { kind: "close_chart" };
  }

  const roomQuery = extractRoomQuery(transcript);
  if (
    roomQuery &&
    /who(?:'s| is)|anyone|patients? in|who is in|in peds|in room|show (me )?who/.test(q)
  ) {
    const occupants = findPatientsByRoom(patients, roomQuery);
    return { kind: "room_occupancy", room: roomQuery, patients: occupants };
  }

  const switchMatch = q.match(/(?:switch to|go back to|return to|back to)\s+(.+)$/);
  if (switchMatch) {
    const matches = findPatientMatches(switchMatch[1], patients);
    if (matches.length > 1) return { kind: "patient_ambiguous", matches };
    const target = matches[0] ?? null;
    if (!target) return { kind: "patient_not_found", query: switchMatch[1] };
    return { kind: "switch_patient", patientId: target.id, sections: ["overview"] };
  }

  if (!hasClinicalDataIntent(q)) return { kind: "none" };

  const nameHint = extractPatientNameHint(transcript);
  const explicitNameMatch =
    transcript.match(/\bfor\s+(.+?)(?:'s)?(?:\s+(?:chart|record|meds?|medications?|vitals?|allergies|labs?|notes?|encounter))?$/i) ??
    (nameHint ? [transcript, nameHint] : null);
  const matches = explicitNameMatch
    ? findPatientMatches(explicitNameMatch[1], patients)
    : findPatientMatches(transcript, patients);
  if (matches.length > 1) return { kind: "patient_ambiguous", matches };
  const explicit = matches[0] ?? null;
  const active =
    (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
  const target = explicit ?? active;
  if (!target) {
    return {
      kind: "patient_not_found",
      query: explicitNameMatch?.[1] ?? nameHint ?? "requested patient",
    };
  }

  const sections = detectRequestedFields(transcript);
  let resolvedSections: PatientFieldKey[];
  if (
    /full chart|entire chart|complete chart|open (the )?full|everything|all info|full file|full record|all (of )?(the )?(chart|record|file)/i.test(
      q
    )
  ) {
    resolvedSections = [
      "overview",
      "allergies",
      "medications",
      "diagnoses",
      "vitals",
      "labs",
      "plan",
    ];
  } else if (sections.includes("overview") && sections.length === 1) {
    resolvedSections = [
      "overview",
      "allergies",
      "medications",
      "diagnoses",
      "vitals",
      "labs",
      "plan",
    ];
  } else {
    resolvedSections = sections;
  }
  return { kind: "open_sections", patientId: target.id, sections: resolvedSections };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Page
 * ────────────────────────────────────────────────────────────────────────── */

export default function VitalOsClient() {
  const { role, user, permissions, logout } = useAuth();
  const apiRole = role as VitalRole;
  const [systemState, setSystemState] = React.useState<SystemState>("idle");
  const [mode, setMode] = React.useState<VitalMode>("general");
  const [emergencyArmed, setEmergencyArmed] = React.useState(false);

  const [interimTranscript, setInterimTranscript] = React.useState("");
  const [finalTranscript, setFinalTranscript] = React.useState("");
  const [heardPreview, setHeardPreview] = React.useState("");
  const [lastSubmittedTranscript, setLastSubmittedTranscript] =
    React.useState("");

  const [response, setResponse] = React.useState<VitalApiResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [audit, setAudit] = React.useState<AuditEntry[]>([]);
  const [patientSnapshot, setPatientSnapshot] = React.useState("");
  const [conversationTurns, setConversationTurns] = React.useState<
    ConversationTurn[]
  >([]);
  const [lastCommand, setLastCommand] = React.useState("System ready");
  const [activeRequestedSections, setActiveRequestedSections] = React.useState<
    PatientFieldKey[]
  >([]);
  const [activePage, setActivePage] = React.useState<ActivePage>("dashboard");
  const [encounterFilter, setEncounterFilter] = React.useState<EncounterFilter>("all");
  const [patientSearch, setPatientSearch] = React.useState("");
  const [typedCommandOpen, setTypedCommandOpen] = React.useState(false);
  const [typedCommand, setTypedCommand] = React.useState("");
  const [waveformBars, setWaveformBars] = React.useState<number[]>(
    Array.from({ length: 28 }, () => 4)
  );
  const [isChartLoading, setIsChartLoading] = React.useState(false);
  const [pendingOrders, setPendingOrders] = React.useState<PendingOrder[]>([]);
  const [ordersPanelVisible, setOrdersPanelVisible] = React.useState(false);
  const ordersFadeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const ordersPanelClearTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [problemStateByPatient, setProblemStateByPatient] = React.useState<
    Record<string, EditableProblem[]>
  >({});
  const [problemStatusFlashId, setProblemStatusFlashId] = React.useState<string | null>(null);
  const [orderNotice, setOrderNotice] = React.useState<string | null>(null);
  const [chartSaveError, setChartSaveError] = React.useState<string | null>(null);
  const [openPatientTabIds, setOpenPatientTabIds] = React.useState<string[]>([]);
  const [dischargeConfirmId, setDischargeConfirmId] = React.useState<string | null>(null);
  const [dischargeWorkflow, setDischargeWorkflow] = React.useState<{
    patientId: string;
    patientName: string;
    step: "confirm" | "reason";
  } | null>(null);
  const dischargeWorkflowRef = React.useRef(dischargeWorkflow);

  React.useEffect(() => {
    dischargeWorkflowRef.current = dischargeWorkflow;
  }, [dischargeWorkflow]);
  const lastUndoRef = React.useRef<UndoSnapshot | null>(null);
  const [pendingMedicationOrder, setPendingMedicationOrder] =
    React.useState<PendingMedicationDraft | null>(null);
  const [clinicalReasoning, setClinicalReasoning] =
    React.useState<ClinicalReasoningResult | null>(null);
  const [admitFormOpen, setAdmitFormOpen] = React.useState(false);
  const [admitDraft, setAdmitDraft] = React.useState({
    name: "",
    room: "",
    age: "",
    sex: "",
    chiefConcern: "",
    triageAcuity: "CTAS 3",
  });
  const [admissionConversation, setAdmissionConversation] =
    React.useState<AdmissionDraft>(EMPTY_ADMISSION);
  const isCreatingPatientRef = React.useRef(false);
  const [requestedPatientView, setRequestedPatientView] =
    React.useState<RequestedPatientView | null>(null);
  const conversationTurnsRef = React.useRef<ConversationTurn[]>([]);
  const [patients, setPatients] = React.useState<DemoPatient[]>([]);
  /** When true, roster refresh keeps no active chart (user chose "No focus"). */
  const userClearedFocusRef = React.useRef(false);
  const [selectedPatientId, setSelectedPatientId] = React.useState<
    string | null
  >(null);
  /** Live voice session: mic stays open; pause → auto-send; you can interrupt TTS. */
  const [voiceSessionLive, setVoiceSessionLive] = React.useState(false);
  const [micMuted, setMicMuted] = React.useState(false);
  const micMutedRef = React.useRef(false);

  React.useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);

  const [voiceEnabled, setVoiceEnabled] = React.useState(true);
  const [supportsSpeech, setSupportsSpeech] = React.useState(true);
  const [supportsTts, setSupportsTts] = React.useState(true);
  const [now, setNow] = React.useState(() => Date.now());
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceTab, setWorkspaceTab] = React.useState<
    "charts" | "response" | "dialogue" | "actions" | "system"
  >("charts");
  const workspaceToggleRef = React.useRef<HTMLButtonElement | null>(null);

  const toggleWorkspace = React.useCallback(() => {
    setWorkspaceOpen((open) => !open);
  }, []);

  /* Esc closes the panel. Bound only while open so it cannot swallow Esc
     from the typed-command input or a future dialog. */
  React.useEffect(() => {
    if (!workspaceOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setWorkspaceOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [workspaceOpen]);

  /* Return focus to the toggle on close so keyboard users are not dumped
     at the top of the document. */
  const workspaceWasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (workspaceWasOpenRef.current && !workspaceOpen) {
      workspaceToggleRef.current?.focus();
    }
    workspaceWasOpenRef.current = workspaceOpen;
  }, [workspaceOpen]);

  const recognitionRef = React.useRef<SR | null>(null);

  /* Whisper capture. Runs alongside SR: SR is the VAD, Whisper is the transcript. */
  const recorder = useUtteranceRecorder();
  const recorderRef = React.useRef(recorder);
  recorderRef.current = recorder;
  const [sttChoice, setSttChoice] = React.useState<TranscriptChoice | null>(null);
  /* Drives the amber dot on the workspace toggle: the degrade has to be
     visible without opening the panel, or it is not really visible. */
  const sttDegraded = sttChoice !== null && sttChoice.degradedReason !== null;

  /* Which leg of the intent chain answered last. Reported, never assumed —
     two silent model deprecations were missed because the panel was a literal. */
  const [intentRoute, setIntentRoute] = React.useState<{
    provider: IntentProvider;
    latencyMs: number | null;
    fallbackReason: string | null;
  } | null>(null);
  const shouldSubmitOnEndRef = React.useRef(false);
  /** True between `onstart` and `onend` — prevents double `start()` (InvalidStateError). */
  const recognitionActiveRef = React.useRef(false);
  /** After `abort()`, ignore the next `onend` from the torn-down instance (no submit / no resume). */
  const ignoreNextEndRef = React.useRef(false);
  /** When `start()` hits InvalidStateError, we `abort()` and call `start()` again from `onend`. */
  const resumeStartAfterEndRef = React.useRef(false);
  /**
   * True only when the user explicitly stops/mutes the mic. Unexpected
   * SpeechRecognition `onend` / recoverable `onerror` events restart when false.
   */
  const intentionallyStoppedRef = React.useRef(false);
  const finalRef = React.useRef("");
  const interimRef = React.useRef("");
  const utteranceRef = React.useRef<SpeechSynthesisUtterance | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  /** Latest `submit` for SpeechRecognition `onend` (avoid stale closure). */
  const submitRef = React.useRef<
    (t: string, o?: VitalMode, c?: string) => void
  >(() => {});
  /** True while voice session is active (mic should stay up). */
  const listeningIntentRef = React.useRef(false);
  const voiceSessionActiveRef = React.useRef(false);
  const startListeningContinueRef = React.useRef<(opts?: { hard?: boolean }) => void>(
    () => {}
  );
  const silenceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSilenceSubmitRef = React.useRef<() => void>(() => {});
  const resumeVoiceCaptureRef = React.useRef<() => void>(() => {});
  const systemStateRef = React.useRef<SystemState>("idle");
  const bargeInRef = React.useRef<() => void>(() => {});
  const lastBargeAtRef = React.useRef(0);
  const voiceHeroRef = React.useRef<VoiceHeroVisualHandle>(null);
  const speakRef = React.useRef<(text: string) => void>(() => {});
  const requestedCardRef = React.useRef<HTMLDivElement | null>(null);

  const refreshPatients = React.useCallback(async () => {
    try {
      const res = await fetch("/api/patients");
      if (!res.ok) return;
      const data = (await res.json()) as { patients?: DemoPatient[] };
      const list = data.patients ?? [];
      setPatients(list);
      setSelectedPatientId((cur) => {
        if (cur && list.some((p) => p.id === cur)) return cur;
        return null;
      });
    } catch {
      /* ignore — roster is best-effort until server is up */
    }
  }, []);

  const commitChartPatch = React.useCallback(
    async (
      patientId: string,
      patch: Record<string, unknown>,
      optimistic: Partial<DemoPatient>
    ) => {
      if (!permissions.canEditPatientStatus) {
        setChartSaveError(ACCESS_RESTRICTED_MESSAGE);
        return;
      }
      let snapshot: DemoPatient | undefined;
      setPatients((prev) => {
        snapshot = prev.find((p) => p.id === patientId);
        return prev.map((p) =>
          p.id === patientId ? { ...p, ...optimistic } : p
        );
      });
      const result = await persistPatientPatch(patientId, patch);
      if (!result.ok) {
        if (snapshot) {
          const rolled = snapshot;
          setPatients((prev) =>
            prev.map((p) => (p.id === patientId ? rolled : p))
          );
        }
        setChartSaveError(result.error ?? "Unable to save chart changes.");
        return;
      }
      setChartSaveError(null);
      if (result.patient) {
        const saved = result.patient;
        setPatients((prev) =>
          prev.map((p) => (p.id === patientId ? saved : p))
        );
      }
    },
    [apiRole, permissions.canEditPatientStatus]
  );

  React.useEffect(() => {
    void refreshPatients();
  }, [refreshPatients]);

  /* clock for status bar */
  React.useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  React.useEffect(() => {
    systemStateRef.current = systemState;
  }, [systemState]);

  React.useEffect(() => {
    const id = window.setInterval(() => {
      const base =
        systemState === "listening"
          ? 12
          : systemState === "processing"
            ? 9
            : systemState === "speaking"
              ? 8
              : 3;
      const variance = systemState === "idle" ? 2 : 8;
      setWaveformBars(
        Array.from({ length: 28 }, (_, i) =>
          Math.max(2, base + Math.round(Math.sin((Date.now() / 170) + i) * variance))
        )
      );
    }, 120);
    return () => window.clearInterval(id);
  }, [systemState]);

  React.useEffect(() => {
    conversationTurnsRef.current = conversationTurns;
  }, [conversationTurns]);

  /** Browsers often pause SpeechRecognition while TTS plays — keep the mic alive so talking can interrupt audio. */
  React.useEffect(() => {
    if (systemState !== "speaking") return;
    const ensureMic = () => {
      if (!voiceSessionActiveRef.current || !listeningIntentRef.current) return;
      if (micMutedRef.current) return;
      if (typeof window === "undefined" || !window.speechSynthesis?.speaking) {
        return;
      }
      const rec = recognitionRef.current;
      if (!rec || recognitionActiveRef.current) return;
      try {
        rec.start();
      } catch {
        startListeningContinueRef.current({ hard: false });
      }
    };
    ensureMic();
    const id = window.setInterval(ensureMic, 750);
    return () => window.clearInterval(id);
  }, [systemState]);

  React.useEffect(() => {
    if (!selectedPatientId) {
      setPatientSnapshot("");
      return;
    }
    const p = patients.find((x) => x.id === selectedPatientId);
    if (p) setPatientSnapshot(patientToSnapshot(p));
  }, [selectedPatientId, patients]);

  React.useEffect(() => {
    setProblemStateByPatient((prev) => {
      const next = { ...prev };
      for (const patient of patients) {
        next[patient.id] = problemsToEditable(
          patient.id,
          patient.problems,
          patient.diagnoses
        );
      }
      return next;
    });
  }, [patients]);

  React.useEffect(() => {
    const activeTimers = pendingOrders
      .filter((order) => order.stepIndex < ORDER_WORKFLOW_STEPS.length - 1)
      .map((order) => {
        const nextStep = ORDER_WORKFLOW_STEPS[order.stepIndex];
        return globalThis.setTimeout(() => {
          setPendingOrders((prev) =>
            prev.map((item) => {
              if (item.id !== order.id) return item;
              const nextIndex = Math.min(item.stepIndex + 1, ORDER_WORKFLOW_STEPS.length - 1);
              const nextStatus = ORDER_WORKFLOW_STEPS[nextIndex].status;
              if (nextStatus === "Ready for Pickup") {
                setOrderNotice("Pharmacy preparation complete.");
              }
              if (nextStatus === "Nurse Assigned") {
                setOrderNotice(`Nurse assigned: ${item.nurseName}.`);
              }
              if (nextStatus === "Delivered") {
                setOrderNotice(`Medication delivered successfully to ${item.room}.`);
                if (voiceEnabled && supportsTts) {
                  speakRef.current(`Medication delivered to ${item.room}.`);
                }
              }
              return {
                ...item,
                stepIndex: nextIndex,
                status: nextStatus,
                completedAt: nextStatus === "Delivered" ? Date.now() : item.completedAt,
              };
            })
          );
        }, nextStep.delayMs);
      });
    return () => {
      for (const timer of activeTimers) {
        globalThis.clearTimeout(timer);
      }
    };
  }, [pendingOrders, supportsTts, voiceEnabled]);

  React.useEffect(() => {
    const clearTimers = () => {
      if (ordersFadeTimerRef.current) {
        globalThis.clearTimeout(ordersFadeTimerRef.current);
        ordersFadeTimerRef.current = null;
      }
      if (ordersPanelClearTimerRef.current) {
        globalThis.clearTimeout(ordersPanelClearTimerRef.current);
        ordersPanelClearTimerRef.current = null;
      }
    };

    if (pendingOrders.length === 0) {
      clearTimers();
      setOrdersPanelVisible(false);
      return;
    }

    setOrdersPanelVisible(true);
    const allDelivered = pendingOrders.every((order) => order.status === "Delivered");
    if (!allDelivered) {
      clearTimers();
      return;
    }

    clearTimers();
    ordersFadeTimerRef.current = globalThis.setTimeout(() => {
      setOrdersPanelVisible(false);
      ordersPanelClearTimerRef.current = globalThis.setTimeout(() => {
        setPendingOrders([]);
      }, 450);
    }, 5000);

    return clearTimers;
  }, [pendingOrders]);

  React.useEffect(() => {
    if (!problemStatusFlashId) return;
    const timer = globalThis.setTimeout(() => setProblemStatusFlashId(null), 900);
    return () => globalThis.clearTimeout(timer);
  }, [problemStatusFlashId]);

  React.useEffect(() => {
    if (!orderNotice) return;
    const timer = globalThis.setTimeout(() => setOrderNotice(null), 2600);
    return () => globalThis.clearTimeout(timer);
  }, [orderNotice]);

  React.useEffect(() => {
    if (!chartSaveError) return;
    const timer = globalThis.setTimeout(() => setChartSaveError(null), 5000);
    return () => globalThis.clearTimeout(timer);
  }, [chartSaveError]);

  /* feature detection */
  React.useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: SRCtor;
      webkitSpeechRecognition?: SRCtor;
    };
    const secure =
      window.isSecureContext ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (!secure) {
      setSupportsSpeech(false);
      setSupportsTts(false);
      setSystemState("error");
      setError(
        "Speech and voice need a secure context. Use http://localhost:3000 (not a raw LAN IP) or HTTPS."
      );
      return;
    }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setSupportsSpeech(false);
      setSystemState("error");
      setError(
        "This browser does not support the SpeechRecognition API. Use Chrome, Edge, or another Chromium-based browser."
      );
    }
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setSupportsTts(false);
    }
  }, []);

  /* keep finalRef in sync so async handlers can read latest */
  React.useEffect(() => {
    finalRef.current = finalTranscript;
  }, [finalTranscript]);

  /* Prime speech voices (Chrome often returns [] until voiceschanged). */
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const kick = () => {
      void window.speechSynthesis.getVoices();
    };
    kick();
    window.speechSynthesis.addEventListener("voiceschanged", kick);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", kick);
  }, []);

  /* unmount cleanup */
  React.useEffect(() => {
    return () => {
      listeningIntentRef.current = false;
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      try {
        recognitionRef.current?.abort();
      } catch {
        /* noop */
      }
      recognitionRef.current = null;
      recognitionActiveRef.current = false;
      ignoreNextEndRef.current = false;
      resumeStartAfterEndRef.current = false;
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      abortRef.current?.abort();
    };
  }, []);

  const bargeIn = React.useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    abortRef.current?.abort();
    systemStateRef.current = "listening";
    setSystemState("listening");
  }, []);

  React.useEffect(() => {
    bargeInRef.current = bargeIn;
  }, [bargeIn]);

  const updateHeardPreview = React.useCallback((final: string, interim: string) => {
    const line = `${final} ${interim}`.trim();
    setHeardPreview(line);
  }, []);
  const updateHeardPreviewRef = React.useRef(updateHeardPreview);

  React.useEffect(() => {
    updateHeardPreviewRef.current = updateHeardPreview;
  }, [updateHeardPreview]);

  /**
   * Closes the utterance, uploads it, and submits whichever transcript won.
   *
   * Whisper is authoritative; SR's text is the safety net. A Whisper failure
   * never blocks the command - it demotes and is reported in the system panel,
   * because a silent demote is how a dead provider goes unnoticed for weeks.
   */
  const finalizeAndSubmit = React.useCallback(
    async (browserText: string) => {
      let choice: TranscriptChoice = {
        text: browserText,
        source: "browser",
        degradedReason: "Audio capture unavailable in this browser.",
      };

      if (recorderRef.current.available) {
        /* Whisper adds ~400ms between endpoint and submit; show work immediately. */
        setSystemState("processing");
        const outcome = await recorderRef.current.finalize();
        choice = outcome
          ? chooseTranscript(outcome, browserText)
          : {
              text: browserText,
              source: "browser",
              degradedReason: "Clip too short to transcribe.",
            };
      }

      setSttChoice(choice);
      if (choice.degradedReason) {
        console.warn("[STT] degraded to browser transcript", choice.degradedReason);
      }

      if (!choice.text) {
        setSystemState("idle");
        return;
      }

      setLastSubmittedTranscript(choice.text);
      setHeardPreview(choice.text);
      await submitRef.current(choice.text);
    },
    [apiRole]
  );
  const finalizeAndSubmitRef = React.useRef(finalizeAndSubmit);
  finalizeAndSubmitRef.current = finalizeAndSubmit;

  const armSilenceSubmit = React.useCallback(() => {
    if (!voiceSessionActiveRef.current) return;
    if (micMutedRef.current) return;
    if (systemStateRef.current === "processing") return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = globalThis.setTimeout(() => {
      silenceTimerRef.current = null;
      if (!voiceSessionActiveRef.current) return;
      if (micMutedRef.current) return;
      if (systemStateRef.current === "processing") return;
      const browserText = (finalRef.current + " " + interimRef.current).trim();
      if (!browserText) return;
      setHeardPreview(browserText);
      setFinalTranscript("");
      finalRef.current = "";
      setInterimTranscript("");
      interimRef.current = "";
      void finalizeAndSubmitRef.current(browserText);
    }, 1600);
  }, []);

  const resumeVoiceCapture = React.useCallback(() => {
    if (!voiceSessionActiveRef.current) return;
    if (micMutedRef.current) return;
    globalThis.setTimeout(() => {
      if (!voiceSessionActiveRef.current) return;
      if (micMutedRef.current) return;
      /* Drop the TTS playback and silence buffered since the last submit. */
      recorderRef.current.discard();
      startListeningContinueRef.current({ hard: false });
    }, 400);
  }, []);

  React.useEffect(() => {
    resumeVoiceCaptureRef.current = resumeVoiceCapture;
  }, [resumeVoiceCapture]);

  React.useEffect(() => {
    scheduleSilenceSubmitRef.current = armSilenceSubmit;
  }, [armSilenceSubmit]);

  /* ──────────────────────────────────────────────────────────────────────
   * Speech recognition
   * ────────────────────────────────────────────────────────────────────── */

  const disposeRecognition = React.useCallback(() => {
    ignoreNextEndRef.current = true;
    try {
      recognitionRef.current?.abort();
    } catch {
      /* noop */
    }
    recognitionRef.current = null;
    recognitionActiveRef.current = false;
  }, []);

  /** Always returns a new instance — never reuse a dead SR object. */
  const mountRecognition = React.useCallback((): SR | null => {
    const w = window as unknown as {
      SpeechRecognition?: SRCtor;
      webkitSpeechRecognition?: SRCtor;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return null;

    const rec = new Ctor();
    rec.lang = "en-US";
    /* true = one Start keeps dictation open; avoids tight start/stop loops with getUserMedia conflicts */
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      recognitionActiveRef.current = true;
      setSystemState("listening");
      setError(null);
    };

    rec.onaudiostart = () => {
      setSystemState("listening");
    };

    rec.onresult = (ev) => {
      if (micMutedRef.current) return;

      const { interim, finalDelta } = readRecognitionTranscripts(ev);

      const heard = Boolean(finalDelta.trim() || interim.trim());
      const ttsOn =
        typeof window !== "undefined" && Boolean(window.speechSynthesis?.speaking);

      if (heard) {
        voiceHeroRef.current?.bump();
      }

      if (
        heard &&
        systemStateRef.current === "processing" &&
        voiceSessionActiveRef.current
      ) {
        bargeInRef.current();
        setFinalTranscript("");
        setInterimTranscript("");
        finalRef.current = "";
        interimRef.current = "";
        updateHeardPreviewRef.current("", "");
      } else if (ttsOn) {
        const finalLen = finalDelta.trim().length;
        const interimLen = interim.trim().length;
        const shouldInterruptTts =
          finalLen >= MIN_FINAL_CHARS_TO_BARGE_TTS ||
          interimLen >= MIN_INTERIM_CHARS_TO_BARGE_TTS;
        if (shouldInterruptTts && Date.now() - lastBargeAtRef.current > 650) {
          lastBargeAtRef.current = Date.now();
          bargeInRef.current();
          scheduleSilenceSubmitRef.current();
        }
      }

      let nextFinal = finalRef.current;
      if (finalDelta) {
        nextFinal = (nextFinal ? `${nextFinal} ` : "") + finalDelta.trim();
        finalRef.current = nextFinal;
        setFinalTranscript(nextFinal);
      }
      interimRef.current = interim;
      setInterimTranscript(interim);
      updateHeardPreviewRef.current(nextFinal, interim);

      if (
        heard &&
        voiceSessionActiveRef.current &&
        !ttsOn &&
        systemStateRef.current !== "processing"
      ) {
        scheduleSilenceSubmitRef.current();
      }
    };

    rec.onerror = (ev) => {
      recognitionActiveRef.current = false;
      const code = ev.error;
      if (code === "aborted") {
        return;
      }
      if (code === "no-speech" || code === "audio-capture") {
        if (!intentionallyStoppedRef.current) {
          try {
            intentionallyStoppedRef.current = false;
            rec.start();
          } catch {
            /* already starting */
          }
        }
        return;
      }
      let msg = `Microphone error: ${code}`;
      if (code === "not-allowed" || code === "service-not-allowed") {
        listeningIntentRef.current = false;
        voiceSessionActiveRef.current = false;
        setVoiceSessionLive(false);
        msg =
          "Microphone permission was denied. Allow mic access in your browser to use VITAL OS.";
      } else if (code === "network") {
        msg =
          "Speech recognition needs an internet connection (Chrome sends audio to Google). Check your network.";
        setError(msg);
        setSystemState("listening");
        resumeVoiceCaptureRef.current();
        return;
      } else {
        listeningIntentRef.current = false;
        voiceSessionActiveRef.current = false;
        setVoiceSessionLive(false);
      }
      setError(msg);
      setSystemState("error");
      shouldSubmitOnEndRef.current = false;
    };

    rec.onend = () => {
      recognitionActiveRef.current = false;
      if (!listeningIntentRef.current) {
        setInterimTranscript("");
        interimRef.current = "";
      }

      if (ignoreNextEndRef.current) {
        ignoreNextEndRef.current = false;
        return;
      }

      if (resumeStartAfterEndRef.current) {
        resumeStartAfterEndRef.current = false;
        try {
          intentionallyStoppedRef.current = false;
          rec.start();
        } catch {
          listeningIntentRef.current = false;
          setError("Could not start the microphone. Please try again.");
          setSystemState("error");
        }
        return;
      }

      const shouldSubmit = shouldSubmitOnEndRef.current;
      shouldSubmitOnEndRef.current = false;

      if (shouldSubmit) {
        const browserText = finalRef.current.trim();
        if (browserText) {
          void finalizeAndSubmitRef.current(browserText);
        } else {
          setSystemState("idle");
        }
        listeningIntentRef.current = false;
        return;
      }

      /* Unexpected end (not a user stop/mute) — restart recognition in place. */
      if (!intentionallyStoppedRef.current) {
        try {
          intentionallyStoppedRef.current = false;
          rec.start();
        } catch {
          /* already starting */
        }
        return;
      }

      setSystemState((s) => (s === "listening" ? "idle" : s));
    };

    recognitionRef.current = rec;
    return rec;
  }, []);

  const startListening = React.useCallback(
    async (opts?: { hard?: boolean }) => {
      const hard = opts?.hard ?? true;
      setError(null);
      if (!supportsSpeech) {
        setError(
          "SpeechRecognition is not available in this browser. Try Chrome or Edge."
        );
        setSystemState("error");
        return;
      }

      if (!hard) {
        if (
          !listeningIntentRef.current &&
          !voiceSessionActiveRef.current
        ) {
          return;
        }
        if (micMutedRef.current) return;
        await new Promise<void>((r) => setTimeout(r, 60));
        let rec = recognitionRef.current;
        if (!rec) {
          rec = mountRecognition();
          if (!rec) return;
        }
        if (recognitionActiveRef.current) return;
        try {
          intentionallyStoppedRef.current = false;
          rec.start();
        } catch (err) {
          const invalid =
            err instanceof DOMException && err.name === "InvalidStateError";
          if (invalid) {
            resumeStartAfterEndRef.current = true;
            try {
              rec.abort();
            } catch {
              resumeStartAfterEndRef.current = false;
              disposeRecognition();
              await new Promise<void>((r) => setTimeout(r, 80));
              const again = mountRecognition();
              if (!again) return;
              try {
                intentionallyStoppedRef.current = false;
                again.start();
              } catch {
                setError("Could not start the microphone. Please try again.");
                setSystemState("error");
              }
            }
            return;
          }
          setError("Could not start the microphone. Please try again.");
          setSystemState("error");
        }
        return;
      }

      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }

      listeningIntentRef.current = true;
      disposeRecognition();
      await new Promise<void>((r) => setTimeout(r, 80));

      const rec = mountRecognition();
      if (!rec) {
        listeningIntentRef.current = false;
        return;
      }

      setFinalTranscript("");
      finalRef.current = "";
      setInterimTranscript("");
      interimRef.current = "";
      setHeardPreview("");
      shouldSubmitOnEndRef.current = false;
      resumeStartAfterEndRef.current = false;

      try {
        intentionallyStoppedRef.current = false;
        rec.start();
      } catch (err) {
        const invalid =
          err instanceof DOMException && err.name === "InvalidStateError";
        if (invalid) {
          resumeStartAfterEndRef.current = true;
          try {
            rec.abort();
          } catch {
            resumeStartAfterEndRef.current = false;
            disposeRecognition();
            await new Promise<void>((r) => setTimeout(r, 80));
            const again = mountRecognition();
            if (!again) {
              listeningIntentRef.current = false;
              return;
            }
            try {
              intentionallyStoppedRef.current = false;
              again.start();
            } catch {
              listeningIntentRef.current = false;
              setError("Could not start the microphone. Please try again.");
              setSystemState("error");
            }
          }
          return;
        }
        listeningIntentRef.current = false;
        setError("Could not start the microphone. Please try again.");
        setSystemState("error");
      }
    },
    [disposeRecognition, mountRecognition, supportsSpeech]
  );

  React.useEffect(() => {
    startListeningContinueRef.current = (o?: { hard?: boolean }) => {
      void startListening(o);
    };
  }, [startListening]);

  const stopListening = React.useCallback((opts?: { submit?: boolean }) => {
    intentionallyStoppedRef.current = true;
    listeningIntentRef.current = false;
    const rec = recognitionRef.current;
    if (!rec) {
      setSystemState("idle");
      return;
    }
    shouldSubmitOnEndRef.current = opts?.submit === true;
    try {
      rec.stop();
    } catch {
      try {
        rec.abort();
      } catch {
        /* noop */
      }
    }
  }, []);

  const resetSession = React.useCallback(() => {
    setRequestedPatientView(null);
    setActiveRequestedSections([]);
    setSelectedPatientId(null);
    setOpenPatientTabIds([]);
    setResponse(null);
    setError(null);
    setFinalTranscript("");
    finalRef.current = "";
    setInterimTranscript("");
    interimRef.current = "";
    setLastSubmittedTranscript("");
    setLastCommand("System ready");
    setAdmissionConversation(EMPTY_ADMISSION);
  }, []);

  const pushLocalAssistantResponse = React.useCallback(
    (command: string, text: string) => {
      const local: VitalApiResponse = {
        text,
        mode: "general",
        model: "Local command router",
        latencyMs: 120,
      };
      setResponse(local);
      setConversationTurns((prev) =>
        [
          ...prev,
          { role: "user" as const, content: command },
          { role: "assistant" as const, content: text },
        ].slice(-40)
      );
      setAudit((prev) =>
        [
          {
            id: uid(),
            at: Date.now(),
            mode: "general" as const,
            command,
            response: text,
            model: "Local command router",
            latencyMs: 120,
            kind: "exchange" as const,
          },
          ...prev,
        ].slice(0, 180)
      );
      if (voiceEnabled && supportsTts) {
        speakRef.current(text);
      } else {
        setSystemState("idle");
        resumeVoiceCaptureRef.current();
      }
    },
    [supportsTts, voiceEnabled]
  );

  const openRequestedView = React.useCallback(
    async (patient: DemoPatient, sections: PatientFieldKey[]) => {
      setSelectedPatientId(patient.id);
      setOpenPatientTabIds((prev) =>
        prev.includes(patient.id) ? prev : [...prev, patient.id].slice(-5)
      );
      setActiveRequestedSections(sections);
      setIsChartLoading(true);
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 360));
      setRequestedPatientView(buildRequestedPatientView(patient, sections));
      setIsChartLoading(false);
      globalThis.setTimeout(() => {
        requestedCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 40);
    },
    []
  );

  const queueMedicationFromDraft = React.useCallback(
    (draft: PendingMedicationDraft) => {
      const target = patients.find((p) => p.id === draft.patientId);
      if (!target) return;
      const sigParts = [
        draft.dose,
        draft.route,
        draft.frequency,
      ].filter(Boolean);
      const medicationLabel = sigParts.length
        ? `${draft.medication} (${sigParts.join(", ")})`
        : draft.medication;
      const nurseName = pickBySeed(MOCK_NURSES, `${target.id}-${draft.medication}`);
      const pharmacyStation = pickBySeed(
        MOCK_PHARMACY,
        `${draft.medication}-${target.room}`
      );
      setPendingOrders((prev) =>
        [
          {
            id: uid(),
            patientId: target.id,
            patientName: target.name,
            room: target.room,
            medication: medicationLabel,
            status: "Order Queued" as const,
            nurseName,
            pharmacyStation,
            stepIndex: 0,
            createdAt: Date.now(),
          },
          ...prev,
        ].slice(0, 12)
      );
      setOrdersPanelVisible(true);
      if (selectedPatientId !== target.id) {
        setSelectedPatientId(target.id);
      }
      if (!activeRequestedSections.includes("medications")) {
        setActiveRequestedSections((prev) => [...prev, "medications"]);
      }
    },
    [patients, selectedPatientId, activeRequestedSections]
  );

  const applyClinicalApiResult = React.useCallback(
    async (
      command: string,
      data: ClinicalCommandResponse
    ): Promise<boolean> => {
      const { action, assistantResponse, parsedIntent } = data;

      /* Recorded before the unknown-intent bail: a parse that came back
         unknown still tells us which provider produced it. */
      if (parsedIntent.provider) {
        setIntentRoute({
          provider: parsedIntent.provider,
          latencyMs: parsedIntent.parseLatencyMs ?? null,
          fallbackReason: parsedIntent.fallbackReason ?? null,
        });
      }

      if (action?.type === "unknown" || parsedIntent.intent === "unknown") {
        return false;
      }

      const pushGeminiResponse = (text: string, model = "Gemini clinical command") => {
        const local: VitalApiResponse = {
          text,
          mode: "general",
          model,
          latencyMs: 0,
        };
        setResponse(local);
        setConversationTurns((prev) =>
          [
            ...prev,
            { role: "user" as const, content: command },
            { role: "assistant" as const, content: text },
          ].slice(-40)
        );
        setAudit((prev) =>
          [
            {
              id: uid(),
              at: Date.now(),
              mode: "general" as const,
              command,
              response: text,
              model,
              latencyMs: 0,
              kind: "exchange" as const,
            },
            ...prev,
          ].slice(0, 180)
        );
        if (voiceEnabled && supportsTts) {
          speakRef.current(text);
        } else {
          setSystemState("idle");
          resumeVoiceCaptureRef.current();
        }
      };

      if (!action) {
        if (assistantResponse) {
          pushGeminiResponse(assistantResponse);
          return true;
        }
        return false;
      }

      switch (action.type) {
        case "clarification":
          pushGeminiResponse(action.payload.question || assistantResponse);
          return true;

        case "roster_answer":
          pushGeminiResponse(action.payload.text || assistantResponse);
          return true;

        case "open_patient_chart": {
          const patient = patients.find((p) => p.id === action.payload.patientId);
          if (!patient) {
            pushGeminiResponse("Patient not found on the roster.");
            return true;
          }
          const sections = apiSectionsToFields(action.payload.sections);
          await openRequestedView(patient, sections);
          const editable = problemStateByPatient[patient.id] ?? [];
          const spoken = buildVoiceSummaryForChartOpen(
            command,
            patient,
            sections,
            editable
          );
          pushGeminiResponse(spoken || assistantResponse);
          return true;
        }

        case "medication_order_draft":
          if (!permissions.canCreateMedicationOrders) {
            pushGeminiResponse(ACCESS_RESTRICTED_MESSAGE);
            return true;
          }
          setPendingMedicationOrder(action.payload);
          setClinicalReasoning(null);
          pushGeminiResponse(assistantResponse);
          return true;

        case "discharge_confirm":
          if (!permissions.canDischargePatient) {
            pushGeminiResponse(PERMISSION_DENIED_MESSAGE);
            return true;
          }
          setDischargeWorkflow({
            patientId: action.payload.patientId,
            patientName:
              patients.find((p) => p.id === action.payload.patientId)?.name ??
              "patient",
            step: "confirm",
          });
          setDischargeConfirmId(action.payload.patientId);
          setPendingMedicationOrder(null);
          pushGeminiResponse(
            assistantResponse ||
              `Are you sure you want to discharge ${
                patients.find((p) => p.id === action.payload.patientId)?.name ??
                "this patient"
              }?`
          );
          return true;

        case "update_problem_status": {
          if (!permissions.canEditPatientStatus) {
            pushGeminiResponse(ACCESS_RESTRICTED_MESSAGE);
            return true;
          }
          const patient = patients.find((p) => p.id === action.payload.patientId);
          if (!patient) {
            pushGeminiResponse("Patient not found.");
            return true;
          }
          const status = action.payload.status as ProblemStatus;
          const statusOk = PROBLEM_STATUS_OPTIONS.includes(status);
          if (!statusOk) {
            pushGeminiResponse(assistantResponse);
            return true;
          }
          const existing = problemStateByPatient[patient.id] ?? [];
          const problemKey = normalizeProblemKey(action.payload.problem);
          const matched = existing.filter((item) =>
            normalizeProblemKey(item.name).includes(problemKey)
          );
          if (!matched.length) {
            pushGeminiResponse(
              `Could not find problem "${action.payload.problem}" on ${patient.name}'s list.`
            );
            return true;
          }
          const ids = new Set(matched.map((m) => m.id));
          setProblemStateByPatient((prev) => ({
            ...prev,
            [patient.id]: (prev[patient.id] ?? []).map((item) =>
              ids.has(item.id) ? { ...item, status } : item
            ),
          }));
          if (selectedPatientId !== patient.id) {
            setSelectedPatientId(patient.id);
          }
          void openRequestedView(patient, ["diagnoses"]);
          pushGeminiResponse(assistantResponse);
          return true;
        }

        case "clinical_reasoning":
          if (!permissions.canUseAI) {
            pushGeminiResponse(ACCESS_RESTRICTED_MESSAGE);
            return true;
          }
          setClinicalReasoning(action.payload.reasoning);
          setWorkspaceOpen(true);
          setWorkspaceTab("response");
          pushGeminiResponse(assistantResponse, "Gemini clinical reasoning");
          return true;

        case "admit_patient": {
          if (!permissions.canAdmitPatient) {
            pushGeminiResponse(ACCESS_RESTRICTED_MESSAGE);
            return true;
          }
          const lower = command.toLowerCase();
          if (isAdmitIntent(lower)) {
            return false;
          }
          const cleaned = cleanVoiceCommand(command);
          const boot = parseAdmissionBootstrap(command);
          let draft: AdmissionDraft = {
            active: true,
            data: boot,
            currentStep: "name",
            nameConfirmed: false,
            medicationsCaptured: bootstrapExplicitMedicationsCaptured(cleaned),
            missingFields: [],
            lastQuestionAsked: "",
          };
          draft.currentStep = getNextAdmissionStep(draft);
          draft.missingFields = computeMissingFields(draft);
          setAdmissionConversation(draft);
          pushGeminiResponse(
            draft.currentStep === "done"
              ? "Ready to finalize admission."
              : admissionPromptForStep(draft)
          );
          return true;
        }

        default:
          if (assistantResponse) {
            pushGeminiResponse(assistantResponse);
            return true;
          }
          return false;
      }
    },
    [
      patients,
      selectedPatientId,
      problemStateByPatient,
      openRequestedView,
      voiceEnabled,
      supportsTts,
      activeRequestedSections,
      permissions,
    ]
  );

  const handleClinicalCommand = React.useCallback(
    async (commandText: string): Promise<boolean> => {
      const command = commandText.trim();
      if (!command) return false;
      setLastCommand(command);
      const lower = command.toLowerCase();

      if (isResetCommand(lower) || /logout/.test(lower)) {
        resetSession();
        logout();
        pushLocalAssistantResponse(command, "Session ended. Panels cleared.");
        return true;
      }

      if (!permissions.canAdmitPatient && isAdmitIntent(lower)) {
        pushLocalAssistantResponse(command, ACCESS_RESTRICTED_MESSAGE);
        return true;
      }

      if (!permissions.canDischargePatient && isDischargeIntent(lower)) {
        pushLocalAssistantResponse(command, PERMISSION_DENIED_MESSAGE);
        return true;
      }

      if (role !== "doctor" && matchesStatusIntent(command)) {
        pushLocalAssistantResponse(command, PERMISSION_DENIED_MESSAGE);
        return true;
      }

      if (!permissions.canEditPatientStatus && matchesStatusIntent(command)) {
        pushLocalAssistantResponse(command, ACCESS_RESTRICTED_MESSAGE);
        return true;
      }

      const parsedVoice = parsePatientCommand(command);
      if (parsedVoice.intent !== "unknown") {
        if (requiresDoctorRole(parsedVoice.intent) && role !== "doctor") {
          pushLocalAssistantResponse(command, PERMISSION_DENIED_MESSAGE);
          return true;
        }

        if (parsedVoice.intent === "undo") {
          const snap = lastUndoRef.current;
          if (!snap) {
            pushLocalAssistantResponse(command, "There is no recent change to undo.");
            return true;
          }
          const { ok } = await persistPatientPatch(snap.patientId, snap.patch);
          lastUndoRef.current = null;
          if (!ok) {
            pushLocalAssistantResponse(command, "Undo failed. Try again.");
            return true;
          }
          await refreshPatients();
          pushLocalAssistantResponse(
            command,
            `Undid the last ${snap.description} change.`
          );
          return true;
        }

        if (parsedVoice.intent === "dischargePatient") {
          const resolved = resolvePatientForModification(patients, {
            transcript: command,
            patientHint: parsedVoice.patientHint,
            activePatientId: selectedPatientId,
          });
          if (resolved.status === "ambiguous") {
            pushLocalAssistantResponse(
              command,
              resolved.message || formatAmbiguousPatientPrompt(resolved.patients)
            );
            return true;
          }
          if (resolved.status === "not_found") {
            pushLocalAssistantResponse(
              command,
              resolved.message ??
                "Please confirm which patient should be discharged."
            );
            return true;
          }
          setDischargeWorkflow({
            patientId: resolved.patient.id,
            patientName: resolved.patient.name,
            step: "confirm",
          });
          setDischargeConfirmId(resolved.patient.id);
          pushLocalAssistantResponse(
            command,
            `Are you sure you want to discharge ${resolved.patient.name}?`
          );
          return true;
        }

        const resolved = resolvePatientForModification(patients, {
          transcript: command,
          patientHint: parsedVoice.patientHint,
          activePatientId: selectedPatientId,
        });
        if (resolved.status === "ambiguous") {
          pushLocalAssistantResponse(
            command,
            resolved.message || formatAmbiguousPatientPrompt(resolved.patients)
          );
          return true;
        }
        if (resolved.status === "not_found" && parsedVoice.confidence === "high") {
          if (parsedVoice.intent === "patientSummary") {
            pushLocalAssistantResponse(
              command,
              resolved.message ?? "I could not find that patient on the roster."
            );
            return true;
          }
          const explicitName = extractModificationPatientName(
            command,
            parsedVoice.patientHint
          );
          if (explicitName) {
            pushLocalAssistantResponse(
              command,
              resolved.message ?? "I could not find that patient on the roster."
            );
            return true;
          }
          if (
            parsedVoice.intent !== "addSymptom" &&
            parsedVoice.intent !== "removeSymptom" &&
            parsedVoice.intent !== "updateSymptomStatus" &&
            parsedVoice.intent !== "updateChiefConcern" &&
            parsedVoice.intent !== "addChartNote" &&
            parsedVoice.intent !== "updateMedicationDosage" &&
            parsedVoice.intent !== "removeMedication" &&
            parsedVoice.intent !== "replaceMedication"
          ) {
            pushLocalAssistantResponse(
              command,
              resolved.message ?? "I could not find that patient on the roster."
            );
            return true;
          }
        }

        const explicitName = extractModificationPatientName(
          command,
          parsedVoice.patientHint
        );
        const targetPatient =
          resolved.status === "matched"
            ? resolved.patient
            : !explicitName && selectedPatientId
              ? patients.find((p) => p.id === selectedPatientId) ?? null
              : null;

        if (!targetPatient && parsedVoice.confidence === "high") {
          pushLocalAssistantResponse(
            command,
            "Please specify which patient you would like to update."
          );
          return true;
        }

        if (targetPatient) {
          const providerName =
            role === "doctor" && user?.userName
              ? formatDoctorDisplayName(user.userName)
              : user?.userName ?? "Provider";
          const result = applyParsedCommandToPatient(
            targetPatient,
            parsedVoice,
            providerName
          );
          if (result) {
            if (Object.keys(result.patch).length > 0) {
              const { ok } = await persistPatientPatch(
                targetPatient.id,
                result.patch
              );
              if (!ok) {
                pushLocalAssistantResponse(command, "Update failed. Try again.");
                return true;
              }
              if (result.undo) lastUndoRef.current = result.undo;
              await refreshPatients();
              if (selectedPatientId !== targetPatient.id) {
                setSelectedPatientId(targetPatient.id);
              }
            }
            pushLocalAssistantResponse(command, result.message);
            return true;
          }
        }
      }

      const focusedPatientEarly = findFocusedPatientFromCommand(command, patients);

      const finalizeAdmissionConversation = async (
        draft: AdmissionDraft,
        early: boolean
      ) => {
        if (isCreatingPatientRef.current) {
          console.warn("[PATIENT CREATE] Ignoring duplicate confirmation while create is in progress");
          return;
        }

        const d = draft.data;
        const nameOk = Boolean(d.name?.trim());
        const ageOk = typeof d.age === "number" && Number.isFinite(d.age);
        const sexOk = d.sex === "M" || d.sex === "F" || d.sex === "U";
        const roomOk = Boolean(d.room?.trim());
        const chiefOk = Boolean(d.chiefConcern?.trim());
        const ready = draft.nameConfirmed && nameOk && ageOk && sexOk && roomOk && chiefOk;

        if (!ready) {
          setAdmissionConversation(draft);
          const missingPrompt = missingAdmissionFieldPrompt(draft);
          pushLocalAssistantResponse(
            command,
            missingPrompt ?? admissionPromptForStep(draft)
          );
          return;
        }

        const payload = buildAdmissionPayload(draft.data);
        console.log("[PATIENT CREATE] Frontend payload:", payload);

        isCreatingPatientRef.current = true;
        try {
          const res = await fetch("/api/patients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const body = (await res.json().catch(() => ({}))) as {
            patient?: DemoPatient;
            error?: string;
            code?: string;
            details?: string;
            hint?: string;
          };
          console.log("[PATIENT CREATE] API response:", {
            status: res.status,
            ok: res.ok,
            error: body.error,
            code: body.code,
            details: body.details,
            hint: body.hint,
            patientId: body.patient?.id,
          });
          if (!res.ok) {
            const detail = body.error?.trim() || `HTTP ${res.status}`;
            pushLocalAssistantResponse(
              command,
              `Unable to create patient: ${detail}`
            );
            return;
          }
          await refreshPatients();
          setAdmissionConversation(EMPTY_ADMISSION);
          const created = body.patient;
          if (created?.id) {
            setSelectedPatientId(created.id);
          }
          const roomLabel = created?.room ?? draft.data.room ?? "Unassigned";
          const message = created
            ? buildAdmissionFinalizeMessage(created, { early, roomLabel })
            : "Patient successfully admitted.";
          pushLocalAssistantResponse(command, message);
        } finally {
          isCreatingPatientRef.current = false;
        }
      };

      if (admissionConversation.active) {
        if (isAdmissionFinalizePhrase(command)) {
          const merged = mergeAdmissionAnswer(admissionConversation, command);
          await finalizeAdmissionConversation(merged, true);
          return true;
        }
        const merged = mergeAdmissionAnswer(admissionConversation, command);
        if (merged.currentStep === "done") {
          await finalizeAdmissionConversation(merged, false);
          return true;
        }
        setAdmissionConversation(merged);
        pushLocalAssistantResponse(command, admissionPromptForStep(merged));
        return true;
      }

      const focusedPatient = focusedPatientEarly ?? findFocusedPatientFromCommand(command, patients);
      if (focusedPatient) {
        setSelectedPatientId(focusedPatient.id);
      }

      if (isDischargeIntent(lower) && !dischargeWorkflow) {
        const parsedDischarge = parsePatientCommand(command);
        const resolved = resolvePatientForModification(patients, {
          transcript: command,
          patientHint: parsedDischarge.patientHint,
          activePatientId: selectedPatientId,
        });
        if (resolved.status === "ambiguous") {
          pushLocalAssistantResponse(
            command,
            resolved.message || formatAmbiguousPatientPrompt(resolved.patients)
          );
          return true;
        }
        if (resolved.status === "not_found") {
          pushLocalAssistantResponse(
            command,
            resolved.message ??
              "Please confirm which patient should be discharged."
          );
          return true;
        }
        const target = resolved.patient;
        setDischargeWorkflow({
          patientId: target.id,
          patientName: target.name,
          step: "confirm",
        });
        setDischargeConfirmId(target.id);
        pushLocalAssistantResponse(
          command,
          `Are you sure you want to discharge ${target.name}?`
        );
        return true;
      }

      if (isAdmitIntent(lower)) {
        const cleaned = cleanVoiceCommand(command);
        const boot = parseAdmissionBootstrap(command);
        let draft: AdmissionDraft = {
          active: true,
          data: boot,
          currentStep: "name",
          nameConfirmed: false,
          medicationsCaptured: bootstrapExplicitMedicationsCaptured(cleaned),
          missingFields: [],
          lastQuestionAsked: "",
        };
        draft.currentStep = getNextAdmissionStep(draft);
        draft.missingFields = computeMissingFields(draft);
        setAdmissionConversation(draft);
        pushLocalAssistantResponse(command, admissionPromptForStep(draft));
        return true;
      }

      if (matchesStatusIntent(command)) {
        const status = detectStatusValue(command);
        const resolved = resolvePatientForModification(patients, {
          transcript: command,
          activePatientId: selectedPatientId,
        });
        const target =
          resolved.status === "matched"
            ? resolved.patient
            : focusedPatient ?? null;
        if (resolved.status === "ambiguous") {
          pushLocalAssistantResponse(
            command,
            resolved.message || formatAmbiguousPatientPrompt(resolved.patients)
          );
          return true;
        }
        if (!target || !status) {
          pushLocalAssistantResponse(
            command,
            "Please confirm the problem, status, and patient."
          );
          return true;
        }
        const existingProblems = problemStateByPatient[target.id] ?? [];
        const problems = findProblemsInCommand(command, existingProblems);
        if (problems.length === 0) {
          pushLocalAssistantResponse(command, "Please confirm which problem should be updated.");
          return true;
        }
        const problemIds = new Set(problems.map((problem) => problem.id));
        const updatedProblems = (problemStateByPatient[target.id] ?? []).map(
          (item) => (problemIds.has(item.id) ? { ...item, status } : item)
        );
        setProblemStateByPatient((prev) => ({
          ...prev,
          [target.id]: updatedProblems,
        }));
        void persistPatientProblems(target.id, updatedProblems).then(
          (ok) => {
            if (ok) void refreshPatients();
          }
        );
        if (selectedPatientId !== target.id) {
          setSelectedPatientId(target.id);
        }
        void openRequestedView(target, ["diagnoses"]);
        const problemLabel =
          problems.length === 1
            ? problems[0].name
            : `${problems
                .slice(0, -1)
                .map((problem) => problem.name)
                .join(", ")} and ${problems[problems.length - 1].name}`;
        pushLocalAssistantResponse(
          command,
          `Updated: ${problemLabel} marked as ${status.toLowerCase()} for ${target.name}.`
        );
        return true;
      }

      const rosterCountIntent =
        /how many patients|number of patients|patient count|how many (people|cases)|roster (size|count)|census|patients (on|in) (the )?(board|roster|list)|total patients|count (the )?patients|size of (the )?roster/i.test(
          lower
        );
      if (rosterCountIntent) {
        const n = patients.length;
        pushLocalAssistantResponse(
          command,
          `There are ${n} patient${n === 1 ? "" : "s"} on the roster.`
        );
        return true;
      }

      const action = parseVoiceCommand(command, patients, selectedPatientId);
      if (action.kind !== "none") {
        if (action.kind === "clear_session") {
          resetSession();
          pushLocalAssistantResponse(command, "Session ended. Panels cleared.");
          return true;
        }
        if (action.kind === "patient_ambiguous") {
          setError("Multiple patients matched. Select one.");
          return true;
        }
        if (action.kind === "patient_not_found") {
          setError(`Patient not found: ${action.query}`);
          return true;
        }
        if (action.kind === "close_chart") {
          setRequestedPatientView(null);
          setActiveRequestedSections([]);
          return true;
        }
        if (action.kind === "switch_patient") {
          const patient = patients.find((p) => p.id === action.patientId);
          if (!patient) {
            setError("Patient not found.");
            return true;
          }
          setSelectedPatientId(patient.id);
          setOpenPatientTabIds((prev) =>
            prev.includes(patient.id) ? prev : [...prev, patient.id].slice(-5)
          );
          pushLocalAssistantResponse(command, `Active chart set to ${patient.name}.`);
          return true;
        }
        if (action.kind === "room_occupancy") {
          const label = normalizeRoomLabel(action.room);
          const spoken =
            action.patients.length === 0
              ? `No patients are listed in ${label}.`
              : `Patients in ${label}: ${action.patients
                  .map((p) => `${p.name} (${p.mrn})`)
                  .join("; ")}.`;
          pushLocalAssistantResponse(command, spoken);
          return true;
        }
        const patient = patients.find((p) => p.id === action.patientId);
        if (!patient) {
          setError("Patient not found.");
          return true;
        }
        await openRequestedView(patient, action.sections);
        const editable = problemStateByPatient[patient.id] ?? [];
        const spoken = buildVoiceSummaryForChartOpen(
          command,
          patient,
          action.sections,
          editable
        );
        pushLocalAssistantResponse(command, spoken);
        return true;
      }

      const orderIntent = extractMedicationOrderIntent(command, patients);
      if (orderIntent) {
        if (!permissions.canCreateMedicationOrders) {
          pushLocalAssistantResponse(command, ACCESS_RESTRICTED_MESSAGE);
          return true;
        }
        if (orderIntent.uncertain) {
          pushLocalAssistantResponse(
            command,
            "Do you want to view chart data or queue a medication order?"
          );
          return true;
        }
        const medication = orderIntent.medication;
        const resolved = resolvePatientForModification(patients, {
          transcript: command,
          activePatientId: selectedPatientId,
        });
        if (resolved.status === "ambiguous") {
          pushLocalAssistantResponse(
            command,
            resolved.message || formatAmbiguousPatientPrompt(resolved.patients)
          );
          return true;
        }
        const target =
          resolved.status === "matched"
            ? resolved.patient
            : (selectedPatientId &&
                patients.find((p) => p.id === selectedPatientId)) ||
              null;
        if (!target) {
          pushLocalAssistantResponse(command, "Please confirm which patient should receive the medication.");
          return true;
        }
        const nurseName = pickBySeed(MOCK_NURSES, `${target.id}-${medication}`);
        const pharmacyStation = pickBySeed(MOCK_PHARMACY, `${medication}-${target.room}`);
        setPendingOrders((prev) => [
          {
            id: uid(),
            patientId: target.id,
            patientName: target.name,
            room: target.room,
            medication,
            status: "Order Queued" as const,
            nurseName,
            pharmacyStation,
            stepIndex: 0,
            createdAt: Date.now(),
          },
          ...prev,
        ].slice(0, 12));
        if (selectedPatientId !== target.id) {
          setSelectedPatientId(target.id);
        }
        if (!activeRequestedSections.includes("medications")) {
          setActiveRequestedSections((prev) => [...prev, "medications"]);
        }
        pushLocalAssistantResponse(
          command,
          `Order queued. Pharmacy notified. A nurse will deliver ${medication} to ${target.name} in ${target.room}.`
        );
        return true;
      }
      return false;
    },
    [
      patients,
      selectedPatientId,
      admissionConversation,
      resetSession,
      activeRequestedSections,
      openRequestedView,
      pushLocalAssistantResponse,
      problemStateByPatient,
      role,
      user,
      permissions,
      apiRole,
      refreshPatients,
      resumeVoiceCapture,
      logout,
      dischargeWorkflow,
    ]
  );

  /* ──────────────────────────────────────────────────────────────────────
   * Submit to /api/vital
   * ────────────────────────────────────────────────────────────────────── */

  const submit = React.useCallback(
    async (
      transcript: string,
      overrideMode?: VitalMode,
      overrideContext?: string
    ) => {
      const finalMode: VitalMode =
        overrideMode ?? (emergencyArmed ? "emergency" : mode);

      setSystemState("processing");
      setError(null);
      setLastSubmittedTranscript(transcript);
      setLastCommand(transcript.trim());

      if (micMutedRef.current) {
        setSystemState("idle");
        return;
      }

      if (isNegativeCommand(transcript)) {
        if (pendingMedicationOrder) {
          setPendingMedicationOrder(null);
          pushLocalAssistantResponse(transcript, "Medication order cancelled.");
          setSystemState("idle");
          resumeVoiceCapture();
          return;
        }
        if (dischargeConfirmId) {
          setDischargeConfirmId(null);
          pushLocalAssistantResponse(transcript, "Discharge cancelled.");
          setSystemState("idle");
          resumeVoiceCapture();
          return;
        }
      }

      if (pendingMedicationOrder && isAffirmativeCommand(transcript)) {
        queueMedicationFromDraft(pendingMedicationOrder);
        const draft = pendingMedicationOrder;
        setPendingMedicationOrder(null);
        pushLocalAssistantResponse(
          transcript,
          `Order placed. Pharmacy notified for ${draft.medication} — ${draft.patientName}.`
        );
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      if (dischargeWorkflowRef.current && isNegativeCommand(transcript)) {
        setDischargeWorkflow(null);
        setDischargeConfirmId(null);
        pushLocalAssistantResponse(transcript, "Discharge cancelled.");
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      if (
        dischargeWorkflowRef.current?.step === "confirm" &&
        isAffirmativeCommand(transcript)
      ) {
        setDischargeWorkflow((prev) =>
          prev ? { ...prev, step: "reason" } : null
        );
        pushLocalAssistantResponse(
          transcript,
          "What is the discharge reason? Options include Recovered, Transfer, Left against medical advice, Deceased, or Other."
        );
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      if (dischargeWorkflowRef.current?.step === "reason") {
        const reason = parseDischargeReason(transcript);
        if (!reason) {
          pushLocalAssistantResponse(
            transcript,
            "Please state the discharge reason. For example: Recovered, Transfer, Left against medical advice, Deceased, or Other."
          );
          setSystemState("idle");
          resumeVoiceCapture();
          return;
        }
        const { patientId, patientName } = dischargeWorkflowRef.current;
        const providerName =
          role === "doctor" && user?.userName
            ? formatDoctorDisplayName(user.userName)
            : user?.userName ?? "Provider";
        const { ok } = await persistPatientPatch(
          patientId,
          {
            discharge: true,
            dischargeReason: reason,
            dischargedBy: providerName,
            encounterStatus: "Discharged",
          }
        );
        if (!ok) {
          pushLocalAssistantResponse(transcript, "Discharge failed. Try again.");
          setSystemState("idle");
          resumeVoiceCapture();
          return;
        }
        setDischargeWorkflow(null);
        setDischargeConfirmId(null);
        if (selectedPatientId === patientId) {
          setRequestedPatientView(null);
          setActiveRequestedSections([]);
          setSelectedPatientId(null);
        }
        setOpenPatientTabIds((prev) => prev.filter((tabId) => tabId !== patientId));
        await refreshPatients();
        pushLocalAssistantResponse(
          transcript,
          `${patientName} has been discharged. Reason: ${reason}. Patient moved to discharged list.`
        );
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      if (dischargeConfirmId && isAffirmativeCommand(transcript)) {
        const id = dischargeConfirmId;
        const target = patients.find((p) => p.id === id);
        setDischargeWorkflow({
          patientId: id,
          patientName: target?.name ?? "patient",
          step: "reason",
        });
        pushLocalAssistantResponse(
          transcript,
          "What is the discharge reason? Options include Recovered, Transfer, Left against medical advice, Deceased, or Other."
        );
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      const localParsedEarly = parsePatientCommand(transcript);
      if (localParsedEarly.intent !== "unknown") {
        const handledLocal = await handleClinicalCommand(transcript);
        if (handledLocal) {
          setSystemState("idle");
          resumeVoiceCapture();
          return;
        }
      }

      if (!permissions.canUseAI) {
        pushLocalAssistantResponse(transcript, AI_ASSISTANT_RESTRICTED_MESSAGE);
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      // Admission flow is deterministic/local. When active (or a new admit is requested),
      // bypass Gemini entirely to avoid conflicting parsing.
      const admissionLower = transcript.trim().toLowerCase();
      if (admissionConversation.active || isAdmitIntent(admissionLower)) {
        const handled = await handleClinicalCommand(transcript);
        if (handled) {
          setSystemState("idle");
          resumeVoiceCapture();
          return;
        }
      }

      let geminiHandled = false;
      try {
        const clinicalRes = await fetch("/api/clinical-command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            activePatientId: selectedPatientId,
            role: apiRole,
            mode: finalMode,
            conversationHistory: conversationTurnsRef.current,
          }),
        });
        if (clinicalRes.ok) {
          const clinicalData =
            (await clinicalRes.json()) as ClinicalCommandResponse;
          geminiHandled = await applyClinicalApiResult(transcript, clinicalData);
        }
      } catch {
        geminiHandled = false;
      }

      if (geminiHandled) {
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      const handled = await handleClinicalCommand(transcript);
      if (handled) {
        setSystemState("idle");
        resumeVoiceCapture();
        return;
      }

      const routedPatientId =
        findFocusedPatientFromCommand(transcript, patients)?.id ?? selectedPatientId;

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch("/api/vital", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            mode: finalMode,
            patientContext: overrideContext ?? patientSnapshot ?? "",
            conversationHistory: conversationTurnsRef.current,
            activePatientId: routedPatientId,
            role: apiRole,
          }),
          signal: ctrl.signal,
        });

        const data = (await res.json().catch(() => ({}))) as
          | VitalApiResponse
          | VitalApiError;

        if (!res.ok || "error" in data) {
          const message =
            ("error" in data && data.error) ||
            `Request failed with HTTP ${res.status}.`;
          throw new Error(message);
        }

        const ok = data as VitalApiResponse;
        setResponse(ok);
        setEmergencyArmed(false);
        setMode("general");

        if (ok.rosterChanged) {
          void refreshPatients();
        }

        setConversationTurns((prev) =>
          [
            ...prev,
            { role: "user" as const, content: transcript },
            { role: "assistant" as const, content: ok.text },
          ].slice(-40)
        );

        setAudit((prev) =>
          [
            {
              id: uid(),
              at: Date.now(),
              mode: ok.mode,
              command: transcript,
              response: ok.text,
              model: ok.model,
              latencyMs: ok.latencyMs,
              kind: "exchange" as const,
            },
            ...prev,
          ].slice(0, 80)
        );

        if (voiceEnabled && supportsTts) {
          speak(ok.text);
        } else {
          setSystemState("idle");
          if (voiceSessionActiveRef.current) {
            globalThis.setTimeout(
              () => startListeningContinueRef.current({ hard: false }),
              450
            );
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        const message =
          err instanceof Error ? err.message : "Unknown VITAL OS error.";
        setError(message);
        setSystemState("error");
        if (voiceSessionActiveRef.current) {
          globalThis.setTimeout(
            () => startListeningContinueRef.current({ hard: false }),
            600
          );
        }
        setAudit((prev) =>
          [
            {
              id: uid(),
              at: Date.now(),
              mode: finalMode,
              command: transcript,
              response: `ERROR: ${message}`,
              kind: "system" as const,
            },
            ...prev,
          ].slice(0, 80)
        );
      }
    },
    [
      emergencyArmed,
      mode,
      patients,
      patientSnapshot,
      selectedPatientId,
      setRequestedPatientView,
      supportsTts,
      voiceEnabled,
      refreshPatients,
      handleClinicalCommand,
      applyClinicalApiResult,
      queueMedicationFromDraft,
      pendingMedicationOrder,
      dischargeConfirmId,
      dischargeWorkflow,
      user,
      pushLocalAssistantResponse,
      role,
      permissions,
      apiRole,
      resumeVoiceCapture,
    ]
  );

  submitRef.current = submit;

  React.useEffect(() => {
    if (permissions.canViewReports && permissions.canViewAnalytics && permissions.canViewSettings) {
      return;
    }
    if (
      activePage === "reports" ||
      activePage === "analytics" ||
      activePage === "settings"
    ) {
      setActivePage("dashboard");
    }
  }, [activePage, permissions]);

  /* ──────────────────────────────────────────────────────────────────────
   * Speech synthesis
   * ────────────────────────────────────────────────────────────────────── */

  const speak = React.useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setSystemState("idle");
      if (voiceSessionActiveRef.current) {
        globalThis.setTimeout(
          () => startListeningContinueRef.current({ hard: false }),
          500
        );
      }
      return;
    }

    const line = text.trim();
    if (!line) {
      setSystemState("idle");
      if (voiceSessionActiveRef.current) {
        globalThis.setTimeout(
          () => startListeningContinueRef.current({ hard: false }),
          400
        );
      }
      return;
    }

    window.speechSynthesis.cancel();
    try {
      window.speechSynthesis.resume();
    } catch {
      /* noop — some engines throw if nothing paused */
    }

    /** Prefer a natural female English voice for VITAL AI responses (cross-browser heuristic). */
    const pickFemaleVoice = (): SpeechSynthesisVoice | undefined => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return undefined;

      const en = voices.filter((v) => /^en/i.test(v.lang));
      const isLikelyMale = (name: string) =>
        /\b(male|guy|^mark|^fred|^david|^tom|^john|^james|^paul|^rick|ravi|zak|george|^dan\b)\b/i.test(
          name
        );

      const femaleNameHints =
        /\b(Aria|Jenny|Zira|Samantha|Victoria|Susan|Sonia|Amy|Karen|Emma|Linda|Sara|Lisa|Jennifer|Tessa|Evelyn|Nova|Sophia|Elizabeth|Female|Women|Woman)\b|^Google .*Female/i;

      const scored = en.map((v) => {
        let score = 0;
        if (isLikelyMale(v.name)) score -= 300;
        const nameOk = femaleNameHints.test(v.name) && !isLikelyMale(v.name);
        if (nameOk) score += 500;
        if (/\b(Aria|Jenny|Zira)\b/i.test(v.name) && !isLikelyMale(v.name)) score += 120;
        if (/en-US/i.test(v.lang)) score += 80;
        if (/Microsoft/i.test(v.name)) score += 40;
        if (/Google/i.test(v.name)) score += 40;
        if (v.localService) score += 15;
        return { v, score };
      });
      scored.sort((a, b) => b.score - a.score);

      const best =
        scored.find((entry) => entry.score > 0)?.v ||
        voices.find((v) => /^en-US/i.test(v.lang) && !isLikelyMale(v.name)) ||
        voices.find((v) => /^en/i.test(v.lang));

      return best ?? voices[0];
    };

    const play = () => {
      const u = new SpeechSynthesisUtterance(line);
      u.lang = "en-US";
      u.rate = 1.04;
      u.pitch = 1.03;
      u.volume = 1;
      const voice = pickFemaleVoice();
      if (voice) u.voice = voice;

      u.onstart = () => {
        setSystemState("speaking");
        const kickMic = () => {
          if (
            !voiceSessionActiveRef.current ||
            !listeningIntentRef.current ||
            micMutedRef.current
          ) {
            return;
          }
          const rec = recognitionRef.current;
          if (rec && !recognitionActiveRef.current) {
            try {
              rec.start();
            } catch {
              startListeningContinueRef.current({ hard: false });
            }
          }
        };
        globalThis.setTimeout(kickMic, 180);
        globalThis.setTimeout(kickMic, 650);
      };
      u.onend = () => {
        setSystemState("idle");
        if (voiceSessionActiveRef.current && !micMutedRef.current && listeningIntentRef.current) {
          globalThis.setTimeout(
            () => startListeningContinueRef.current({ hard: false }),
            400
          );
        }
      };
      u.onerror = () => {
        setSystemState("idle");
        if (voiceSessionActiveRef.current && !micMutedRef.current && listeningIntentRef.current) {
          globalThis.setTimeout(
            () => startListeningContinueRef.current({ hard: false }),
            500
          );
        }
      };

      utteranceRef.current = u;
      window.speechSynthesis.speak(u);
    };

    if (window.speechSynthesis.getVoices().length > 0) {
      play();
      return;
    }

    let started = false;
    const run = () => {
      if (started) return;
      started = true;
      window.speechSynthesis.removeEventListener("voiceschanged", run);
      play();
    };
    window.speechSynthesis.addEventListener("voiceschanged", run);
    globalThis.setTimeout(run, 350);
  }, []);

  React.useEffect(() => {
    speakRef.current = speak;
  }, [speak]);

  const stopSpeaking = React.useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSystemState((s) => (s === "speaking" ? "idle" : s));
  }, []);

  /* ──────────────────────────────────────────────────────────────────────
   * Action buttons
   * ────────────────────────────────────────────────────────────────────── */

  const startVoiceSession = React.useCallback(() => {
    if (systemState === "speaking") stopSpeaking();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setVoiceSessionLive(true);
    setMicMuted(false);
    voiceSessionActiveRef.current = true;
    listeningIntentRef.current = true;
    intentionallyStoppedRef.current = false;
    setSttChoice(null);
    void recorderRef.current.start();
    void startListening({ hard: true });
  }, [startListening, stopSpeaking, systemState]);

  const endVoiceSession = React.useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    intentionallyStoppedRef.current = true;
    setVoiceSessionLive(false);
    voiceSessionActiveRef.current = false;
    listeningIntentRef.current = false;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    abortRef.current?.abort();
    recorderRef.current.stop();
    setSttChoice(null);
    disposeRecognition();
    resetSession();
    setMicMuted(false);
    setSystemState("idle");
  }, [disposeRecognition, resetSession]);

  const handleSignOut = React.useCallback(() => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Are you sure you want to sign out?")
    ) {
      return;
    }
    endVoiceSession();
    logout();
  }, [endVoiceSession, logout]);

  const toggleMicMute = React.useCallback(() => {
    if (!voiceSessionLive) {
      startVoiceSession();
      return;
    }
    setMicMuted((prev) => {
      const next = !prev;
      micMutedRef.current = next;
      if (next) {
        intentionallyStoppedRef.current = true;
        listeningIntentRef.current = false;
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        setInterimTranscript("");
        setFinalTranscript("");
        finalRef.current = "";
        interimRef.current = "";
        setHeardPreview("");
        ignoreNextEndRef.current = true;
        try {
          recognitionRef.current?.abort();
        } catch {
          /* noop */
        }
        recognitionRef.current = null;
        recognitionActiveRef.current = false;
        stopListening({ submit: false });
        recorderRef.current.stop();
        setSystemState("idle");
      } else {
        intentionallyStoppedRef.current = false;
        listeningIntentRef.current = true;
        void recorderRef.current.start();
        void startListening({ hard: false });
      }
      return next;
    });
  }, [startListening, startVoiceSession, stopListening, voiceSessionLive]);

  const handleEmergency = React.useCallback(() => {
    setEmergencyArmed((v) => !v);
    setMode("general");
  }, []);

  const handleSoap = React.useCallback(() => {
    const text = (finalTranscript || lastSubmittedTranscript).trim();
    if (!text) {
      setError(
        "No transcript to convert. Start a voice session, dictate the encounter, then try Generate SOAP Note."
      );
      setSystemState("error");
      return;
    }
    setMode("soap");
    void submit(text, "soap");
  }, [finalTranscript, lastSubmittedTranscript, submit]);

  const handleSummarize = React.useCallback(() => {
    const ctx = patientSnapshot.trim();
    const transcript =
      (finalTranscript || lastSubmittedTranscript).trim() ||
      "Summarize the patient based on the snapshot below.";
    if (!ctx && !transcript) {
      setError(
        "Add a patient snapshot or dictate context, then try Summarize Patient."
      );
      setSystemState("error");
      return;
    }
    setMode("summary");
    void submit(transcript, "summary", ctx);
  }, [finalTranscript, lastSubmittedTranscript, patientSnapshot, submit]);

  const handleClear = React.useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setVoiceSessionLive(false);
    voiceSessionActiveRef.current = false;
    listeningIntentRef.current = false;
    abortRef.current?.abort();
    ignoreNextEndRef.current = true;
    try {
      recognitionRef.current?.abort();
    } catch {
      /* noop */
    }
    recognitionRef.current = null;
    recognitionActiveRef.current = false;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setFinalTranscript("");
    setInterimTranscript("");
    interimRef.current = "";
    setLastSubmittedTranscript("");
    setResponse(null);
    setError(null);
    setAudit([]);
    setEmergencyArmed(false);
    setMode("general");
    setSystemState("idle");
    setConversationTurns([]);
    resetSession();
    userClearedFocusRef.current = false;
  }, [resetSession]);

  /* ──────────────────────────────────────────────────────────────────────
   * Render
   * ────────────────────────────────────────────────────────────────────── */

  const isBusy =
    systemState === "processing" ||
    systemState === "listening" ||
    systemState === "speaking";
  const activePatient = patients.find((p) => p.id === selectedPatientId) ?? null;
  const activeVitals = activePatient ? Object.entries(activePatient.vitals) : [];
  const activeMeds = activePatient?.medications ?? [];
  const activeAllergies = activePatient?.allergies ?? [];
  const activeProblems = activePatient?.diagnoses ?? [];
  const activeProblemRows = React.useMemo(
    () => (activePatient ? problemStateByPatient[activePatient.id] ?? [] : []),
    [activePatient, problemStateByPatient]
  );
  const activeProblemCount = React.useMemo(
    () => activeProblemRows.filter((item) => item.status === "Active").length,
    [activeProblemRows]
  );
  const highAcuityPatients = React.useMemo(() => getHighAcuityPatients(patients), [patients]);
  const patientsWithAllergies = React.useMemo(
    () => getPatientsWithAllergies(patients),
    [patients]
  );
  const pendingLabsPatients = React.useMemo(() => getPendingLabs(patients), [patients]);
  const imagingOrderedPatients = React.useMemo(() => getImagingOrdered(patients), [patients]);
  const consultRequestedPatients = React.useMemo(
    () => getConsultRequested(patients),
    [patients]
  );
  const pediatricPatients = React.useMemo(
    () => patients.filter((p) => isPediatric(p)),
    [patients]
  );
  const acuityDistribution = React.useMemo(() => getAcuityDistribution(patients), [patients]);
  const ageDistribution = React.useMemo(() => getAgeDistribution(patients), [patients]);
  const unitDistribution = React.useMemo(() => getUnitDistribution(patients), [patients]);
  const topConcernCategories = React.useMemo(
    () => getTopConcernCategories(patients),
    [patients]
  );
  const riskDistribution = React.useMemo(
    () => getRiskCategoryDistribution(patients),
    [patients]
  );
  const medicationsCount = React.useMemo(
    () => patients.reduce((sum, p) => sum + p.medications.length, 0),
    [patients]
  );
  const roomOccupancy = React.useMemo(
    () =>
      [...patients]
        .sort((a, b) => a.room.localeCompare(b.room))
        .map((p) => ({ room: p.room, patient: p.name, acuity: p.triageAcuity }))
        .slice(0, 10),
    [patients]
  );
  const encounterRows = React.useMemo(
    () =>
      patients.map((p, idx) => {
        const status = deriveEncounterStatus(p);
        const ts = new Date();
        ts.setMinutes(ts.getMinutes() - idx * 9);
        return {
          patient: p,
          status,
          updatedLabel: ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
      }),
    [patients]
  );
  const filteredEncounters = React.useMemo(() => {
    switch (encounterFilter) {
      case "high_acuity":
        return encounterRows.filter(({ patient }) => /ctas\s*[12]/i.test(patient.triageAcuity));
      case "pediatrics":
        return encounterRows.filter(({ patient }) => isPediatric(patient));
      case "allergies":
        return encounterRows.filter(({ patient }) => getPatientsWithAllergies([patient]).length > 0);
      case "imaging_pending":
        return encounterRows.filter(({ patient }) => hasImagingOrdered(patient));
      case "labs_pending":
        return encounterRows.filter(({ patient }) => hasPendingLabs(patient));
      default:
        return encounterRows;
    }
  }, [encounterFilter, encounterRows]);
  const shiftTrend = React.useMemo(
    () => [
      { label: "08:00", value: Math.max(2, Math.round(patients.length * 0.45)) },
      { label: "10:00", value: Math.max(2, Math.round(patients.length * 0.62)) },
      { label: "12:00", value: Math.max(2, Math.round(patients.length * 0.76)) },
      { label: "14:00", value: Math.max(2, Math.round(patients.length * 0.84)) },
      { label: "16:00", value: Math.max(2, Math.round(patients.length * 0.92)) },
      { label: "18:00", value: patients.length },
    ],
    [patients.length]
  );
  const unitDonut = React.useMemo(() => {
    const total = unitDistribution.reduce((sum, item) => sum + item.value, 0);
    const palette = ["#0284C7", "#64748B", "#0EA5E9", "#10B981", "#FBBF24"];
    if (!total) return { background: "#e2e8f0" };
    let cursor = 0;
    const stops = unitDistribution.map((item, idx) => {
      const start = cursor;
      const sweep = (item.value / total) * 360;
      cursor += sweep;
      return `${palette[idx % palette.length]} ${start.toFixed(1)}deg ${cursor.toFixed(1)}deg`;
    });
    return { background: `conic-gradient(${stops.join(", ")})` };
  }, [unitDistribution]);
  const activityFeed = React.useMemo(
    () =>
      patients.slice(0, 8).map((p, idx) => {
        const base =
          p.cardiacStudies && /ordered|ecg|ct/i.test(p.cardiacStudies)
            ? `${p.cardiacStudies} for ${p.name}.`
            : p.riskFlags
              ? `${p.riskFlags.split(".")[0]} for ${p.name}.`
              : `${deriveEncounterStatus(p)} for ${p.name}.`;
        return {
          id: `${p.id}-${idx}`,
          text: base,
          room: p.room,
          at: `${idx * 6 + 2} min ago`,
          level: /stroke|anaphylaxis|critical|acs|sepsis|code/i.test(base) ? "high" : "normal",
        };
      }),
    [patients]
  );
  const fullChartSections: PatientFieldKey[] = [
    "overview",
    "allergies",
    "medications",
    "diagnoses",
    "vitals",
    "labs",
    "plan",
    "history",
  ];
  const showSection = (key: PatientFieldKey) =>
    activeRequestedSections.includes("overview") || activeRequestedSections.includes(key);
  const hasRequestedSections = activeRequestedSections.length > 0;
  const filteredPatients = patients.filter((p) => {
    const q = patientSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.mrn.toLowerCase().includes(q) ||
      p.room.toLowerCase().includes(q) ||
      p.chiefConcern.toLowerCase().includes(q)
    );
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AnimatePresence>
        {orderNotice && (
          <motion.div
            initial={{ opacity: 0, y: -8, x: 12 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, y: -8, x: 12 }}
            className="fixed right-4 top-4 z-50 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground"
          >
            {orderNotice}
          </motion.div>
        )}
        {chartSaveError && (
          <motion.div
            initial={{ opacity: 0, y: -8, x: 12 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, y: -8, x: 12 }}
            className="fixed right-4 top-16 z-50 max-w-sm rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-200"
          >
            {chartSaveError}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[112px_minmax(0,1fr)_320px]">
        <aside className="hidden border-r border-sidebar-border bg-sidebar px-2 py-4 text-sidebar-foreground lg:flex lg:flex-col">
          <div className="mb-6 flex items-center justify-center px-1">
            <VitalLogo
              size={32}
              variant="stacked"
              textClassName="text-sidebar-foreground"
              className="rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2.5"
            />
          </div>
          <nav className="flex flex-1 flex-col gap-1">
            {[
              { key: "dashboard" as ActivePage, label: "Dashboard", icon: Home, show: true },
              { key: "patients" as ActivePage, label: "Patients", icon: Users, show: true },
              { key: "encounters" as ActivePage, label: "Encounters", icon: NotebookTabs, show: true },
              {
                key: "reports" as ActivePage,
                label: "Reports",
                icon: FileBarChart2,
                show: permissions.canViewReports,
              },
              {
                key: "analytics" as ActivePage,
                label: "Analytics",
                icon: BarChart3,
                show: permissions.canViewAnalytics,
              },
              {
                key: "settings" as ActivePage,
                label: "Settings",
                icon: Settings,
                show: permissions.canViewSettings,
              },
            ]
              .filter((item) => item.show)
              .map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => setActivePage(item.key)}
                  className={cn(
                    "flex h-12 w-full flex-col items-center justify-center gap-1 rounded-lg px-2 text-center text-[11px] font-medium transition-colors",
                    activePage === item.key
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="leading-none">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="mt-auto flex flex-col gap-2 border-t border-sidebar-border pt-3">
            <button
              type="button"
              onClick={handleSignOut}
              className="flex h-12 w-full flex-col items-center justify-center gap-1 rounded-lg px-2 text-center text-[11px] font-medium text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              title="Sign out and return to role selection"
            >
              <LogOut className="h-4 w-4 shrink-0" aria-hidden />
              <span className="leading-none">Sign Out</span>
            </button>
            <div className="px-1 text-center text-[10px] font-medium uppercase tracking-wide text-sidebar-muted">
              HIPAA Secure
            </div>
          </div>
        </aside>

        <section className="flex min-h-screen flex-col bg-background px-4 py-4 lg:px-5 lg:py-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <VitalLogo size={22} variant="full" textClassName="font-medium text-foreground" />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="inline-flex items-center gap-2">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    systemState === "listening" ? "bg-emerald-500" : "bg-muted-foreground"
                  )}
                />
                System Ready
              </Badge>
              <Badge variant="clinical">
                {role === "doctor" && user?.doctorId
                  ? `Doctor Mode · ${formatDoctorDisplayName(user.userName)}`
                  : role === "doctor"
                    ? "Doctor Mode"
                    : role === "staff" && user?.staffId
                      ? `Staff Mode · ${user.userName}`
                      : "Staff Mode"}
              </Badge>
              {mode !== "general" && (
                <Badge variant="medications">
                  Care Mode: {MODE_LABEL[mode]}
                </Badge>
              )}
              <button
                ref={workspaceToggleRef}
                type="button"
                onClick={toggleWorkspace}
                aria-haspopup="dialog"
                aria-expanded={workspaceOpen}
                aria-controls="vital-workspace-panel"
                className={cn(
                  "relative inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                  workspaceOpen
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                title={
                  workspaceOpen
                    ? "Close workspace panel (Esc)"
                    : "Open workspace panel - charts, log, tools, system"
                }
              >
                <PanelRight className="h-4 w-4 shrink-0" aria-hidden />
                <span className="hidden sm:inline">Workspace</span>
                {sttDegraded && (
                  <>
                    <span
                      className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background"
                      aria-hidden
                    />
                    <span className="sr-only">Speech-to-text degraded</span>
                  </>
                )}
              </button>
              <span className="ml-1 text-sm font-medium tabular-nums text-muted-foreground">{fmtTime(now)}</span>
            </div>
          </div>

          <div className="mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
            <button
              type="button"
              onClick={toggleMicMute}
              disabled={
                !supportsSpeech ||
                systemState === "processing"
              }
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors",
                voiceSessionLive && !micMuted
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-muted"
              )}
              title={
                !voiceSessionLive
                  ? "Start voice session"
                  : voiceSessionLive && !micMuted
                  ? "Mic live - tap to mute"
                  : "Mic muted - tap to unmute"
              }
            >
              {voiceSessionLive && !micMuted ? (
                <Mic className="h-5 w-5" />
              ) : (
                <MicOff className="h-5 w-5" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <p className="text-sm font-medium text-foreground">
                  {voiceSessionLive && micMuted
                    ? "Microphone muted"
                    : systemState === "listening"
                      ? "Listening"
                      : systemState === "speaking"
                        ? "AI speaking"
                        : systemState === "processing"
                          ? "Processing"
                          : "System ready"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {heardPreview.trim() ||
                    interimTranscript.trim() ||
                    finalTranscript.trim() ||
                    lastSubmittedTranscript.trim() ||
                    "Listening for clinician command"}
                </p>
              </div>
              <div className="mt-1.5 flex h-5 items-end gap-0.5 overflow-hidden">
                {waveformBars.map((h, i) => (
                  <span
                    key={`wf-${i}`}
                    className="w-0.5 rounded-full bg-primary/70 transition-all duration-100"
                    style={{ height: `${Math.max(2, Math.min(h, 16))}px` }}
                  />
                ))}
              </div>
              {error ? (
                <p className="mt-1 text-xs text-destructive">{error}</p>
              ) : null}
              {!permissions.canUseAI ? (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {AI_ASSISTANT_RESTRICTED_MESSAGE}
                </p>
              ) : null}
              {typedCommandOpen && permissions.canUseAI && (
                <input
                  value={typedCommand}
                  onChange={(e) => setTypedCommand(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const text = typedCommand.trim();
                    if (!text) return;
                    setTypedCommand("");
                    void submitRef.current(text);
                  }}
                  placeholder="Type a clinical command..."
                  className="vital-input mt-2"
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  if (!permissions.canUseAI) return;
                  setTypedCommandOpen((v) => !v);
                }}
                disabled={!permissions.canUseAI}
                className={cn(
                  "flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted",
                  !permissions.canUseAI && "cursor-not-allowed opacity-50"
                )}
                title={
                  permissions.canUseAI
                    ? "Toggle typed command"
                    : AI_ASSISTANT_RESTRICTED_MESSAGE
                }
              >
                <Keyboard className="h-4 w-4" />
              </button>
              {systemState === "speaking" && (
                <button
                  type="button"
                  onClick={stopSpeaking}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted"
                >
                  Stop voice
                </button>
              )}
              <button
                type="button"
                onClick={() => setVoiceEnabled((v) => !v)}
                disabled={!supportsTts}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted"
                title={voiceEnabled ? "Mute AI voice" : "Unmute AI voice"}
              >
                {voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={endVoiceSession}
                className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-200 dark:hover:bg-rose-950/60"
              >
                End Session
              </button>
            </div>
          </div>

          <div className="mb-3 flex items-center justify-end">
            {activePatient && (
              <button
                type="button"
                onClick={() => {
                  if (!activePatient) return;
                  void openRequestedView(activePatient, fullChartSections);
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                View Full Chart
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {activePage !== "dashboard" ? (
            <div className="grid gap-3">
              {activePage === "patients" && (
                <div className="vital-card p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">Patient Roster</p>
                    <motion.div layout className="flex flex-wrap items-center gap-2">
                      <input
                        value={patientSearch}
                        onChange={(e) => setPatientSearch(e.target.value)}
                        placeholder="Search name, MRN, room..."
                        className="w-64 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground outline-none focus:border-ring"
                      />
                      {permissions.canAdmitPatient ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setAdmitFormOpen((open) => !open)}
                        >
                          Admit Patient
                        </Button>
                      ) : null}
                    </motion.div>
                  </div>
                  <AnimatePresence initial={false}>
                    {admitFormOpen && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mb-3 overflow-hidden vital-section p-3"
                      >
                        <motion.div layout className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {(
                            [
                              ["name", "Name", "text"],
                              ["room", "Room", "text"],
                              ["age", "Age", "number"],
                              ["sex", "Sex", "text"],
                              ["chiefConcern", "Chief Concern", "text"],
                            ] as const
                          ).map(([key, label, type]) => (
                            <label key={key} className="text-xs font-medium text-foreground">
                              {label}
                              <input
                                type={type}
                                value={admitDraft[key]}
                                onChange={(e) =>
                                  setAdmitDraft((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground outline-none focus:border-ring"
                              />
                            </label>
                          ))}
                          <label className="text-xs font-medium text-foreground">
                            Acuity (CTAS 1-5)
                            <select
                              value={admitDraft.triageAcuity}
                              onChange={(e) =>
                                setAdmitDraft((prev) => ({
                                  ...prev,
                                  triageAcuity: e.target.value,
                                }))
                              }
                              className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground outline-none focus:border-ring"
                            >
                              {["CTAS 1", "CTAS 2", "CTAS 3", "CTAS 4", "CTAS 5"].map((level) => (
                                <option key={level} value={level}>
                                  {level}
                                </option>
                              ))}
                            </select>
                          </label>
                        </motion.div>
                        <div className="mt-3 flex justify-end gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setAdmitFormOpen(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              void (async () => {
                                const res = await fetch("/api/patients", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({
                                    name: admitDraft.name.trim(),
                                    room: admitDraft.room.trim(),
                                    age: Number(admitDraft.age) || 0,
                                    sex: admitDraft.sex.trim() || "?",
                                    chiefConcern:
                                      admitDraft.chiefConcern.trim() || "Not specified",
                                    triageAcuity: admitDraft.triageAcuity,
                                  }),
                                });
                                if (!res.ok) return;
                                setAdmitFormOpen(false);
                                setAdmitDraft({
                                  name: "",
                                  room: "",
                                  age: "",
                                  sex: "",
                                  chiefConcern: "",
                                  triageAcuity: "CTAS 3",
                                });
                                await refreshPatients();
                              })();
                            }}
                          >
                            Submit Admission
                          </Button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="rounded-xl border border-border">
                    <motion.div layout className="grid grid-cols-[1.2fr_0.9fr_0.7fr_0.8fr_1.1fr_0.7fr_0.7fr_0.9fr] border-b border-border bg-muted px-3 py-2 text-xs font-semibold uppercase tracking-wide text-foreground">
                      <span>Patient</span>
                      <span>MRN</span>
                      <span>Age/Sex</span>
                      <span>Room</span>
                      <span>Chief Concern</span>
                      <span>Acuity</span>
                      <span>Status</span>
                      <span>Actions</span>
                    </motion.div>
                  <div className="max-h-[420px] overflow-auto">
                    {filteredPatients.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => {
                          setActivePage("dashboard");
                          void openRequestedView(p, fullChartSections);
                        }}
                        className={cn(
                          "grid cursor-pointer grid-cols-[1.2fr_0.9fr_0.7fr_0.8fr_1.1fr_0.7fr_0.7fr_0.9fr] gap-2 border-b border-border px-3 py-2.5 text-left text-sm hover:bg-muted",
                          selectedPatientId === p.id ? "bg-primary/10" : "bg-card"
                        )}
                      >
                        <span className="font-medium text-foreground">
                          {p.name}
                          <PatientClinicalIndicator patient={p} />
                        </span>
                        <span className="text-foreground">{p.mrn}</span>
                        <span className="text-foreground">
                          {p.age}
                          {p.sex}
                        </span>
                        <span>
                          <Badge variant="medications">
                            {p.room}
                          </Badge>
                        </span>
                        <span className="truncate text-foreground">{p.chiefConcern}</span>
                        <span>
                          <Badge variant={acuityBadgeVariant(p.triageAcuity)}>
                            {p.triageAcuity}
                          </Badge>
                        </span>
                        <span className="text-xs text-foreground">
                          {p.allergies.length ? "Allergy" : "Stable"}
                        </span>
                        <div
                          className="flex items-center justify-end"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {!permissions.canDischargePatient ? (
                            <span className="text-[10px] text-muted-foreground">—</span>
                          ) : dischargeConfirmId === p.id ? (
                            <div className="flex items-center gap-1 text-xs text-foreground">
                              <span>Confirm discharge?</span>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => setDischargeConfirmId(null)}
                              >
                                No
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => {
                                  void (async () => {
                                    const res = await fetch(
                                      `/api/patients/${encodeURIComponent(p.id)}`,
                                      {
                                        method: "DELETE",
                                      }
                                    );
                                    if (!res.ok) return;
                                    setDischargeConfirmId(null);
                                    if (selectedPatientId === p.id) {
                                      setRequestedPatientView(null);
                                      setActiveRequestedSections([]);
                                      setSelectedPatientId(null);
                                    }
                                    setOpenPatientTabIds((prev) =>
                                      prev.filter((tabId) => tabId !== p.id)
                                    );
                                    await refreshPatients();
                                  })();
                                }}
                              >
                                Yes
                              </Button>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-[11px]"
                              onClick={() => setDischargeConfirmId(p.id)}
                            >
                              Discharge
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  </div>
                </div>
              )}
              {activePage === "encounters" && (
                <div className="grid gap-3">
                  <div className="vital-card p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-foreground">Active Encounters</p>
                      <Badge variant="medications">{filteredEncounters.length} visible</Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ["all", "All"],
                        ["high_acuity", "High acuity"],
                        ["pediatrics", "Pediatrics"],
                        ["allergies", "Allergies"],
                        ["imaging_pending", "Imaging pending"],
                        ["labs_pending", "Labs pending"],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setEncounterFilter(key as EncounterFilter)}
                          className={cn(
                            "rounded-lg border px-3 py-1 text-xs font-medium transition-colors",
                            encounterFilter === key
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-card text-muted-foreground hover:border-border hover:text-foreground"
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-2 xl:grid-cols-2">
                    {filteredEncounters.map(({ patient, status, updatedLabel }) => (
                      <button
                        key={patient.id}
                        type="button"
                        onClick={() => {
                          setActivePage("dashboard");
                          void openRequestedView(patient, fullChartSections);
                        }}
                        className="vital-card-hover p-3 text-left"
                      >
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-foreground">
                            {patient.name}
                            <PatientClinicalIndicator patient={patient} />
                          </p>
                          <Badge variant={statusBadgeVariant(status)}>{status}</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                          <p>MRN: <span className="font-medium text-foreground">{patient.mrn}</span></p>
                          <p>ROOM: <span className="font-medium text-foreground">{patient.room}</span></p>
                          <p>
                            Acuity:{" "}
                            <span className="font-medium text-foreground">{patient.triageAcuity}</span>
                          </p>
                          <p>Updated: <span className="font-medium text-foreground">{updatedLabel}</span></p>
                        </div>
                        <p className="mt-2 line-clamp-1 text-sm text-foreground">{patient.chiefConcern}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Badge variant="notes" className="text-[10px]">
                            Team: {(patient.careTeam ?? []).slice(0, 2).join(", ") || "Assigned"}
                          </Badge>
                          <Badge variant={patient.riskFlags ? "risk" : "outline"} className="text-[10px]">
                            {patient.riskFlags ? patient.riskFlags.split(".")[0] : "No major flags"}
                          </Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="vital-card p-4">
                      <p className="text-sm font-semibold text-foreground">Recent Activity Feed</p>
                      <div className="mt-3 space-y-2">
                        {activityFeed.slice(0, 6).map((item) => (
                          <div
                            key={item.id}
                            className="flex items-start gap-2 rounded-lg border border-border bg-muted/70 px-3 py-2"
                          >
                            <Activity
                              className={cn(
                                "mt-0.5 h-3.5 w-3.5",
                                item.level === "high" ? "text-rose-500" : "text-cyan-600"
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-foreground">{item.text}</p>
                              <p className="mt-0.5 text-[11px] text-muted-foreground">
                                {item.room} • {item.at}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="vital-card p-4">
                      <p className="text-sm font-semibold text-foreground">Room Occupancy</p>
                      <div className="mt-3 space-y-2">
                        {roomOccupancy.map((item) => (
                          <div
                            key={`${item.room}-${item.patient}`}
                            className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-xs"
                          >
                            <span className="font-semibold text-foreground">{item.room}</span>
                            <span className="truncate px-2 text-muted-foreground">{item.patient}</span>
                            <Badge variant="notes">{item.acuity}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {activePage === "reports" && (
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {[
                      ["Daily triage volume", patients.length, "notes"],
                      ["High acuity cases", highAcuityPatients.length, "risk"],
                      ["Allergy-risk patients", patientsWithAllergies.length, "allergies"],
                      ["Medication safety flags", patients.filter((p) => (p.pharmacyNotes ?? "").length > 0).length, "medications"],
                      ["Pending labs", pendingLabsPatients.length, "problems"],
                      ["Imaging ordered", imagingOrderedPatients.length, "medications"],
                      ["Consults requested", consultRequestedPatients.length, "risk"],
                      ["Pediatric cases", pediatricPatients.length, "notes"],
                      ["Discharge candidates", patients.filter((p) => /discharge|improved/i.test(p.edOrUrgentCourse ?? "")).length, "notes"],
                    ].map(([title, value, variant]) => (
                      <div
                        key={String(title)}
                        className="vital-card p-4"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
                        <div className="mt-2 flex items-center justify-between">
                          <p className="text-2xl font-semibold text-foreground">{value}</p>
                          <Badge variant={variant as "allergies" | "medications" | "problems" | "notes" | "risk"}>
                            Live
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="vital-card p-4">
                    <p className="text-sm font-semibold text-foreground">Generated Reports</p>
                    <div className="mt-3 grid gap-2 xl:grid-cols-2">
                      {[
                        ["ED Daily Summary", "Snapshot of active encounters and room occupancy.", patients.length, "Ready"],
                        ["High-Risk Patient Review", "Aggregated CTAS 1-2 and risk flag cohort.", highAcuityPatients.length, "Review"],
                        ["Allergy & Medication Safety Report", "Cross-check allergy and med risk exposure.", patientsWithAllergies.length, "Ready"],
                        ["Pending Diagnostics Report", "Labs and imaging currently pending.", pendingLabsPatients.length + imagingOrderedPatients.length, "Pending"],
                        ["Care Team Workload Report", "Assigned care teams and consult demand.", consultRequestedPatients.length, "Ready"],
                      ].map(([title, desc, count, status]) => (
                        <div
                          key={String(title)}
                          className="vital-card p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold text-foreground">{title}</p>
                            <Badge variant={status === "Pending" ? "problems" : "notes"}>{status}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
                          <div className="mt-3 flex items-center justify-between">
                            <p className="text-xs text-muted-foreground">{count} records</p>
                            <button className="rounded-lg border border-border bg-card px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted">
                              Preview
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="vital-card p-4">
                    <p className="text-sm font-semibold text-foreground">Care Team Activity</p>
                    <div className="mt-3 grid gap-2 xl:grid-cols-2">
                      {activityFeed.slice(0, 6).map((item) => (
                        <div
                          key={`report-${item.id}`}
                          className="rounded-lg border border-border bg-muted/70 px-3 py-2 text-xs text-foreground"
                        >
                          <p>{item.text}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {item.room} • {item.at}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {activePage === "analytics" && (
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                    {[
                      ["Total patients", patients.length],
                      ["Allergy patients", patientsWithAllergies.length],
                      ["High-risk flags", patients.filter((p) => (p.riskFlags ?? "").trim().length > 0).length],
                      ["Medication count", medicationsCount],
                      ["Pending labs", pendingLabsPatients.length],
                      ["Consult requested", consultRequestedPatients.length],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="vital-card p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
                        <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-3 xl:grid-cols-3">
                    <div className="vital-card p-4 xl:col-span-2">
                      <p className="text-sm font-semibold text-foreground">CTAS Acuity Distribution</p>
                      <div className="mt-3 space-y-2">
                        {acuityDistribution.map((item) => {
                          const max = Math.max(...acuityDistribution.map((x) => x.value), 1);
                          return (
                            <div key={item.label}>
                              <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                                <span>{item.label}</span>
                                <span>{item.value}</span>
                              </div>
                              <div className="h-2 rounded-full bg-muted">
                                <div
                                  className="h-2 rounded-full bg-primary"
                                  style={{ width: `${(item.value / max) * 100}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="vital-card p-4">
                      <p className="text-sm font-semibold text-foreground">Patients by Unit</p>
                      <div className="mt-4 flex items-center gap-4">
                        <div className="h-24 w-24 rounded-full" style={unitDonut} />
                        <div className="space-y-1">
                          {unitDistribution.map((item) => (
                            <p key={item.label} className="text-xs text-foreground">
                              {item.label}: <span className="font-semibold">{item.value}</span>
                            </p>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="vital-card p-4">
                      <p className="text-sm font-semibold text-foreground">Top Concern Categories</p>
                      <div className="mt-3 space-y-2">
                        {topConcernCategories.map((item) => (
                          <div key={item.label} className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-xs">
                            <span className="line-clamp-1 text-foreground">{item.label}</span>
                            <Badge variant="medications">{item.value}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="vital-card p-4">
                      <p className="text-sm font-semibold text-foreground">Shift Triage Trend</p>
                      <div className="mt-4 flex h-32 items-end gap-2">
                        {shiftTrend.map((item) => {
                          const max = Math.max(...shiftTrend.map((x) => x.value), 1);
                          return (
                            <div key={item.label} className="flex flex-1 flex-col items-center gap-1">
                              <div
                                className="w-full rounded-t-md bg-primary"
                                style={{ height: `${Math.max(12, (item.value / max) * 96)}px` }}
                              />
                              <span className="text-[10px] text-muted-foreground">{item.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="vital-card p-4">
                      <p className="text-sm font-semibold text-foreground">Risk Categories</p>
                      <div className="mt-3 space-y-2">
                        {riskDistribution.map((item) => (
                          <div key={item.label} className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-xs">
                            <span className="line-clamp-1 text-foreground">{item.label}</span>
                            <Badge variant="risk">{item.value}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="vital-card p-4">
                      <p className="text-sm font-semibold text-foreground">Age Distribution</p>
                      <div className="mt-3 space-y-2">
                        {ageDistribution.map((item) => (
                          <div key={item.label} className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2 text-xs">
                            <span className="text-foreground">{item.label}</span>
                            <Badge variant="notes">{item.value}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {activePage === "settings" && (
                <div className="grid gap-3">
                  <div className="vital-card p-4">
                    <p className="text-sm font-semibold text-foreground">Settings</p>
                    <div className="mt-3 grid gap-2 text-sm text-foreground">
                      <p>Microphone: {supportsSpeech ? "Available" : "Unavailable"}</p>
                      <p>Voice mode: {voiceSessionLive ? "Live" : "Idle"}</p>
                      <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
                        Demo environment. Mock patient data only.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={handleClear}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 hover:bg-muted"
                        >
                          Clear Session
                        </button>
                        <button
                          type="button"
                          onClick={() => void refreshPatients()}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 hover:bg-muted"
                        >
                          Reload Patient Store
                        </button>
                        <button
                          type="button"
                          onClick={handleSignOut}
                          className="rounded-lg border border-border bg-card px-3 py-1.5 hover:bg-muted"
                        >
                          Sign Out
                        </button>
                      </div>
                    </div>
                  </div>
                  <ThemeAppearanceControl />
                </div>
              )}
            </div>
          ) : (
            <>
          {openPatientTabIds.length > 1 && (
            <motion.div layout className="vital-card mb-3 px-3 py-2">
              <motion.div layout className="flex flex-wrap items-center gap-2">
                {openPatientTabIds.map((id) => {
                  const p = patients.find((item) => item.id === id);
                  if (!p) return null;
                  const active = id === selectedPatientId;
                  return (
                    <motion.button
                      key={id}
                      layout
                      type="button"
                      onClick={() => setSelectedPatientId(id)}
                      className={cn(
                        "group inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1 text-xs text-foreground transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-primary ring-clinical"
                          : "hover:border-border hover:bg-muted"
                      )}
                    >
                      <span className="font-medium">{p.name}</span>
                      <PatientClinicalIndicator patient={p} />
                      <span className="mono text-[10px] text-muted-foreground">{p.mrn}</span>
                      <span
                        className="rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenPatientTabIds((prev) => prev.filter((tab) => tab !== id));
                          if (selectedPatientId === id) setSelectedPatientId(null);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </motion.button>
                  );
                })}
              </motion.div>
              {openPatientTabIds.length > 3 && (
                <p className="mt-2 text-xs text-amber-700">
                  Multiple charts open - verify active patient before documenting.
                </p>
              )}
            </motion.div>
          )}

          {activePatient && hasRequestedSections && (
            <div className="mb-3 vital-section px-3 py-2 text-sm font-medium text-foreground">
              Active Chart: {activePatient.name} • {activePatient.mrn} • Room {activePatient.room}
            </div>
          )}

          {activePatient && (
            <div className="mb-3 vital-card p-3">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-8">
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Patient</p>
                <p className="text-sm font-semibold text-foreground">{activePatient.name}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">MRN</p>
                <p className="text-sm font-semibold text-foreground">{activePatient.mrn}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Age/Sex</p>
                <div className="flex items-center gap-1">
                  <InlineField
                    value={String(activePatient.age || "")}
                    displayValue={String(activePatient.age || "—")}
                    type="number"
                    disabled={!permissions.canEditPatientStatus}
                    className="w-12 font-semibold"
                    onCommit={(raw) => {
                      const age = Number(raw);
                      if (!raw.trim() || !Number.isFinite(age) || age < 0) return;
                      void commitChartPatch(
                        activePatient.id,
                        { age },
                        { age }
                      );
                    }}
                  />
                  <InlineSelect
                    value={activePatient.sex || "U"}
                    options={["M", "F", "U"]}
                    disabled={!permissions.canEditPatientStatus}
                    className="w-14 font-semibold"
                    onCommit={(sex) => {
                      void commitChartPatch(activePatient.id, { sex }, { sex });
                    }}
                  />
                </div>
              </div>
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">DOB</p>
                <InlineField
                  value={/^\d{4}-\d{2}-\d{2}/.test(activePatient.dob) ? activePatient.dob.slice(0, 10) : ""}
                  displayValue={activePatient.dob}
                  type="date"
                  disabled={!permissions.canEditPatientStatus}
                  className="font-semibold"
                  onCommit={(dob) => {
                    void commitChartPatch(activePatient.id, { dob }, { dob: dob || "Not listed" });
                  }}
                />
              </div>
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Blood</p>
                <InlineField
                  value={activePatient.bloodType || ""}
                  displayValue={activePatient.bloodType || "—"}
                  disabled={!permissions.canEditPatientStatus}
                  className="font-semibold"
                  onCommit={(bloodType) => {
                    void commitChartPatch(
                      activePatient.id,
                      { bloodType },
                      { bloodType }
                    );
                  }}
                />
              </div>
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Provider</p>
                <InlineField
                  value={activePatient.pcp ?? ""}
                  displayValue={activePatient.pcp ?? "Unassigned"}
                  disabled={!permissions.canEditPatientStatus}
                  className="font-semibold"
                  onCommit={(pcp) => {
                    void commitChartPatch(activePatient.id, { pcp }, { pcp });
                  }}
                />
              </div>
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Room</p>
                <InlineField
                  value={activePatient.room || ""}
                  displayValue={activePatient.room || "Unassigned"}
                  disabled={!permissions.canEditPatientStatus}
                  className="font-semibold"
                  onCommit={(room) => {
                    void commitChartPatch(activePatient.id, { room }, { room });
                  }}
                />
              </div>
              <div>
                <p className="text-[11px] uppercase text-muted-foreground">Last Visit</p>
                <p className="text-sm font-semibold text-foreground">{activePatient.lastVisit}</p>
              </div>
              </div>
              <div className="mt-2 border-t border-border pt-2">
                <p className="text-[11px] uppercase text-muted-foreground">Chief concern</p>
                <InlineField
                  value={activePatient.chiefConcern || ""}
                  displayValue={activePatient.chiefConcern || "Not specified"}
                  disabled={!permissions.canEditPatientStatus}
                  className="font-semibold"
                  onCommit={(chiefConcern) => {
                    void commitChartPatch(
                      activePatient.id,
                      { chiefConcern },
                      { chiefConcern }
                    );
                  }}
                />
              </div>
            </div>
          )}

          {!activePatient && !hasRequestedSections && (
            <div className="mb-3 rounded-lg border border-dashed border-border bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
              <div className="mb-2 inline-flex rounded-lg border border-border bg-card px-3 py-2">
                <VitalLogo size={34} variant="full" textClassName="text-sidebar-foreground" />
              </div>
              <p className="font-medium text-foreground">Awaiting clinician request</p>
              <p className="mt-1 text-muted-foreground">No chart section currently opened</p>
            </div>
          )}

          {activePatient && hasRequestedSections && (
          <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
            {activePatient && showSection("allergies") && (
            <div className="vital-card border-l-4 border-l-rose-400 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">Allergies</p>
                <Badge variant="allergies" className="text-xs">
                  {activeAllergies.length ? `${activeAllergies.length} total` : "None listed"}
                </Badge>
              </div>
              <EditableAllergyTable
                allergies={activeAllergies}
                canEdit={permissions.canEditPatientStatus}
                onSave={(next) => {
                  void commitChartPatch(
                    activePatient.id,
                    { allergies: next },
                    {
                      allergies: next.map(
                        (row) => `${row.allergen} — ${row.reaction} — ${row.severity}`
                      ),
                    }
                  );
                }}
              />
            </div>
            )}

            {activePatient && showSection("medications") && (
            <div className="vital-card border-l-4 border-l-sky-500 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">Medications</p>
                <Badge variant="medications" className="text-xs">
                  {activeMeds.length ? `${activeMeds.length} active` : "None listed"}
                </Badge>
              </div>
              <EditableMedicationTable
                medications={activeMeds}
                canEdit={permissions.canEditPatientStatus}
                onSave={(next) => {
                  void commitChartPatch(
                    activePatient.id,
                    {
                      medications: next.map((m) => ({
                        name: m.name,
                        dose: m.sig,
                        sig: m.sig,
                        status: m.status || "Active",
                      })),
                    },
                    { medications: next }
                  );
                }}
              />
            </div>
            )}

            {activePatient && showSection("diagnoses") && (
            <div className="vital-card border-l-4 border-l-amber-400 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">Problems</p>
                <Badge variant="problems" className="text-xs">
                  {activeProblems.length ? `${activeProblemCount} active` : "None listed"}
                </Badge>
              </div>
              <EditableProblemTable
                problems={
                  activePatient.problems?.length
                    ? activePatient.problems
                    : activeProblemRows.map(({ name, status, since }) => ({
                        name,
                        status,
                        since,
                      }))
                }
                canEdit={permissions.canEditPatientStatus}
                onSave={(next) => {
                  void commitChartPatch(
                    activePatient.id,
                    { problems: next },
                    {
                      problems: next,
                      diagnoses: next.map((p) => p.name),
                    }
                  );
                }}
              />
            </div>
            )}

            {activePatient && (showSection("vitals") || showSection("labs")) && (
            <motion.div className="vital-card border-l-4 border-l-emerald-500 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">Recent Notes / Vitals</p>
                <Badge variant="notes" className="text-xs">
                  {notesFromPatient(activePatient).length
                    ? `${notesFromPatient(activePatient).length} notes`
                    : "None listed"}
                </Badge>
              </div>
              {activeVitals.length > 0 && (
                <div className="mb-2 grid grid-cols-2 gap-1 text-sm">
                  {activeVitals.slice(0, 6).map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-muted px-2 py-1.5">
                      <span className="mr-1 text-muted-foreground">{k}</span>
                      <span className="font-medium text-foreground">{v}</span>
                    </div>
                  ))}
                </div>
              )}
              <EditableNoteList
                notes={notesFromPatient(activePatient)}
                canEdit={permissions.canEditPatientStatus}
                noteProvider={
                  role === "doctor" && user?.userName
                    ? formatDoctorDisplayName(user.userName)
                    : user?.userName ?? "Chart"
                }
                onSave={(chartNotes) => {
                  void commitChartPatch(
                    activePatient.id,
                    { chartNotes },
                    {
                      chartNotes,
                      chartNote: chartNotes.map((n) => n.text).join(" "),
                    }
                  );
                }}
              />
            </motion.div>
            )}
          </div>
          )}

          {activePatient && (showSection("plan") || showSection("history")) && (
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="vital-card border-l-4 border-l-sky-500 px-3 py-2">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                <Phone className="h-4 w-4 text-blue-500" />
                Emergency Contact
              </p>
              <div className="mt-1 space-y-1">
                <InlineField
                  value={activePatient.emergencyContact?.name || ""}
                  displayValue={activePatient.emergencyContact?.name || "Not listed"}
                  placeholder="Name"
                  disabled={!permissions.canEditPatientStatus}
                  onCommit={(name) => {
                    const emergencyContact = {
                      ...activePatient.emergencyContact,
                      name: name || "Not listed",
                    };
                    void commitChartPatch(
                      activePatient.id,
                      { emergencyContact },
                      { emergencyContact }
                    );
                  }}
                />
                <InlineField
                  value={activePatient.emergencyContact?.relationship || ""}
                  displayValue={
                    activePatient.emergencyContact?.relationship || "Not listed"
                  }
                  placeholder="Relationship"
                  disabled={!permissions.canEditPatientStatus}
                  onCommit={(relationship) => {
                    const emergencyContact = {
                      ...activePatient.emergencyContact,
                      relationship: relationship || "Not listed",
                    };
                    void commitChartPatch(
                      activePatient.id,
                      { emergencyContact },
                      { emergencyContact }
                    );
                  }}
                />
                <InlineField
                  value={
                    /^not listed$/i.test(activePatient.emergencyContact?.phone ?? "")
                      ? ""
                      : activePatient.emergencyContact?.phone || ""
                  }
                  displayValue={activePatient.emergencyContact?.phone || "Not listed"}
                  placeholder="Phone"
                  disabled={!permissions.canEditPatientStatus}
                  onCommit={(phone) => {
                    const nextPhone = phone || "Not listed";
                    const emergencyContact = {
                      ...activePatient.emergencyContact,
                      phone: nextPhone,
                    };
                    void commitChartPatch(
                      activePatient.id,
                      { emergencyContact, primaryContactLine: phone },
                      { emergencyContact }
                    );
                  }}
                />
              </div>
            </div>
            <div className="vital-card border-l-4 border-l-amber-400 px-3 py-2">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                <Phone className="h-4 w-4 text-blue-500" />
                Primary contact line
              </p>
              <div className="mt-1">
                <InlineField
                  value={
                    /^not listed$/i.test(activePatient.emergencyContact?.phone ?? "")
                      ? ""
                      : activePatient.emergencyContact?.phone || ""
                  }
                  displayValue={activePatient.emergencyContact?.phone || "Not listed"}
                  placeholder="Phone"
                  disabled={!permissions.canEditPatientStatus}
                  onCommit={(phone) => {
                    void commitChartPatch(
                      activePatient.id,
                      { primaryContactLine: phone },
                      {
                        emergencyContact: {
                          ...activePatient.emergencyContact,
                          phone: phone || "Not listed",
                        },
                      }
                    );
                  }}
                />
              </div>
            </div>
            <div className="vital-card border-l-4 border-l-emerald-500 px-3 py-2">
              <p className="text-sm font-medium text-foreground">Care Team</p>
              <EditableStringList
                items={activePatient.careTeam ?? []}
                canEdit={permissions.canEditPatientStatus}
                addLabel="+ Add team member"
                placeholder="Role or name"
                onSave={(careTeam) => {
                  void commitChartPatch(
                    activePatient.id,
                    { careTeam },
                    { careTeam }
                  );
                }}
              />
            </div>
            <div className="vital-card border-l-4 border-l-amber-500 px-3 py-2">
              <p className="text-sm font-medium text-foreground">Risk Flags</p>
              <EditableStringList
                items={splitRiskFlags(activePatient.riskFlags)}
                canEdit={permissions.canEditPatientStatus}
                addLabel="+ Add risk flag"
                placeholder="Risk flag"
                onSave={(items) => {
                  const riskFlags = joinRiskFlags(items);
                  void commitChartPatch(
                    activePatient.id,
                    { riskFlags },
                    { riskFlags }
                  );
                }}
              />
            </div>
          </div>
          )}

          {(isChartLoading || requestedPatientView) && (
            <div className="mt-3" ref={requestedCardRef}>
              <AnimatePresence mode="wait">
                {isChartLoading ? (
                  <motion.div
                    key="chart-loading"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className="vital-card p-4"
                  >
                    <div className="mb-3 h-5 w-48 animate-pulse rounded bg-muted" />
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
                      ))}
                    </div>
                  </motion.div>
                ) : requestedPatientView ? (
                  <motion.div
                    key={`requested-${requestedPatientView.patientId}-${requestedPatientView.fields.join("-")}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.25 }}
                  >
                    <RequestedPatientCard
                      view={requestedPatientView}
                      problems={problemStateByPatient[requestedPatientView.patientId] ?? []}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          )}

          <AnimatePresence initial={false}>
            {pendingOrders.length > 0 && ordersPanelVisible && (
              <motion.div
                key="live-medication-orders"
                initial={{ opacity: 1, y: 0 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.4 }}
                className="mt-3 vital-card border-l-4 border-l-sky-600 p-3"
              >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-foreground">Live Medication Orders</p>
                <Badge variant="notes">
                  {pendingOrders.filter((o) => o.status !== "Delivered").length} active
                </Badge>
              </div>
              <div className="space-y-2">
                {pendingOrders.slice(0, 4).map((order) => (
                  <motion.div
                    key={order.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      "rounded-lg border border-border bg-muted px-3 py-2",
                      order.status === "Delivered" && "border-emerald-200 bg-emerald-50"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">
                        {order.medication} for {order.patientName}
                      </p>
                      <Badge
                        variant={
                          order.status === "Order Queued"
                            ? "outline"
                            : order.status === "Pharmacy Preparing"
                              ? "problems"
                              : order.status === "Ready for Pickup"
                                ? "notes"
                                : order.status === "Nurse Assigned"
                                  ? "medications"
                                  : order.status === "In Transit"
                                    ? "clinical"
                                    : "notes"
                        }
                      >
                        {order.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {order.room} •{" "}
                      {new Date(order.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {order.nurseName} • {order.pharmacyStation}
                    </p>
                    <div className="mt-2 h-1.5 rounded-full bg-muted">
                      <motion.div
                        className="h-1.5 rounded-full bg-primary"
                        initial={{ width: 0 }}
                        animate={{
                          width: `${((order.stepIndex + 1) / ORDER_WORKFLOW_STEPS.length) * 100}%`,
                        }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Queued → Pharmacy → Nurse → Patient
                    </p>
                  </motion.div>
                ))}
              </div>
              </motion.div>
            )}
          </AnimatePresence>

            </>
          )}
        </section>

        <aside className="hidden border-l border-border bg-card p-4 lg:block">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">Patient Details</p>
            <Badge variant="notes" className="text-[10px]">
              {activePage === "dashboard" ? "Live" : "Info"}
            </Badge>
          </div>
          {activePage !== "dashboard" ? (
            <div className="vital-card p-3 text-sm text-muted-foreground">
              Select <span className="font-medium text-foreground">Dashboard</span> to view active
              patient details and chart navigation.
            </div>
          ) : !activePatient ? (
            <div className="vital-card border-dashed p-4 text-sm text-muted-foreground">
              No active patient chart.
            </div>
          ) : (
          <div className="space-y-2">
            {[
              ["Allergies", `${activeAllergies.length || 0} total`, "allergies", "border-l-rose-400"],
              ["Medications", `${activeMeds.length || 0} active`, "medications", "border-l-sky-500"],
              ["Problems", `${activeProblems.length || 0} active`, "diagnoses", "border-l-amber-400"],
              [
                "Recent Notes",
                notesFromPatient(activePatient).length
                  ? `${notesFromPatient(activePatient).length} notes`
                  : "None listed",
                "vitals",
                "border-l-slate-400",
              ],
              ["Emergency Contact", activePatient?.emergencyContact?.name ? "1 contact" : "None listed", "plan", "border-l-sky-400"],
              ["Care Team", `${activePatient?.careTeam?.length ?? 0} listed`, "plan", "border-l-emerald-500"],
              ["Risk Flags", activePatient?.riskFlags ? "1 flag" : "None listed", "plan", "border-l-amber-500"],
            ].map(([label, value, key, accent]) => (
              <button
                type="button"
                key={label}
                onClick={() => {
                  if (!activePatient) return;
                  const next = key as PatientFieldKey;
                  setActiveRequestedSections((prev) => {
                    const updated = prev.includes(next)
                      ? prev.filter((section) => section !== next)
                      : [...prev, next];
                    if (updated.length) {
                      void openRequestedView(activePatient, updated);
                    } else {
                      setRequestedPatientView(null);
                    }
                    return updated;
                  });
                }}
                className={cn(
                  "w-full vital-card-hover border-l-4 p-3 text-left",
                  accent as string
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-foreground">{label}</p>
                  <div className="inline-flex items-center gap-2">
                    <Badge
                      variant={
                        label === "Allergies"
                          ? "allergies"
                          : label === "Medications"
                            ? "medications"
                            : label === "Problems"
                              ? "problems"
                              : label === "Risk Flags"
                                ? "risk"
                                : "notes"
                      }
                      className="text-xs"
                    >
                      {value}
                    </Badge>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">- Tap to open section in workspace</p>
              </button>
            ))}
            <div className="vital-card p-3">
              <p className="text-sm font-semibold text-foreground">Notes</p>
              <div className="mt-1">
                <EditableNoteList
                  notes={notesFromPatient(activePatient)}
                  canEdit={permissions.canEditPatientStatus}
                  addLabel="+ Add note"
                  noteProvider={
                    role === "doctor" && user?.userName
                      ? formatDoctorDisplayName(user.userName)
                      : user?.userName ?? "Chart"
                  }
                  onSave={(chartNotes) => {
                    void commitChartPatch(
                      activePatient.id,
                      { chartNotes },
                      {
                        chartNotes,
                        chartNote: chartNotes.map((n) => n.text).join(" "),
                      }
                    );
                  }}
                />
              </div>
            </div>
            <div className="vital-card p-3">
              <p className="text-sm font-semibold text-foreground">Emergency Contact</p>
              <div className="mt-2 space-y-1">
                <InlineField
                  value={activePatient.emergencyContact?.name || ""}
                  displayValue={activePatient.emergencyContact?.name || "Not listed"}
                  placeholder="Name"
                  disabled={!permissions.canEditPatientStatus}
                  onCommit={(name) => {
                    const emergencyContact = {
                      ...activePatient.emergencyContact,
                      name: name || "Not listed",
                    };
                    void commitChartPatch(
                      activePatient.id,
                      { emergencyContact },
                      { emergencyContact }
                    );
                  }}
                />
                <InlineField
                  value={activePatient.emergencyContact?.relationship || ""}
                  displayValue={
                    activePatient.emergencyContact?.relationship || "Not listed"
                  }
                  placeholder="Relationship"
                  disabled={!permissions.canEditPatientStatus}
                  onCommit={(relationship) => {
                    const emergencyContact = {
                      ...activePatient.emergencyContact,
                      relationship: relationship || "Not listed",
                    };
                    void commitChartPatch(
                      activePatient.id,
                      { emergencyContact },
                      { emergencyContact }
                    );
                  }}
                />
                <p className="inline-flex w-full items-center gap-2 text-sm text-foreground">
                  <Phone className="h-4 w-4 shrink-0 text-blue-500" />
                  <InlineField
                    value={
                      /^not listed$/i.test(activePatient.emergencyContact?.phone ?? "")
                        ? ""
                        : activePatient.emergencyContact?.phone || ""
                    }
                    displayValue={activePatient.emergencyContact?.phone || "Not listed"}
                    placeholder="Phone"
                    disabled={!permissions.canEditPatientStatus}
                    onCommit={(phone) => {
                      const nextPhone = phone || "Not listed";
                      void commitChartPatch(
                        activePatient.id,
                        {
                          emergencyContact: {
                            ...activePatient.emergencyContact,
                            phone: nextPhone,
                          },
                          primaryContactLine: phone,
                        },
                        {
                          emergencyContact: {
                            ...activePatient.emergencyContact,
                            phone: nextPhone,
                          },
                        }
                      );
                    }}
                  />
                </p>
              </div>
            </div>
            <div className="vital-card p-3">
              <p className="text-sm font-semibold text-foreground">Care Team</p>
              <EditableStringList
                items={activePatient.careTeam ?? []}
                canEdit={permissions.canEditPatientStatus}
                addLabel="+ Add team member"
                onSave={(careTeam) => {
                  void commitChartPatch(activePatient.id, { careTeam }, { careTeam });
                }}
              />
            </div>
            <div className="vital-card p-3">
              <p className="text-sm font-semibold text-foreground">Risk Flags</p>
              <EditableStringList
                items={splitRiskFlags(activePatient.riskFlags)}
                canEdit={permissions.canEditPatientStatus}
                addLabel="+ Add risk flag"
                onSave={(items) => {
                  const riskFlags = joinRiskFlags(items);
                  void commitChartPatch(
                    activePatient.id,
                    { riskFlags },
                    { riskFlags }
                  );
                }}
              />
            </div>
          </div>
          )}
        </aside>
      </div>

      <AnimatePresence mode="sync">
        {workspaceOpen && (
          <WorkspaceOverlay
            tab={workspaceTab}
            onTab={setWorkspaceTab}
            onClose={() => setWorkspaceOpen(false)}
            patients={patients}
            selectedPatientId={selectedPatientId}
            onSelectPatient={(id) => {
              if (id === null) userClearedFocusRef.current = true;
              else userClearedFocusRef.current = false;
              setSelectedPatientId(id);
              if (id) {
                setOpenPatientTabIds((prev) =>
                  prev.includes(id) ? prev : [...prev, id].slice(-5)
                );
              }
            }}
            patientSnapshot={patientSnapshot}
            onPatientSnapshot={setPatientSnapshot}
            conversationTurns={conversationTurns}
            response={response}
            systemState={systemState}
            isBusy={isBusy}
            voiceEnabled={voiceEnabled}
            supportsTts={supportsTts}
            onReplay={() =>
              response && voiceEnabled && supportsTts && speak(response.text)
            }
            onStopSpeaking={stopSpeaking}
            onEmergency={handleEmergency}
            onSoap={handleSoap}
            onSummarize={handleSummarize}
            onClear={handleClear}
            emergencyArmed={emergencyArmed}
            audit={audit}
            clinicalReasoning={clinicalReasoning}
            pendingMedicationOrder={pendingMedicationOrder}
            sttChoice={sttChoice}
            intentRoute={intentRoute}
          />
        )}
      </AnimatePresence>
    </main>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Minimal chrome + workspace (reference-style split UI)
 * ────────────────────────────────────────────────────────────────────────── */

function CompactStatusPill({
  systemState,
  mode,
}: {
  systemState: SystemState;
  mode: VitalMode;
}) {
  const label: Record<SystemState, string> = {
    idle: "Ready",
    listening: "Listening",
    processing: "Thinking",
    speaking: "Speaking",
    error: "Error",
  };
  return (
    <span className="inline-flex max-w-[220px] flex-wrap items-center justify-end gap-1.5 text-[10px] font-medium text-foreground">
      <span className="flex items-center gap-1 rounded-full border border-border/90 bg-card px-2 py-0.5 text-foreground transition-colors hover:bg-muted">
        {systemState === "idle" && <VitalLogo size={11} variant="icon" />}
        {systemState === "listening" && (
          <span className="animate-pulse">
            <VitalLogo size={11} variant="icon" />
          </span>
        )}
        {systemState === "processing" && (
          <span className="animate-spin">
            <VitalLogo size={11} variant="icon" />
          </span>
        )}
        {systemState === "speaking" && (
          <Volume2 className="h-3 w-3 text-fuchsia-300" />
        )}
        {systemState === "error" && (
          <AlertTriangle className="h-3 w-3 text-red-300" />
        )}
        {label[systemState]}
      </span>
      <span className="rounded-full border border-teal-300/85 bg-teal-100 px-2 py-0.5 font-semibold text-teal-900 transition-colors hover:bg-teal-200">
        {MODE_LABEL[mode]}
      </span>
    </span>
  );
}

function LiveTranscriptBlock({
  finalText,
  interimText,
  lastSubmitted,
  systemState,
}: {
  finalText: string;
  interimText: string;
  lastSubmitted: string;
  systemState: SystemState;
}) {
  const f = finalText.trim();
  const i = interimText.trim();
  const listening = systemState === "listening";

  if (!f && !i) {
    return (
      <div className="space-y-3">
        <p className="text-2xl font-medium leading-snug tracking-tight text-neutral-400 lg:text-[1.65rem] lg:leading-snug">
          {lastSubmitted.trim() ? (
            <>
              <span className="text-neutral-400">Last said — </span>
              <span className="text-neutral-600">{lastSubmitted.trim()}</span>
            </>
          ) : (
            "Use the mic to start. Pause briefly to send your message."
          )}
        </p>
      </div>
    );
  }

  const words = i.split(/\s+/).filter(Boolean);
  const emphasis =
    words.length > 0 ? words[words.length - 1] : "";
  const lead =
    words.length > 1 ? words.slice(0, -1).join(" ") + (words.length > 1 ? " " : "") : "";

  return (
    <div className="space-y-3">
      {f && (
        <p className="text-xl font-normal leading-relaxed text-neutral-500 lg:text-2xl">
          {f}
        </p>
      )}
      {i && (
        <p className="text-2xl font-semibold leading-snug tracking-tight text-neutral-900 lg:text-[1.85rem]">
          {lead}
          {emphasis && (
            <span className="font-bold text-neutral-950">{emphasis}</span>
          )}
          {listening && (
            <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-primary align-middle" />
          )}
        </p>
      )}
    </div>
  );
}

function RequestedPatientCard({
  view,
  problems,
}: {
  view: RequestedPatientView;
  problems: EditableProblem[];
}) {
  const p = view.patient;
  const wantsOverview = view.fields.includes("overview");
  const show = (k: PatientFieldKey) => wantsOverview || view.fields.includes(k);
  const vitals = Object.entries(p.vitals);
  const meds = p.medications.slice(0, 6);
  const onlySection = !wantsOverview && view.fields.length === 1 ? view.fields[0] : null;

  return (
    <div className="mt-2 overflow-hidden vital-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-4 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Requested chart data
        </p>
        <Badge variant="clinical">{view.title}</Badge>
      </div>
      <div className="p-4">

      {(wantsOverview || !onlySection) && (
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="vital-section p-2.5">
          <p className="text-[10px] uppercase text-muted-foreground">Age/Sex</p>
          <p className="text-sm font-medium text-foreground">
            {p.age}
            {p.sex}
          </p>
        </div>
        <div className="vital-section p-2.5">
          <p className="text-[10px] uppercase text-muted-foreground">MRN</p>
          <p className="text-sm font-medium text-foreground">{p.mrn}</p>
        </div>
        <div className="vital-section p-2.5">
          <p className="text-[10px] uppercase text-muted-foreground">Problems</p>
          <p className="text-sm font-medium text-foreground">
            {p.diagnoses.length}
          </p>
        </div>
        <div className="vital-section p-2.5">
          <p className="text-[10px] uppercase text-muted-foreground">Meds</p>
          <p className="text-sm font-medium text-foreground">
            {p.medications.length}
          </p>
        </div>
      </div>
      )}

      {view.fields.includes("demographics") && !wantsOverview && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="vital-section px-2.5 py-2">
            <p className="text-[10px] uppercase text-muted-foreground">DOB</p>
            <p className="text-sm font-medium text-foreground">{p.dob}</p>
          </div>
          <div className="vital-section px-2.5 py-2">
            <p className="text-[10px] uppercase text-muted-foreground">Room</p>
            <p className="text-sm font-medium text-foreground">{p.room}</p>
          </div>
          <div className="vital-section px-2.5 py-2">
            <p className="text-[10px] uppercase text-muted-foreground">Blood type</p>
            <p className="text-sm font-semibold text-neutral-900">{p.bloodType}</p>
          </div>
          <div className="vital-section px-2.5 py-2">
            <p className="text-[10px] uppercase text-muted-foreground">Acuity</p>
            <p className="text-sm font-medium text-foreground">{p.triageAcuity}</p>
          </div>
          <div className="col-span-2 vital-section px-2.5 py-2 sm:col-span-3">
            <p className="text-[10px] uppercase text-muted-foreground">Chief concern</p>
            <p className="text-sm font-medium text-foreground">{p.chiefConcern}</p>
          </div>
          {p.symptoms && p.symptoms.length > 0 && (
            <div className="col-span-2 vital-section px-2.5 py-2 sm:col-span-3">
              <p className="text-[10px] uppercase text-muted-foreground">Symptoms</p>
              <p className="text-sm text-foreground">{p.symptoms.join(", ")}</p>
            </div>
          )}
        </div>
      )}

      {show("vitals") && vitals.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
            Vitals
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {vitals.map(([k, v]) => (
              <div
                key={`${view.patientId}-v-${k}`}
                className="rounded-lg border border-border bg-muted/60 px-2.5 py-2"
              >
                <p className="text-[10px] uppercase text-neutral-500">{k}</p>
                <p className="text-sm font-semibold text-neutral-900">{v}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {show("medications") && meds.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
            Active medications
          </p>
          <div className="space-y-1">
            {meds.map((m, idx) => (
              <p
                key={`${view.patientId}-m-${idx}`}
                className="rounded-lg border border-border bg-muted/60 px-2.5 py-1.5 text-sm text-foreground"
              >
                {m.name} - {m.sig}
              </p>
            ))}
          </div>
        </div>
      )}

      {show("diagnoses") && problems.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
            Problems
          </p>
          <div className="space-y-1.5">
            {problems.map((problem) => (
              <div
                key={problem.id}
                className="flex items-center justify-between rounded-lg border border-amber-200/80 bg-amber-50/60 px-2.5 py-1.5 text-sm dark:border-amber-800/50 dark:bg-amber-950/30"
              >
                <span className="text-neutral-800">{problem.name}</span>
                <Badge
                  variant={
                    problem.status === "Resolved"
                      ? "notes"
                      : problem.status === "Monitoring"
                        ? "problems"
                        : problem.status === "Pending"
                          ? "allergies"
                          : problem.status === "Ruled out"
                            ? "outline"
                            : "medications"
                  }
                  className="text-[10px]"
                >
                  {problem.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 space-y-1.5">
        {view.lines.map((line, idx) => (
          <p
            key={`${view.patientId}-${idx}`}
            className="text-sm leading-relaxed text-neutral-700"
          >
            {line}
          </p>
        ))}
      </div>
      </div>
    </div>
  );
}

function ErrorBannerLight({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <AnimatePresence>
      {error && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="flex-1">{error}</p>
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded-lg border border-red-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-red-800 hover:bg-red-100"
          >
            dismiss
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function WorkspaceOverlay({
  tab,
  onTab,
  onClose,
  patients,
  selectedPatientId,
  onSelectPatient,
  patientSnapshot,
  onPatientSnapshot,
  conversationTurns,
  response,
  systemState,
  isBusy,
  voiceEnabled,
  supportsTts,
  onReplay,
  onStopSpeaking,
  onEmergency,
  onSoap,
  onSummarize,
  onClear,
  emergencyArmed,
  audit,
  clinicalReasoning,
  pendingMedicationOrder,
  sttChoice,
  intentRoute,
}: {
  tab: "charts" | "response" | "dialogue" | "actions" | "system";
  onTab: (t: "charts" | "response" | "dialogue" | "actions" | "system") => void;
  onClose: () => void;
  patients: DemoPatient[];
  selectedPatientId: string | null;
  onSelectPatient: (id: string | null) => void;
  patientSnapshot: string;
  onPatientSnapshot: (v: string) => void;
  conversationTurns: ConversationTurn[];
  response: VitalApiResponse | null;
  systemState: SystemState;
  isBusy: boolean;
  voiceEnabled: boolean;
  supportsTts: boolean;
  onReplay: () => void;
  onStopSpeaking: () => void;
  onEmergency: () => void;
  onSoap: () => void;
  onSummarize: () => void;
  onClear: () => void;
  emergencyArmed: boolean;
  audit: AuditEntry[];
  clinicalReasoning: ClinicalReasoningResult | null;
  pendingMedicationOrder: PendingMedicationDraft | null;
  sttChoice: TranscriptChoice | null;
  intentRoute: {
    provider: IntentProvider;
    latencyMs: number | null;
    fallbackReason: string | null;
  } | null;
}) {
  const tabs: { id: typeof tab; label: string }[] = [
    { id: "charts", label: "Charts" },
    { id: "response", label: "Answer" },
    { id: "dialogue", label: "Log" },
    { id: "actions", label: "Tools" },
    { id: "system", label: "System" },
  ];

  const sheetSurface =
    "[&_.panel]:border-neutral-200/90 [&_.panel]:bg-card [&_.panel]:shadow-sm [&_.panel-header]:border-neutral-200/80 [&_.mono]:text-neutral-600 [&_.text-muted-foreground]:text-neutral-500";

  return (
    <motion.div
      className="fixed inset-0 z-50 flex"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, pointerEvents: "auto" }}
      /* pointerEvents goes dead the instant exit starts, so a stalled or
         interrupted unmount can never leave an invisible full-screen layer
         swallowing clicks on the page underneath. */
      exit={{
        opacity: 0,
        pointerEvents: "none",
        transition: { duration: 0.18, ease: "easeIn" },
      }}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        aria-label="Close panel"
        onClick={onClose}
      />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        /* Spring on the way in, tween on the way out. A spring approaches its
           target asymptotically and may never report completion, and
           AnimatePresence will not unmount the tree until it does. */
        exit={{
          x: "100%",
          transition: { type: "tween", duration: 0.2, ease: "easeIn" },
        }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
        id="vital-workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Clinical workspace"
        className="relative ml-auto flex h-full w-full max-w-full flex-col bg-[#F2F2EB] shadow-2xl sm:max-w-md md:max-w-lg"
      >
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200/90 px-4 py-3">
          <div className="scrollbar-thin flex flex-1 gap-1 overflow-x-auto pb-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTab(t.id)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                  tab === t.id
                    ? "bg-neutral-900 text-[#F2F2EB]"
                    : "bg-card text-neutral-600 shadow-sm ring-1 ring-neutral-200/80 hover:bg-neutral-50"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-card text-neutral-700 hover:bg-neutral-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          className={cn(
            "scrollbar-thin flex-1 space-y-4 overflow-y-auto p-4",
            sheetSurface
          )}
        >
          {tab === "charts" && (
            <>
              <DemoRosterPanel
                patients={patients}
                selectedId={selectedPatientId}
                onSelect={onSelectPatient}
              />
              <PatientPanel value={patientSnapshot} onChange={onPatientSnapshot} />
            </>
          )}
          {tab === "response" && (
            <>
              {pendingMedicationOrder && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-xl border border-amber-300/60 bg-amber-50/90 px-3 py-2 text-sm text-amber-950 shadow-sm dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-100"
                >
                  Pending order: {pendingMedicationOrder.medication} for{" "}
                  {pendingMedicationOrder.patientName}. Say &quot;yes&quot; to
                  confirm or &quot;cancel&quot; to discard.
                </motion.div>
              )}
              {clinicalReasoning && (
                <ClinicalReasoningPanel reasoning={clinicalReasoning} />
              )}
              <ResponsePanel
                response={response}
                systemState={systemState}
                isBusy={isBusy}
                onReplay={onReplay}
                onStopSpeaking={onStopSpeaking}
                voiceEnabled={voiceEnabled}
                supportsTts={supportsTts}
              />
            </>
          )}
          {tab === "dialogue" && (
            <>
              <DialogueRail turns={conversationTurns} />
              <AuditPanel entries={audit} />
            </>
          )}
          {tab === "actions" && (
            <div className="space-y-3">
              <ActionBar
                systemState={systemState}
                emergencyArmed={emergencyArmed}
                onEmergency={onEmergency}
                onSoap={onSoap}
                onSummarize={onSummarize}
                onClear={onClear}
              />
              <p className="text-center text-[11px] text-neutral-500">
                Or keep using voice — these mirror your clinical shortcuts.
              </p>
            </div>
          )}
          {tab === "system" && (
            <SystemPanel
              systemState={systemState}
              sttChoice={sttChoice}
              intentRoute={intentRoute}
            />
          )}
        </div>
      </motion.aside>
    </motion.div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Action Bar
 * ────────────────────────────────────────────────────────────────────────── */

function ActionBar({
  systemState,
  emergencyArmed,
  onEmergency,
  onSoap,
  onSummarize,
  onClear,
}: {
  systemState: SystemState;
  emergencyArmed: boolean;
  onEmergency: () => void;
  onSoap: () => void;
  onSummarize: () => void;
  onClear: () => void;
}) {
  const disabled = systemState === "processing";
  return (
    <div className="panel grid grid-cols-2 gap-2.5 p-3.5 sm:grid-cols-4">
      <Button
        variant={emergencyArmed ? "destructive" : "outline"}
        onClick={onEmergency}
        disabled={disabled}
        className={cn(
          emergencyArmed && "ring-2 ring-rose-300"
        )}
      >
        <Siren className="h-4 w-4" />
        {emergencyArmed ? "Emergency · Armed" : "Emergency Mode"}
      </Button>
      <Button variant="secondary" onClick={onSoap} disabled={disabled}>
        <FileText className="h-4 w-4" />
        Generate SOAP Note
      </Button>
      <Button variant="secondary" onClick={onSummarize} disabled={disabled}>
        <BookText className="h-4 w-4" />
        Summarize Patient
      </Button>
      <Button variant="ghost" onClick={onClear} disabled={disabled}>
        <Eraser className="h-4 w-4" />
        Clear Session
      </Button>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Clinical reasoning (differential diagnosis)
 * ────────────────────────────────────────────────────────────────────────── */

function ClinicalReasoningPanel({
  reasoning,
}: {
  reasoning: ClinicalReasoningResult;
}) {
  return (
    <div className="panel space-y-3 p-4">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-2"
      >
        <Sparkles className="h-4 w-4 text-clinical-cyan" />
        <span className="mono text-xs uppercase tracking-wider text-muted-foreground">
          differential diagnosis
        </span>
      </motion.div>
      <p className="text-sm font-medium text-foreground">
        Chief concern: {reasoning.chiefConcern}
      </p>
      {reasoning.symptomsUsed.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Symptoms considered: {reasoning.symptomsUsed.join(", ")}
        </p>
      )}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="space-y-2"
      >
        {reasoning.possibleDiagnoses.map((dx, idx) => (
          <div
            key={`${dx.diagnosis}-${idx}`}
            className="rounded-lg border border-border bg-muted px-3 py-2"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <p className="text-sm font-semibold text-foreground">{dx.diagnosis}</p>
              <Badge variant="outline" className="text-[10px] uppercase">
                {dx.likelihood}
              </Badge>
            </motion.div>
            <p className="mt-1 text-xs leading-relaxed text-foreground/85">
              {dx.whyItMatters}
            </p>
            {dx.supportingFindings.length > 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Supporting: {dx.supportingFindings.join("; ")}
              </p>
            )}
            {dx.missingOrContradictingFindings.length > 0 && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Missing / contradicting:{" "}
                {dx.missingOrContradictingFindings.join("; ")}
              </p>
            )}
            {dx.suggestedNextChecks.length > 0 && (
              <p className="mt-1 text-[11px] text-clinical-cyan">
                Next checks: {dx.suggestedNextChecks.join("; ")}
              </p>
            )}
          </div>
        ))}
      </motion.div>
      {reasoning.redFlags.length > 0 && (
        <div className="rounded-md border border-clinical-warn/40 bg-clinical-warn/10 px-3 py-2 text-xs text-clinical-warn">
          <p className="font-semibold">Red flags to rule out</p>
          <ul className="mt-1 list-disc pl-4">
            {reasoning.redFlags.map((flag, i) => (
              <li key={i}>{flag}</li>
            ))}
          </ul>
        </div>
      )}
      {(reasoning.recommendedQuestions.length > 0 ||
        reasoning.recommendedChecks.length > 0) && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2"
        >
          {reasoning.recommendedQuestions.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <p className="font-semibold text-foreground/80">Ask next</p>
              <ul className="mt-1 list-disc pl-4">
                {reasoning.recommendedQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </motion.div>
          )}
          {reasoning.recommendedChecks.length > 0 && (
            <motion.div
              initial={{ opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <p className="font-semibold text-foreground/80">Check next</p>
              <ul className="mt-1 list-disc pl-4">
                {reasoning.recommendedChecks.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </motion.div>
          )}
        </motion.div>
      )}
      <p className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
        {reasoning.safetyNote}
      </p>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Response Panel (the clinical card)
 * ────────────────────────────────────────────────────────────────────────── */

function ResponsePanel({
  response,
  systemState,
  isBusy,
  onReplay,
  onStopSpeaking,
  voiceEnabled,
  supportsTts,
}: {
  response: VitalApiResponse | null;
  systemState: SystemState;
  isBusy: boolean;
  onReplay: () => void;
  onStopSpeaking: () => void;
  voiceEnabled: boolean;
  supportsTts: boolean;
}) {
  const isProcessing = systemState === "processing";
  const isSpeaking = systemState === "speaking";

  return (
    <div
      className={cn(
        "panel relative min-h-[280px] overflow-hidden lg:min-h-[320px]",
        isSpeaking && "ring-clinical"
      )}
    >
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-clinical-cyan" />
          <span className="mono text-xs uppercase tracking-wider text-muted-foreground">
            vital os response
          </span>
        </div>
        <div className="flex items-center gap-2">
          {response && (
            <>
              <Badge variant={MODE_BADGE[response.mode]}>
                {MODE_LABEL[response.mode]}
              </Badge>
              <Badge variant="outline">
                <span className="mono">{response.model}</span>
              </Badge>
              <Badge variant="outline">
                <span className="mono">{response.latencyMs}ms</span>
              </Badge>
            </>
          )}
        </div>
      </div>

      <div className="relative min-h-[260px] px-5 py-5">
        {/* Speaking shimmer top edge */}
        {isSpeaking && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden"
          >
            <div className="h-full w-1/3 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-clinical-mint to-transparent" />
          </motion.div>
        )}

        <AnimatePresence mode="wait">
          {isProcessing && !response ? (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center gap-3 py-14 text-muted-foreground"
            >
              <span className="animate-spin">
                <VitalLogo size={24} variant="icon" />
              </span>
              <p className="mono text-xs uppercase tracking-wider">
                consulting vital os…
              </p>
            </motion.div>
          ) : response ? (
            <motion.div
              key={response.text.slice(0, 24) + response.latencyMs}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: "easeOut" }}
              className="space-y-4"
            >
              <ClinicalText text={response.text} />
              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                {voiceEnabled && supportsTts && !isSpeaking && (
                  <Button size="sm" variant="outline" onClick={onReplay}>
                    <Volume2 className="h-3.5 w-3.5" />
                    Replay voice
                  </Button>
                )}
                {isSpeaking && (
                  <Button size="sm" variant="outline" onClick={onStopSpeaking}>
                    <Pause className="h-3.5 w-3.5" />
                    Stop voice
                  </Button>
                )}
                <span className="mono ml-auto text-[10px] uppercase text-muted-foreground">
                  not a substitute for clinical judgment
                </span>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 text-center text-muted-foreground"
            >
              <VitalLogo size={30} variant="icon" />
              <p className="text-sm">
                VITAL OS is on standby. Dictate a command to begin.
              </p>
              <p className="mono text-[11px] uppercase tracking-wider text-muted-foreground/70">
                e.g. &quot;Generate a SOAP note for a 64-year-old with chest pain&quot;
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {isBusy && !isSpeaking && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-clinical-cyan/60 to-transparent" />
      )}
    </div>
  );
}

/**
 * Render assistant text with light structural styling:
 * - Lines that look like ALL-CAPS section headers become headings
 * - Lines starting with "-" or "•" become bullets
 * - Numbered lines become numbered items
 * - Lines starting with "Safety:" get a warning treatment
 */
function ClinicalText({ text }: { text: string }) {
  const lines = text.split(/\n/).map((l) => l.trimEnd());
  const blocks: React.ReactNode[] = [];
  let bullets: string[] | null = null;

  const flushBullets = (key: string) => {
    if (bullets && bullets.length) {
      blocks.push(
        <ul
          key={`bul-${key}`}
          className="ml-1 list-none space-y-1.5 border-l border-clinical-teal/30 pl-3"
        >
          {bullets.map((b, i) => (
            <li
              key={i}
              className="relative text-[14px] leading-relaxed text-foreground/95"
            >
              <span className="absolute -left-[14px] top-2 h-1.5 w-1.5 rounded-full bg-clinical-teal/70" />
              {b}
            </li>
          ))}
        </ul>
      );
      bullets = null;
    }
  };

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) {
      flushBullets(`b-${idx}`);
      blocks.push(<div key={`sp-${idx}`} className="h-1" />);
      return;
    }

    if (/^safety\s*:/i.test(line)) {
      flushBullets(`b-${idx}`);
      const body = line.replace(/^safety\s*:\s*/i, "");
      blocks.push(
        <div
          key={`safe-${idx}`}
          className="flex items-start gap-2 rounded-md border border-clinical-warn/40 bg-clinical-warn/10 px-3 py-2 text-[13px] text-clinical-warn"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <span className="mono uppercase tracking-wider">Safety: </span>
            <span className="text-foreground/90">{body}</span>
          </p>
        </div>
      );
      return;
    }

    const isHeader =
      /^[A-Z][A-Z0-9 \-/&]{2,}:?$/.test(line) && line.length <= 48;
    if (isHeader) {
      flushBullets(`b-${idx}`);
      blocks.push(
        <h3
          key={`h-${idx}`}
          className="mono mt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-clinical-cyan"
        >
          {line.replace(/:$/, "")}
        </h3>
      );
      return;
    }

    const bulletMatch = line.match(/^[-•·]\s+(.*)$/);
    if (bulletMatch) {
      bullets = bullets ?? [];
      bullets.push(bulletMatch[1]);
      return;
    }

    const numMatch = line.match(/^(\d+)[.)]\s+(.*)$/);
    if (numMatch) {
      flushBullets(`b-${idx}`);
      blocks.push(
        <div
          key={`n-${idx}`}
          className="flex items-start gap-3 text-[14px] leading-relaxed text-foreground/95"
        >
          <span className="mono mt-0.5 inline-flex h-5 min-w-[22px] items-center justify-center rounded-md bg-clinical-cyan/15 px-1.5 text-[11px] text-clinical-cyan">
            {numMatch[1]}
          </span>
          <span>{numMatch[2]}</span>
        </div>
      );
      return;
    }

    flushBullets(`b-${idx}`);
    blocks.push(
      <p
        key={`p-${idx}`}
        className="text-[14.5px] leading-relaxed text-foreground/95"
      >
        {line}
      </p>
    );
  });

  flushBullets("end");
  return <div className="space-y-2.5">{blocks}</div>;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Demo roster + dialogue
 * ────────────────────────────────────────────────────────────────────────── */

function DemoRosterPanel({
  patients,
  selectedId,
  onSelect,
}: {
  patients: DemoPatient[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <UserRound className="h-4 w-4 text-clinical-cyan" />
          <span className="mono text-xs uppercase tracking-wider text-muted-foreground">
            Patient roster
          </span>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {patients.length} charts
        </Badge>
      </div>
      <div className="scrollbar-thin max-h-52 space-y-1.5 overflow-y-auto p-3">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={cn(
            "mono w-full rounded-lg border px-2 py-2 text-left text-[11px] transition-colors",
            selectedId === null
              ? "border-clinical-teal/50 bg-clinical-teal/10 text-clinical-teal"
              : "border-border/60 bg-background/40 text-muted-foreground hover:border-border"
          )}
        >
          No focus — ask about any roster patient by name
        </button>
        {patients.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={cn(
              "w-full rounded-lg border px-2 py-2 text-left transition-colors",
              selectedId === p.id
                ? "border-clinical-teal/50 bg-clinical-teal/10"
                : "border-border/60 bg-background/40 hover:border-border"
            )}
          >
            <motion.div layout className="mono text-[11px] font-medium text-foreground/95">
              {p.name}
              <PatientClinicalIndicator patient={p} />
            </motion.div>
            <div className="mono text-[10px] text-muted-foreground">
              {p.mrn} · {p.age}
              {p.sex} ·{" "}
              {p.chiefConcern.length > 40
                ? `${p.chiefConcern.slice(0, 40)}…`
                : p.chiefConcern}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DialogueRail({ turns }: { turns: ConversationTurn[] }) {
  const bottomRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <div className="panel flex max-h-52 min-h-[112px] flex-col">
      <div className="panel-header py-2">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-clinical-mint" />
          <span className="mono text-xs uppercase tracking-wider text-muted-foreground">
            live dialogue · session memory
          </span>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {turns.length} lines
        </Badge>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-3">
        {turns.length === 0 ? (
          <p className="mono py-4 text-center text-[11px] leading-relaxed text-muted-foreground">
            In a voice session the mic stays open: pause to send, talk over the
            AI to interrupt. Each reply is remembered for follow-ups like &quot;what
            about her meds?&quot;
          </p>
        ) : (
          <div className="space-y-2 font-mono text-[12px] leading-relaxed">
            {turns.map((t, i) => (
              <div
                key={`${i}-${t.role}-${t.content.slice(0, 12)}`}
                className={cn(
                  "rounded-md border px-2 py-1.5",
                  t.role === "user"
                    ? "border-clinical-teal/30 bg-clinical-teal/5"
                    : "border-clinical-cyan/25 bg-clinical-cyan/5"
                )}
              >
                <span
                  className={cn(
                    "text-[10px] uppercase tracking-wider",
                    t.role === "user"
                      ? "text-clinical-teal"
                      : "text-clinical-cyan"
                  )}
                >
                  {t.role === "user" ? "You" : "VITAL OS"}
                </span>
                <p className="mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap text-foreground/90">
                  {t.content}
                </p>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Patient Snapshot
 * ────────────────────────────────────────────────────────────────────────── */

function PatientPanel({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <UserRound className="h-4 w-4 text-clinical-teal" />
          <span className="mono text-xs uppercase tracking-wider text-muted-foreground">
            patient snapshot
          </span>
        </div>
        <Badge variant="outline" className="text-[10px]">
          persisted JSON store
        </Badge>
      </div>
      <div className="p-3">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={[
            "MRN: —",
            "Age/Sex: —",
            "Allergies: —",
            "Active problems:",
            "  - ",
            "Current meds:",
            "  - ",
            "Vitals: BP — / HR — / SpO2 — / T —",
          ].join("\n")}
          className="scrollbar-thin min-h-[180px] w-full resize-y rounded-lg border border-border bg-card p-3 text-[12.5px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30"
        />
        <p className="mono mt-2 px-1 text-[10px] leading-relaxed text-muted-foreground/80">
          Selecting a chart fills this from the local roster file (
          <span className="text-muted-foreground">data/patients.json</span>). You
          can ask VITAL by voice to add or update patients; this textarea is still
          merged into each AI request as extra context.
        </p>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Audit Timeline
 * ────────────────────────────────────────────────────────────────────────── */

function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="panel flex min-h-[300px] flex-1 flex-col">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-clinical-mint" />
          <span className="mono text-xs uppercase tracking-wider text-muted-foreground">
            audit timeline
          </span>
        </div>
        <Badge variant="outline" className="text-[10px]">
          {entries.length} event{entries.length === 1 ? "" : "s"}
        </Badge>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <CircleDashed className="h-5 w-5" />
            <p className="text-xs">No exchanges yet.</p>
            <p className="mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              every command is logged here
            </p>
          </div>
        ) : (
          <ol className="relative space-y-3 border-l border-border/60 pl-4">
            <AnimatePresence initial={false}>
              {entries.map((e) => (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -6 }}
                  transition={{ duration: 0.25 }}
                  className="relative"
                >
                  <span
                    className={cn(
                      "absolute -left-[19px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-background",
                      e.kind === "system"
                        ? "bg-clinical-danger"
                        : e.mode === "emergency"
                        ? "bg-clinical-danger"
                        : e.mode === "soap" || e.mode === "summary"
                        ? "bg-clinical-cyan"
                        : "bg-clinical-mint"
                    )}
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mono text-[10px] tabular-nums text-muted-foreground">
                      {fmtTime(e.at)}
                    </span>
                    <Badge
                      variant={e.kind === "system" ? "danger" : MODE_BADGE[e.mode]}
                      className="text-[9px]"
                    >
                      {e.kind === "system" ? "SYSTEM" : MODE_LABEL[e.mode]}
                    </Badge>
                    {e.latencyMs !== undefined && (
                      <span className="mono text-[10px] text-muted-foreground/80">
                        {e.latencyMs}ms
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12.5px] text-foreground/90">
                    <span className="text-muted-foreground">› </span>
                    {e.command}
                  </p>
                  <p
                    className={cn(
                      "mt-0.5 line-clamp-2 text-[12px]",
                      e.kind === "system"
                        ? "text-clinical-danger"
                        : "text-foreground/70"
                    )}
                  >
                    {e.response}
                  </p>
                </motion.li>
              ))}
            </AnimatePresence>
          </ol>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * System Panel + Footer + Errors
 * ────────────────────────────────────────────────────────────────────────── */

function SystemPanel({
  systemState,
  sttChoice,
  intentRoute,
}: {
  systemState: SystemState;
  sttChoice: TranscriptChoice | null;
  intentRoute: {
    provider: IntentProvider;
    latencyMs: number | null;
    fallbackReason: string | null;
  } | null;
}) {
  /* Reports what actually transcribed the last utterance, not what we hope did. */
  const sttValue =
    sttChoice === null
      ? "Whisper via Groq (idle)"
      : sttChoice.source === "whisper"
        ? "Whisper via Groq"
        : sttChoice.source === "browser"
          ? "Browser SR - Whisper degraded"
          : "No transcript";
  const sttTone =
    sttChoice && sttChoice.source !== "whisper"
      ? "text-amber-400"
      : "text-clinical-teal";

  /* Groq is the primary leg; Gemini answering means the primary failed.
     Idle is stated as idle rather than guessing a provider. */
  const brainValue =
    intentRoute === null
      ? "Groq primary (idle)"
      : intentRoute.provider === "groq"
        ? `Groq${intentRoute.latencyMs === null ? "" : ` · ${intentRoute.latencyMs} ms`}`
        : `Gemini fallback - Groq degraded${
            intentRoute.latencyMs === null ? "" : ` · ${intentRoute.latencyMs} ms`
          }`;
  const brainTone =
    intentRoute !== null && intentRoute.provider !== "groq"
      ? "text-amber-400"
      : "text-clinical-cyan";

  const items: { label: string; value: string; tone?: string }[] = [
    {
      label: "STT",
      value: sttValue,
      tone: sttTone,
    },
    {
      label: "TTS",
      value: "Browser SpeechSynthesis",
      tone: "text-clinical-mint",
    },
    {
      label: "INTENT",
      value: brainValue,
      tone: brainTone,
    },
    {
      label: "MODE",
      value: systemState.toUpperCase(),
      tone:
        systemState === "error"
          ? "text-clinical-danger"
          : systemState === "listening" || systemState === "speaking"
          ? "text-clinical-teal"
          : systemState === "processing"
          ? "text-clinical-cyan"
          : "text-muted-foreground",
    },
  ];
  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-clinical-cyan" />
          <span className="mono text-xs uppercase tracking-wider text-muted-foreground">
            system
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-xl bg-border/60 sm:grid-cols-4">
        {items.map((it) => (
          <div key={it.label} className="bg-card/80 px-4 py-3">
            <div className="mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {it.label}
            </div>
            <div className={cn("mono mt-0.5 text-[12px]", it.tone)}>
              {it.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

