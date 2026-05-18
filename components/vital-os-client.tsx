"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookText,
  Check,
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
  VoiceHeroVisual,
  type VoiceHeroVisualHandle,
} from "@/components/voice-hero-visual";
import { VitalLogo } from "@/components/vital-logo";
import { useAuth } from "@/components/auth-provider";
import {
  ACCESS_RESTRICTED_MESSAGE,
  AI_ASSISTANT_RESTRICTED_MESSAGE,
  formatDoctorDisplayName,
  roleRequestHeaders,
  type VitalRole,
} from "@/lib/auth";
import type { ConversationTurn } from "@/lib/vital-llm";
import type { ClinicalReasoningResult } from "@/lib/clinical-reasoning";
import type { ClinicalCommandResponse } from "@/app/api/clinical-command/route";
import type { DemoMedication, DemoPatient } from "@/lib/demo-patients";
import { patientToSnapshot } from "@/lib/demo-patients";

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
  problems: EditableProblem[],
  role: VitalRole
): Promise<boolean> {
  const payload = problems.map(({ name, status, since }) => ({
    name,
    status,
    since,
  }));
  const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...roleRequestHeaders(role),
    },
    body: JSON.stringify({ problems: payload }),
  });
  return res.ok;
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
  | "chief_concern"
  | "age_sex"
  | "allergies"
  | "medications"
  | "contextual"
  | "done";

type AdmissionDraft = {
  active: boolean;
  data: Partial<DemoPatient>;
  step: AdmissionStep;
  allergiesCaptured: boolean;
  medicationsCaptured: boolean;
  contextualAnswered: boolean;
};

const EMPTY_ADMISSION: AdmissionDraft = {
  active: false,
  data: {},
  step: "chief_concern",
  allergiesCaptured: false,
  medicationsCaptured: false,
  contextualAnswered: false,
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

function normalizeAdmissionRoom(room: string): string {
  const trimmed = room.trim();
  if (!trimmed) return "Unassigned";
  if (/^room\b/i.test(trimmed)) {
    return trimmed.replace(/^room\s*/i, "Room ");
  }
  return `Room ${trimmed}`;
}

function normalizeMedicationSig(sig: string): string {
  return sig
    .replace(/\bonce a day\b/i, "PO daily")
    .replace(/\btwice a day\b/i, "PO BID")
    .replace(/\bthree times a day\b/i, "PO TID");
}

function parseAgeSex(text: string): { age?: number; sex?: string } {
  const out: { age?: number; sex?: string } = {};
  const ageMatch = text.match(/\b(\d{1,3})\s*(?:years?\s*old|y\.?o\.?)?\b/i);
  if (ageMatch) out.age = Number(ageMatch[1]);
  const sexMatch =
    text.match(/\b(male|female|man|woman|nonbinary|non-binary|nb)\b/i) ??
    text.match(/\b([mf])\b/i);
  if (sexMatch) {
    const token = sexMatch[1].toLowerCase();
    if (token === "m" || token === "male" || token === "man") out.sex = "M";
    else if (token === "f" || token === "female" || token === "woman") out.sex = "F";
    else out.sex = sexMatch[1];
  }
  return out;
}

function parseAllergiesAnswer(text: string): string[] | null {
  const q = text.trim();
  if (!q) return null;
  if (/^(no|none|no allergies|none known|nkda|nka|not aware of any)\b/i.test(q)) {
    return [];
  }
  return q
    .split(/\s*,\s*|\s+and\s+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMedicationsAnswer(text: string): DemoMedication[] | null {
  const q = text.trim();
  if (!q) return null;
  if (/^(no|none|no medications|not on any|nkda|n\/a)\b/i.test(q)) return [];
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
    } else {
      meds.push({ name: part.trim(), sig: "As directed" });
    }
  }
  return meds.length ? meds : null;
}

function parseChiefConcernAndRoom(text: string): {
  chiefConcern?: string;
  room?: string;
} {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const roomMatch =
    trimmed.match(/\b(?:room|in)\s+([A-Za-z0-9-]+)\b/i) ??
    trimmed.match(/,\s*([A-Za-z0-9-]+)\s*$/);
  let chiefConcern = trimmed;
  let room: string | undefined;
  if (roomMatch) {
    room = normalizeAdmissionRoom(roomMatch[1]);
    chiefConcern = trimmed.replace(roomMatch[0], "").replace(/,\s*$/, "").trim();
  }
  chiefConcern = chiefConcern.replace(/^(?:chief concern|presenting complaint)\s*[:,-]?\s*/i, "").trim();
  return {
    chiefConcern: chiefConcern || undefined,
    room,
  };
}

function parseEmergencyContactAnswer(text: string): DemoPatient["emergencyContact"] | null {
  const trimmed = text.trim();
  if (!trimmed || /^(no|none|not at this time|unknown)\b/i.test(trimmed)) {
    return { name: "Not listed", relationship: "Not listed", phone: "Not listed" };
  }
  const phoneMatch = trimmed.match(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  const relationshipMatch = trimmed.match(/\b(spouse|partner|parent|mother|father|sibling|child|friend)\b/i);
  const namePart = trimmed
    .replace(phoneMatch?.[0] ?? "", "")
    .replace(relationshipMatch?.[0] ?? "", "")
    .replace(/\b(contact|is|the)\b/gi, "")
    .trim();
  return {
    name: namePart || trimmed,
    relationship: relationshipMatch?.[1] ?? "Contact",
    phone: phoneMatch?.[1] ?? "Not listed",
  };
}

function stripAdmissionPrefix(command: string): string {
  return command
    .replace(
      /^(?:please\s+)?(?:admit|add patient|new patient)(?:\s+a)?(?:\s+new patient)?(?:\s+named)?[,:]?\s*/i,
      ""
    )
    .trim();
}

function parseAdmissionBootstrap(command: string): Partial<DemoPatient> {
  let rest = stripAdmissionPrefix(command);
  rest = rest.replace(/^(?:a\s+)?new patient[,:]?\s*/i, "").trim();
  const data: Partial<DemoPatient> = {};
  if (!rest) return data;

  const parts = rest.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 3) {
    data.name = parts[0];
    data.chiefConcern = parts.slice(1, -1).join(", ") || parts[1];
    data.room = normalizeAdmissionRoom(parts[parts.length - 1].replace(/^room\s*/i, ""));
    return data;
  }
  if (parts.length === 2) {
    data.name = parts[0];
    const second = parts[1];
    const concernRoom = parseChiefConcernAndRoom(second);
    if (concernRoom.room) data.room = concernRoom.room;
    if (concernRoom.chiefConcern) data.chiefConcern = concernRoom.chiefConcern;
    if (!data.chiefConcern && !data.room) data.chiefConcern = second;
    return data;
  }

  const token = parts[0] ?? rest;
  const concernRoom = parseChiefConcernAndRoom(token);
  if (concernRoom.room) {
    data.room = concernRoom.room;
    if (concernRoom.chiefConcern) data.chiefConcern = concernRoom.chiefConcern;
    return data;
  }
  if (
    /\b(pain|fever|nausea|injury|bleeding|shortness|chest|abdominal|seizure|trauma)\b/i.test(
      token
    )
  ) {
    data.chiefConcern = token;
    return data;
  }
  data.name = token.replace(/[?.!]+$/, "").trim();
  return data;
}

function isSeriousAdmissionCase(data: Partial<DemoPatient>): boolean {
  const concern = (data.chiefConcern ?? "").toLowerCase();
  const acuity = (data.triageAcuity ?? "").toLowerCase();
  return (
    /\b(ctas\s*[12]|critical|severe|unresponsive|stemi|stroke|chest pain|shortness of breath|sepsis|abdominal pain)\b/i.test(
      concern
    ) || /\bctas\s*[12]\b/.test(acuity)
  );
}

function resolveAdmissionStep(draft: AdmissionDraft): AdmissionStep {
  const data = draft.data;
  if (!data.name?.trim() || !data.chiefConcern?.trim() || !data.room?.trim()) {
    return "chief_concern";
  }
  if (data.age === undefined || !data.sex?.trim()) return "age_sex";
  if (!draft.allergiesCaptured) return "allergies";
  if (!draft.medicationsCaptured) return "medications";
  if (!draft.contextualAnswered) return "contextual";
  return "done";
}

function admissionPromptForStep(draft: AdmissionDraft): string {
  const firstName = admissionFirstName(draft.data);
  switch (draft.step) {
    case "chief_concern":
      if (draft.data.name?.trim()) {
        return `Got it. What's ${firstName}'s chief concern and what room are they in?`;
      }
      return "What is the patient's name, chief concern, and room assignment?";
    case "age_sex":
      return `How old is ${firstName} and what's their sex?`;
    case "allergies":
      return "Any known allergies?";
    case "medications":
      return `Is ${firstName} on any medications?`;
    case "contextual":
      return isSeriousAdmissionCase(draft.data)
        ? `Is there someone we should contact for ${firstName}?`
        : `Do we need any medications or orders queued for ${firstName}?`;
    default:
      return "";
  }
}

function mergeAdmissionAnswer(draft: AdmissionDraft, command: string): AdmissionDraft {
  const data: Partial<DemoPatient> = { ...draft.data };
  let allergiesCaptured = draft.allergiesCaptured;
  let medicationsCaptured = draft.medicationsCaptured;
  let contextualAnswered = draft.contextualAnswered;

  const concernRoom = parseChiefConcernAndRoom(command);
  if (concernRoom.chiefConcern) data.chiefConcern = concernRoom.chiefConcern;
  if (concernRoom.room) data.room = concernRoom.room;
  if (!data.name?.trim() && draft.step === "chief_concern") {
    const stripped = command
      .replace(/\b(?:room|in)\s+[A-Za-z0-9-]+\b/i, "")
      .replace(/[?.!]+$/, "")
      .trim();
    if (stripped && !data.chiefConcern) {
      data.name = stripped.split(",")[0]?.trim() ?? stripped;
    }
  }

  const ageSex = parseAgeSex(command);
  if (ageSex.age !== undefined) data.age = ageSex.age;
  if (ageSex.sex) data.sex = ageSex.sex;

  const allergies = parseAllergiesAnswer(command);
  if (allergies !== null) {
    data.allergies = allergies;
    allergiesCaptured = true;
  }

  const medications = parseMedicationsAnswer(command);
  if (medications !== null) {
    data.medications = medications;
    medicationsCaptured = true;
  }

  if (draft.step === "contextual" || contextualAnswered) {
    const contact = parseEmergencyContactAnswer(command);
    if (contact) data.emergencyContact = contact;
    if (draft.step === "contextual" && command.trim()) {
      contextualAnswered = true;
    }
  }

  const next: AdmissionDraft = {
    active: true,
    data,
    step: "chief_concern",
    allergiesCaptured,
    medicationsCaptured,
    contextualAnswered,
  };
  next.step = resolveAdmissionStep(next);
  return next;
}

function buildAdmissionPayload(data: Partial<DemoPatient>): Record<string, unknown> {
  return {
    name: data.name?.trim(),
    room: data.room?.trim() || "Unassigned",
    chiefConcern: data.chiefConcern?.trim() || "Not specified",
    age: typeof data.age === "number" && Number.isFinite(data.age) ? data.age : 0,
    sex: data.sex?.trim() || "Unknown",
    allergies: data.allergies ?? [],
    medications: data.medications ?? [],
    triageAcuity: data.triageAcuity?.trim() || "CTAS 3",
    emergencyContact: data.emergencyContact,
    lastVisit: new Date().toISOString().slice(0, 10),
  };
}

function buildAdmissionFinalizeMessage(
  patient: DemoPatient,
  opts: { early: boolean; roomLabel: string }
): string {
  if (opts.early) {
    return `${patient.name} has been admitted. Chart created with the information provided. You can update the record later.`;
  }
  return `${patient.name} admitted to ${opts.roomLabel}. Chart created. MRN assigned: ${patient.mrn}.`;
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
  const [openPatientTabIds, setOpenPatientTabIds] = React.useState<string[]>([]);
  const [dischargeConfirmId, setDischargeConfirmId] = React.useState<string | null>(null);
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

  const [voiceEnabled, setVoiceEnabled] = React.useState(true);
  const [supportsSpeech, setSupportsSpeech] = React.useState(true);
  const [supportsTts, setSupportsTts] = React.useState(true);
  const [now, setNow] = React.useState(() => Date.now());
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [workspaceTab, setWorkspaceTab] = React.useState<
    "charts" | "response" | "dialogue" | "actions" | "system"
  >("charts");

  const recognitionRef = React.useRef<SR | null>(null);
  const shouldSubmitOnEndRef = React.useRef(false);
  /** True between `onstart` and `onend` — prevents double `start()` (InvalidStateError). */
  const recognitionActiveRef = React.useRef(false);
  /** After `abort()`, ignore the next `onend` from the torn-down instance (no submit / no resume). */
  const ignoreNextEndRef = React.useRef(false);
  /** When `start()` hits InvalidStateError, we `abort()` and call `start()` again from `onend`. */
  const resumeStartAfterEndRef = React.useRef(false);
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

  const armSilenceSubmit = React.useCallback(() => {
    if (!voiceSessionActiveRef.current) return;
    if (systemStateRef.current === "processing") return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = globalThis.setTimeout(() => {
      silenceTimerRef.current = null;
      if (!voiceSessionActiveRef.current) return;
      if (systemStateRef.current === "processing") return;
      const text = (finalRef.current + " " + interimRef.current).trim();
      if (!text) return;
      setLastSubmittedTranscript(text);
      setHeardPreview(text);
      setFinalTranscript("");
      finalRef.current = "";
      setInterimTranscript("");
      interimRef.current = "";
      void submitRef.current(text);
    }, 1600);
  }, []);

  const resumeVoiceCapture = React.useCallback(() => {
    if (!voiceSessionActiveRef.current) return;
    globalThis.setTimeout(() => {
      if (!voiceSessionActiveRef.current) return;
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
      let msg = `Microphone error: ${code}`;
      if (code === "not-allowed" || code === "service-not-allowed") {
        listeningIntentRef.current = false;
        voiceSessionActiveRef.current = false;
        setVoiceSessionLive(false);
        msg =
          "Microphone permission was denied. Allow mic access in your browser to use VITAL OS.";
      } else if (code === "no-speech") {
        if (listeningIntentRef.current && voiceSessionActiveRef.current) {
          resumeVoiceCaptureRef.current();
        }
        return;
      } else if (code === "audio-capture") {
        listeningIntentRef.current = false;
        voiceSessionActiveRef.current = false;
        setVoiceSessionLive(false);
        msg = "No microphone detected. Connect a mic and try again.";
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
        const text = finalRef.current.trim();
        if (text) {
          void submitRef.current(text);
        } else {
          setSystemState("idle");
        }
        listeningIntentRef.current = false;
        return;
      }

      /* Session ended unexpectedly while still listening — restart after a tick (Chromium quirk). */
      if (listeningIntentRef.current) {
        globalThis.setTimeout(() => {
          if (!listeningIntentRef.current) return;
          resumeVoiceCaptureRef.current();
        }, 200);
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
        await new Promise<void>((r) => setTimeout(r, 60));
        let rec = recognitionRef.current;
        if (!rec) {
          rec = mountRecognition();
          if (!rec) return;
        }
        if (recognitionActiveRef.current) return;
        try {
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
            pushGeminiResponse(ACCESS_RESTRICTED_MESSAGE);
            return true;
          }
          setDischargeConfirmId(action.payload.patientId);
          setPendingMedicationOrder(null);
          pushGeminiResponse(assistantResponse);
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
          let draft: AdmissionDraft = {
            active: true,
            data: parseAdmissionBootstrap(command),
            step: "chief_concern",
            allergiesCaptured: false,
            medicationsCaptured: false,
            contextualAnswered: false,
          };
          draft = mergeAdmissionAnswer(draft, command);
          setAdmissionConversation(draft);
          pushGeminiResponse(
            draft.step === "done"
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
        pushLocalAssistantResponse(command, ACCESS_RESTRICTED_MESSAGE);
        return true;
      }

      if (!permissions.canEditPatientStatus && matchesStatusIntent(command)) {
        pushLocalAssistantResponse(command, ACCESS_RESTRICTED_MESSAGE);
        return true;
      }

      const finalizeAdmissionConversation = async (
        draft: AdmissionDraft,
        early: boolean
      ) => {
        if (!draft.data.name?.trim()) {
          pushLocalAssistantResponse(
            command,
            "Please provide the patient name before admitting."
          );
          setAdmissionConversation(EMPTY_ADMISSION);
          return;
        }
        const res = await fetch("/api/patients", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...roleRequestHeaders(apiRole),
          },
          body: JSON.stringify(buildAdmissionPayload(draft.data)),
        });
        if (!res.ok) {
          pushLocalAssistantResponse(command, "Admit failed. Try again.");
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { patient?: DemoPatient };
        await refreshPatients();
        setAdmissionConversation(EMPTY_ADMISSION);
        const created = body.patient;
        const roomLabel = created?.room ?? draft.data.room ?? "Unassigned";
        const message = created
          ? buildAdmissionFinalizeMessage(created, { early, roomLabel })
          : `${draft.data.name} has been admitted.`;
        pushLocalAssistantResponse(command, message);
      };

      if (admissionConversation.active) {
        if (isAdmissionFinalizePhrase(command)) {
          const merged = mergeAdmissionAnswer(admissionConversation, command);
          await finalizeAdmissionConversation(merged, true);
          return true;
        }
        const merged = mergeAdmissionAnswer(admissionConversation, command);
        if (merged.step === "done") {
          await finalizeAdmissionConversation(merged, false);
          return true;
        }
        setAdmissionConversation(merged);
        pushLocalAssistantResponse(command, admissionPromptForStep(merged));
        return true;
      }

      const focusedPatient = findFocusedPatientFromCommand(command, patients);
      if (focusedPatient) {
        setSelectedPatientId(focusedPatient.id);
      }

      if (isDischargeIntent(lower)) {
        const matches = findAllPatientMatches(command, patients);
        const active =
          (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
        const targets = matches.length > 0 ? matches : active ? [active] : [];
        if (targets.length === 0) {
          pushLocalAssistantResponse(
            command,
            "Please confirm which patient should be discharged."
          );
          return true;
        }
        for (const target of targets) {
          const res = await fetch(`/api/patients/${encodeURIComponent(target.id)}`, {
            method: "DELETE",
            headers: roleRequestHeaders(apiRole),
          });
          if (!res.ok) {
            pushLocalAssistantResponse(command, "Discharge failed. Try again.");
            return true;
          }
          if (selectedPatientId === target.id) {
            setRequestedPatientView(null);
            setActiveRequestedSections([]);
            setSelectedPatientId(null);
          }
          setOpenPatientTabIds((prev) => prev.filter((tabId) => tabId !== target.id));
        }
        await refreshPatients();
        pushLocalAssistantResponse(
          command,
          `Discharged: ${targets.map((target) => target.name).join(", ")}. Roster updated.`
        );
        return true;
      }

      if (isAdmitIntent(lower)) {
        let draft: AdmissionDraft = {
          active: true,
          data: parseAdmissionBootstrap(command),
          step: "chief_concern",
          allergiesCaptured: false,
          medicationsCaptured: false,
          contextualAnswered: false,
        };
        draft = mergeAdmissionAnswer(draft, command);
        if (draft.step === "done") {
          await finalizeAdmissionConversation(draft, false);
          return true;
        }
        setAdmissionConversation(draft);
        pushLocalAssistantResponse(command, admissionPromptForStep(draft));
        return true;
      }

      if (matchesStatusIntent(command)) {
        const status = detectStatusValue(command);
        const patientMatches = findAllPatientMatches(command, patients);
        const active =
          (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
        const target =
          focusedPatient ??
          (patientMatches.length === 1
            ? patientMatches[0]
            : findPatientMatches(command, patients)[0] ?? active);
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
        void persistPatientProblems(target.id, updatedProblems, apiRole).then(
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
        const matches = findPatientMatches(command, patients);
        const active =
          (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
        const target = matches[0] ?? active;
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
      permissions,
      apiRole,
      refreshPatients,
      resumeVoiceCapture,
      logout,
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

      if (!permissions.canUseAI) {
        pushLocalAssistantResponse(transcript, AI_ASSISTANT_RESTRICTED_MESSAGE);
        setSystemState("idle");
        resumeVoiceCapture();
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

      if (dischargeConfirmId && isAffirmativeCommand(transcript)) {
        const id = dischargeConfirmId;
        const target = patients.find((p) => p.id === id);
        const res = await fetch(`/api/patients/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: roleRequestHeaders(apiRole),
        });
        setDischargeConfirmId(null);
        if (!res.ok) {
          pushLocalAssistantResponse(transcript, "Discharge failed. Try again.");
          setSystemState("idle");
          resumeVoiceCapture();
          return;
        }
        if (selectedPatientId === id) {
          setRequestedPatientView(null);
          setActiveRequestedSections([]);
          setSelectedPatientId(null);
        }
        setOpenPatientTabIds((prev) => prev.filter((tabId) => tabId !== id));
        await refreshPatients();
        pushLocalAssistantResponse(
          transcript,
          `Discharged: ${target?.name ?? "patient"}. Roster updated.`
        );
        setSystemState("idle");
        resumeVoiceCapture();
        return;
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
          if (!voiceSessionActiveRef.current || !listeningIntentRef.current) {
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
        if (voiceSessionActiveRef.current) {
          globalThis.setTimeout(
            () => startListeningContinueRef.current({ hard: false }),
            400
          );
        }
      };
      u.onerror = () => {
        setSystemState("idle");
        if (voiceSessionActiveRef.current) {
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
    void startListening({ hard: true });
  }, [startListening, stopSpeaking, systemState]);

  const endVoiceSession = React.useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setVoiceSessionLive(false);
    voiceSessionActiveRef.current = false;
    listeningIntentRef.current = false;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    abortRef.current?.abort();
    disposeRecognition();
    resetSession();
    setMicMuted(false);
    setSystemState("idle");
    logout();
  }, [disposeRecognition, resetSession, logout]);

  const toggleMicMute = React.useCallback(() => {
    if (!voiceSessionLive) {
      startVoiceSession();
      return;
    }
    setMicMuted((prev) => {
      const next = !prev;
      if (next) {
        listeningIntentRef.current = false;
        stopListening({ submit: false });
      } else {
        listeningIntentRef.current = true;
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
    const palette = ["#0ea5e9", "#06b6d4", "#3b82f6", "#14b8a6", "#f59e0b"];
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
    <main className="min-h-screen bg-[#f7fbff] text-slate-900">
      <AnimatePresence>
        {orderNotice && (
          <motion.div
            initial={{ opacity: 0, y: -8, x: 12 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, y: -8, x: 12 }}
            className="fixed right-4 top-4 z-50 rounded-lg border border-cyan-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 shadow-md"
          >
            {orderNotice}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[120px_minmax(0,1fr)_350px]">
        <aside className="hidden border-r border-[#133a71] bg-[#0B2A55] px-2 py-4 text-white lg:flex lg:flex-col">
          <div className="mb-7 flex items-center justify-center px-1">
            <VitalLogo
              size={36}
              variant="stacked"
              textClassName="text-blue-50"
              className="rounded-xl bg-white/5 px-3 py-2.5"
            />
          </div>
          <nav className="space-y-2">
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
                    "flex h-12 w-full flex-col items-center justify-center gap-1 rounded-xl px-2 text-center text-[11px] font-medium transition-colors",
                    activePage === item.key
                      ? "bg-white/15 text-white"
                      : "text-blue-100/85 hover:bg-white/10"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="leading-none">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="mt-auto flex flex-col gap-2 pt-4">
            <button
              type="button"
              onClick={endVoiceSession}
              className="flex h-12 w-full flex-col items-center justify-center gap-1 rounded-xl px-2 text-center text-[11px] font-medium text-blue-100/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
              title="Sign out and return to role selection"
            >
              <LogOut className="h-4 w-4 shrink-0" aria-hidden />
              <span className="leading-none">Sign Out</span>
            </button>
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 text-center text-[11px] text-blue-100/80">
              HIPAA Secure
            </div>
          </div>
        </aside>

        <section className="flex min-h-screen flex-col bg-white px-4 py-4 lg:px-4 lg:py-4">
          <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-[#0B2A55] px-4 py-2 text-white shadow-sm">
            <VitalLogo size={22} variant="full" textClassName="text-white" />
            <div className="ml-auto flex items-center gap-2">
              <Badge
                variant="outline"
                className="inline-flex items-center gap-2 bg-white/85 text-slate-900 border-white/75 hover:bg-white/95"
              >
                <VitalLogo
                  size={12}
                  variant="icon"
                  className={cn(systemState === "listening" ? "animate-pulse" : "")}
                />
                System Ready
              </Badge>
              <Badge
                variant="notes"
                className="bg-teal-100/95 text-teal-950 border-teal-300/90"
              >
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
              <span className="ml-2 text-sm font-medium tabular-nums">{fmtTime(now)}</span>
            </div>
          </div>

          <div className="sticky top-3 z-30 mb-3 rounded-2xl border border-[#dce9fb] bg-white/95 px-4 py-3 shadow-sm backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={toggleMicMute}
                disabled={
                  !permissions.canUseAI ||
                  !supportsSpeech ||
                  systemState === "processing"
                }
                className={cn(
                  "flex h-14 w-14 items-center justify-center rounded-full border-2 transition-all",
                  voiceSessionLive && !micMuted
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-300 bg-white text-slate-700",
                  !permissions.canUseAI && "cursor-not-allowed opacity-50"
                )}
                title={
                  !permissions.canUseAI
                    ? AI_ASSISTANT_RESTRICTED_MESSAGE
                    : !voiceSessionLive
                    ? "Start voice session"
                    : voiceSessionLive && !micMuted
                    ? "Mic live - tap to mute"
                    : "Mic muted - tap to unmute"
                }
              >
                {voiceSessionLive && !micMuted ? (
                  <Mic className="h-6 w-6" />
                ) : (
                  <MicOff className="h-6 w-6" />
                )}
              </button>
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-700">
                  {voiceSessionLive && micMuted
                    ? "Microphone muted - click to resume listening"
                    : systemState === "listening"
                      ? "Listening..."
                      : systemState === "speaking"
                        ? "AI speaking - you can interrupt by talking"
                        : systemState === "processing"
                          ? "Processing clinician command..."
                          : "System ready"}
                </p>
                <div className="mt-2 h-8 overflow-hidden rounded-xl border border-slate-200 bg-white px-2">
                  <div className="flex h-full items-end gap-1">
                    {waveformBars.map((h, i) => (
                      <span
                        key={`wf-${i}`}
                        className="w-1 rounded-full bg-blue-500/70 transition-all duration-100"
                        style={{ height: `${h}px` }}
                      />
                    ))}
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-600">
                  Last heard:{" "}
                  <span className="font-medium text-slate-900">
                    {heardPreview.trim() ||
                      interimTranscript.trim() ||
                      finalTranscript.trim() ||
                      lastSubmittedTranscript.trim() ||
                      "Listening for clinician command..."}
                  </span>
                </p>
                {error ? (
                  <p className="mt-2 text-xs text-red-600">{error}</p>
                ) : null}
                {!permissions.canUseAI ? (
                  <p className="mt-2 text-xs text-amber-800">
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
                    className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300"
                  />
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!permissions.canUseAI) return;
                    setTypedCommandOpen((v) => !v);
                  }}
                  disabled={!permissions.canUseAI}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white",
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
                    className="rounded-full border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    Stop voice
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setVoiceEnabled((v) => !v)}
                  disabled={!supportsTts}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white"
                  title={voiceEnabled ? "Mute AI voice" : "Unmute AI voice"}
                >
                  {voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={endVoiceSession}
                  className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-600"
                >
                  End Session
                </button>
              </div>
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
                className="inline-flex items-center gap-1 rounded-full border border-blue-100 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                View Full Chart
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {activePage !== "dashboard" ? (
            <div className="grid gap-3">
              {activePage === "patients" && (
                <div className="rounded-xl border border-[#e3edf9] bg-white p-4 shadow-sm">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900">Patient Roster</p>
                    <motion.div layout className="flex flex-wrap items-center gap-2">
                      <input
                        value={patientSearch}
                        onChange={(e) => setPatientSearch(e.target.value)}
                        placeholder="Search name, MRN, room..."
                        className="w-64 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-300"
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
                        className="mb-3 overflow-hidden rounded-xl border border-[#e3edf9] bg-[#f7fbff] p-3"
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
                            <label key={key} className="text-xs font-medium text-slate-700">
                              {label}
                              <input
                                type={type}
                                value={admitDraft[key]}
                                onChange={(e) =>
                                  setAdmitDraft((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-300"
                              />
                            </label>
                          ))}
                          <label className="text-xs font-medium text-slate-700">
                            Acuity (CTAS 1-5)
                            <select
                              value={admitDraft.triageAcuity}
                              onChange={(e) =>
                                setAdmitDraft((prev) => ({
                                  ...prev,
                                  triageAcuity: e.target.value,
                                }))
                              }
                              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-300"
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
                                  headers: {
                                    "Content-Type": "application/json",
                                    ...roleRequestHeaders(apiRole),
                                  },
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
                  <div className="rounded-xl border border-slate-200">
                    <motion.div layout className="grid grid-cols-[1.2fr_0.9fr_0.7fr_0.8fr_1.1fr_0.7fr_0.7fr_0.9fr] border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
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
                          "grid cursor-pointer grid-cols-[1.2fr_0.9fr_0.7fr_0.8fr_1.1fr_0.7fr_0.7fr_0.9fr] gap-2 border-b border-slate-100 px-3 py-2.5 text-left text-sm hover:bg-slate-50",
                          selectedPatientId === p.id ? "bg-blue-50/60" : "bg-white"
                        )}
                      >
                        <span className="font-medium text-slate-900">
                          {p.name}
                          <PatientClinicalIndicator patient={p} />
                        </span>
                        <span className="text-slate-900">{p.mrn}</span>
                        <span className="text-slate-900">
                          {p.age}
                          {p.sex}
                        </span>
                        <span>
                          <Badge variant="medications" className="px-2 py-0.5 text-[11px]">
                            {p.room}
                          </Badge>
                        </span>
                        <span className="truncate text-slate-900">{p.chiefConcern}</span>
                        <span>
                          <Badge
                            variant={
                              /ctas\s*1/i.test(p.triageAcuity)
                                ? "risk"
                                : /ctas\s*2/i.test(p.triageAcuity)
                                  ? "warn"
                                  : /ctas\s*3/i.test(p.triageAcuity)
                                    ? "problems"
                                    : /ctas\s*4/i.test(p.triageAcuity)
                                      ? "medications"
                                      : "notes"
                            }
                            className="px-2 py-0.5 text-[11px]"
                          >
                            {p.triageAcuity}
                          </Badge>
                        </span>
                        <span className="text-xs text-slate-900">
                          {p.allergies.length ? "Allergy" : "Stable"}
                        </span>
                        <div
                          className="flex items-center justify-end"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {!permissions.canDischargePatient ? (
                            <span className="text-[10px] text-slate-500">—</span>
                          ) : dischargeConfirmId === p.id ? (
                            <div className="flex items-center gap-1 text-xs text-slate-700">
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
                                        headers: roleRequestHeaders(apiRole),
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
                  <div className="rounded-xl border border-[#d9e8fb] bg-gradient-to-r from-cyan-50/70 to-blue-50 p-4 shadow-sm">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900">Active Encounters</p>
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
                            "rounded-full border px-3 py-1 text-xs font-semibold transition-all",
                            encounterFilter === key
                              ? "border-blue-300 bg-blue-100 text-blue-900 shadow-sm"
                              : "border-slate-200 bg-white text-slate-600 hover:-translate-y-0.5 hover:border-blue-200 hover:text-slate-900"
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
                        className="rounded-xl border border-[#dce8f8] bg-white p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
                      >
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-slate-900">
                            {patient.name}
                            <PatientClinicalIndicator patient={patient} />
                          </p>
                          <Badge variant={statusBadgeVariant(status)}>{status}</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                          <p>MRN: <span className="font-medium text-slate-800">{patient.mrn}</span></p>
                          <p>ROOM: <span className="font-medium text-slate-800">{patient.room}</span></p>
                          <p>
                            Acuity:{" "}
                            <span className="font-medium text-slate-800">{patient.triageAcuity}</span>
                          </p>
                          <p>Updated: <span className="font-medium text-slate-800">{updatedLabel}</span></p>
                        </div>
                        <p className="mt-2 line-clamp-1 text-sm text-slate-700">{patient.chiefConcern}</p>
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
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                      <p className="text-sm font-semibold text-slate-900">Recent Activity Feed</p>
                      <div className="mt-3 space-y-2">
                        {activityFeed.slice(0, 6).map((item) => (
                          <div
                            key={item.id}
                            className="flex items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2"
                          >
                            <Activity
                              className={cn(
                                "mt-0.5 h-3.5 w-3.5",
                                item.level === "high" ? "text-rose-500" : "text-cyan-600"
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-slate-800">{item.text}</p>
                              <p className="mt-0.5 text-[11px] text-slate-500">
                                {item.room} • {item.at}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                      <p className="text-sm font-semibold text-slate-900">Room Occupancy</p>
                      <div className="mt-3 space-y-2">
                        {roomOccupancy.map((item) => (
                          <div
                            key={`${item.room}-${item.patient}`}
                            className="flex items-center justify-between rounded-lg border border-slate-100 bg-white px-3 py-2 text-xs"
                          >
                            <span className="font-semibold text-slate-800">{item.room}</span>
                            <span className="truncate px-2 text-slate-600">{item.patient}</span>
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
                        className="rounded-xl border border-[#dce8f8] bg-gradient-to-br from-white to-cyan-50/40 p-4 shadow-sm"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
                        <div className="mt-2 flex items-center justify-between">
                          <p className="text-2xl font-semibold text-slate-900">{value}</p>
                          <Badge variant={variant as "allergies" | "medications" | "problems" | "notes" | "risk"}>
                            Live
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                    <p className="text-sm font-semibold text-slate-900">Generated Reports</p>
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
                          className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 shadow-sm"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold text-slate-900">{title}</p>
                            <Badge variant={status === "Pending" ? "problems" : "notes"}>{status}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-slate-600">{desc}</p>
                          <div className="mt-3 flex items-center justify-between">
                            <p className="text-xs text-slate-500">{count} records</p>
                            <button className="rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-semibold text-cyan-900 transition-colors hover:bg-cyan-100">
                              Preview
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                    <p className="text-sm font-semibold text-slate-900">Care Team Activity</p>
                    <div className="mt-3 grid gap-2 xl:grid-cols-2">
                      {activityFeed.slice(0, 6).map((item) => (
                        <div
                          key={`report-${item.id}`}
                          className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2 text-xs text-slate-700"
                        >
                          <p>{item.text}</p>
                          <p className="mt-1 text-[11px] text-slate-500">
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
                      <div key={String(label)} className="rounded-xl border border-[#dce8f8] bg-white p-3 shadow-sm">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                        <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-3 xl:grid-cols-3">
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm xl:col-span-2">
                      <p className="text-sm font-semibold text-slate-900">CTAS Acuity Distribution</p>
                      <div className="mt-3 space-y-2">
                        {acuityDistribution.map((item) => {
                          const max = Math.max(...acuityDistribution.map((x) => x.value), 1);
                          return (
                            <div key={item.label}>
                              <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
                                <span>{item.label}</span>
                                <span>{item.value}</span>
                              </div>
                              <div className="h-2 rounded-full bg-slate-100">
                                <div
                                  className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-cyan-400"
                                  style={{ width: `${(item.value / max) * 100}%` }}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                      <p className="text-sm font-semibold text-slate-900">Patients by Unit</p>
                      <div className="mt-4 flex items-center gap-4">
                        <div className="h-24 w-24 rounded-full" style={unitDonut} />
                        <div className="space-y-1">
                          {unitDistribution.map((item) => (
                            <p key={item.label} className="text-xs text-slate-700">
                              {item.label}: <span className="font-semibold">{item.value}</span>
                            </p>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                      <p className="text-sm font-semibold text-slate-900">Top Concern Categories</p>
                      <div className="mt-3 space-y-2">
                        {topConcernCategories.map((item) => (
                          <div key={item.label} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                            <span className="line-clamp-1 text-slate-700">{item.label}</span>
                            <Badge variant="medications">{item.value}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                      <p className="text-sm font-semibold text-slate-900">Shift Triage Trend</p>
                      <div className="mt-4 flex h-32 items-end gap-2">
                        {shiftTrend.map((item) => {
                          const max = Math.max(...shiftTrend.map((x) => x.value), 1);
                          return (
                            <div key={item.label} className="flex flex-1 flex-col items-center gap-1">
                              <div
                                className="w-full rounded-t-md bg-gradient-to-t from-cyan-500 to-blue-500"
                                style={{ height: `${Math.max(12, (item.value / max) * 96)}px` }}
                              />
                              <span className="text-[10px] text-slate-500">{item.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                      <p className="text-sm font-semibold text-slate-900">Risk Categories</p>
                      <div className="mt-3 space-y-2">
                        {riskDistribution.map((item) => (
                          <div key={item.label} className="flex items-center justify-between rounded-lg bg-rose-50/60 px-3 py-2 text-xs">
                            <span className="line-clamp-1 text-slate-700">{item.label}</span>
                            <Badge variant="risk">{item.value}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm">
                      <p className="text-sm font-semibold text-slate-900">Age Distribution</p>
                      <div className="mt-3 space-y-2">
                        {ageDistribution.map((item) => (
                          <div key={item.label} className="flex items-center justify-between rounded-lg bg-cyan-50/60 px-3 py-2 text-xs">
                            <span className="text-slate-700">{item.label}</span>
                            <Badge variant="notes">{item.value}</Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {activePage === "settings" && (
                <div className="rounded-xl border border-[#e3edf9] bg-white p-4 shadow-sm">
                  <p className="text-sm font-semibold text-slate-900">Settings</p>
                  <div className="mt-3 grid gap-2 text-sm">
                    <p>Microphone: {supportsSpeech ? "Available" : "Unavailable"}</p>
                    <p>Voice mode: {voiceSessionLive ? "Live" : "Idle"}</p>
                    <p>Theme: Light (dark mode ready)</p>
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                      Demo environment. Mock patient data only.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={handleClear}
                        className="rounded-lg border border-slate-300 px-3 py-1.5"
                      >
                        Clear Session
                      </button>
                      <button
                        type="button"
                        onClick={() => void refreshPatients()}
                        className="rounded-lg border border-slate-300 px-3 py-1.5"
                      >
                        Reload Patient Store
                      </button>
                      <button
                        type="button"
                        onClick={() => logout()}
                        className="rounded-lg border border-slate-300 px-3 py-1.5"
                      >
                        Sign Out
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
          {openPatientTabIds.length > 1 && (
            <motion.div layout className="panel mb-3 rounded-xl border border-[#e3edf9] bg-white px-3 py-2 shadow-sm">
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
                        "group inline-flex items-center gap-2 rounded-full border bg-[#07182f] px-3 py-1 text-xs text-slate-100 transition-colors",
                        active
                          ? "border-clinical-teal/70 ring-clinical"
                          : "border-white/15 hover:border-slate-400/50"
                      )}
                    >
                      <span className="font-medium">{p.name}</span>
                      <PatientClinicalIndicator patient={p} />
                      <span className="mono text-[10px] text-slate-300">{p.mrn}</span>
                      <span
                        className="rounded-full p-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/10"
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
            <div className="mb-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2 text-sm font-medium text-slate-700">
              Active Chart: {activePatient.name} • {activePatient.mrn} • Room {activePatient.room}
            </div>
          )}

          {activePatient && (
            <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl border border-[#e3edf9] bg-white p-3 shadow-sm lg:grid-cols-7">
              <div>
                <p className="text-[11px] uppercase text-slate-600">Patient</p>
                <p className="text-sm font-semibold text-slate-900">{activePatient.name}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-600">MRN</p>
                <p className="text-sm font-semibold text-slate-900">{activePatient.mrn}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-600">Age/Sex</p>
                <p className="text-sm font-semibold text-slate-900">
                  {activePatient.age}
                  {activePatient.sex}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-600">DOB</p>
                <p className="text-sm font-semibold text-slate-900">{activePatient.dob}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-600">Blood</p>
                <p className="text-sm font-semibold text-slate-900">{activePatient.bloodType || "—"}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-600">Provider</p>
                <p className="text-sm font-semibold text-slate-900">{activePatient.pcp ?? "Unassigned"}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-600">Last Visit</p>
                <p className="text-sm font-semibold text-slate-900">{activePatient.lastVisit}</p>
              </div>
            </div>
          )}

          {!activePatient && !hasRequestedSections && (
            <div className="mb-3 rounded-xl border border-dashed border-[#cfe0f5] bg-[#f8fbff] px-4 py-8 text-center text-sm text-slate-600">
              <div className="mb-2 inline-flex rounded-2xl border border-[#dbe8f9] bg-white px-3 py-2">
                <VitalLogo size={34} variant="full" textClassName="text-slate-800" />
              </div>
              <p className="font-medium text-slate-700">Awaiting clinician request</p>
              <p className="mt-1 text-slate-500">No chart section currently opened</p>
            </div>
          )}

          {activePatient && hasRequestedSections && (
          <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
            {activePatient && showSection("allergies") && (
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-rose-300 bg-rose-50/30 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">Allergies</p>
                <Badge variant="allergies" className="text-xs">
                  {activeAllergies.length ? `${activeAllergies.length} total` : "None listed"}
                </Badge>
              </div>
              <div className="rounded-xl border border-slate-100">
                <div className="grid grid-cols-[1.5fr_1fr_1fr] border-b border-slate-100 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700">
                  <span>Allergen</span>
                  <span>Reaction</span>
                  <span>Severity</span>
                </div>
                {activeAllergies.slice(0, 5).map((a, i) => {
                  const [namePart, reactionPart] = a.split("—").map((s) => s.trim());
                  const severity = /anaphylaxis|severe/i.test(a)
                    ? "Severe"
                    : /rash|hives|swelling/i.test(a)
                      ? "Moderate"
                      : "Mild";
                  return (
                    <div
                      key={`all-${i}`}
                      className="grid grid-cols-[1.5fr_1fr_1fr] border-b border-slate-100 px-2 py-1.5 text-sm last:border-b-0"
                    >
                      <span className="font-medium text-slate-800">{namePart || a}</span>
                      <span className="text-slate-900">{reactionPart || "Noted"}</span>
                      <span className="text-slate-900">{severity}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            )}

            {activePatient && showSection("medications") && (
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-blue-300 bg-blue-50/20 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">Medications</p>
                <Badge variant="medications" className="text-xs">
                  {activeMeds.length ? `${activeMeds.length} active` : "None listed"}
                </Badge>
              </div>
              <div className="rounded-xl border border-slate-100">
                <div className="grid grid-cols-[1.6fr_1.2fr_1fr] border-b border-slate-100 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700">
                  <span>Medication</span>
                  <span>Dose / Frequency</span>
                  <span>Indication</span>
                </div>
                {activeMeds.slice(0, 5).map((m, i) => (
                  <div
                    key={`med-${i}`}
                    className="grid grid-cols-[1.6fr_1.2fr_1fr] border-b border-slate-100 px-2 py-1.5 text-sm last:border-b-0"
                  >
                    <span className="font-medium text-slate-800">{m.name}</span>
                    <span className="text-slate-900">{m.sig}</span>
                    <span className="text-slate-900">Active</span>
                  </div>
                ))}
              </div>
            </div>
            )}

            {activePatient && showSection("diagnoses") && (
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-amber-300 bg-amber-50/20 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">Problems</p>
                <Badge variant="problems" className="text-xs">
                  {activeProblems.length ? `${activeProblemCount} active` : "None listed"}
                </Badge>
              </div>
              <div className="rounded-xl border border-slate-100">
                <div className="grid grid-cols-[2fr_1fr_1fr] border-b border-slate-100 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-700">
                  <span>Problem</span>
                  <span>Status</span>
                  <span>Since</span>
                </div>
                <AnimatePresence initial={false}>
                  {activeProblemRows.slice(0, 5).map(({ id, name, status, since }, i) => (
                    <motion.div
                      key={`${id}-${status}-${i}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.2 }}
                      className="grid grid-cols-[2fr_1fr_1fr] border-b border-slate-100 px-2 py-1.5 text-sm last:border-b-0"
                    >
                      <span className="font-medium text-slate-900">{name}</span>
                      <motion.div className="flex flex-wrap items-center gap-1">
                        {permissions.canEditPatientStatus ? (
                          <select
                            value={status}
                            onChange={(e) => {
                              if (!activePatient) return;
                              const nextStatus = e.target.value as ProblemStatus;
                              const updatedProblems = (
                                problemStateByPatient[activePatient.id] ?? []
                              ).map((item) =>
                                item.id === id ? { ...item, status: nextStatus } : item
                              );
                              setProblemStateByPatient((prev) => ({
                                ...prev,
                                [activePatient.id]: updatedProblems,
                              }));
                              setProblemStatusFlashId(`${id}-${nextStatus}`);
                              void persistPatientProblems(
                                activePatient.id,
                                updatedProblems,
                                apiRole
                              ).then((ok) => {
                                if (ok) void refreshPatients();
                              });
                            }}
                            className="h-7 rounded-md border border-slate-200 bg-white px-1 text-[10px] text-slate-900"
                          >
                            {PROBLEM_STATUS_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs font-medium text-slate-800">{status}</span>
                        )}
                        <Badge
                          variant={problemStatusBadgeVariant(status)}
                          className="w-fit text-[10px] transition-all duration-300"
                        >
                          {status}
                        </Badge>
                        <AnimatePresence>
                          {problemStatusFlashId === `${id}-${status}` && (
                            <motion.span
                              key={`${id}-${status}-check`}
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0, opacity: 0 }}
                            >
                              <Check className="h-3.5 w-3.5 text-clinical-teal" />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </motion.div>
                      <span className="text-slate-900">{since}</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
            )}

            {activePatient && (showSection("vitals") || showSection("labs")) && (
            <motion.div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-teal-300 bg-teal-50/20 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">Recent Notes / Vitals</p>
                <Badge variant="notes" className="text-xs">
                  {activeVitals.length ? "Live" : "None listed"}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-1 text-sm">
                {activeVitals.slice(0, 6).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <span className="mr-1 text-slate-600">{k}</span>
                    <span className="font-medium text-slate-900">{v}</span>
                  </div>
                ))}
                <motion.div className="col-span-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
                  {activePatient?.chartNote || "No recent notes"}
                </motion.div>
              </div>
            </motion.div>
            )}
          </div>
          )}

          {activePatient && (showSection("plan") || showSection("history")) && (
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-cyan-300 bg-cyan-50/20 px-3 py-2 shadow-sm">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                <Phone className="h-4 w-4 text-blue-500" />
                Emergency Contact
              </p>
              <p className="mt-1 text-sm text-slate-900">
                {activePatient.emergencyContact?.name || "Not listed"} (
                {activePatient.emergencyContact?.relationship || "Not listed"})
              </p>
            </div>
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-amber-300 bg-amber-50/20 px-3 py-2 shadow-sm">
              <p className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                <Phone className="h-4 w-4 text-blue-500" />
                {activePatient.emergencyContact?.phone || "Not listed"}
              </p>
              <p className="mt-1 text-xs text-slate-500">Primary contact line</p>
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
                    className="rounded-2xl border border-[#dbe7fb] bg-white p-4 shadow-sm"
                  >
                    <div className="mb-3 h-5 w-48 animate-pulse rounded bg-slate-200" />
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-16 animate-pulse rounded-xl bg-slate-100" />
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
                className="mt-3 rounded-xl border border-cyan-200/60 bg-gradient-to-br from-[#0b2a55] via-[#10386c] to-[#0f4b78] p-3 text-white shadow-md"
              >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Live Medication Orders</p>
                <Badge variant="notes" className="bg-cyan-100 text-[#0b2a55]">
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
                      "rounded-lg border border-cyan-200/35 bg-white/10 px-3 py-2 backdrop-blur-sm",
                      order.status !== "Delivered" && "animate-pulse",
                      order.status === "Delivered" && "border-emerald-300/70 bg-emerald-400/15"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">
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
                    <p className="mt-1 text-xs text-white/80">
                      {order.room} •{" "}
                      {new Date(order.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    <p className="mt-1 text-xs text-cyan-100">
                      {order.nurseName} • {order.pharmacyStation}
                    </p>
                    <div className="mt-2 h-1.5 rounded-full bg-white/20">
                      <motion.div
                        className="h-1.5 rounded-full bg-gradient-to-r from-cyan-300 via-blue-300 to-emerald-300"
                        initial={{ width: 0 }}
                        animate={{
                          width: `${((order.stepIndex + 1) / ORDER_WORKFLOW_STEPS.length) * 100}%`,
                        }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>
                    <p className="mt-1 text-[10px] text-cyan-100/90">
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

        <aside className="hidden border-l border-[#e3edf9] bg-[#f8fbff] p-4 lg:block">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Patient Details</p>
            <Badge variant="notes" className="text-[10px]">
              {activePage === "dashboard" ? "Live" : "Info"}
            </Badge>
          </div>
          {activePage !== "dashboard" ? (
            <div className="rounded-xl border border-[#e3edf9] bg-white p-3 text-sm text-slate-600 shadow-sm">
              Select <span className="font-medium text-slate-900">Dashboard</span> to view active
              patient details and chart navigation.
            </div>
          ) : !activePatient ? (
            <div className="rounded-xl border border-dashed border-[#d6e4f8] bg-white p-4 text-sm text-slate-500 shadow-sm">
              No active patient chart.
            </div>
          ) : (
          <div className="space-y-2">
            {[
              ["Allergies", `${activeAllergies.length || 0} total`, "allergies", "border-l-rose-300"],
              ["Medications", `${activeMeds.length || 0} active`, "medications", "border-l-blue-300"],
              ["Problems", `${activeProblems.length || 0} active`, "diagnoses", "border-l-amber-300"],
              ["Recent Notes", activePatient?.chartNote ? "1 recent" : "None listed", "vitals", "border-l-indigo-300"],
              ["Emergency Contact", activePatient?.emergencyContact?.name ? "1 contact" : "None listed", "plan", "border-l-cyan-300"],
              ["Care Team", `${activePatient?.careTeam?.length ?? 0} listed`, "plan", "border-l-teal-300"],
              ["Risk Flags", activePatient?.riskFlags ? "1 flag" : "None listed", "plan", "border-l-amber-400"],
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
                  "w-full rounded-xl border border-[#e3edf9] border-l-4 bg-white p-3 text-left shadow-sm",
                  accent as string
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">{label}</p>
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
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-600">- Tap to open section in workspace</p>
              </button>
            ))}
            <div className="rounded-xl border border-[#e3edf9] bg-white p-3 shadow-sm">
              <p className="text-sm font-semibold text-slate-900">Notes</p>
              <p className="mt-1 text-sm text-slate-700">
                {activePatient?.chartNote || "No notes yet"}
              </p>
            </div>
            <div className="rounded-xl border border-[#e3edf9] bg-white p-3 shadow-sm">
              <p className="text-sm font-semibold text-slate-900">Emergency Contact</p>
              <p className="mt-2 inline-flex items-center gap-2 text-sm text-slate-700">
                <Phone className="h-4 w-4 text-blue-500" />
                {activePatient?.social?.includes("daughter")
                  ? "(555) 123-4567"
                  : "On file in patient chart"}
              </p>
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
    <span className="inline-flex max-w-[220px] flex-wrap items-center justify-end gap-1.5 text-[10px] font-medium text-slate-700">
      <span className="flex items-center gap-1 rounded-full border border-slate-300/90 bg-white/95 px-2 py-0.5 text-slate-900 transition-colors hover:bg-slate-100">
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
            <span className="ml-1 inline-block h-2 w-2 animate-pulse rounded-full bg-violet-500 align-middle" />
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
    <div className="mt-2 overflow-hidden rounded-2xl border border-[#d8e6fb] bg-white shadow-md">
      <div className="flex items-center justify-between gap-2 bg-[#0B2A55] px-4 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/90">
          Requested chart data
        </p>
        <span className="rounded-full border border-cyan-200/60 bg-cyan-100 px-2 py-0.5 text-[10px] font-semibold text-[#0B2A55]">
          {view.title}
        </span>
      </div>
      <div className="p-4">

      {(wantsOverview || !onlySection) && (
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-2.5 shadow-sm">
          <p className="text-[10px] uppercase text-neutral-500">Age/Sex</p>
          <p className="text-sm font-semibold text-neutral-900">
            {p.age}
            {p.sex}
          </p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-2.5 shadow-sm">
          <p className="text-[10px] uppercase text-neutral-500">MRN</p>
          <p className="text-sm font-semibold text-neutral-900">{p.mrn}</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-2.5 shadow-sm">
          <p className="text-[10px] uppercase text-neutral-500">Problems</p>
          <p className="text-sm font-semibold text-neutral-900">
            {p.diagnoses.length}
          </p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-2.5 shadow-sm">
          <p className="text-[10px] uppercase text-neutral-500">Meds</p>
          <p className="text-sm font-semibold text-neutral-900">
            {p.medications.length}
          </p>
        </div>
      </div>
      )}

      {view.fields.includes("demographics") && !wantsOverview && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <div className="rounded-lg border border-violet-100 bg-violet-50/60 px-2.5 py-2">
            <p className="text-[10px] uppercase text-neutral-500">DOB</p>
            <p className="text-sm font-semibold text-neutral-900">{p.dob}</p>
          </div>
          <div className="rounded-lg border border-violet-100 bg-violet-50/60 px-2.5 py-2">
            <p className="text-[10px] uppercase text-neutral-500">Room</p>
            <p className="text-sm font-semibold text-neutral-900">{p.room}</p>
          </div>
          <div className="rounded-lg border border-violet-100 bg-violet-50/60 px-2.5 py-2">
            <p className="text-[10px] uppercase text-neutral-500">Blood type</p>
            <p className="text-sm font-semibold text-neutral-900">{p.bloodType}</p>
          </div>
          <div className="rounded-lg border border-violet-100 bg-violet-50/60 px-2.5 py-2">
            <p className="text-[10px] uppercase text-neutral-500">Acuity</p>
            <p className="text-sm font-semibold text-neutral-900">{p.triageAcuity}</p>
          </div>
          <div className="col-span-2 rounded-lg border border-violet-100 bg-violet-50/60 px-2.5 py-2 sm:col-span-3">
            <p className="text-[10px] uppercase text-neutral-500">Chief concern</p>
            <p className="text-sm font-semibold text-neutral-900">{p.chiefConcern}</p>
          </div>
          {p.symptoms && p.symptoms.length > 0 && (
            <div className="col-span-2 rounded-lg border border-violet-100 bg-violet-50/60 px-2.5 py-2 sm:col-span-3">
              <p className="text-[10px] uppercase text-neutral-500">Symptoms</p>
              <p className="text-sm text-neutral-800">{p.symptoms.join(", ")}</p>
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
                className="rounded-lg border border-cyan-100 bg-cyan-50/60 px-2.5 py-2"
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
                className="rounded-lg border border-cyan-100 bg-cyan-50/60 px-2.5 py-1.5 text-sm text-neutral-700"
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
                className="flex items-center justify-between rounded-lg border border-amber-100 bg-amber-50/60 px-2.5 py-1.5 text-sm"
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
}) {
  const tabs: { id: typeof tab; label: string }[] = [
    { id: "charts", label: "Charts" },
    { id: "response", label: "Answer" },
    { id: "dialogue", label: "Log" },
    { id: "actions", label: "Tools" },
    { id: "system", label: "System" },
  ];

  const sheetSurface =
    "[&_.panel]:border-neutral-200/90 [&_.panel]:bg-white/95 [&_.panel]:shadow-sm [&_.panel-header]:border-neutral-200/80 [&_.mono]:text-neutral-600 [&_.text-muted-foreground]:text-neutral-500";

  return (
    <motion.div
      className="fixed inset-0 z-50 flex"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
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
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 320 }}
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
                    : "bg-white text-neutral-600 shadow-sm ring-1 ring-neutral-200/80 hover:bg-neutral-50"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
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
                  className="rounded-xl border border-amber-300/60 bg-amber-50/90 px-3 py-2 text-sm text-amber-950 shadow-sm"
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
          {tab === "system" && <SystemPanel systemState={systemState} />}
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
          emergencyArmed &&
            "shadow-[0_0_0_1px_hsl(var(--clinical-danger)/0.5),0_8px_30px_-10px_hsl(var(--clinical-danger)/0.7)]"
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
            className="rounded-lg border border-border/70 bg-black/10 px-3 py-2"
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
          className="scrollbar-thin mono min-h-[180px] w-full resize-y rounded-2xl border border-white/10 bg-black/25 p-3 text-[12.5px] leading-relaxed text-foreground/90 placeholder:text-muted-foreground/45 backdrop-blur-sm focus:outline-none focus:ring-2 focus:ring-clinical-teal/40"
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

function SystemPanel({ systemState }: { systemState: SystemState }) {
  const items: { label: string; value: string; tone?: string }[] = [
    {
      label: "STT",
      value: "Browser SpeechRecognition",
      tone: "text-clinical-teal",
    },
    {
      label: "TTS",
      value: "Browser SpeechSynthesis",
      tone: "text-clinical-mint",
    },
    { label: "BRAIN", value: "Gemini · 1.5 Flash", tone: "text-clinical-cyan" },
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

