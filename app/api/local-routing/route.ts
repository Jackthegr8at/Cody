import { NextResponse } from "next/server";
import { requireAdminOrOpenInstance } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import {
  configuredLocalRoutingModels,
  localRoutingRoleIds,
  readLocalRoutingConfig,
  readConfiguredLocalRoutingIntent,
  writeLocalRoutingConfig,
} from "@/lib/local-model-routing";

export const dynamic = "force-dynamic";

const SURFACE = "Local-only routing";

function responseBody() {
  const availability = configuredLocalRoutingModels();
  const roleIds = [...localRoutingRoleIds()];
  const intent = readConfiguredLocalRoutingIntent();
  const configured = intent.enabled;
  return {
    // `supported` means the composer can safely activate Local only now, not
    // merely that this OMP installation understands routing overlays.
    supported: configured,
    engineSupported: true,
    config: readLocalRoutingConfig(),
    models: availability.models,
    roleIds,
    roleAssignmentsScope: "future_local_sessions" as const,
    ...(configured ? {} : { error: intent.error ?? availability.error ?? "No configured usable local model is available; no cloud fallback will be used." }),
  };
}

export async function GET() {
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    return NextResponse.json(responseBody());
  } catch (error) {
    return NextResponse.json({ supported: false, engineSupported: true, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  const authorization = requireAdminOrOpenInstance(request);
  if (authorization) return authorization;
  try {
    const gate = requireEngine("omp", SURFACE);
    if ("response" in gate) return gate.response;
    const body = await request.json();
    const config = writeLocalRoutingConfig(body);
    const availability = configuredLocalRoutingModels();
    return NextResponse.json({
      success: true,
      supported: true,
      config,
      models: availability.models,
      roleIds: [...localRoutingRoleIds()],
      roleAssignmentsScope: "future_local_sessions" as const,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
