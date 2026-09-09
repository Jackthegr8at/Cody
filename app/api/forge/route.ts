import { NextResponse } from "next/server";
import { jsonError, requireAdmin, requireUser } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import {
  DEFAULT_CODY_UPDATE_SOURCE,
  ForgeConfigError,
  listForgeHosts,
  readForgeConfig,
  removeForgeHost,
  resolveCodyUpdateSource,
  setCodyUpdateSource,
  setDefaultForgeHost,
  upsertForgeHost,
  type ForgeKind,
} from "@/lib/forge/config";
import { invalidateAppUpdateCache } from "@/lib/npm-update";

/**
 * Code hosts: which GitHub or Gitea servers this Cody knows, and which one
 * publishes Cody's own updates.
 *
 * GET answers the roster with the tokens redacted to "a token is saved, ending
 * in ….". Writes are admin-only for the same reason provider keys are: a host
 * applies to the whole instance — every session's `forge` tool, every skill
 * update check and the app update card spend the credential it holds.
 */

export const dynamic = "force-dynamic";

const MAX_TOKEN_LENGTH = 4_096;
/** Anything that would corrupt an HTTP header silently. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function answer() {
  const config = readForgeConfig();
  const { source, isDefault } = resolveCodyUpdateSource();
  return NextResponse.json(
    {
      hosts: listForgeHosts(),
      defaultHostId: config.defaultHostId ?? null,
      updateSource: { ...source, isDefault },
      defaultUpdateSource: DEFAULT_CODY_UPDATE_SOURCE,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;
  return answer();
}

interface WriteBody {
  host?: { id?: unknown; kind?: unknown; label?: unknown; baseUrl?: unknown; owner?: unknown; token?: unknown };
  defaultHostId?: unknown;
  /** `null` restores the built-in GitHub channel. */
  codyUpdateSource?: { hostId?: unknown; repo?: unknown; image?: unknown } | null;
}

export async function PUT(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: WriteBody;
  try {
    body = await parseJsonWithinLimit(request, 16_384);
  } catch {
    return jsonError("Invalid request body", 400);
  }

  try {
    if (body.host) {
      const kind: ForgeKind = body.host.kind === "gitea" ? "gitea" : "github";
      const token = typeof body.host.token === "string" ? body.host.token : undefined;
      if (token !== undefined) {
        if (token.length > MAX_TOKEN_LENGTH) return jsonError("Token is too long", 400);
        if (CONTROL_CHARACTERS.test(token)) return jsonError("Token contains control characters", 400);
      }
      upsertForgeHost({
        id: typeof body.host.id === "string" ? body.host.id : undefined,
        kind,
        label: typeof body.host.label === "string" ? body.host.label : "",
        baseUrl: typeof body.host.baseUrl === "string" ? body.host.baseUrl : "",
        owner: typeof body.host.owner === "string" ? body.host.owner : "",
        ...(token !== undefined ? { token } : {}),
      });
    }
    if (typeof body.defaultHostId === "string" && body.defaultHostId) {
      setDefaultForgeHost(body.defaultHostId);
    }
    if (body.codyUpdateSource !== undefined) {
      if (body.codyUpdateSource === null) setCodyUpdateSource(null);
      else {
        setCodyUpdateSource({
          hostId: typeof body.codyUpdateSource.hostId === "string" ? body.codyUpdateSource.hostId : "",
          repo: typeof body.codyUpdateSource.repo === "string" ? body.codyUpdateSource.repo : "",
          image: typeof body.codyUpdateSource.image === "string" ? body.codyUpdateSource.image : "",
        });
      }
      // The update check caches for an hour; a source that just changed must
      // not keep reporting the old channel's version.
      invalidateAppUpdateCache();
    }
  } catch (error) {
    if (error instanceof ForgeConfigError) return jsonError(error.message, 400, error.code);
    throw error;
  }
  return answer();
}

export function DELETE(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!id) return jsonError("A host id is required", 400, "host_id_required");
  try {
    if (!removeForgeHost(id)) return jsonError("Unknown code host", 404, "unknown_host");
  } catch (error) {
    if (error instanceof ForgeConfigError) return jsonError(error.message, 400, error.code);
    throw error;
  }
  invalidateAppUpdateCache();
  return answer();
}
