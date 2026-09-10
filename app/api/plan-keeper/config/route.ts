import { NextResponse } from "next/server";
import { jsonError, requireAdminOrOpenInstance } from "@/lib/auth/http";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { readPlanKeeperConfig, writePlanKeeperConfig } from "@/lib/plan-keeper/config";
import { planKeeperEngine } from "@/lib/plan-keeper/keeper";
import { isRecord } from "@/lib/type-guards";

/**
 * Whether the plan keeper (lib/plan-keeper/keeper.ts) runs for this Cody
 * instance (lib/plan-keeper/config.ts).
 *
 * Same shape as Distill's config route (app/api/distill/config/route.ts):
 * GET is readable by anyone the perimeter let in and also answers whether the
 * viewer may flip the switch, so the preferences panel can render the toggle
 * read-only instead of guessing; PUT is admin-only, with the open-instance
 * exception every write to Cody-level instance state shares
 * (requireAdminOrOpenInstance). An engine that cannot run a one-off model
 * call at all (an ACP engine) refuses both with 400 `unsupported` — the
 * feature literally cannot exist there, so the client hides the card rather
 * than offer a switch that could never take effect. omp/pi missing their
 * binary is a different answer: `enabled` is still Cody's own state and
 * still worth flipping ahead of the binary being installed, so that is a 200
 * with supported: false and a reason.
 */

export const dynamic = "force-dynamic";

/** The body is one boolean field. */
const MAX_BODY_BYTES = 256;

function answer(request: Request, enabled: boolean): NextResponse {
  const engine = planKeeperEngine();
  return NextResponse.json(
    {
      supported: engine.status === "ready",
      ...(engine.status === "ready" ? {} : { reason: engine.reason }),
      enabled,
      canManage: requireAdminOrOpenInstance(request) === null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(request: Request) {
  const engine = planKeeperEngine();
  if (engine.status === "unsupported") return jsonError(engine.reason, 400, "unsupported");
  return answer(request, readPlanKeeperConfig().enabled);
}

export async function PUT(request: Request) {
  const engine = planKeeperEngine();
  if (engine.status === "unsupported") return jsonError(engine.reason, 400, "unsupported");

  const denied = requireAdminOrOpenInstance(request);
  if (denied) return denied;

  let parsed: unknown;
  try {
    parsed = await parseJsonWithinLimit(request, MAX_BODY_BYTES);
  } catch {
    return jsonError("Invalid request body", 400, "invalid_body");
  }
  const enabled = isRecord(parsed) && typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  if (enabled === null) return jsonError("enabled must be a boolean", 400, "invalid_body");

  return answer(request, writePlanKeeperConfig({ enabled }).enabled);
}
