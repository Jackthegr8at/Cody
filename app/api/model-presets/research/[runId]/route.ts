import { NextResponse } from "next/server";
import { requireAdminOrOpenInstance } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { cancelRun, getRun } from "@/lib/model-presets/research";

export const dynamic = "force-dynamic";

const SURFACE = "The researched-preset planner";

/** Clients poll this every ~2s while the named run is `"running"`. */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;

    const { runId } = await params;
    const run = getRun(runId);
    if (!run) return NextResponse.json({ error: "No research run with that id", code: "not_found" }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const denied = requireAdminOrOpenInstance(request);
    if (denied) return denied;

    const { runId } = await params;
    const run = cancelRun(runId);
    if (!run) {
      return NextResponse.json({ error: "No running research run with that id", code: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ run });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
