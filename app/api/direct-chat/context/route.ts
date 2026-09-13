import { NextResponse } from "next/server";
import { getRequestUser, isAuthRequired } from "@/lib/auth/guard";
import { DirectChatError, getContextCandidates } from "@/lib/direct-chat/service";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function guard(request: Request): NextResponse | null {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  if (isAuthRequired() && !getRequestUser(request)) return NextResponse.json({ error: "Authentication required", code: "auth_required" }, { status: 401 });
  return null;
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const cwd = new URL(request.url).searchParams.get("cwd")?.trim();
  if (!cwd || cwd.length > 4096) return NextResponse.json({ error: "A workspace path is required." }, { status: 400 });
  try {
    return NextResponse.json({ candidates: await getContextCandidates(cwd) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof DirectChatError ? error.status : 500;
    return NextResponse.json({ error: error instanceof DirectChatError ? error.message : "Unable to read workspace instructions." }, { status });
  }
}
