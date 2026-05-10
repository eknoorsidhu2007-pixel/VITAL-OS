import { NextResponse } from "next/server";

import {
  deletePatientById,
  getPatientById,
  updatePatientById,
} from "@/lib/patient-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = ctx.params;
  try {
    const patient = await getPatientById(decodeURIComponent(id));
    if (!patient) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(
      { patient },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to read patient.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = ctx.params;
  try {
    const patch = (await req.json().catch(() => ({}))) as unknown;
    const res = await updatePatientById(decodeURIComponent(id), patch);
    if (!res) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(
      { patient: res.patient },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to update patient.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = ctx.params;
  try {
    const res = await deletePatientById(decodeURIComponent(id));
    if (!res) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to delete patient.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
