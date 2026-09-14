import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/http";
import { requireEngine } from "@/lib/engine-guard";
import { unblockOmpCredential } from "@/lib/harness/omp-credentials";
import { markStale } from "@/lib/usage/cache";

/**
 * POST /api/usage/unblock — clear omp's rate-limit block on one credential.
 *
 * omp writes a block against a credential when a provider answers with a
 * limit, and refuses to send on it until the deadline. That store is
 * separate from the usage API and can outlive the condition: measured on a
 * live install, an Anthropic account reporting **4% used** carried a
 * five-hour block, so every turn fell back to another provider while the
 * quota sat unspent.
 *
 * Clearing it is deliberately cheap and safe — if the provider really is
 * limiting, the next request writes the block straight back — but it is
 * still a mutation of the credential store, so it is admin-only, and the
 * usage cache is marked stale so the ring stops showing the block it just
 * removed.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const resolved = requireAdmin(request);
  if ("response" in resolved) return resolved.response;
  const gate = requireEngine("omp", "Credential rate-limit blocks");
  if ("response" in gate) return gate.response;

  let credentialId: unknown;
  try {
    ({ credentialId } = (await request.json()) as { credentialId?: unknown });
  } catch {
    return NextResponse.json({ error: "A JSON body with credentialId is required." }, { status: 400 });
  }
  if (typeof credentialId !== "number" || !Number.isSafeInteger(credentialId)) {
    return NextResponse.json({ error: "credentialId must be an integer." }, { status: 400 });
  }

  const result = await unblockOmpCredential(credentialId);
  if (result.code) {
    return NextResponse.json({ error: result.message ?? "Clearing the block failed.", code: result.code }, { status: 400 });
  }
  markStale();
  return NextResponse.json({ cleared: result.cleared }, { headers: { "Cache-Control": "no-store" } });
}
