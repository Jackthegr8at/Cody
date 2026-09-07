import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/http";
import { getOpenRouterAccount, unavailableAccount } from "@/lib/openrouter/account";

/**
 * GET /api/openrouter/account[?refresh=1] — the OpenRouter account behind the
 * configured key: prepaid balance, this key's spend and cap, and (with a
 * management key) daily activity.
 *
 * Same shape of contract as GET /api/usage: any signed-in user may read it,
 * and an unavailable snapshot is a VALUE rather than a 4xx. The credit
 * section in the composer's usage popover hides itself on `available: false`,
 * so answering an error status here would paint a failure over a widget whose
 * honest state is "there is no OpenRouter key to report on".
 *
 * `?refresh=1` bypasses the 30s cache. It exists for the top-up flow: after
 * the user comes back from OpenRouter's credits page, "did my money land?"
 * must not be answered from a cached entry that predates the purchase.
 *
 * The key itself NEVER appears in the response — only which store it came
 * from, and the masked label OpenRouter prints for it.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  try {
    const snapshot = await getOpenRouterAccount({ refresh });
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // getOpenRouterAccount fails soft on its own; this only guards something
    // more fundamental (the module throwing during import-time setup).
    return NextResponse.json(
      unavailableAccount({ code: "unreachable", message: error instanceof Error ? error.message : String(error) }),
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
