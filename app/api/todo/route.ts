import fs from "node:fs";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { parseJsonWithinLimit } from "@/lib/bounded-form-data";
import {
  ProjectTodoError,
  mutateProjectTodo,
  parseTodoActor,
  parseTodoOperation,
  readProjectTodo,
} from "@/lib/project-todo";
import { resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";

const MAX_TODO_REQUEST_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function invalidResponse(error: string) {
  return NextResponse.json({ error, code: "invalid" }, { status: 400, headers: NO_STORE });
}

async function resolveAuthorizedProjectRoot(request: Request): Promise<{ projectRoot: string } | NextResponse> {
  const cwd = new URL(request.url).searchParams.get("cwd")?.trim() ?? "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return invalidResponse("cwd must be an absolute path");
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) return invalidResponse("Unknown project root");

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(cwd);
  } catch {
    return invalidResponse("Unknown project root");
  }
  if (!stat.isDirectory() || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    return invalidResponse("Unknown project root");
  }

  const projectRoot = (await resolveProject(cwd)).projectRoot;
  if (!isFilePathAllowed(projectRoot, allowedRoots) || !isExistingFilePathAllowed(projectRoot, allowedRoots)) {
    return invalidResponse("Unknown project root");
  }
  return { projectRoot };
}

function todoErrorResponse(error: unknown): NextResponse {
  if (error instanceof ProjectTodoError) {
    const status = error.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status, headers: NO_STORE });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500, headers: NO_STORE },
  );
}

export async function GET(request: Request) {
  try {
    const resolved = await resolveAuthorizedProjectRoot(request);
    if (resolved instanceof NextResponse) return resolved;

    const result = await readProjectTodo(resolved.projectRoot);
    if (result.status === "invalid") return invalidResponse(result.reason);
    return NextResponse.json(
      { status: result.status, path: result.path, doc: result.doc },
      { headers: NO_STORE },
    );
  } catch (error) {
    return todoErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const resolved = await resolveAuthorizedProjectRoot(request);
    if (resolved instanceof NextResponse) return resolved;

    let body: unknown;
    try {
      body = await parseJsonWithinLimit(request, MAX_TODO_REQUEST_BYTES);
    } catch {
      return invalidResponse("Invalid to-do request body");
    }
    const operation = parseTodoOperation(body);
    const actor = parseTodoActor(
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).actor
        : undefined,
    );
    const doc = await mutateProjectTodo(resolved.projectRoot, operation, actor);
    return NextResponse.json({ doc }, { headers: NO_STORE });
  } catch (error) {
    return todoErrorResponse(error);
  }
}
