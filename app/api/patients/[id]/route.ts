import { NextResponse } from "next/server";

import {
  DOCTOR_ONLY_API_MESSAGE,
  isRestrictedClinicalPatch,
  parseRoleFromRequest,
} from "@/lib/auth";
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
    const role = parseRoleFromRequest(
      req,
      patch && typeof patch === "object"
        ? (patch as Record<string, unknown>).role
        : undefined
    );
    if (isRestrictedClinicalPatch(patch) && role !== "doctor") {
      return NextResponse.json(
        { error: DOCTOR_ONLY_API_MESSAGE },
        { status: 403 }
      );
    }
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

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = ctx.params;
  try {
    const role = parseRoleFromRequest(req);
    if (role !== "doctor") {
      return NextResponse.json(
        { error: DOCTOR_ONLY_API_MESSAGE },
        { status: 403 }
      );
    }
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
