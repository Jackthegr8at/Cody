import fs from "node:fs";
import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import { verifyDisplayCapability } from "@/lib/display/capability";
import { getEngineSession } from "@/lib/harness/engine-sessions";
import {
  ProjectTodoError,
  mutateProjectTodo,
  parseTodoActor,
  parseTodoOperation,
  readProjectTodo,
} from "@/lib/project-todo";
import { getRpcSession } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";
import { resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";

const MAX_INTERNAL_TODO_BODY_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function invalidResponse(error: string, status = 400) {
  return NextResponse.json({ error, code: "invalid" }, { status, headers: NO_STORE });
}

function todoErrorResponse(error: unknown): NextResponse {
  if (error instanceof ProjectTodoError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.code === "not_found" ? 404 : 400, headers: NO_STORE },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500, headers: NO_STORE },
  );
}

async function projectRootForSession(sessionId: string): Promise<string> {
  const cwd = getRpcSession(sessionId)?.cwd ?? getEngineSession(sessionId)?.cwd;
  if (!cwd) throw new ProjectTodoError("Session not found", "not_found");
  const projectRoot = (await resolveProject(cwd)).projectRoot;
  try {
    if (!(await fs.promises.stat(projectRoot)).isDirectory()) {
      throw new ProjectTodoError("Session project root is not a directory");
    }
  } catch (error) {
    if (error instanceof ProjectTodoError) throw error;
    throw new ProjectTodoError("Session project root is unavailable");
  }
  return projectRoot;
}

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  let capability = null;
  try {
    capability = verifyDisplayCapability(token);
  } catch {
    // The capability issuer is unavailable until Cody's internal secret exists.
  }
  if (!capability) {
    return NextResponse.json(
      { error: "Invalid to-do capability", code: "invalid" },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    let body: unknown;
    try {
      body = await parseJsonWithinLimit(request, MAX_INTERNAL_TODO_BODY_BYTES);
    } catch {
      return invalidResponse("Invalid to-do request body");
    }
    if (!isRecord(body) || typeof body.sessionId !== "string" || !body.sessionId) {
      return invalidResponse("sessionId is required");
    }
    if (body.sessionId !== capability.sid) {
      return invalidResponse("Session does not match the to-do capability", 403);
    }

    const projectRoot = await projectRootForSession(capability.sid);
    if (body.op === "list") {
      const loaded = await readProjectTodo(projectRoot);
      if (loaded.status === "invalid") return invalidResponse(loaded.reason);
      return NextResponse.json({ doc: loaded.doc }, { headers: NO_STORE });
    }

    const operation = parseTodoOperation(body);
    const label = request.headers.get("x-cody-engine-label")?.trim() || "Agent";
    const actor = parseTodoActor({ kind: "agent", label });
    const doc = await mutateProjectTodo(projectRoot, operation, actor);
    return NextResponse.json({ doc }, { headers: NO_STORE });
  } catch (error) {
    return todoErrorResponse(error);
  }
}
