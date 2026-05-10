"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  Accessibility,
  BarChart3,
  BellRing,
  BookText,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Eraser,
  FileBarChart2,
  FileText,
  Home,
  Keyboard,
  Loader2,
  MessageCircle,
  Mic,
  MicOff,
  Monitor,
  Moon,
  NotebookTabs,
  Palette,
  Pause,
  Phone,
  Settings,
  ShieldAlert,
  Siren,
  SlidersHorizontal,
  Sparkles,
  Sun,
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
import type { ConversationTurn } from "@/lib/vital-llm";
import type { DemoPatient } from "@/lib/demo-patients";
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

function detectStatusValue(command: string): ProblemStatus | null {
  if (/ruled\s*out/i.test(command)) return "Ruled out";
  if (/resolved/i.test(command)) return "Resolved";
  if (/monitoring|monitor/i.test(command)) return "Monitoring";
  if (/pending/i.test(command)) return "Pending";
  if (/active/i.test(command)) return "Active";
  return null;
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

type ProblemStatus = "Active" | "Resolved" | "Monitoring" | "Pending" | "Ruled out";

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
  isClosing?: boolean;
  closingStartedAt?: number;
  createdAt: number;
};

type DischargedRecord = {
  patientId: string;
  patientName: string;
  room: string;
  dischargedAt: number;
  status: "Completed";
};

type ThemeMode = "light" | "dark" | "system";

type ParsedAction =
  | { intent: "discharge_patient"; patientQuery?: string }
  | { intent: "restore_patient"; patientQuery?: string }
  | {
      intent: "update_problem_status";
      patientQuery?: string;
      problemName?: string;
      status: ProblemStatus;
      allProblems?: boolean;
    }
  | { intent: "medication_order"; patientQuery?: string; medication?: string }
  | { intent: "show_section"; patientQuery?: string; sections: PatientFieldKey[] }
  | { intent: "allergy_search"; sex?: "M" | "F"; pediatric?: boolean; allergies: string[] }
  | { intent: "list_patients"; sex?: "M" | "F"; pediatric?: boolean }
  | { intent: "end_session" };

type VoiceCommandAction =
  | { kind: "none" }
  | { kind: "clear_session" }
  | { kind: "patient_ambiguous"; matches: DemoPatient[] }
  | { kind: "patient_not_found"; query: string }
  | { kind: "close_chart" }
  | { kind: "switch_patient"; patientId: string; sections: PatientFieldKey[] }
  | { kind: "open_sections"; patientId: string; sections: PatientFieldKey[] };

type ActivePage =
  | "dashboard"
  | "patients"
  | "encounters"
  | "reports"
  | "analytics"
  | "settings";

function detectRequestedFields(transcript: string): PatientFieldKey[] {
  const q = transcript.toLowerCase();
  const hasInfoIntent =
    /pull up|show|display|open|review|give me|tell me|what is|what are|chart|patient|mrn|record|info/.test(
      q
    );
  if (!hasInfoIntent) return [];

  const out = new Set<PatientFieldKey>();
  if (/(med|meds|medication|rx|prescription)/.test(q)) out.add("medications");
  if (/(allerg|allergy)/.test(q)) out.add("allergies");
  if (/(vital|bp|heart rate|spo2|temp|temperature)/.test(q)) out.add("vitals");
  if (/(lab|a1c|bmp|cbc|creatinine|bnp)/.test(q)) out.add("labs");
  if (/(diagnos|problem|condition|assessment)/.test(q))
    out.add("diagnoses");
  if (/(imag|xray|ct|mri|echo|ekg|ultrasound)/.test(q)) out.add("imaging");
  if (/(social|smok|alcohol|home|family support)/.test(q)) out.add("social");
  if (/(history|surgical|family history|immunization)/.test(q))
    out.add("history");
  if (/(plan|next step|consult|follow[- ]?up|risk)/.test(q)) out.add("plan");

  if (out.size === 0) out.add("overview");
  return Array.from(out);
}

function buildRequestedPatientView(
  patient: DemoPatient,
  fields: PatientFieldKey[]
): RequestedPatientView {
  const lines: string[] = [];
  const wantsOverview = fields.includes("overview");
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
  const roomMatch = q.match(/patient in ([a-z]+\s*\d+)/i);
  if (roomMatch) {
    const room = roomMatch[1].trim().toLowerCase();
    return patients.filter((p) => p.room.toLowerCase() === room);
  }
  const mrnMatch = q.match(/mrn[-\s]?\d+/i)?.[0]?.toLowerCase();
  if (mrnMatch) {
    return patients.filter((p) => p.mrn.toLowerCase() === mrnMatch);
  }
  const fullMatches = patients.filter((p) => q.includes(p.name.toLowerCase()));
  if (fullMatches.length) return fullMatches;
  const tokenMatches = patients.filter((p) => {
    const parts = p.name.toLowerCase().split(" ");
    return parts.some((part) => q.includes(part));
  });
  return tokenMatches;
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

  const switchMatch = q.match(/switch to (.+)$/);
  if (switchMatch) {
    const matches = findPatientMatches(switchMatch[1], patients);
    if (matches.length > 1) return { kind: "patient_ambiguous", matches };
    const target = matches[0] ?? null;
    if (!target) return { kind: "patient_not_found", query: switchMatch[1] };
    return { kind: "switch_patient", patientId: target.id, sections: ["overview"] };
  }

  const hasChartIntent =
    /pull up|show|open|find|view|bring up|display|review|what is|tell me|get/.test(
      q
    ) &&
    /chart|allerg|med|problem|note|vital|lab|emergency|care team|risk|patient|age|dob|blood|room|chief concern/.test(
      q
    );
  if (!hasChartIntent) return { kind: "none" };

  const explicitNameMatch = q.match(/for (.+)$/);
  const matches = explicitNameMatch
    ? findPatientMatches(explicitNameMatch[1], patients)
    : findPatientMatches(q, patients);
  if (matches.length > 1) return { kind: "patient_ambiguous", matches };
  const explicit = matches[0] ?? null;
  const active =
    (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
  const target = explicit ?? active;
  if (!target) {
    return {
      kind: "patient_not_found",
      query: explicitNameMatch?.[1] ?? "requested patient",
    };
  }

  const sections = detectRequestedFields(transcript);
  const resolvedSections =
    sections.includes("overview") || /full chart/.test(q)
      ? (["overview", "allergies", "medications", "diagnoses", "vitals", "labs", "plan"] as PatientFieldKey[])
      : sections;
  return { kind: "open_sections", patientId: target.id, sections: resolvedSections };
}

function splitCompoundCommands(input: string): string[] {
  return input
    .split(/\b(?:and also|also|then|plus|after that| and )\b/gi)
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractAllergyTerms(q: string): string[] {
  const known = ["penicillin", "peanut", "peanuts", "latex", "sulfa", "shellfish"];
  const found = known.filter((term) => new RegExp(`\\b${term}\\b`, "i").test(q));
  const unique = Array.from(new Set(found.map((x) => (x === "peanut" ? "peanuts" : x))));
  return unique;
}

function parseCommand(
  transcript: string,
  patients: DemoPatient[],
  selectedPatientId: string | null
): ParsedAction[] {
  const chunks = splitCompoundCommands(transcript);
  const actions: ParsedAction[] = [];

  for (const chunk of chunks) {
    const q = chunk.toLowerCase();
    const patientMatch = findPatientMatches(chunk, patients)[0];
    const patientQuery = patientMatch?.name ?? undefined;

    if (isResetCommand(q) || /end session|logout/.test(q)) {
      actions.push({ intent: "end_session" });
      continue;
    }
    if (/discharge|ready for discharge|remove .*active roster|clear .*active roster/.test(q)) {
      actions.push({ intent: "discharge_patient", patientQuery });
      continue;
    }
    if (/restore|bring .* back|reopen/.test(q)) {
      actions.push({ intent: "restore_patient", patientQuery });
      continue;
    }
    if (/mark all|resolve all|clear all active issues/.test(q) && /problem|issue|diagnos/.test(q)) {
      actions.push({
        intent: "update_problem_status",
        patientQuery,
        status: "Resolved",
        allProblems: true,
      });
      continue;
    }
    if (/resolve|resolved|monitoring|pending|ruled out|active/.test(q) && /problem|diagnos|hypertension|status|fixed/.test(q)) {
      actions.push({
        intent: "update_problem_status",
        patientQuery,
        problemName: chunk,
        status: detectStatusValue(chunk) ?? "Resolved",
      });
      continue;
    }
    if (/prescribe|give|order|send medication|send .*med/.test(q)) {
      actions.push({
        intent: "medication_order",
        patientQuery,
        medication: detectOrderMedication(chunk) ?? undefined,
      });
      continue;
    }

    const sections = detectRequestedFields(chunk);
    if (sections.length > 0) {
      actions.push({
        intent: "show_section",
        patientQuery: patientQuery ?? (selectedPatientId ? patients.find((p) => p.id === selectedPatientId)?.name : undefined),
        sections,
      });
      continue;
    }

    if (/list|show|provide/.test(q) && /patient/.test(q)) {
      const allergies = extractAllergyTerms(q);
      if (allergies.length > 0) {
        actions.push({
          intent: "allergy_search",
          sex: /male/.test(q) ? "M" : /female/.test(q) ? "F" : undefined,
          pediatric: /pediatric|peds|child/.test(q),
          allergies,
        });
      } else {
        actions.push({
          intent: "list_patients",
          sex: /male/.test(q) ? "M" : /female/.test(q) ? "F" : undefined,
          pediatric: /pediatric|peds|child/.test(q),
        });
      }
    }
  }
  return actions;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Page
 * ────────────────────────────────────────────────────────────────────────── */

export default function VitalOsClient() {
  const [systemState, setSystemState] = React.useState<SystemState>("idle");
  const [mode, setMode] = React.useState<VitalMode>("general");
  const [emergencyArmed, setEmergencyArmed] = React.useState(false);

  const [interimTranscript, setInterimTranscript] = React.useState("");
  const [finalTranscript, setFinalTranscript] = React.useState("");
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
  const [dischargedPatients, setDischargedPatients] = React.useState<
    Record<string, DischargedRecord>
  >({});
  const [dischargedPatientIds, setDischargedPatientIds] = React.useState<string[]>([]);
  const [editableProblems, setEditableProblems] = React.useState<
    Record<string, EditableProblem[]>
  >({});
  const [orderNotice, setOrderNotice] = React.useState<string | null>(null);
  const [searchResults, setSearchResults] = React.useState<DemoPatient[]>([]);
  const [searchResultsTitle, setSearchResultsTitle] = React.useState<string>("");
  const [openPatientTabIds, setOpenPatientTabIds] = React.useState<string[]>([]);
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
  const [themeMode, setThemeMode] = React.useState<ThemeMode>("light");
  const [systemPrefersDark, setSystemPrefersDark] = React.useState(false);
  const [micSensitivity, setMicSensitivity] = React.useState(62);
  const [speechRateSetting, setSpeechRateSetting] = React.useState(104);
  const [assistantVoice, setAssistantVoice] = React.useState("Clinical Voice A");
  const [muteAssistant, setMuteAssistant] = React.useState(false);
  const [autoOpenChartData, setAutoOpenChartData] = React.useState(true);
  const [autoScrollToRequested, setAutoScrollToRequested] = React.useState(true);
  const [medicationWorkflowAnimations, setMedicationWorkflowAnimations] = React.useState(true);
  const [deliveryNotificationsEnabled, setDeliveryNotificationsEnabled] = React.useState(true);
  const [compactDashboardMode, setCompactDashboardMode] = React.useState(false);
  const [persistentPatientPanels, setPersistentPatientPanels] = React.useState(true);
  const [highRiskAlerts, setHighRiskAlerts] = React.useState(true);
  const [criticalLabAlerts, setCriticalLabAlerts] = React.useState(true);
  const [voiceConfirmationsEnabled, setVoiceConfirmationsEnabled] = React.useState(true);
  const [sessionNotificationsEnabled, setSessionNotificationsEnabled] = React.useState(true);
  const [textScalePercent, setTextScalePercent] = React.useState(100);
  const [reducedMotionMode, setReducedMotionMode] = React.useState(false);
  const [highContrastMode, setHighContrastMode] = React.useState(false);
  const [largerTouchTargets, setLargerTouchTargets] = React.useState(false);
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
  const systemStateRef = React.useRef<SystemState>("idle");
  const bargeInRef = React.useRef<() => void>(() => {});
  const lastBargeAtRef = React.useRef(0);
  const voiceHeroRef = React.useRef<VoiceHeroVisualHandle>(null);
  const speakRef = React.useRef<(text: string) => void>(() => {});
  const speakResponseRef = React.useRef<(text: string) => void>(() => {});
  const requestedCardRef = React.useRef<HTMLDivElement | null>(null);
  const orderDismissTimersRef = React.useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const orderRemoveTimersRef = React.useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const resolvedTheme = themeMode === "system"
    ? (systemPrefersDark ? "dark" : "light")
    : themeMode;

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
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setSystemPrefersDark(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("vital-os-settings");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
      if (parsed.themeMode === "light" || parsed.themeMode === "dark" || parsed.themeMode === "system") {
        setThemeMode(parsed.themeMode);
      }
      if (typeof parsed.micSensitivity === "number") setMicSensitivity(parsed.micSensitivity);
      if (typeof parsed.speechRateSetting === "number") setSpeechRateSetting(parsed.speechRateSetting);
      if (typeof parsed.assistantVoice === "string") setAssistantVoice(parsed.assistantVoice);
      if (typeof parsed.autoOpenChartData === "boolean") setAutoOpenChartData(parsed.autoOpenChartData);
      if (typeof parsed.autoScrollToRequested === "boolean") setAutoScrollToRequested(parsed.autoScrollToRequested);
      if (typeof parsed.medicationWorkflowAnimations === "boolean") setMedicationWorkflowAnimations(parsed.medicationWorkflowAnimations);
      if (typeof parsed.deliveryNotificationsEnabled === "boolean") setDeliveryNotificationsEnabled(parsed.deliveryNotificationsEnabled);
      if (typeof parsed.compactDashboardMode === "boolean") setCompactDashboardMode(parsed.compactDashboardMode);
      if (typeof parsed.persistentPatientPanels === "boolean") setPersistentPatientPanels(parsed.persistentPatientPanels);
      if (typeof parsed.highRiskAlerts === "boolean") setHighRiskAlerts(parsed.highRiskAlerts);
      if (typeof parsed.criticalLabAlerts === "boolean") setCriticalLabAlerts(parsed.criticalLabAlerts);
      if (typeof parsed.voiceConfirmationsEnabled === "boolean") setVoiceConfirmationsEnabled(parsed.voiceConfirmationsEnabled);
      if (typeof parsed.sessionNotificationsEnabled === "boolean") setSessionNotificationsEnabled(parsed.sessionNotificationsEnabled);
      if (typeof parsed.textScalePercent === "number") setTextScalePercent(parsed.textScalePercent);
      if (typeof parsed.reducedMotionMode === "boolean") setReducedMotionMode(parsed.reducedMotionMode);
      if (typeof parsed.highContrastMode === "boolean") setHighContrastMode(parsed.highContrastMode);
      if (typeof parsed.largerTouchTargets === "boolean") setLargerTouchTargets(parsed.largerTouchTargets);
      // Always start each demo session with voice output enabled.
      setMuteAssistant(false);
    } catch {
      /* ignore malformed local settings */
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "vital-os-settings",
      JSON.stringify({
        themeMode,
        micSensitivity,
        speechRateSetting,
        assistantVoice,
        muteAssistant,
        autoOpenChartData,
        autoScrollToRequested,
        medicationWorkflowAnimations,
        deliveryNotificationsEnabled,
        compactDashboardMode,
        persistentPatientPanels,
        highRiskAlerts,
        criticalLabAlerts,
        voiceConfirmationsEnabled,
        sessionNotificationsEnabled,
        textScalePercent,
        reducedMotionMode,
        highContrastMode,
        largerTouchTargets,
      })
    );
  }, [
    themeMode,
    micSensitivity,
    speechRateSetting,
    assistantVoice,
    muteAssistant,
    autoOpenChartData,
    autoScrollToRequested,
    medicationWorkflowAnimations,
    deliveryNotificationsEnabled,
    compactDashboardMode,
    persistentPatientPanels,
    highRiskAlerts,
    criticalLabAlerts,
    voiceConfirmationsEnabled,
    sessionNotificationsEnabled,
    textScalePercent,
    reducedMotionMode,
    highContrastMode,
    largerTouchTargets,
  ]);

  React.useEffect(() => {
    setVoiceEnabled(!muteAssistant);
  }, [muteAssistant]);

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
    if (!selectedPatientId) return;
    if (!dischargedPatientIds.includes(selectedPatientId)) return;
    setSelectedPatientId(null);
  }, [dischargedPatientIds, selectedPatientId]);

  React.useEffect(() => {
    setEditableProblems((prev) => {
      const next = { ...prev };
      for (const patient of patients) {
        if (next[patient.id]?.length) continue;
        next[patient.id] = patient.diagnoses.map((name) => ({
          id: `${patient.id}-${normalizeProblemKey(name)}`,
          name,
          status: "Active",
          since: "Chart",
        }));
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
              if (nextStatus === "Ready for Pickup" && deliveryNotificationsEnabled) {
                setOrderNotice("Pharmacy preparation complete.");
              }
              if (nextStatus === "Nurse Assigned" && deliveryNotificationsEnabled) {
                setOrderNotice(`Nurse assigned: ${item.nurseName}.`);
              }
              if (nextStatus === "Delivered") {
                if (deliveryNotificationsEnabled) {
                  setOrderNotice(`Medication delivered successfully to ${item.room}.`);
                }
                speakResponseRef.current(`Medication delivered to ${item.room}.`);
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
  }, [deliveryNotificationsEnabled, pendingOrders]);

  React.useEffect(() => {
    for (const order of pendingOrders) {
      if (order.status !== "Delivered" || order.isClosing) continue;
      if (orderDismissTimersRef.current[order.id]) continue;
      orderDismissTimersRef.current[order.id] = globalThis.setTimeout(() => {
        setPendingOrders((prev) =>
          prev.map((item) =>
            item.id === order.id
              ? { ...item, isClosing: true, closingStartedAt: Date.now() }
              : item
          )
        );
        delete orderDismissTimersRef.current[order.id];
      }, 5000);
    }

    return () => {
      for (const [id, timer] of Object.entries(orderDismissTimersRef.current)) {
        if (!pendingOrders.some((o) => o.id === id && o.status === "Delivered" && !o.isClosing)) {
          globalThis.clearTimeout(timer);
          delete orderDismissTimersRef.current[id];
        }
      }
    };
  }, [pendingOrders]);

  React.useEffect(() => {
    for (const order of pendingOrders) {
      if (!order.isClosing) continue;
      if (orderRemoveTimersRef.current[order.id]) continue;
      orderRemoveTimersRef.current[order.id] = globalThis.setTimeout(() => {
        setPendingOrders((prev) => prev.filter((item) => item.id !== order.id));
        delete orderRemoveTimersRef.current[order.id];
      }, 800);
    }

    return () => {
      for (const [id, timer] of Object.entries(orderRemoveTimersRef.current)) {
        if (!pendingOrders.some((o) => o.id === id && o.isClosing)) {
          globalThis.clearTimeout(timer);
          delete orderRemoveTimersRef.current[id];
        }
      }
    };
  }, [pendingOrders]);

  React.useEffect(
    () => () => {
      Object.values(orderDismissTimersRef.current).forEach((timer) =>
        globalThis.clearTimeout(timer)
      );
      Object.values(orderRemoveTimersRef.current).forEach((timer) =>
        globalThis.clearTimeout(timer)
      );
    },
    []
  );

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
      setFinalTranscript("");
      finalRef.current = "";
      setInterimTranscript("");
      interimRef.current = "";
      void submitRef.current(text);
    }, 1400);
  }, []);

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

    rec.onresult = (ev) => {
      let interim = "";
      let finalDelta = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const txt = r[0]?.transcript ?? "";
        if (r.isFinal) finalDelta += txt;
        else interim += txt;
      }

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

      if (finalDelta) {
        setFinalTranscript((prev) => {
          const next = (prev ? prev + " " : "") + finalDelta.trim();
          finalRef.current = next;
          return next;
        });
      }
      setInterimTranscript(interim);
      interimRef.current = interim;

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
        /* Harmless gap between phrases while continuous listening. */
        return;
      } else if (code === "audio-capture") {
        listeningIntentRef.current = false;
        voiceSessionActiveRef.current = false;
        setVoiceSessionLive(false);
        msg = "No microphone detected. Connect a mic and try again.";
      } else if (code === "network") {
        listeningIntentRef.current = false;
        voiceSessionActiveRef.current = false;
        setVoiceSessionLive(false);
        msg =
          "Speech recognition needs an internet connection (Chrome sends audio to Google). Check your network.";
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
      setInterimTranscript("");

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
          const r = recognitionRef.current;
          if (!r) return;
          try {
            r.start();
          } catch {
            listeningIntentRef.current = false;
            setSystemState((s) => (s === "listening" ? "idle" : s));
          }
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

      /* Do NOT call getUserMedia here — holding a MediaStream often blocks Web Speech on Windows/Chrome. */

      const rec = mountRecognition();
      if (!rec) {
        listeningIntentRef.current = false;
        return;
      }

      setFinalTranscript("");
      finalRef.current = "";
      setInterimTranscript("");
      interimRef.current = "";
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
      speakResponseRef.current(text);
    },
    []
  );

  const updateProblemStatus = React.useCallback(
    (patientId: string, problemName: string, newStatus: ProblemStatus): EditableProblem | null => {
      let updated: EditableProblem | null = null;
      setEditableProblems((prev) => {
        const list = prev[patientId] ?? [];
        const normalizedProblem = normalizeProblemKey(problemName);
        const nextList = list.map((item) => {
          const match =
            normalizeProblemKey(item.name).includes(normalizedProblem) ||
            normalizedProblem.includes(normalizeProblemKey(item.name));
          if (!match) return item;
          updated = { ...item, status: newStatus };
          return updated;
        });
        console.log("[VITAL COMMAND] updated editableProblems:", {
          patientId,
          problemName,
          newStatus,
          matched: Boolean(updated),
        });
        return { ...prev, [patientId]: nextList };
      });
      return updated;
    },
    []
  );

  const dischargePatient = React.useCallback((patient: DemoPatient) => {
    console.log("[VITAL COMMAND] discharge patient:", patient.name, patient.id);
    setDischargedPatients((prev) => ({
      ...prev,
      [patient.id]: {
        patientId: patient.id,
        patientName: patient.name,
        room: patient.room,
        dischargedAt: Date.now(),
        status: "Completed",
      },
    }));
    setDischargedPatientIds((prev) => (prev.includes(patient.id) ? prev : [...prev, patient.id]));
    setOpenPatientTabIds((prev) => prev.filter((id) => id !== patient.id));
    if (selectedPatientId === patient.id) {
      setRequestedPatientView(null);
      setActiveRequestedSections([]);
      setSelectedPatientId(null);
    }
  }, [selectedPatientId]);

  const restorePatient = React.useCallback((patient: DemoPatient) => {
    console.log("[VITAL COMMAND] restore patient:", patient.name, patient.id);
    setDischargedPatients((prev) => {
      const next = { ...prev };
      delete next[patient.id];
      return next;
    });
    setDischargedPatientIds((prev) => prev.filter((id) => id !== patient.id));
  }, []);

  const resetSettingsToDefaults = React.useCallback(() => {
    setThemeMode("light");
    setMicSensitivity(62);
    setSpeechRateSetting(104);
    setAssistantVoice("Clinical Voice A");
    setMuteAssistant(false);
    setAutoOpenChartData(true);
    setAutoScrollToRequested(true);
    setMedicationWorkflowAnimations(true);
    setDeliveryNotificationsEnabled(true);
    setCompactDashboardMode(false);
    setPersistentPatientPanels(true);
    setHighRiskAlerts(true);
    setCriticalLabAlerts(true);
    setVoiceConfirmationsEnabled(true);
    setSessionNotificationsEnabled(true);
    setTextScalePercent(100);
    setReducedMotionMode(false);
    setHighContrastMode(false);
    setLargerTouchTargets(false);
    setOrderNotice("Settings reset to defaults.");
  }, []);

  const runPatientSearch = React.useCallback(
    (opts: { sex?: "M" | "F"; pediatric?: boolean; allergies?: string[] }) => {
      let out = patients.filter((p) => !dischargedPatientIds.includes(p.id));
      if (opts.sex) out = out.filter((p) => p.sex.toUpperCase().startsWith(opts.sex!));
      if (opts.pediatric) out = out.filter((p) => p.age < 18 || /^peds/i.test(p.room));
      if (opts.allergies?.length) {
        out = out.filter((p) => {
          const allergiesText = p.allergies.join(" ").toLowerCase();
          return opts.allergies!.every((a) => allergiesText.includes(a.toLowerCase()));
        });
      }
      return out;
    },
    [dischargedPatientIds, patients]
  );

  const openRequestedView = React.useCallback(
    async (patient: DemoPatient, sections: PatientFieldKey[]) => {
      setSelectedPatientId(patient.id);
      setOpenPatientTabIds((prev) =>
        prev.includes(patient.id) ? prev : [...prev, patient.id].slice(-5)
      );
      setActiveRequestedSections(sections);
      if (!autoOpenChartData) {
        return;
      }
      setIsChartLoading(true);
      await new Promise<void>((resolve) =>
        setTimeout(() => resolve(), reducedMotionMode ? 80 : 360)
      );
      setRequestedPatientView(buildRequestedPatientView(patient, sections));
      setIsChartLoading(false);
      if (autoScrollToRequested) {
        globalThis.setTimeout(() => {
          requestedCardRef.current?.scrollIntoView({
            behavior: reducedMotionMode ? "auto" : "smooth",
            block: "start",
          });
        }, 40);
      }
    },
    [autoOpenChartData, autoScrollToRequested, reducedMotionMode]
  );

  const handleClinicalCommand = React.useCallback(
    async (commandText: string): Promise<boolean> => {
      const command = commandText.trim();
      if (!command) return false;
      setLastCommand(command);
      const lower = command.toLowerCase();

      console.log("[VITAL COMMAND] input:", command);

      const parsedActions = parseCommand(command, patients, selectedPatientId);
      console.log("[VITAL COMMAND] parsed intents:", parsedActions);
      if (parsedActions.length > 0) {
        const outputs: string[] = [];
        for (const action of parsedActions) {
          if (action.intent === "end_session") {
            resetSession();
            outputs.push("Session ended. Panels cleared.");
            continue;
          }
          if (action.intent === "discharge_patient") {
            const target =
              (action.patientQuery && findPatientByQuery(patients, action.patientQuery)) ||
              (selectedPatientId ? patients.find((p) => p.id === selectedPatientId) ?? null : null);
            console.log("[VITAL COMMAND] discharge target:", target?.name ?? "none");
            if (!target) {
              outputs.push("Please confirm which patient should be ready for discharge.");
              continue;
            }
            dischargePatient(target);
            setOrderNotice(`${target.name} discharged from active roster.`);
            outputs.push(
              `Discharge workflow started. ${target.name} has been removed from the active roster for this session.`
            );
            continue;
          }
          if (action.intent === "restore_patient") {
            const target =
              (action.patientQuery && findPatientByQuery(patients, action.patientQuery)) || null;
            console.log("[VITAL COMMAND] restore target:", target?.name ?? "none");
            if (!target || !dischargedPatientIds.includes(target.id)) {
              outputs.push("Please confirm which discharged patient to restore.");
              continue;
            }
            restorePatient(target);
            outputs.push(`${target.name} has been restored to the active roster.`);
            continue;
          }
          if (action.intent === "update_problem_status") {
            const target =
              (action.patientQuery && findPatientByQuery(patients, action.patientQuery)) ||
              (selectedPatientId ? patients.find((p) => p.id === selectedPatientId) ?? null : null);
            console.log("[VITAL COMMAND] status target:", target?.name ?? "none");
            if (!target) {
              outputs.push("Please confirm the patient for the problem update.");
              continue;
            }
            const problems = editableProblems[target.id] ?? [];
            if (action.allProblems) {
              setEditableProblems((prev) => ({
                ...prev,
                [target.id]: (prev[target.id] ?? []).map((p) => ({ ...p, status: "Resolved" })),
              }));
              void openRequestedView(target, ["diagnoses"]);
              outputs.push(`All active problems for ${target.name} are now marked resolved.`);
              continue;
            }
            const query = action.problemName ?? command;
            const match = problems.find(
              (p) =>
                normalizeProblemKey(query).includes(normalizeProblemKey(p.name)) ||
                normalizeProblemKey(p.name).includes(normalizeProblemKey(query))
            );
            console.log("[VITAL COMMAND] status problem:", match?.name ?? "none");
            if (!match) {
              outputs.push("Please confirm which problem should be updated.");
              continue;
            }
            updateProblemStatus(target.id, match.name, action.status);
            void openRequestedView(target, ["diagnoses"]);
            outputs.push(
              `Updated. ${match.name} is now marked ${action.status.toLowerCase()} for ${target.name}.`
            );
            continue;
          }
          if (action.intent === "show_section") {
            const target =
              (action.patientQuery && findPatientByQuery(patients, action.patientQuery)) ||
              (selectedPatientId ? patients.find((p) => p.id === selectedPatientId) ?? null : null);
            if (!target) {
              outputs.push("Please confirm which patient chart to open.");
              continue;
            }
            await openRequestedView(target, action.sections);
            outputs.push(`Requested chart data displayed for ${target.name}.`);
            continue;
          }
          if (action.intent === "medication_order") {
            const target =
              (action.patientQuery && findPatientByQuery(patients, action.patientQuery)) ||
              (selectedPatientId ? patients.find((p) => p.id === selectedPatientId) ?? null : null);
            if (!target || !action.medication) {
              outputs.push("Please confirm the medication and patient.");
              continue;
            }
            const medication = action.medication;
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
                isClosing: false,
                createdAt: Date.now(),
              },
              ...prev,
            ].slice(0, 12));
            outputs.push(
              `Order queued. Pharmacy notified. A nurse will deliver ${medication} to ${target.name} in ${target.room}.`
            );
            continue;
          }
          if (action.intent === "allergy_search" || action.intent === "list_patients") {
            const matches = runPatientSearch({
              sex: action.sex,
              pediatric: action.pediatric,
              allergies: action.intent === "allergy_search" ? action.allergies : undefined,
            });
            setSearchResults(matches);
            setSearchResultsTitle(
              action.intent === "allergy_search"
                ? `Filtered allergy results (${matches.length})`
                : `Patient list results (${matches.length})`
            );
            outputs.push(
              matches.length === 0
                ? "No matching patients found."
                : `${matches.length} matching patient${matches.length > 1 ? "s" : ""} found.`
            );
            continue;
          }
        }
        const responseText = outputs.join(" ");
        if (responseText.trim()) {
          console.log("[VITAL COMMAND] response text:", responseText);
          pushLocalAssistantResponse(command, responseText);
          return true;
        }
      }

      if (isResetCommand(lower) || /logout/.test(lower)) {
        console.log("[VITAL COMMAND] intent: clear_session");
        resetSession();
        pushLocalAssistantResponse(command, "Session ended. Panels cleared.");
        return true;
      }

      // 1) Discharge / restore commands (highest priority)
      const restoreIntent = /restore|bring .* back|reopen .*chart/.test(lower);
      if (restoreIntent) {
        console.log("[VITAL COMMAND] intent: restore");
        const matches = findPatientMatches(command, patients);
        const target = matches[0] ?? null;
        console.log("[VITAL COMMAND] detected patient:", target?.name ?? "none");
        if (!target || !dischargedPatientIds.includes(target.id)) {
          pushLocalAssistantResponse(command, "Please confirm which discharged patient to restore.");
          return true;
        }
        restorePatient(target);
        setOrderNotice(`${target.name} restored to active roster.`);
        pushLocalAssistantResponse(
          command,
          `${target.name} has been restored to the active roster.`
        );
        return true;
      }

      const dischargeIntent =
        /prepare .*discharge|ready for discharge|discharge|clear .*active roster|remove .*active patients/.test(
          lower
        );
      if (dischargeIntent) {
        console.log("[VITAL COMMAND] intent: discharge");
        const matches = findPatientMatches(command, patients);
        const active =
          (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
        const target = matches[0] ?? active;
        console.log("[VITAL COMMAND] detected patient:", target?.name ?? "none");
        if (!target) {
          pushLocalAssistantResponse(command, "Please confirm which patient should be ready for discharge.");
          return true;
        }
        dischargePatient(target);
        setOrderNotice(`${target.name} discharged from active roster.`);
        pushLocalAssistantResponse(
          command,
          `Discharge workflow started. ${target.name} has been removed from the active roster for this session.`
        );
        return true;
      }

      // 2) Problem status update commands
      const statusIntent =
        /make|mark|change status|resolve|resolved|monitoring|ruled out|pending|active/i.test(
          command
        ) && /diagnos|problem|status|hypertension|condition|fixed/i.test(command);
      if (statusIntent) {
        console.log("[VITAL COMMAND] intent: update_problem_status");
        const status = detectStatusValue(command);
        const matches = findPatientMatches(command, patients);
        const active =
          (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
        const target = matches[0] ?? active;
        console.log("[VITAL COMMAND] detected patient:", target?.name ?? "none");
        if (!target || !status) {
          pushLocalAssistantResponse(
            command,
            "Please confirm the problem, status, and patient."
          );
          return true;
        }
        const explicitProblem = command.match(
          /(?:for|status for|mark|make|resolve)\s+(.+?)\s+(?:as|to)\s+(?:active|resolved|monitoring|pending|ruled out)/i
        )?.[1];
        const existingProblems = editableProblems[target.id] ?? [];
        const problem = explicitProblem
          ? existingProblems.find((d) =>
              normalizeProblemKey(d.name).includes(normalizeProblemKey(explicitProblem))
            )
          : existingProblems.find(
              (d) =>
                normalizeProblemKey(command).includes(normalizeProblemKey(d.name)) ||
                normalizeProblemKey(d.name).includes("hypertension")
            );
        if (!problem) {
          pushLocalAssistantResponse(command, "Please confirm which problem should be updated.");
          return true;
        }
        console.log("[VITAL COMMAND] detected problem:", problem.name, "=>", status);
        updateProblemStatus(target.id, problem.name, status);
        if (selectedPatientId !== target.id) {
          setSelectedPatientId(target.id);
        }
        void openRequestedView(target, ["diagnoses"]);
        pushLocalAssistantResponse(
          command,
          `Updated. ${problem.name} is now marked ${status.toLowerCase()} for ${target.name}.`
        );
        return true;
      }

      // 3) Section chart requests
      const action = parseVoiceCommand(command, patients, selectedPatientId);
      if (action.kind === "none") {
        // 4) Medication workflow commands
        const orderIntent = /prescribe|give|order|send medication|send .*med/i.test(lower);
        if (orderIntent) {
          console.log("[VITAL COMMAND] intent: medication_workflow");
          const medication = detectOrderMedication(command);
          const matches = findPatientMatches(command, patients);
          const active =
            (selectedPatientId && patients.find((p) => p.id === selectedPatientId)) || null;
          const target = matches[0] ?? active;
          console.log("[VITAL COMMAND] detected patient:", target?.name ?? "none");
          console.log("[VITAL COMMAND] detected medication:", medication ?? "none");
          if (!target || !medication) {
            pushLocalAssistantResponse(command, "Please confirm the medication and patient.");
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
              isClosing: false,
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
      }
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
      const patient = patients.find((p) => p.id === action.patientId);
      if (!patient) {
        setError("Patient not found.");
        return true;
      }
      await openRequestedView(patient, action.sections);
      const spoken = lower.includes("vital")
        ? `Vitals displayed for ${patient.name}.`
        : lower.includes("allerg")
          ? `Allergies displayed for ${patient.name}.`
        : lower.includes("med")
            ? `Medications displayed for ${patient.name}.`
            : `Chart data displayed for ${patient.name}.`;
      pushLocalAssistantResponse(command, spoken);
      return true;
    },
    [
      patients,
      dischargedPatientIds,
      selectedPatientId,
      resetSession,
      activeRequestedSections,
      openRequestedView,
      pushLocalAssistantResponse,
      editableProblems,
      updateProblemStatus,
      dischargePatient,
      restorePatient,
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
      const handled = await handleClinicalCommand(transcript);
      if (handled) {
        setSystemState("idle");
        return;
      }

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
            activePatientId: selectedPatientId,
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
          speakResponseRef.current(ok.text);
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
    ]
  );

  submitRef.current = submit;

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

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      const preferred =
        assistantVoice === "Clinical Voice B"
          ? voices.find((v) => /Aria|Jenny|Google UK/i.test(v.name))
          : assistantVoice === "Clinical Voice C"
            ? voices.find((v) => /Guy|Mark|David|Microsoft/i.test(v.name))
            : voices.find((v) => /Google US English|Zira|Natural/i.test(v.name));
      if (preferred) return preferred;
      return (
        voices.find((v) => /Google US English/i.test(v.name)) ||
        voices.find(
          (v) =>
            /Microsoft|Google|Natural|Aria|Jenny|Guy|Zira|Mark/i.test(v.name) &&
            /en(-US)?/i.test(v.lang)
        ) ||
        voices.find((v) => v.lang === "en-US") ||
        voices.find((v) => v.default && /^en/i.test(v.lang)) ||
        voices.find((v) => /^en/i.test(v.lang))
      );
    };

    const play = () => {
      const u = new SpeechSynthesisUtterance(line);
      u.lang = "en-US";
      u.rate = Math.max(0.75, Math.min(1.35, speechRateSetting / 100));
      u.pitch = 1.03;
      u.volume = 1;
      const voice = pickVoice();
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
  }, [assistantVoice, speechRateSetting]);

  React.useEffect(() => {
    speakRef.current = speak;
  }, [speak]);

  const speakResponse = React.useCallback(
    (text: string) => {
      const line = text.trim();
      if (!line) return;
      if (!supportsTts) {
        setOrderNotice("Voice output unavailable in this browser.");
        return;
      }
      const allowSpeech = !muteAssistant || voiceSessionLive;
      if (!allowSpeech || !voiceEnabled) return;
      try {
        speakRef.current(line);
      } catch (err) {
        console.error("VITAL OS TTS failed:", err);
      }
    },
    [supportsTts, muteAssistant, voiceSessionLive, voiceEnabled]
  );

  React.useEffect(() => {
    speakResponseRef.current = speakResponse;
  }, [speakResponse]);

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
  }, [disposeRecognition, resetSession]);

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
  const activePatients = React.useMemo(
    () => patients.filter((p) => !dischargedPatientIds.includes(p.id)),
    [patients, dischargedPatientIds]
  );
  const dischargedList = React.useMemo(
    () => Object.values(dischargedPatients).sort((a, b) => b.dischargedAt - a.dischargedAt),
    [dischargedPatients]
  );
  const activePatient = activePatients.find((p) => p.id === selectedPatientId) ?? null;
  const activeVitals = activePatient ? Object.entries(activePatient.vitals) : [];
  const activeMeds = activePatient?.medications ?? [];
  const activeAllergies = activePatient?.allergies ?? [];
  const activeProblems = activePatient?.diagnoses ?? [];
  const activeProblemRows = React.useMemo(
    () => (activePatient ? editableProblems[activePatient.id] ?? [] : []),
    [activePatient, editableProblems]
  );
  const activeProblemCount = React.useMemo(
    () => activeProblemRows.filter((item) => item.status === "Active").length,
    [activeProblemRows]
  );
  const highAcuityPatients = React.useMemo(
    () => getHighAcuityPatients(activePatients),
    [activePatients]
  );
  const patientsWithAllergies = React.useMemo(
    () => getPatientsWithAllergies(activePatients),
    [activePatients]
  );
  const pendingLabsPatients = React.useMemo(
    () => getPendingLabs(activePatients),
    [activePatients]
  );
  const imagingOrderedPatients = React.useMemo(
    () => getImagingOrdered(activePatients),
    [activePatients]
  );
  const consultRequestedPatients = React.useMemo(
    () => getConsultRequested(activePatients),
    [activePatients]
  );
  const pediatricPatients = React.useMemo(
    () => activePatients.filter((p) => isPediatric(p)),
    [activePatients]
  );
  const acuityDistribution = React.useMemo(
    () => getAcuityDistribution(activePatients),
    [activePatients]
  );
  const ageDistribution = React.useMemo(
    () => getAgeDistribution(activePatients),
    [activePatients]
  );
  const unitDistribution = React.useMemo(
    () => getUnitDistribution(activePatients),
    [activePatients]
  );
  const topConcernCategories = React.useMemo(
    () => getTopConcernCategories(activePatients),
    [activePatients]
  );
  const riskDistribution = React.useMemo(
    () => getRiskCategoryDistribution(activePatients),
    [activePatients]
  );
  const medicationsCount = React.useMemo(
    () => activePatients.reduce((sum, p) => sum + p.medications.length, 0),
    [activePatients]
  );
  const roomOccupancy = React.useMemo(
    () =>
      [...activePatients]
        .sort((a, b) => a.room.localeCompare(b.room))
        .map((p) => ({ room: p.room, patient: p.name, acuity: p.triageAcuity }))
        .slice(0, 10),
    [activePatients]
  );
  const encounterRows = React.useMemo(
    () =>
      activePatients.map((p, idx) => {
        const status = deriveEncounterStatus(p);
        const ts = new Date();
        ts.setMinutes(ts.getMinutes() - idx * 9);
        return {
          patient: p,
          status,
          updatedLabel: ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
      }),
    [activePatients]
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
      { label: "08:00", value: Math.max(2, Math.round(activePatients.length * 0.45)) },
      { label: "10:00", value: Math.max(2, Math.round(activePatients.length * 0.62)) },
      { label: "12:00", value: Math.max(2, Math.round(activePatients.length * 0.76)) },
      { label: "14:00", value: Math.max(2, Math.round(activePatients.length * 0.84)) },
      { label: "16:00", value: Math.max(2, Math.round(activePatients.length * 0.92)) },
      { label: "18:00", value: activePatients.length },
    ],
    [activePatients.length]
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
      activePatients.slice(0, 8).map((p, idx) => {
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
    [activePatients]
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
  const filteredPatients = activePatients.filter((p) => {
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
    <main
      className={cn(
        "min-h-screen text-slate-900 transition-colors duration-300",
        resolvedTheme === "dark" ? "bg-slate-950 text-slate-100" : "bg-[#f7fbff]",
        resolvedTheme === "dark" &&
          "[&_.bg-white]:bg-slate-900 [&_.bg-slate-50]:bg-slate-800/60 [&_.text-slate-900]:text-slate-100 [&_.text-slate-700]:text-slate-200 [&_.text-slate-600]:text-slate-300 [&_.border-\\[\\#e3edf9\\]]:border-slate-700 [&_.border-slate-200]:border-slate-700 [&_.shadow-sm]:shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)]",
        reducedMotionMode && "[&_*]:!transition-none [&_*]:!animate-none",
        highContrastMode && "[&_*]:!border-opacity-100 [&_.text-slate-500]:!text-slate-300",
        largerTouchTargets && "[&_button]:min-h-[42px] [&_button]:px-3",
        compactDashboardMode && "[&_.p-4]:p-3 [&_.mt-3]:mt-2"
      )}
      style={{ fontSize: `${textScalePercent}%` }}
    >
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
              { key: "dashboard" as ActivePage, label: "Dashboard", icon: Home },
              { key: "patients" as ActivePage, label: "Patients", icon: Users },
              { key: "encounters" as ActivePage, label: "Encounters", icon: NotebookTabs },
              { key: "reports" as ActivePage, label: "Reports", icon: FileBarChart2 },
              { key: "analytics" as ActivePage, label: "Analytics", icon: BarChart3 },
              { key: "settings" as ActivePage, label: "Settings", icon: Settings },
            ].map((item) => {
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
          <div className="mt-auto rounded-xl border border-white/10 bg-white/5 p-2 text-center text-[11px] text-blue-100/80">
            HIPAA Secure
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
                Session Active
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
                disabled={!supportsSpeech || systemState === "processing"}
                className={cn(
                  "flex h-14 w-14 items-center justify-center rounded-full border-2 transition-all",
                  voiceSessionLive && !micMuted
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-300 bg-white text-slate-700"
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
                <div className="mt-2 h-8 overflow-hidden rounded-xl border border-blue-100 bg-white px-2">
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
                <p className="mt-2 text-xs text-slate-500">
                  Last heard:{" "}
                  <span className="text-slate-700">
                    {interimTranscript.trim() ||
                      finalTranscript.trim() ||
                      lastSubmittedTranscript.trim() ||
                      "Listening for clinician command..."}
                  </span>
                </p>
                {typedCommandOpen && (
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
                  onClick={() => setTypedCommandOpen((v) => !v)}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 bg-white"
                  title="Toggle typed command"
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
                  onClick={() => setMuteAssistant((v) => !v)}
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
                <>
                <div className="rounded-xl border border-[#e3edf9] bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900">
                      Patient Roster ({filteredPatients.length} active)
                    </p>
                    <input
                      value={patientSearch}
                      onChange={(e) => setPatientSearch(e.target.value)}
                      placeholder="Search name, MRN, room..."
                      className="w-64 rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-blue-300"
                    />
                  </div>
                  <div className="rounded-xl border border-slate-200">
                    <div className="grid grid-cols-[1.3fr_1fr_0.8fr_1fr_1.3fr_0.8fr_0.8fr] border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                      <span>Patient</span>
                      <span>MRN</span>
                      <span>Age/Sex</span>
                      <span>Room</span>
                      <span>Chief Concern</span>
                      <span>Acuity</span>
                      <span>Status</span>
                    </div>
                  <div className="max-h-[420px] overflow-auto">
                    <AnimatePresence initial={false}>
                    {filteredPatients.map((p) => (
                      <motion.button
                        key={p.id}
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 12 }}
                        transition={{ duration: 0.28 }}
                        type="button"
                        onClick={() => {
                          setActivePage("dashboard");
                          void openRequestedView(p, fullChartSections);
                        }}
                        className={cn(
                          "grid w-full grid-cols-[1.3fr_1fr_0.8fr_1fr_1.3fr_0.8fr_0.8fr] gap-2 border-b border-slate-100 px-3 py-2.5 text-left text-sm hover:bg-slate-50",
                          selectedPatientId === p.id ? "bg-blue-50/60" : "bg-white"
                        )}
                      >
                        <span className="font-medium text-slate-900">
                          {p.name}
                          {(p.riskFlags || p.allergies.length > 0) && (
                            <span className="ml-1 text-xs text-rose-600">●</span>
                          )}
                        </span>
                        <span className="text-slate-600">{p.mrn}</span>
                        <span className="text-slate-600">
                          {p.age}
                          {p.sex}
                        </span>
                        <span>
                          <Badge variant="medications" className="px-2 py-0.5 text-[11px]">
                            {p.room}
                          </Badge>
                        </span>
                        <span className="truncate text-slate-600">{p.chiefConcern}</span>
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
                        <span className="text-xs text-slate-600">
                          {p.allergies.length ? "Allergy" : "Stable"}
                        </span>
                      </motion.button>
                    ))}
                    </AnimatePresence>
                  </div>
                  </div>
                </div>
                {dischargedList.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 shadow-sm"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-semibold text-slate-900">Discharged / Completed</p>
                      <Badge variant="notes">{dischargedList.length} completed</Badge>
                    </div>
                    <div className="space-y-2">
                      {dischargedList.slice(0, 6).map((item) => (
                        <div
                          key={item.patientId}
                          className="flex items-center justify-between rounded-lg border border-emerald-200 bg-white px-3 py-2"
                        >
                          <div>
                            <p className="text-sm font-medium text-slate-900">{item.patientName}</p>
                            <p className="text-xs text-slate-600">
                              {item.room} • {new Date(item.dischargedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge variant="notes">{item.status}</Badge>
                            <button
                              type="button"
                              onClick={() => {
                                const restored = patients.find((p) => p.id === item.patientId);
                                if (!restored) return;
                                restorePatient(restored);
                                setOrderNotice(`${restored.name} restored to active roster.`);
                                pushLocalAssistantResponse(
                                  `restore ${restored.name}`,
                                  `${restored.name} has been restored to the active roster.`
                                );
                              }}
                              className="rounded-full border border-emerald-300 bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 transition-colors hover:bg-emerald-200"
                            >
                              Restore to active roster
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
                </>
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
                          <p className="text-sm font-semibold text-slate-900">{patient.name}</p>
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
                      ["Daily triage volume", activePatients.length, "notes"],
                      ["High acuity cases", highAcuityPatients.length, "risk"],
                      ["Allergy-risk patients", patientsWithAllergies.length, "allergies"],
                      [
                        "Medication safety flags",
                        activePatients.filter((p) => (p.pharmacyNotes ?? "").length > 0).length,
                        "medications",
                      ],
                      ["Pending labs", pendingLabsPatients.length, "problems"],
                      ["Imaging ordered", imagingOrderedPatients.length, "medications"],
                      ["Consults requested", consultRequestedPatients.length, "risk"],
                      ["Pediatric cases", pediatricPatients.length, "notes"],
                      [
                        "Discharge candidates",
                        activePatients.filter((p) =>
                          /discharge|improved/i.test(p.edOrUrgentCourse ?? "")
                        ).length,
                        "notes",
                      ],
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
                        [
                          "ED Daily Summary",
                          "Snapshot of active encounters and room occupancy.",
                          activePatients.length,
                          "Ready",
                        ],
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
                      ["Total patients", activePatients.length],
                      ["Allergy patients", patientsWithAllergies.length],
                      [
                        "High-risk flags",
                        activePatients.filter((p) => (p.riskFlags ?? "").trim().length > 0)
                          .length,
                      ],
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
                                  className={cn(
                                    "h-2 rounded-full bg-gradient-to-r",
                                    resolvedTheme === "dark"
                                      ? "from-cyan-400 via-blue-400 to-indigo-400 shadow-[0_0_12px_rgba(34,211,238,0.45)]"
                                      : "from-blue-500 to-cyan-400"
                                  )}
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
                                className={cn(
                                  "w-full rounded-t-md bg-gradient-to-t",
                                  resolvedTheme === "dark"
                                    ? "from-cyan-400 via-blue-400 to-indigo-400 shadow-[0_0_12px_rgba(34,211,238,0.45)]"
                                    : "from-cyan-500 to-blue-500"
                                )}
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
                <div className="grid gap-3">
                  <div className="grid gap-3 xl:grid-cols-2">
                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                      <div className="mb-3 flex items-start gap-2">
                        <Palette className="mt-0.5 h-4 w-4 text-cyan-600" />
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Appearance</p>
                          <p className="text-xs text-slate-600">Theme and visual density controls.</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {[
                          { value: "light" as ThemeMode, label: "Light Mode", Icon: Sun },
                          { value: "dark" as ThemeMode, label: "Dark Mode", Icon: Moon },
                          { value: "system" as ThemeMode, label: "System", Icon: Monitor },
                        ].map(({ value, label, Icon: ActiveIcon }) => {
                          return (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setThemeMode(value)}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold transition-all",
                                themeMode === value
                                  ? "border-cyan-300 bg-cyan-100 text-cyan-900"
                                  : "border-slate-200 bg-white text-slate-600 hover:border-cyan-200"
                              )}
                            >
                              <ActiveIcon className="h-3.5 w-3.5" />
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          Current Theme Preview
                        </p>
                        <div
                          className={cn(
                            "rounded-md border px-3 py-2 transition-all",
                            resolvedTheme === "dark"
                              ? "border-cyan-300/40 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-cyan-100"
                              : "border-cyan-200 bg-gradient-to-r from-white via-cyan-50 to-blue-50 text-slate-800"
                          )}
                        >
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold">VITAL OS Clinical UI</span>
                            <span className="rounded-full border border-cyan-300/50 px-2 py-0.5 text-[10px]">
                              {resolvedTheme.toUpperCase()}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                      <div className="mb-3 flex items-start gap-2">
                        <Volume2 className="mt-0.5 h-4 w-4 text-cyan-600" />
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Voice & Audio</p>
                          <p className="text-xs text-slate-600">Speech output and microphone tuning.</p>
                        </div>
                      </div>
                      <div className="space-y-3 text-xs">
                        <label className="block">
                          <span className="mb-1 block text-slate-600">Microphone sensitivity: {micSensitivity}%</span>
                          <input type="range" min={0} max={100} value={micSensitivity} onChange={(e) => setMicSensitivity(Number(e.target.value))} className="w-full accent-cyan-600" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-slate-600">Speech speed: {speechRateSetting}%</span>
                          <input type="range" min={80} max={130} value={speechRateSetting} onChange={(e) => setSpeechRateSetting(Number(e.target.value))} className="w-full accent-cyan-600" />
                        </label>
                        <select
                          value={assistantVoice}
                          onChange={(e) => setAssistantVoice(e.target.value)}
                          className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                        >
                          <option>Clinical Voice A</option>
                          <option>Clinical Voice B</option>
                          <option>Clinical Voice C</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => setMuteAssistant((v) => !v)}
                          className={cn(
                            "rounded-full border px-3 py-1 font-semibold transition-colors",
                            muteAssistant
                              ? "border-rose-200 bg-rose-50 text-rose-700"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700"
                          )}
                        >
                          {muteAssistant ? "Assistant Muted" : "Assistant Voice Enabled"}
                        </button>
                        <p className="text-[11px] text-slate-500">
                          Status: {voiceSessionLive ? "Listening" : "Idle"} • {micMuted ? "Muted" : "Mic active"} • {voiceEnabled ? "Voice ON" : "Voice OFF"}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                      <div className="mb-3 flex items-start gap-2">
                        <SlidersHorizontal className="mt-0.5 h-4 w-4 text-cyan-600" />
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Clinical Workflow</p>
                          <p className="text-xs text-slate-600">Operational behavior and panel preferences.</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button type="button" onClick={() => setAutoOpenChartData((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", autoOpenChartData ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Auto-open chart data</button>
                        <button type="button" onClick={() => setAutoScrollToRequested((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", autoScrollToRequested ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Auto-scroll to data</button>
                        <button type="button" onClick={() => setMedicationWorkflowAnimations((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", medicationWorkflowAnimations ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Medication animations</button>
                        <button type="button" onClick={() => setDeliveryNotificationsEnabled((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", deliveryNotificationsEnabled ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Delivery notifications</button>
                        <button type="button" onClick={() => setCompactDashboardMode((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", compactDashboardMode ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Compact dashboard</button>
                        <button type="button" onClick={() => setPersistentPatientPanels((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", persistentPatientPanels ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Persistent panels</button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                      <div className="mb-3 flex items-start gap-2">
                        <BellRing className="mt-0.5 h-4 w-4 text-cyan-600" />
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Notifications</p>
                          <p className="text-xs text-slate-600">Alert and confirmation preferences.</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <button type="button" onClick={() => setDeliveryNotificationsEnabled((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", deliveryNotificationsEnabled ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Delivery toasts</button>
                        <button type="button" onClick={() => setHighRiskAlerts((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", highRiskAlerts ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>High-risk alerts</button>
                        <button type="button" onClick={() => setCriticalLabAlerts((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", criticalLabAlerts ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Critical lab alerts</button>
                        <button type="button" onClick={() => setVoiceConfirmationsEnabled((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", voiceConfirmationsEnabled ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Voice confirmations</button>
                        <button type="button" onClick={() => setSessionNotificationsEnabled((v) => !v)} className={cn("rounded-lg border px-2 py-1.5 col-span-2", sessionNotificationsEnabled ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Session notifications</button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#dce8f8] bg-white p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
                      <div className="mb-3 flex items-start gap-2">
                        <Accessibility className="mt-0.5 h-4 w-4 text-cyan-600" />
                        <div>
                          <p className="text-sm font-semibold text-slate-900">Accessibility</p>
                          <p className="text-xs text-slate-600">Readability and motion controls.</p>
                        </div>
                      </div>
                      <label className="block text-xs text-slate-600">
                        Text scaling: {textScalePercent}%
                        <input type="range" min={90} max={120} value={textScalePercent} onChange={(e) => setTextScalePercent(Number(e.target.value))} className="mt-1 w-full accent-cyan-600" />
                      </label>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                        <button type="button" onClick={() => setReducedMotionMode((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", reducedMotionMode ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Reduced motion</button>
                        <button type="button" onClick={() => setHighContrastMode((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", highContrastMode ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>High contrast</button>
                        <button type="button" onClick={() => setLargerTouchTargets((v) => !v)} className={cn("rounded-lg border px-2 py-1.5", largerTouchTargets ? "border-cyan-300 bg-cyan-50 text-cyan-900" : "border-slate-200")}>Large targets</button>
                      </div>
                    </div>

                    <div className="rounded-xl border border-[#dce8f8] bg-gradient-to-br from-[#0b2a55] to-[#0f4b78] p-4 text-white shadow-md transition-all hover:-translate-y-0.5 hover:shadow-lg">
                      <div className="mb-3 flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-cyan-200" />
                        <div>
                          <p className="text-sm font-semibold">About VITAL OS</p>
                          <p className="text-xs text-cyan-100">System status and demo environment.</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs text-cyan-50">
                        <p>Version: <span className="font-semibold">0.1.0-demo</span></p>
                        <p>Mode: <span className="font-semibold">Demo</span></p>
                        <p>AI Provider: <span className="font-semibold">Groq/Gemini</span></p>
                        <p>Voice: <span className="font-semibold">{supportsTts ? "Online" : "Unavailable"}</span></p>
                        <p>Simulation: <span className="font-semibold">Local state</span></p>
                        <p>Theme: <span className="font-semibold capitalize">{resolvedTheme}</span></p>
                      </div>
                      <p className="mt-3 rounded-lg border border-amber-200/50 bg-amber-300/10 px-2 py-1 text-[11px] text-amber-100">
                        Demo environment. Mock patient data only.
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={resetSettingsToDefaults}
                      className="rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-900"
                    >
                      Reset Settings to Default
                    </button>
                      <button
                        type="button"
                        onClick={handleClear}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                      >
                        Clear Session
                      </button>
                      <button
                        type="button"
                        onClick={() => void refreshPatients()}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs"
                      >
                        Reload Patient Store
                      </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
          {openPatientTabIds.length > 1 && (
            <div className="mb-3 rounded-xl border border-[#e3edf9] bg-[#f8fbff] px-3 py-2 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                {openPatientTabIds.map((id) => {
                  const p = patients.find((item) => item.id === id);
                  if (!p) return null;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setSelectedPatientId(id)}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs",
                        id === selectedPatientId
                          ? "border-blue-200 bg-white text-slate-900"
                          : "border-slate-200 bg-slate-50 text-slate-600"
                      )}
                    >
                      {p.name}
                      <span className="text-slate-400">{p.mrn}</span>
                      <span
                        className="rounded-full p-0.5 hover:bg-slate-200"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenPatientTabIds((prev) => prev.filter((tab) => tab !== id));
                          if (selectedPatientId === id) setSelectedPatientId(null);
                        }}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </button>
                  );
                })}
              </div>
              {openPatientTabIds.length > 3 && (
                <p className="mt-2 text-xs text-amber-700">
                  Multiple charts open - verify active patient before documenting.
                </p>
              )}
            </div>
          )}

          {activePatient && hasRequestedSections && (
            <div className="mb-3 rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-2 text-sm font-medium text-slate-700">
              Active Chart: {activePatient.name} • {activePatient.mrn} • Room {activePatient.room}
            </div>
          )}

          {activePatient && (
            <div className="mb-3 grid grid-cols-2 gap-2 rounded-xl border border-[#e3edf9] bg-white p-3 shadow-sm lg:grid-cols-7">
              <div>
                <p className="text-[11px] uppercase text-slate-500">Patient</p>
                <p className="text-sm font-semibold">{activePatient.name}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-500">MRN</p>
                <p className="text-sm font-semibold">{activePatient.mrn}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-500">Age/Sex</p>
                <p className="text-sm font-semibold">
                  {activePatient.age}
                  {activePatient.sex}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-500">DOB</p>
                <p className="text-sm font-semibold">{activePatient.dob}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-500">Blood</p>
                <p className="text-sm font-semibold">{activePatient.bloodType || "—"}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-500">Provider</p>
                <p className="text-sm font-semibold">{activePatient.pcp ?? "Unassigned"}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase text-slate-500">Last Visit</p>
                <p className="text-sm font-semibold">{activePatient.lastVisit}</p>
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
                <p className="text-sm font-semibold">Allergies</p>
                <Badge variant="allergies" className="text-xs">
                  {activeAllergies.length ? `${activeAllergies.length} total` : "None listed"}
                </Badge>
              </div>
              <div className="rounded-xl border border-slate-100">
                <div className="grid grid-cols-[1.5fr_1fr_1fr] border-b border-slate-100 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-500">
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
                      <span className="text-slate-600">{reactionPart || "Noted"}</span>
                      <span className="text-slate-600">{severity}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            )}

            {activePatient && showSection("medications") && (
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-blue-300 bg-blue-50/20 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Medications</p>
                <Badge variant="medications" className="text-xs">
                  {activeMeds.length ? `${activeMeds.length} active` : "None listed"}
                </Badge>
              </div>
              <div className="rounded-xl border border-slate-100">
                <div className="grid grid-cols-[1.6fr_1.2fr_1fr] border-b border-slate-100 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-500">
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
                    <span className="text-slate-600">{m.sig}</span>
                    <span className="text-slate-600">Active</span>
                  </div>
                ))}
              </div>
            </div>
            )}

            {activePatient && showSection("diagnoses") && (
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-amber-300 bg-amber-50/20 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Problems</p>
                <Badge variant="problems" className="text-xs">
                  {activeProblems.length ? `${activeProblemCount} active` : "None listed"}
                </Badge>
              </div>
              <div className="rounded-xl border border-slate-100">
                <div className="grid grid-cols-[2fr_1fr_1fr] border-b border-slate-100 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-500">
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
                      <span className="font-medium text-slate-800">{name}</span>
                      <Badge
                        variant={
                          status === "Resolved"
                            ? "notes"
                            : status === "Monitoring"
                              ? "problems"
                              : status === "Pending"
                                ? "allergies"
                                : status === "Ruled out"
                                  ? "outline"
                                  : "medications"
                        }
                        className="w-fit text-[10px] transition-all duration-300"
                      >
                        {status}
                      </Badge>
                      <span className="text-slate-600">{since}</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
            )}

            {activePatient && (showSection("vitals") || showSection("labs")) && (
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-teal-300 bg-teal-50/20 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Recent Notes / Vitals</p>
                <Badge variant="notes" className="text-xs">
                  {activeVitals.length ? "Live" : "None listed"}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-1 text-sm">
                {activeVitals.slice(0, 6).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <span className="mr-1 text-slate-500">{k}</span>
                    <span className="font-medium">{v}</span>
                  </div>
                ))}
                <div className="col-span-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
                  {activePatient?.chartNote || "No recent notes"}
                </div>
              </div>
            </div>
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
                      problems={editableProblems[requestedPatientView.patientId] ?? []}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          )}

          {pendingOrders.length > 0 && (
            <div className="mt-3 rounded-xl border border-cyan-200/60 bg-gradient-to-br from-[#0b2a55] via-[#10386c] to-[#0f4b78] p-3 text-white shadow-md">
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
                    animate={
                      order.isClosing
                        ? { opacity: 0, y: 12, scale: 0.985 }
                        : { opacity: 1, y: 0, scale: 1 }
                    }
                    transition={{ duration: order.isClosing ? 0.8 : 0.35, ease: "easeOut" }}
                className={cn(
                      "rounded-lg border border-cyan-200/35 bg-white/10 px-3 py-2 backdrop-blur-sm transition-all",
                      order.status !== "Delivered" && "animate-pulse",
                      order.status === "Delivered" &&
                        "border-emerald-300/70 bg-emerald-400/15 shadow-[0_0_24px_-8px_rgba(34,197,94,0.8)]"
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
            </div>
          )}

          {searchResultsTitle && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 rounded-xl border border-[#dce8f8] bg-white p-3 shadow-sm"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">{searchResultsTitle}</p>
                <Badge variant="medications">{searchResults.length}</Badge>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {searchResults.map((p) => (
                  <div key={`search-${p.id}`} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-sm font-medium text-slate-900">{p.name}</p>
                    <p className="text-xs text-slate-600">
                      {p.room} • {p.triageAcuity}
                    </p>
                    <p className="mt-1 line-clamp-1 text-xs text-slate-700">{p.chiefConcern}</p>
                    <p className="mt-1 line-clamp-1 text-[11px] text-slate-600">
                      Allergies: {p.allergies.join(", ") || "None listed"}
                    </p>
            </div>
                ))}
          </div>
            </motion.div>
          )}

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
            patients={activePatients}
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
            <ResponsePanel
              response={response}
              systemState={systemState}
              isBusy={isBusy}
              onReplay={onReplay}
              onStopSpeaking={onStopSpeaking}
              voiceEnabled={voiceEnabled}
              supportsTts={supportsTts}
            />
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
            <div className="mono text-[11px] font-medium text-foreground/95">
              {p.name}
            </div>
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
    { label: "BRAIN", value: "Groq · Llama", tone: "text-clinical-cyan" },
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

