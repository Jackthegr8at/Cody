import { NextResponse } from "next/server";
import { jsonError } from "@/lib/auth/http";
import { canAccessSession } from "@/lib/auth/session-owners";
import { getRequestUser } from "@/lib/auth/guard";
import { requireEngine } from "@/lib/engine-guard";
import {
  isSessionLocalOnly,
  localRoutingAllowedModels,
  readConfiguredLocalRoutingIntent,
  readLocalRoutingIntent,
  setSessionLocalOnly,
} from "@/lib/local-model-routing";
import { getRpcSession, restartSessionForRouting } from "@/lib/rpc-manager";
import { resolveSessionPathOr404 } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

const SURFACE = "Local-only routing";

async function assertSessionAccess(id: string, request: Request): Promise<NextResponse | null> {
  if (!canAccessSession(id, getRequestUser(request))) return jsonError("Session not found", 404, "session_not_found");
  // A live session may not have created its jsonl yet. A dormant one must
  // still resolve through the regular path/ownership guard before its sidecar
  // setting can be changed.
  if (!getRpcSession(id)?.isAlive()) {
    const resolved = await resolveSessionPathOr404(id, request);
    if ("response" in resolved) return resolved.response;
  }
  return null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  const access = await assertSessionAccess(id, request);
  if (access) return access;
  const intent = readLocalRoutingIntent(id);
  const availability = readConfiguredLocalRoutingIntent();
  return NextResponse.json({
    active: intent.enabled,
    supported: availability.enabled,
    models: localRoutingAllowedModels(id),
    ...(intent.error ? { error: intent.error } : availability.error ? { error: availability.error } : {}),
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const { id } = await params;
  const access = await assertSessionAccess(id, request);
  if (access) return access;

  try {
    const body = await request.json() as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return jsonError("enabled must be a boolean", 400, "invalid_local_routing");
    const wasEnabled = isSessionLocalOnly(id);
    const intent = setSessionLocalOnly(id, body.enabled);
    try {
      const restarted = await restartSessionForRouting(id);
      if (restarted.active && !restarted.restarted) {
        throw new Error("Finish the active turn before changing Local-only routing.");
      }
      const availability = readConfiguredLocalRoutingIntent();
      return NextResponse.json({ active: intent.enabled, supported: availability.enabled, models: localRoutingAllowedModels(id), restarted });
    } catch (error) {
      // A busy session must retain exactly its previous launch policy; deferring
      // an unnoticed mode change until some later reconnect would be deceptive.
      setSessionLocalOnly(id, wasEnabled);
      throw error;
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}
