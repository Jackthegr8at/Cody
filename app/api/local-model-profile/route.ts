import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { requireEngine } from "@/lib/engine-guard";
import {
  resolveLocalModelPromptProfile,
  type ModelProfileTarget,
} from "@/lib/local-model-profile-runtime";
import {
  isPromptProfileOverrideValue,
  isValidModelKey,
  modelOverrideKey,
  readPromptProfileOverrides,
  writeGlobalPromptProfileOverride,
  writeModelPromptProfileOverride,
} from "@/lib/local-model-profile-store";
import { getLocalModelProfileApplication } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const SURFACE = "Local model prompt profiles";
const MAX_BODY_BYTES = 16 * 1024;

function targetFromParams(params: URLSearchParams): ModelProfileTarget | undefined {
  const provider = params.get("provider")?.trim();
  const modelId = params.get("modelId")?.trim();
  if (!provider && !modelId) return undefined;
  if (!provider || !modelId || !isValidModelKey(modelOverrideKey(provider, modelId))) return undefined;
  return { provider, modelId };
}

function answer(request: Request, target?: ModelProfileTarget): NextResponse {
  const overrides = readPromptProfileOverrides();
  if (!target) {
    return NextResponse.json(
      { overrides, canManage: requireAdminOrOpenInstance(request) === null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const resolved = resolveLocalModelPromptProfile(target);
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  const applied = sessionId ? getLocalModelProfileApplication(sessionId) : undefined;
  const appliedProfile = applied?.provider === target.provider && applied.modelId === target.modelId
    ? applied.profileId
    : null;
  return NextResponse.json(
    {
      overrides,
      canManage: requireAdminOrOpenInstance(request) === null,
      selection: {
        provider: target.provider,
        modelId: target.modelId,
        override: resolved.override,
        resolvedProfile: resolved.profile.id,
        toolNames: resolved.profile.toolNames ?? null,
        appliedProfile,
        appliesOnNextProviderCall: appliedProfile !== resolved.profile.id,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: Request) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;

  const params = new URL(request.url).searchParams;
  const target = targetFromParams(params);
  if ((params.has("provider") || params.has("modelId")) && !target) {
    return jsonError("provider and modelId must name one configured model", 400, "invalid_query");
  }
  return answer(request, target);
}

export async function PUT(request: Request) {
  const gate = requireEngine("omp", SURFACE);
  if ("response" in gate) return gate.response;

  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  if (!isRecord(body) || !isPromptProfileOverrideValue(body.value)) {
    return jsonError("value must be auto, full, compact, or minimal", 400, "invalid_body");
  }

  if (body.scope === "global") {
    writeGlobalPromptProfileOverride(body.value);
    return answer(request);
  }
  if (body.scope !== "model" || typeof body.provider !== "string" || typeof body.modelId !== "string") {
    return jsonError("scope must be global or model with provider and modelId", 400, "invalid_body");
  }
  const target = { provider: body.provider.trim(), modelId: body.modelId.trim() };
  if (!isValidModelKey(modelOverrideKey(target.provider, target.modelId))) {
    return jsonError("provider and modelId must name one configured model", 400, "invalid_body");
  }
  writeModelPromptProfileOverride(target.provider, target.modelId, body.value);
  return answer(request, target);
}
