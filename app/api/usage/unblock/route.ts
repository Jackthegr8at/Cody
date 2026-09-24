import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { getHarness } from "@/lib/harness";
import { liftCredentialBlock, planUnblock, type UnblockResult } from "@/lib/harness/omp-unblock";
import { restartIdleRpcSessions } from "@/lib/rpc-manager";
import { reconcileRoutingForRequest } from "@/lib/routing/request";
import { clearBlackout } from "@/lib/routing/route-memory";
import { getUsageSnapshot, markStale } from "@/lib/usage/cache";
import { usageReaderInstalled } from "@/lib/usage/omp-usage";

/**
 * POST /api/usage/unblock {provider, accountId} — "Retry now" for an account
 * omp blocked after ONE rejected request.
 *
 * A block (`source: "block"` in the usage snapshot) is omp's own deadline,
 * written when a provider answered with a limit, and it can outlive the
 * condition: an Anthropic account reporting 4% used was blocked for five
 * hours after a single 429. Lifting it is cheap and self-correcting (a
 * provider that is still limiting writes it straight back), so it is offered;
 * a MEASURED exhaustion is authoritative and is refused as `measured`.
 *
 * After a lift: Cody's remembered blackout for the account goes, the usage
 * cache is re-read, routing is reconciled (so filtered fallback chains get
 * the provider back), and idle omp children are restarted. That last step
 * is required, not tidy-up: a running omp keeps its own in-memory copy of
 * the block (AuthStorage's backoff map, which it consults beside the
 * persisted row and never re-reads), so only a fresh child forgets it.
 *
 * Answers `{outcome: "lifted"|"not_blocked"|"measured"|"error", message}`,
 * always 200 for a well-formed request: the outcome is the answer.
 */
export const dynamic = "force-dynamic";

function reply(result: UnblockResult) {
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "A JSON body with provider and accountId is required." }, { status: 400 });
  }
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const accountId = typeof record.accountId === "string" ? record.accountId.trim() : "";
  if (!provider || !accountId) return NextResponse.json({ error: "provider and accountId are required." }, { status: 400 });

  // Blocks belong to the accounts, like the quota they stand in for, so any
  // engine may lift one; omp only has to be installed to own the store.
  if (!usageReaderInstalled()) return reply({ outcome: "error", code: "unsupported", message: "omp is not installed, so its rate-limit blocks cannot be changed." });

  const plan = planUnblock(await getUsageSnapshot(), provider, accountId);
  if (plan.kind === "done") return reply(plan.result);

  const result = await liftCredentialBlock(plan.credentialId);
  if (result.outcome === "lifted" || result.outcome === "not_blocked") {
    clearBlackout(provider, accountId);
    markStale();
    try {
      await reconcileRoutingForRequest(await getUsageSnapshot({ awaitFresh: true }));
    } catch {
      // Routing catches up on the next usage poll; the lift itself stands.
    }
    // Only omp children hold the in-memory copy; another engine has none.
    if (result.outcome === "lifted" && getHarness().id === "omp") await restartIdleRpcSessions().catch(() => undefined);
  }
  return reply(result);
}
