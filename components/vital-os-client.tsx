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
  if (/(diagnos|problem list|condition|assessment)/.test(q))
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
  const [patientSearch, setPatientSearch] = React.useState("");
  const [typedCommandOpen, setTypedCommandOpen] = React.useState(false);
  const [typedCommand, setTypedCommand] = React.useState("");
  const [waveformBars, setWaveformBars] = React.useState<number[]>(
    Array.from({ length: 28 }, () => 4)
  );
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
  const systemStateRef = React.useRef<SystemState>("idle");
  const bargeInRef = React.useRef<() => void>(() => {});
  const lastBargeAtRef = React.useRef(0);
  const voiceHeroRef = React.useRef<VoiceHeroVisualHandle>(null);
  const speakRef = React.useRef<(text: string) => void>(() => {});

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

  const handleClinicalCommand = React.useCallback(
    async (commandText: string): Promise<boolean> => {
      const command = commandText.trim();
      if (!command) return false;
      setLastCommand(command);
      const action = parseVoiceCommand(command, patients, selectedPatientId);
      if (action.kind === "none") return false;
      if (action.kind === "clear_session") {
        resetSession();
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
      setSelectedPatientId(patient.id);
      setOpenPatientTabIds((prev) =>
        prev.includes(patient.id) ? prev : [...prev, patient.id].slice(-5)
      );
      setActiveRequestedSections(action.sections);
      setRequestedPatientView(buildRequestedPatientView(patient, action.sections));
      const lower = command.toLowerCase();
      const spoken = lower.includes("allerg")
        ? `${patient.name} has ${patient.allergies.length ? patient.allergies.join(", ") : "no listed allergies"}.`
        : lower.includes("med")
          ? `${patient.name} has ${patient.medications.length} active medications: ${patient.medications
              .slice(0, 3)
              .map((m) => m.name)
              .join(", ")}.`
          : lower.includes("age")
            ? `${patient.name} is ${patient.age} years old. Date of birth is ${patient.dob}.`
            : `${patient.name}, MRN ${patient.mrn}, room ${patient.room}.`;
      if (voiceEnabled && supportsTts) speakRef.current(spoken);
      return true;
    },
    [patients, selectedPatientId, resetSession, voiceEnabled, supportsTts]
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
      u.rate = 1.04;
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
    setSystemState("idle");
  }, [disposeRecognition, resetSession]);

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
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs">
                <VitalLogo
                  size={12}
                  variant="icon"
                  className={cn(systemState === "listening" ? "animate-pulse" : "")}
                />
                System Ready
              </span>
              <span className="rounded-full bg-white/10 px-3 py-1 text-xs">Session Active</span>
              {mode !== "general" && (
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs">
                  Care Mode: {MODE_LABEL[mode]}
                </span>
              )}
              <span className="ml-2 text-sm font-medium tabular-nums">{fmtTime(now)}</span>
            </div>
          </div>

          <div className="mb-3 flex items-center justify-end">
            {activePatient && (
              <button
                type="button"
                onClick={() => {
                  if (!activePatient) return;
                  setActiveRequestedSections(fullChartSections);
                  setRequestedPatientView(
                    buildRequestedPatientView(activePatient, fullChartSections)
                  );
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
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900">Patient Roster</p>
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
                    {filteredPatients.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setActivePage("dashboard");
                          setSelectedPatientId(p.id);
                          setOpenPatientTabIds((prev) =>
                            prev.includes(p.id) ? prev : [...prev, p.id].slice(-5)
                          );
                          setActiveRequestedSections(fullChartSections);
                          setRequestedPatientView(buildRequestedPatientView(p, fullChartSections));
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
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                            {p.room}
                          </span>
                        </span>
                        <span className="truncate text-slate-600">{p.chiefConcern}</span>
                        <span>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs",
                              /ctas\s*1/i.test(p.triageAcuity)
                                ? "bg-rose-100 text-rose-700"
                                : /ctas\s*2/i.test(p.triageAcuity)
                                  ? "bg-orange-100 text-orange-700"
                                  : /ctas\s*3/i.test(p.triageAcuity)
                                    ? "bg-amber-100 text-amber-700"
                                    : /ctas\s*4/i.test(p.triageAcuity)
                                      ? "bg-blue-100 text-blue-700"
                                      : "bg-emerald-100 text-emerald-700"
                            )}
                          >
                            {p.triageAcuity}
                          </span>
                        </span>
                        <span className="text-xs text-slate-600">
                          {p.allergies.length ? "Allergy" : "Stable"}
                        </span>
                      </button>
                    ))}
                  </div>
                  </div>
                </div>
              )}
              {activePage === "encounters" && (
                <div className="rounded-xl border border-[#e3edf9] bg-white p-4 shadow-sm">
                  <p className="text-sm font-semibold text-slate-900">Recent Encounters</p>
                  <p className="mt-2 text-sm text-slate-600">
                    {patients.length
                      ? `${patients.length} active mock encounters available via roster.`
                      : "No encounters available."}
                  </p>
                </div>
              )}
              {activePage === "reports" && (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    `Daily triage volume: ${patients.length}`,
                    `Open charts: ${openPatientTabIds.length}`,
                    `High acuity patients: ${patients.filter((p) => /ctas\\s*[12]/i.test(p.triageAcuity)).length}`,
                    "Pending follow-ups: 0",
                  ].map((item) => (
                    <div key={item} className="rounded-xl border border-[#e3edf9] bg-white p-4 text-sm text-slate-700 shadow-sm">
                      {item}
                    </div>
                  ))}
                </div>
              )}
              {activePage === "analytics" && (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="rounded-xl border border-[#e3edf9] bg-white p-4 shadow-sm">Total patients: {patients.length}</div>
                  <div className="rounded-xl border border-[#e3edf9] bg-white p-4 shadow-sm">
                    Patients with allergies: {patients.filter((p) => p.allergies.length > 0).length}
                  </div>
                  <div className="rounded-xl border border-[#e3edf9] bg-white p-4 shadow-sm">
                    High-risk flags: {patients.filter((p) => (p.riskFlags ?? "").trim().length > 0).length}
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
                    </div>
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
                <Badge variant="outline" className="text-xs">
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
                <Badge variant="outline" className="text-xs">
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
                <Badge variant="outline" className="text-xs">
                  {activeProblems.length ? `${activeProblems.length} active` : "None listed"}
                </Badge>
              </div>
              <div className="rounded-xl border border-slate-100">
                <div className="grid grid-cols-[2fr_1fr_1fr] border-b border-slate-100 bg-slate-50 px-2 py-1 text-[11px] font-medium text-slate-500">
                  <span>Problem</span>
                  <span>Status</span>
                  <span>Since</span>
                </div>
                {activeProblems.slice(0, 5).map((p, i) => (
                  <div
                    key={`prob-${i}`}
                    className="grid grid-cols-[2fr_1fr_1fr] border-b border-slate-100 px-2 py-1.5 text-sm last:border-b-0"
                  >
                    <span className="font-medium text-slate-800">{p}</span>
                    <span className="text-emerald-600">Active</span>
                    <span className="text-slate-600">Chart</span>
                  </div>
                ))}
              </div>
            </div>
            )}

            {activePatient && (showSection("vitals") || showSection("labs")) && (
            <div className="rounded-xl border border-[#e3edf9] border-l-4 border-l-teal-300 bg-teal-50/20 p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">Recent Notes / Vitals</p>
                <Badge variant="outline" className="text-xs">
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

          {requestedPatientView && (
            <div className="mt-3">
              <RequestedPatientCard view={requestedPatientView} />
            </div>
          )}

          <div className="mt-3 rounded-2xl border border-[#dce9fb] bg-white px-4 py-3 shadow-sm">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  voiceSessionLive ? endVoiceSession() : startVoiceSession()
                }
                disabled={!supportsSpeech || systemState === "processing"}
                className={cn(
                  "flex h-14 w-14 items-center justify-center rounded-full border-2 transition-all",
                  voiceSessionLive
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-300 bg-white text-slate-700"
                )}
                title={voiceSessionLive ? "Mic live - tap to mute" : "Mic muted - tap to listen"}
              >
                {voiceSessionLive ? <Mic className="h-6 w-6" /> : <MicOff className="h-6 w-6" />}
              </button>
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-700">
                  {systemState === "listening"
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
                        className={cn(
                          "w-1 rounded-full bg-blue-500/70 transition-all duration-100"
                        )}
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
            </>
          )}
        </section>

        <aside className="hidden border-l border-[#e3edf9] bg-[#f8fbff] p-4 lg:block">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Patient Details</p>
            <Badge variant="outline" className="text-[10px]">
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
                  setActiveRequestedSections((prev) =>
                    prev.includes(next) ? prev : [...prev, next]
                  );
                }}
                className={cn(
                  "w-full rounded-xl border border-[#e3edf9] border-l-4 bg-white p-3 text-left shadow-sm",
                  accent as string
                )}
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-900">{label}</p>
                  <div className="inline-flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">{value}</Badge>
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
    <span className="inline-flex max-w-[200px] flex-wrap items-center justify-end gap-1.5 text-[10px] font-medium text-white/65">
      <span className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5">
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
      <span className="rounded-full bg-white/5 px-2 py-0.5 text-white/50">
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

function RequestedPatientCard({ view }: { view: RequestedPatientView }) {
  const p = view.patient;
  const wantsOverview = view.fields.includes("overview");
  const show = (k: PatientFieldKey) => wantsOverview || view.fields.includes(k);
  const vitals = Object.entries(p.vitals);
  const meds = p.medications.slice(0, 6);

  return (
    <div className="mt-5 rounded-2xl border border-neutral-200 bg-white/90 p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
          Requested chart data
        </p>
        <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[10px] font-semibold text-[#F2F2EB]">
          {view.title}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5">
          <p className="text-[10px] uppercase text-neutral-500">Age/Sex</p>
          <p className="text-sm font-semibold text-neutral-900">
            {p.age}
            {p.sex}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5">
          <p className="text-[10px] uppercase text-neutral-500">MRN</p>
          <p className="text-sm font-semibold text-neutral-900">{p.mrn}</p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5">
          <p className="text-[10px] uppercase text-neutral-500">Problems</p>
          <p className="text-sm font-semibold text-neutral-900">
            {p.diagnoses.length}
          </p>
        </div>
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5">
          <p className="text-[10px] uppercase text-neutral-500">Meds</p>
          <p className="text-sm font-semibold text-neutral-900">
            {p.medications.length}
          </p>
        </div>
      </div>

      {show("vitals") && vitals.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
            Vitals
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {vitals.map(([k, v]) => (
              <div
                key={`${view.patientId}-v-${k}`}
                className="rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-2"
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
                className="rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-sm text-neutral-700"
              >
                {m.name} - {m.sig}
              </p>
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

