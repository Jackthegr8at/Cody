import { NextResponse } from "next/server";
import { jsonError, requireAdmin } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { fetchManagedKeys, updateKeyLimit } from "@/lib/openrouter/api";
import { invalidateOpenRouterAccount } from "@/lib/openrouter/account";
import { resolveOpenRouterManagementKey } from "@/lib/openrouter/key";
import { isRecord } from "@/lib/type-guards";

/**
 * The account's API keys, and the spend cap on each — the one genuinely useful
 * WRITE OpenRouter's API still offers, and the reason a management key is
 * worth adding at all.
 *
 * GET  → `{keys}` or `{keys: null, error}` when no management key is set.
 * PATCH {hash, limit} → set or clear one key's spend cap (`limit: null`
 *        removes it).
 *
 * Admin-only in both directions, unlike /api/openrouter/account: a management
 * key can mint and revoke credentials for the whole OpenRouter account, so
 * reading the roster is already privileged, and capping a key is a spend
 * decision. This mirrors the existing split — /api/providers is any signed-in
 * user, /api/providers/verify and /api/provider-keys are admin.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  const managementKey = resolveOpenRouterManagementKey();
  if (!managementKey) {
    // A missing management key is the expected state, not a failure: the UI
    // turns this into an offer to add one.
    return NextResponse.json(
      { keys: null, error: { code: "management_key_required", message: "No OpenRouter management key is configured." } },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await fetchManagedKeys(managementKey);
  if (!result.ok) {
    return NextResponse.json({ keys: null, error: result.error }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ keys: result.value, error: null }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  const managementKey = resolveOpenRouterManagementKey();
  if (!managementKey) return jsonError("No OpenRouter management key is configured.", 400, "management_key_required");

  let body: unknown;
  try {
    body = await parseJsonWithinLimit(request, 2_048);
  } catch {
    return jsonError("Invalid request body", 400);
  }
  if (!isRecord(body)) return jsonError("Expected a JSON object.", 400);

  const hash = typeof body.hash === "string" ? body.hash.trim() : "";
  if (!hash) return jsonError("A key hash is required.", 400);

  // `null` clears the cap; a number sets it. Anything else is rejected rather
  // than coerced — silently turning a typo into an unlimited key would be a
  // spend decision Cody made on the user's behalf.
  let limit: number | null;
  if (body.limit === null) {
    limit = null;
  } else if (typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit >= 0) {
    limit = body.limit;
  } else {
    return jsonError("limit must be a non-negative number, or null to remove the cap.", 400);
  }

  const result = await updateKeyLimit(managementKey, hash, limit);
  if (!result.ok) {
    const status = result.error.code === "management_key_required" ? 403 : 502;
    return jsonError(result.error.message, status, result.error.code);
  }
  // The cap changed what this key may spend, so the cached account snapshot's
  // `limit`/`limitRemaining` are now wrong.
  invalidateOpenRouterAccount();
  return NextResponse.json({ key: result.value }, { headers: { "Cache-Control": "no-store" } });
}
