import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/auth/http";
import { createForgeClient, ForgeError } from "@/lib/forge/client";
import { getForgeHost, resolveApiUrl } from "@/lib/forge/config";

/**
 * "Test connection": ask the host who the saved token belongs to.
 *
 * `/user` is the one call that proves all three things at once — the base URL
 * resolves, TLS is accepted, and the token is valid for an account — and it is
 * a read, so a member may run it. Gitea also reports its own version, which is
 * what tells the user whether the Actions endpoints this Cody uses exist.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = requireUser(request);
  if ("response" in resolved) return resolved.response;

  const { id } = await params;
  const host = getForgeHost(id);
  if (!host) return jsonError("Unknown code host", 404, "unknown_host");

  try {
    const identity = await createForgeClient(host).whoami();
    return NextResponse.json(
      {
        ok: true,
        hostId: host.id,
        apiUrl: resolveApiUrl(host),
        login: identity.login,
        name: identity.name ?? null,
        serverVersion: identity.serverVersion,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // A failed probe is a real answer about a configured host, not a server
    // fault: 200 with ok:false so the panel renders the reason inline.
    const message = error instanceof ForgeError ? error.message : error instanceof Error ? error.message : String(error);
    const status = error instanceof ForgeError ? error.status : null;
    return NextResponse.json(
      { ok: false, hostId: host.id, apiUrl: resolveApiUrl(host), error: message, status },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
