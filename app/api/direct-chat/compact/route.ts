import { NextResponse } from "next/server";
import { getRequestUser, isAuthRequired } from "@/lib/auth/guard";
import { DirectChatError, directTargets, parseDirectRequest, parseJsonRequest, streamDirectChat } from "@/lib/direct-chat/service";
import { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const RECENT_MESSAGES = 6;
const COMPACT_THRESHOLD_BYTES = 12 * 1024;

function guard(request: Request): NextResponse | null {
  if (shouldCheckApiRequestOrigin(request) && !isApiRequestOriginAllowed(request)) return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  if (isAuthRequired() && !getRequestUser(request)) return NextResponse.json({ error: "Authentication required", code: "auth_required" }, { status: 401 });
  return null;
}

function frame(type: string, payload: object): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function transcript(messages: { role: string; content: string }[]): string {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

function compactPrompt(messages: { role: string; content: string }[]): string {
  return `Summarize this direct chat into a durable handoff. Return labeled sections exactly named GOALS, CONSTRAINTS, DECISIONS, UNFINISHED WORK, RELEVANT FACTS, and USER PREFERENCES. Preserve each section's facts; say "none recorded" rather than inventing anything. Do not claim actions that did not happen. Keep it concise but sufficient to continue accurately.\n\nConversation:\n${transcript(messages)}`;
}

function readFrames(buffer: string): { frames: { type: string; payload: Record<string, unknown> }[]; rest: string } {
  const pieces = buffer.split(/\r?\n\r?\n/);
  const rest = pieces.pop() ?? "";
  const frames: { type: string; payload: Record<string, unknown> }[] = [];
  for (const piece of pieces) {
    const type = piece.match(/^event: ([^\r\n]+)/m)?.[1];
    const data = piece.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!type || !data) continue;
    try {
      const payload = JSON.parse(data) as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) frames.push({ type, payload: payload as Record<string, unknown> });
    } catch { /* malformed upstream event cannot produce a replacement snapshot */ }
  }
  return { frames, rest };
}

export async function POST(request: Request) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const parsed = parseDirectRequest(await parseJsonRequest(request));
    if (parsed.messages.some((message) => message.attachments?.length)) return NextResponse.json({ error: "Compact text-only messages after preserving or removing attachments." }, { status: 400 });
    const target = directTargets(getRequestUser(request)?.id).find((candidate) => candidate.model.key === parsed.modelKey);
    if (!target) return NextResponse.json({ error: "Direct model is not available." }, { status: 404 });
    const sourceBytes = encoder.encode(parsed.messages.map((message) => message.content).join("\n")).byteLength;
    const started = Date.now();
    return new Response(new ReadableStream<Uint8Array>({
      async start(output) {
        let complete = false;
        const elapsed = () => Date.now() - started;
        const close = () => { if (!complete) { complete = true; output.close(); } };
        if (parsed.messages.length <= RECENT_MESSAGES || sourceBytes <= COMPACT_THRESHOLD_BYTES) {
          output.enqueue(frame("noop", { status: "noop", reason: "Conversation is already compact.", elapsedMs: elapsed() }));
          close();
          return;
        }
        output.enqueue(frame("progress", { status: "running", phase: "preparing", elapsedMs: elapsed() }));
        const summaryRequest = { modelKey: parsed.modelKey, messages: [{ role: "user" as const, content: compactPrompt(parsed.messages) }], ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}), ...(parsed.fast ? { fast: true } : {}) };
        const decoder = new TextDecoder();
        let summary = "";
        let buffer = "";
        let sawDone = false;
        const consume = (frames: { type: string; payload: Record<string, unknown> }[]) => {
          for (const event of frames) {
            if (event.type === "delta" && typeof event.payload.text === "string") {
              summary += event.payload.text;
              output.enqueue(frame("delta", { text: event.payload.text }));
            }
            if (event.type === "done") sawDone = true;
            if (event.type === "error") throw new DirectChatError("The compact request failed.", 502);
          }
        };
        try {
          output.enqueue(frame("progress", { status: "running", phase: "summarizing", elapsedMs: elapsed() }));
          const reader = streamDirectChat(target, summaryRequest, request.signal).getReader();
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            buffer += decoder.decode(next.value, { stream: true });
            const decoded = readFrames(buffer);
            buffer = decoded.rest;
            consume(decoded.frames);
          }
          buffer += decoder.decode();
          const decoded = readFrames(`${buffer}\n\n`);
          consume(decoded.frames);
          if (request.signal.aborted) {
            output.enqueue(frame("cancelled", { status: "cancelled", elapsedMs: elapsed() }));
            return;
          }
          if (!sawDone) throw new DirectChatError("The compact request ended before completion.", 502);
          if (!summary.trim()) throw new DirectChatError("The compact request returned no summary.", 502);
          const replacement = [{ role: "assistant" as const, content: `Conversation summary:\n${summary.trim()}` }, ...parsed.messages.slice(-RECENT_MESSAGES)];
          output.enqueue(frame("complete", { status: "completed", messages: replacement, elapsedMs: elapsed() }));
        } catch (error) {
          if (request.signal.aborted) output.enqueue(frame("cancelled", { status: "cancelled", elapsedMs: elapsed() }));
          else output.enqueue(frame("error", { status: "failed", message: error instanceof DirectChatError ? error.message : "The compact request failed.", elapsedMs: elapsed() }));
        } finally { close(); }
      },
    }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) {
    const status = error instanceof DirectChatError ? error.status : 500;
    return NextResponse.json({ error: error instanceof DirectChatError ? error.message : "Unable to compact direct chat." }, { status });
  }
}
