import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { readDistillChain, validateChain, writeDistillChain } from "@/lib/distill/config";
import { distillEngine } from "@/lib/distill/runner";
import { isRecord } from "@/lib/type-guards";

/**
 * Distill's model chain (lib/distill/config.ts).
 *
 * GET is readable by anyone the perimeter let in, like `/api/models`; it also
 * answers whether the viewer may change the chain, so the settings panel can
 * render the list read-only instead of guessing. PUT is admin-only, with the
 * open-instance exception every write to Cody-level instance state shares
 * (`requireAdminOrOpenInstance`).
 *
 * An engine that cannot run a one-off model call refuses both with 400
 * `unsupported`, so the client hides Distill entirely rather than offering a
 * setting that could never take effect. "omp is not installed" is a different
 * answer: the chain is still Cody's own state and still worth editing, so
 * that one is a 200 with `supported: false` and a reason.
 */

export const dynamic = "force-dynamic";

/** A chain is at most eight short selectors. */
const MAX_BODY_BYTES = 16_384;

function answer(request: Request, chain: string[]): NextResponse {
  const engine = distillEngine();
  return NextResponse.json(
    {
      supported: engine.status === "ready",
      ...(engine.status === "ready" ? {} : { reason: engine.reason }),
      chain,
      canManage: requireAdminOrOpenInstance(request) === null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: Request) {
  const engine = distillEngine();
  if (engine.status === "unsupported") return jsonError(engine.reason, 400, "unsupported");
  return answer(request, readDistillChain());
}

export async function PUT(request: Request) {
  const engine = distillEngine();
  if (engine.status === "unsupported") return jsonError(engine.reason, 400, "unsupported");

  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let parsed: unknown;
  try {
    parsed = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const validated = validateChain(isRecord(parsed) ? parsed.chain : undefined);
  if ("error" in validated) return jsonError(validated.error, 400, "invalid_chain");

  return answer(request, writeDistillChain(validated.chain));
}
