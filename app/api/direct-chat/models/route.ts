import { NextResponse } from "next/server";
import { getRequestUser, isAuthRequired } from "@/lib/auth/guard";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";
import { accountScope, directTargets } from "@/lib/direct-chat/service";

export const dynamic = "force-dynamic";

function guard(request: Request): NextResponse | null {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  const user = getRequestUser(request);
  if (isAuthRequired() && !user) return NextResponse.json({ error: "Authentication required", code: "auth_required" }, { status: 401 });
  return null;
}

export async function GET(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  const user = getRequestUser(request);
  return NextResponse.json({ models: directTargets(user?.id).map((target) => target.model), accountScope: accountScope(user?.id) }, { headers: { "Cache-Control": "no-store" } });
}
