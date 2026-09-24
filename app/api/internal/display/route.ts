import { NextResponse } from "next/server";
import { publishDisplayRequest } from "@/lib/display/bus";
import { startSharedBrowser } from "@/lib/display/shared-browser";
import { verifyDisplayCapability } from "@/lib/display/capability";
import { parseDisplayRequestInput } from "@/lib/display/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  let capability = null;
  try { capability = verifyDisplayCapability(token); } catch { /* server not initialized */ }
  if (!capability) return NextResponse.json({ error: "Invalid display capability" }, { status: 401 });
  try {
    const body: unknown = await request.json();
    const input = parseDisplayRequestInput(body);
    // `shared: true` means the caller wants to DRIVE the surface, not merely
    // show it — the answer then carries the DevTools endpoint. Anything else
    // is the plain publish this route has always done.
    if (typeof body === "object" && body !== null && (body as { shared?: unknown }).shared === true) {
      const handle = await startSharedBrowser(capability.sid, { ...input });
      return NextResponse.json({ accepted: true, requestId: handle.request.id, url: handle.request.source.url, endpoint: handle.endpoint }, { headers: { "Cache-Control": "no-store" } });
    }
    const display = await publishDisplayRequest(capability.sid, input);
    return NextResponse.json({ accepted: true, requestId: display.id }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid display request" }, { status: 400 });
  }
}
