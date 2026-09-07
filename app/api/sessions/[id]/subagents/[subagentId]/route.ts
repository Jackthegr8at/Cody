import { NextResponse } from "next/server";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { isSafeSubagentId, readCompletionArtifact, readSubagentTranscriptPage, resolveSubagentArtifact, subagentTranscriptPath } from "@/lib/subagent-history";

export const dynamic = "force-dynamic";

// OMP task names are explicit user input and may contain spaces/punctuation.
// The shared path-boundary validator permits those names while rejecting path
// separators, controls, traversal components, and overlong UTF-8 filenames.

/**
 * GET /api/sessions/[id]/subagents/[subagentId]?fromByte=N
 *
 * Default: paged transcript of one subagent, read directly from the parent
 * session's sibling artifacts dir. Mirrors the RPC get_subagent_messages
 * response shape so the dialog can fall back to it when no live RPC process
 * knows the file.
 *
 * ?mode=completion: the subagent's final output (`<id>.md`), without loading
 * the transcript — works even for transcripts beyond the readable size cap.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; subagentId: string }> }
) {
  const { id, subagentId } = await params;
  try {
    if (!isSafeSubagentId(subagentId)) {
      return NextResponse.json({ error: "Invalid subagent id", code: "invalid_subagent_id" }, { status: 400 });
    }
    const sessionResolved = await resolveSessionPathOr404(id, req);
    if ("response" in sessionResolved) return sessionResolved.response;
    const filePath = sessionResolved.filePath;
    const searchParams = new URL(req.url).searchParams;
    if (searchParams.get("mode") === "completion") {
      const resolved = resolveSubagentArtifact(filePath, subagentId, ".md");
      if (!resolved) {
        return NextResponse.json({ error: "Subagent completion not found", code: "transcript_not_found" }, { status: 404 });
      }
      // Read the RESOLVED path: re-deriving from the raw session path here
      // would reopen whatever the symlink points at after the check.
      const completion = readCompletionArtifact(resolved);
      return NextResponse.json({
        sessionFile: subagentTranscriptPath(filePath, subagentId),
        completion: completion?.completion ?? null,
        truncated: completion?.truncated ?? false,
      });
    }
    const resolved = resolveSubagentArtifact(filePath, subagentId, ".jsonl");
    if (!resolved) {
      return NextResponse.json({ error: "Subagent transcript not found", code: "transcript_not_found" }, { status: 404 });
    }
    const fromByteRaw = searchParams.get("fromByte");
    const beforeByteRaw = searchParams.get("beforeByte");
    const fromByte = fromByteRaw !== null ? Number(fromByteRaw) : beforeByteRaw !== null ? Number(beforeByteRaw) : 0;
    const page = readSubagentTranscriptPage(resolved, fromByte, {
      tail: searchParams.get("tail") === "1" || searchParams.get("tail") === "true",
      before: beforeByteRaw !== null,
    });
    return NextResponse.json(page);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
