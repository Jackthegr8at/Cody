import { NextResponse } from "next/server";
import { getRequestUser, isAuthRequired } from "@/lib/auth/guard";
import { DirectChatError, directTargets, parseDirectRequest, parseJsonRequest, streamDirectChat } from "@/lib/direct-chat/service";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function guard(request: Request): NextResponse | null {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  if (isAuthRequired() && !getRequestUser(request)) return NextResponse.json({ error: "Authentication required", code: "auth_required" }, { status: 401 });
  return null;
}

export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const input = parseDirectRequest(await parseJsonRequest(request));
    const target = directTargets(getRequestUser(request)?.id).find((candidate) => candidate.model.key === input.modelKey);
    if (!target) return NextResponse.json({ error: "Direct model is not available." }, { status: 404 });
    return new Response(streamDirectChat(target, input, request.signal), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (error) {
    const status = error instanceof DirectChatError ? error.status : 500;
    return NextResponse.json({ error: error instanceof DirectChatError ? error.message : "Unable to start direct chat." }, { status });
  }
}
