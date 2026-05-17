/**
 * VITAL OS — LLM brain (Google Gemini).
 */

import {
  formatRosterForPrompt,
  patientToSnapshot,
  type DemoPatient,
} from "@/lib/demo-patients";
import {
  executePatientToolCall,
  listPatients,
  type PatientStoreEvent,
} from "@/lib/patient-store";

export type { PatientStoreEvent };

export const VITAL_OS_SYSTEM_PROMPT = `You are VITAL OS — a senior-clinician voice: confident, direct, and human. You work alongside doctors and advanced practice clinicians in real time. You are NOT a replacement for judgment, orders, or the chart; you sharpen thinking, surface risks, and save time.

Voice and presence:
- Sound like an experienced colleague who respects their time: clear, warm when appropriate, never stiff or corporate. You may open with a short orienting line when it helps ("Here's my read…", "I'd frame it this way…") — not every time, and never as filler.
- When the question is deep or ambiguous, think out loud briefly: what you'd weigh first, what would change your mind, what data you're missing — then land on a practical recommendation.
- Avoid robotic symmetry: not every answer needs the same headings. Use structure when it clarifies; use prose when it's a conversation.

Conversation (critical):
- CONVERSATION HISTORY is the thread — pronouns, prior plans, and "why / what else" live there.
- The latest user utterance is what you answer now. If they pivot topics, pivot with them.
- Do not paste your last reply again unless they explicitly ask to recap.
- Match depth to the ask: quick question → tight answer; "walk me through" or complex case → richer reasoning (still bounded below).

Roster tools (local JSON store on this machine):
- When the clinician asks to register, add, create, admit, log, update, delete, remove, list, search, or pull up a chart by name/MRN/id, call the appropriate tool BEFORE you answer, then summarize in plain language what changed (name, MRN, internal id).
- If intent is ambiguous, ask one short clarifying question instead of writing bad data.
- Never invent structured roster fields you were not given; use sensible clinical defaults only when the clinician clearly implied them.

Clinical depth:
- Tie reasoning to concrete chart facts when a roster patient is in play (meds, allergies, vitals, labs, imaging, social context). When data is missing in the record, say what you'd want next — labs, imaging, collateral, med reconciliation — without inventing results.
- Flag drug interactions, anticoagulation, pregnancy, AKI risk, infection red flags, and disposition concerns when relevant.

Output rules:
- Second person to the clinician.
- Plain text only — no Markdown bold/italic (no **, __, or single * / _ emphasis markers).
- Default cap ~320 words unless they request a long differential, full note, or exhaustive plan.
- End high-stakes or uncertain guidance with one "Safety:" line.
- For roster patients: never invent vitals, labs, imaging, or history — only use what the stored record contains.

Precision Q&A (critical):
- When asked how many patients are in the roster, on the board, or in the census: use the exact integer from the ROSTER SNAPSHOT header (N patients total). Do not guess or round.
- When asked for a specific fact (age, DOB, MRN, room, chief concern, acuity, a single vital, one allergy, etc.): lead with the verbatim value from ACTIVE PATIENT FULL RECORD or tool output in the first sentence, then add brief clinical context only if they asked for interpretation.
- Do not answer vague "chart displayed" or "I pulled the chart" — always include the concrete data they asked for when it exists in the record.`;

export type VitalMode = "general" | "soap" | "summary" | "emergency";

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export interface VitalRequestInput {
  transcript: string;
  mode?: VitalMode;
  patientContext?: string;
  /** Prior turns (same session). Excludes the current transcript. */
  conversationHistory?: ConversationTurn[];
  /** Roster patient id when a patient card is selected in the UI. */
  activePatientId?: string | null;
}

export interface VitalResponse {
  text: string;
  mode: VitalMode;
  model: string;
  latencyMs: number;
  /** True when a chart row was created, updated, or deleted via tools. */
  rosterChanged?: boolean;
  storeEvents?: PatientStoreEvent[];
}

const GEMINI_MODEL = "gemini-1.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_HISTORY_MESSAGES = 24;
const MAX_TOOL_ROUNDS = 8;

const GEMINI_FUNCTION_DECLARATIONS = [
  {
    name: "list_patients",
    description:
      "List all patients in the local roster (id, MRN, name, demographics, chief concern).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_patient",
    description:
      "Load one patient's full chart text by internal patient_id or MRN.",
    parameters: {
      type: "object",
      properties: {
        patient_id: {
          type: "string",
          description: "Internal id from roster, e.g. pt-jane-doe-abc123",
        },
        mrn: { type: "string", description: "Medical record number if known" },
      },
    },
  },
  {
    name: "create_patient",
    description:
      "Create a new chart row. Requires at least a name; other fields optional.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        mrn: { type: "string" },
        age: { type: "number" },
        sex: { type: "string" },
        chief_concern: { type: "string" },
        allergies: { type: "array", items: { type: "string" } },
        diagnoses: { type: "array", items: { type: "string" } },
        medications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              sig: { type: "string" },
            },
            required: ["name"],
          },
        },
        vitals: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        chart_note: { type: "string" },
        social: { type: "string" },
        recent_labs: { type: "string" },
        last_visit: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_patient",
    description:
      "Patch fields on an existing patient. patient_id is required; only include fields to change.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string" },
        name: { type: "string" },
        mrn: { type: "string" },
        age: { type: "number" },
        sex: { type: "string" },
        chief_concern: { type: "string" },
        allergies: { type: "array", items: { type: "string" } },
        diagnoses: { type: "array", items: { type: "string" } },
        medications: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              sig: { type: "string" },
            },
            required: ["name"],
          },
        },
        vitals: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        chart_note: { type: "string" },
        social: { type: "string" },
        recent_labs: { type: "string" },
        last_visit: { type: "string" },
      },
      required: ["patient_id"],
    },
  },
  {
    name: "delete_patient",
    description:
      "Remove a patient row from the local roster. Requires patient_id.",
    parameters: {
      type: "object",
      properties: {
        patient_id: { type: "string" },
      },
      required: ["patient_id"],
    },
  },
];

function buildFullSystemPrompt(
  roster: DemoPatient[],
  activePatientId?: string | null
): string {
  const count = roster.length;
  const block = `ROSTER SNAPSHOT (${count} patient${
    count === 1 ? "" : "s"
  } total — use this exact count when asked how many patients are in the roster):\n${formatRosterForPrompt(
    roster
  )}`;
  let focus = "";
  if (activePatientId) {
    const p = roster.find((x) => x.id === activePatientId);
    if (p) {
      focus = `\n\nCLINICIAN FOCUS: The active chart is ${p.name} (${p.mrn}, id ${p.id}). Use this record for follow-up questions unless they clearly ask about someone else or a general topic.\n\nACTIVE PATIENT FULL RECORD — answer factual questions from this block first; quote values exactly:\n${patientToSnapshot(
        p
      )}\n`;
    }
  }
  return `${VITAL_OS_SYSTEM_PROMPT}\n\n${block}${focus}`;
}

function buildModeInstruction(mode: VitalMode, patientContext?: string): string {
  const snap = patientContext?.trim()
    ? `\n\nPATIENT SNAPSHOT (clinician free text, may overlap roster):\n${patientContext.trim()}`
    : "";

  switch (mode) {
    case "soap":
      return `Task: Generate a concise SOAP note from the clinician's spoken input. Use these exact section headers on their own lines: SUBJECTIVE, OBJECTIVE, ASSESSMENT, PLAN. Under each header, use short dashed bullets. Mark missing data as "(not provided)". End with one "Safety:" line.${snap}`;
    case "summary":
      return `Task: Produce a focused patient snapshot summary based on the clinician's spoken input. Use these headers on their own lines: ACTIVE PROBLEMS, RELEVANT HISTORY, MEDICATIONS, RED FLAGS, SUGGESTED NEXT STEPS. Keep each section to short dashed bullets. End with one "Safety:" line.${snap}`;
    case "emergency":
      return `Task: EMERGENCY MODE. The clinician believes this may be time-critical. Respond with: 1) IMMEDIATE ACTIONS (numbered, in order), 2) DIFFERENTIALS TO RULE OUT (short list), 3) WHAT TO MONITOR. Be extremely concise. Assume the clinician is acting now. End with: "Safety: Verify dosing, allergies, and local protocols before acting."${snap}`;
    case "general":
    default:
      return `Task: General clinical dialogue. Use HISTORY + ROSTER context. Answer what they just asked with appropriate depth; offer next diagnostic or management steps when it adds value. Do not repeat your prior full answer unless they asked for a recap.${snap}`;
  }
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type AssistantPayload = {
  parts: GeminiPart[];
};

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  error?: { message?: string; code?: number; status?: string };
}

function toolArgsToString(args?: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  return JSON.stringify(args);
}

function toolResultToResponse(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return { result: content };
}

async function callGeminiCompletion(
  apiKey: string,
  systemPrompt: string,
  contents: GeminiContent[],
  opts?: {
    signal?: AbortSignal;
    temperature?: number;
    max_tokens?: number;
    tools?: boolean;
  }
): Promise<AssistantPayload> {
  const body: Record<string, unknown> = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents,
    generationConfig: {
      temperature: opts?.temperature ?? 0.55,
      maxOutputTokens: opts?.max_tokens ?? 1024,
    },
  };
  if (opts?.tools !== false) {
    body.tools = [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }];
  }

  const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts?.signal,
    cache: "no-store",
  });

  const json = (await res.json().catch(() => ({}))) as GeminiGenerateResponse;
  const errMsg =
    json.error?.message ||
    (!res.ok ? `Gemini request failed with HTTP ${res.status}.` : null);

  if (!res.ok) {
    const err = new Error(
      res.status === 429
        ? "Gemini rate limit reached. Wait a minute or check your quota in Google AI Studio."
        : errMsg || `Gemini error (${res.status}).`
    ) as Error & {
      status?: number;
      model?: string;
    };
    err.status = res.status;
    err.model = GEMINI_MODEL;
    throw err;
  }

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const hasTools = parts.some((part) => "functionCall" in part);
  const text = parts
    .map((part) => ("text" in part ? part.text : ""))
    .join("")
    .trim();
  if (!text && !hasTools) {
    throw new Error(
      "The model returned an empty response. Try rephrasing the command."
    );
  }

  return { parts };
}

function rosterChangedFromEvents(events: PatientStoreEvent[]): boolean {
  return events.some(
    (e) =>
      e.action === "created" ||
      e.action === "updated" ||
      e.action === "deleted"
  );
}

function textFromAssistantParts(parts: GeminiPart[]): string {
  return parts
    .map((part) => ("text" in part ? part.text : ""))
    .join("")
    .trim();
}

async function requestPlainTextSummary(
  apiKey: string,
  systemPrompt: string,
  contents: GeminiContent[],
  opts: {
    signal?: AbortSignal;
    temperature: number;
    max_tokens: number;
  }
): Promise<string> {
  const summary = await callGeminiCompletion(apiKey, systemPrompt, contents, {
    signal: opts.signal,
    temperature: opts.temperature,
    max_tokens: opts.max_tokens,
    tools: false,
  });
  const text = textFromAssistantParts(summary.parts);
  if (!text) {
    throw new Error(
      "The model returned an empty response. Try rephrasing the command."
    );
  }
  return text;
}

async function runCompletionWithTools(
  apiKey: string,
  systemPrompt: string,
  seedContents: GeminiContent[],
  opts: {
    signal?: AbortSignal;
    temperature: number;
    max_tokens: number;
  }
): Promise<{ text: string; storeEvents: PatientStoreEvent[] }> {
  const contents: GeminiContent[] = [...seedContents];
  const storeEvents: PatientStoreEvent[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const assistant = await callGeminiCompletion(apiKey, systemPrompt, contents, {
      signal: opts.signal,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
    });

    const functionCalls = assistant.parts.filter(
      (part): part is { functionCall: { name: string; args?: Record<string, unknown> } } =>
        "functionCall" in part
    );

    if (functionCalls.length) {
      contents.push({ role: "model", parts: assistant.parts });
      const responseParts: GeminiPart[] = [];
      for (const part of functionCalls) {
        const call = part.functionCall;
        const { content, events } = await executePatientToolCall(
          call.name,
          toolArgsToString(call.args)
        );
        for (const e of events) storeEvents.push(e);
        responseParts.push({
          functionResponse: {
            name: call.name,
            response: toolResultToResponse(content),
          },
        });
      }
      contents.push({ role: "user", parts: responseParts });
      continue;
    }

    const text = textFromAssistantParts(assistant.parts);
    if (!text) {
      return {
        text: await requestPlainTextSummary(
          apiKey,
          systemPrompt,
          contents,
          opts
        ),
        storeEvents,
      };
    }
    return { text, storeEvents };
  }

  return {
    text: await requestPlainTextSummary(apiKey, systemPrompt, contents, opts),
    storeEvents,
  };
}

export async function runVital(
  input: VitalRequestInput,
  opts?: { signal?: AbortSignal }
): Promise<VitalResponse> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    const err = new Error(
      "GEMINI_API_KEY is not set. Add it to .env.local and restart the dev server."
    ) as Error & { code?: string };
    err.code = "MISSING_API_KEY";
    throw err;
  }

  const transcript = input.transcript?.trim();
  if (!transcript) {
    throw new Error("Empty transcript. Speak a command and try again.");
  }

  const mode: VitalMode = input.mode ?? "general";
  const instruction = buildModeInstruction(mode, input.patientContext);
  const userMessage = `${instruction}\n\nLatest clinician utterance — answer this now (use prior turns only as context):\n"""${transcript}"""`;

  const temperature: number =
    mode === "general" ? 0.78 : mode === "emergency" ? 0.35 : 0.55;

  const max_tokens: number =
    mode === "general" ? 1280 : mode === "emergency" ? 900 : 1152;

  const roster = await listPatients();
  const systemPrompt = buildFullSystemPrompt(
    roster,
    input.activePatientId ?? null
  );

  const history: ConversationTurn[] = (input.conversationHistory ?? [])
    .filter(
      (t) =>
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string" &&
        t.content.trim().length > 0
    )
    .slice(-MAX_HISTORY_MESSAGES);

  const historyContents: GeminiContent[] = history.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content.trim() }],
  }));

  const seedContents: GeminiContent[] = [
    ...historyContents,
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const t0 = Date.now();

  const { text, storeEvents } = await runCompletionWithTools(
    apiKey,
    systemPrompt,
    seedContents,
    { signal: opts?.signal, temperature, max_tokens }
  );
  return {
    text: sanitize(text),
    mode,
    model: GEMINI_MODEL,
    latencyMs: Date.now() - t0,
    rosterChanged: rosterChangedFromEvents(storeEvents),
    storeEvents: storeEvents.length ? storeEvents : undefined,
  };
}

function sanitize(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\s)\*(\S[^*]*\S|\S)\*(?=\s|$)/g, "$1$2")
    .replace(/(^|\s)_(\S[^_]*\S|\S)_(?=\s|$)/g, "$1$2")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
