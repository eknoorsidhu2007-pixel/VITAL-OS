import { NextResponse } from "next/server";

import {
  createPatientFromPayload,
  listPatients,
} from "@/lib/patient-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const patients = await listPatients();
    return NextResponse.json(
      { patients },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to read roster.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as unknown;
    const { patient } = await createPatientFromPayload(body);
    return NextResponse.json(
      { patient },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to create patient.";
    const status = /required/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
