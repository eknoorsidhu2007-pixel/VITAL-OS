import { NextResponse } from "next/server";
import { ACCESS_RESTRICTED_MESSAGE, type VitalRole } from "@/lib/auth";
import { listPatients } from "@/lib/patient-store";
import {
  runVital,
  type ConversationTurn,
  type VitalMode,
} from "@/lib/vital-llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MODES: VitalMode[] = ["general", "soap", "summary", "emergency"];

interface VitalRequestBody {
  transcript?: unknown;
  mode?: unknown;
  patientContext?: unknown;
  conversationHistory?: unknown;
  activePatientId?: unknown;
  role?: unknown;
}

function parseHistory(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ConversationTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    out.push({ role, content: content.trim() });
  }
  return out;
}

function parseRole(raw: unknown): VitalRole | null {
  return raw === "doctor" || raw === "staff" ? raw : null;
}

export async function POST(req: Request) {
  let body: VitalRequestBody;
  try {
    body = (await req.json()) as VitalRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (!transcript) {
    return NextResponse.json(
      { error: "Missing 'transcript' string in request body." },
      { status: 400 }
    );
  }

  const requestedMode =
    typeof body.mode === "string" ? (body.mode as VitalMode) : "general";
  const mode: VitalMode = ALLOWED_MODES.includes(requestedMode)
    ? requestedMode
    : "general";

  const patientContext =
    typeof body.patientContext === "string" ? body.patientContext : undefined;

  const conversationHistory = parseHistory(body.conversationHistory);

  const activePatientId =
    typeof body.activePatientId === "string" && body.activePatientId.trim()
      ? body.activePatientId.trim()
      : null;

  const role = parseRole(body.role);
  if (role !== "doctor") {
    return NextResponse.json(
      {
        text: ACCESS_RESTRICTED_MESSAGE,
        mode,
        model: "access-control",
        latencyMs: 0,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!process.env.GEMINI_API_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "GEMINI_API_KEY is not set on the server. Add it to .env.local and restart the dev server.",
        code: "MISSING_API_KEY",
      },
      { status: 503 }
    );
  }

  try {
    const result = await runVital({
      transcript,
      mode,
      patientContext,
      conversationHistory,
      activePatientId,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Unknown error while contacting the language model.";
    const code = (err as { code?: string }).code;
    const status = code === "MISSING_API_KEY" ? 503 : 502;
    return NextResponse.json({ error: message, code }, { status });
  }
}

export async function GET() {
  let rosterCount = 0;
  try {
    rosterCount = (await listPatients()).length;
  } catch {
    rosterCount = 0;
  }

  return NextResponse.json(
    {
      service: "VITAL OS",
      status: "online",
      provider: "gemini",
      hasApiKey: Boolean(process.env.GEMINI_API_KEY?.trim()),
      models: ["gemini-1.5-flash"],
      rosterPatients: rosterCount,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
