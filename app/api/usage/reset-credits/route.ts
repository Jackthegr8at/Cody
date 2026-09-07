import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { getHarness } from "@/lib/harness";
import { getUsageSnapshot, markStale } from "@/lib/usage/cache";
import { isResetCreditIdempotencyKey, listResetCredits, redeemResetCredit, type ResetCreditOutcome, type ResetCreditsSnapshot } from "@/lib/harness/reset-credits";

export const dynamic = "force-dynamic";
const inFlight = new Set<string>();
const completed = new Map<string, { outcome: ResetCreditOutcome; expiresAt: number }>();
const COMPLETED_TTL_MS = 10 * 60_000;
function noStore(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function unavailable(reason: string, observerId: string): ResetCreditsSnapshot & { observerId: string } { return { available: false, accounts: [], fetchedAt: new Date().toISOString(), reason, observerId }; }
function pruneCompleted(now: number) { for (const [key, value] of completed) if (value.expiresAt <= now) completed.delete(key); }
function parseRedeem(value: unknown): { accountId: string; creditId: string; idempotencyKey: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  return body.confirmed === true && typeof body.accountId === "string" && body.accountId.trim() && typeof body.creditId === "string" && body.creditId.trim() && isResetCreditIdempotencyKey(body.idempotencyKey) ? { accountId: body.accountId, creditId: body.creditId, idempotencyKey: body.idempotencyKey } : null;
}
export async function GET(request: Request) {
  const resolved = requireAdmin(request); if ("response" in resolved) return resolved.response;
  if (getHarness().id !== "omp") return noStore(unavailable("The active engine does not support banked reset credits.", resolved.user.id));
  const snapshot = await listResetCredits();
  return noStore({ ...snapshot, observerId: resolved.user.id });
}
export async function POST(request: Request) {
  const resolved = requireAdmin(request); if ("response" in resolved) return resolved.response;
  let body: unknown; try { body = await request.json(); } catch { return noStore({ outcome: "error", code: "invalid_request", message: "Malformed reset-credit request." }, 400); }
  const input = parseRedeem(body);
  if (!input) return noStore({ outcome: "error", code: "invalid_request", message: "Select one credit and confirm its redemption." }, 400);
  if (getHarness().id !== "omp") return noStore({ outcome: "error", accountId: input.accountId, creditId: input.creditId, code: "unsupported", message: "The active engine does not support banked reset credits." }, 409);
  const now = Date.now(); pruneCompleted(now);
  const previous = completed.get(input.idempotencyKey); if (previous) return noStore(previous.outcome);
  const key = input.accountId + ":" + input.creditId;
  if (inFlight.has(key)) return noStore({ outcome: "error", accountId: input.accountId, creditId: input.creditId, code: "in_flight", message: "That reset credit is already being redeemed." }, 409);
  inFlight.add(key);
  let outcome: ResetCreditOutcome;
  try { outcome = await redeemResetCredit(input); } finally { inFlight.delete(key); }
  completed.set(input.idempotencyKey, { outcome, expiresAt: now + COMPLETED_TTL_MS });
  markStale();
  await getUsageSnapshot({ awaitFresh: true }).catch(() => undefined);
  return noStore(outcome);
}
