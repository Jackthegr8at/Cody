import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { createPreset, listPresets, presetRoleNames, PresetValidationError } from "@/lib/model-presets/store";
import type { ModelPresetsResponse } from "@/lib/model-presets/types";
import { readModelRoles } from "@/lib/omp/model-roles";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

/** Presets are omp role overlays: nothing about them means anything on
 *  another engine, so the surface refuses there like the other role routes. */
const SURFACE = "Model presets";

function baseRoles(): Record<string, string> {
  try {
    return readModelRoles().roles;
  } catch {
    // A config.yml the user is mid-edit must not hide their presets.
    return {};
  }
}

export async function GET() {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const { presets, lastUsedPresetId } = listPresets();
  const body: ModelPresetsResponse = { presets, lastUsedPresetId, roleNames: presetRoleNames(), baseRoles: baseRoles() };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;
  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400, "invalid_json");
  }
  if (!isRecord(body)) return jsonError("Body must be an object", 400, "invalid_preset");
  try {
    const preset = createPreset({ name: body.name, intent: body.intent, copyFrom: body.copyFrom });
    return NextResponse.json({ preset }, { status: 201 });
  } catch (error) {
    if (error instanceof PresetValidationError) return jsonError(error.message, error.code === "not_found" ? 404 : 400, error.code);
    return jsonError(error instanceof Error ? error.message : String(error), 500);
  }
}
