import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { mkdirSync } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { allowFileRoot } from "@/lib/file-access";
import { FileOpError, validateEntryName } from "@/lib/file-ops";
import { resolveDirectory } from "@/lib/directory-browser";

// POST /api/cwd/mkdir  body: { path: string, name: string }
// Creates a new directory inside an existing parent directory that the user
// can browse (via GET /api/cwd/browse). If the parent is accessible to the
// browse route, it can be written to here too — the authorization rule is
// "if you can browse it, you can create in it," avoiding the old bug where
// freshly-browsed folders outside allowed-roots failed with 403 on mkdir.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { path?: unknown; name?: unknown };
    const parentPath = typeof body.path === "string" ? body.path.trim() : "";

    if (!parentPath) {
      return NextResponse.json(
        { error: "Parent path is required", code: "path_required" },
        { status: 400 }
      );
    }

    // Validate the folder name using the same rules as file-ops.ts.
    let safeName: string;
    try {
      safeName = validateEntryName(body.name);
    } catch (error) {
      if (error instanceof FileOpError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      throw error;
    }

    // Resolve the parent path: normalize (~ expansion, relative -> absolute),
    // then realpath (resolve symlinks) and verify it exists. Mirrors the
    // browse route's resolveDirectory behavior.
    let resolvedParent: string;
    try {
      resolvedParent = await resolveDirectory(parentPath);
    } catch {
      return NextResponse.json(
        { error: "Parent directory does not exist", code: "not_found" },
        { status: 404 }
      );
    }

    // Ensure the resolved path is a directory, not a file.
    const parentStat = await stat(resolvedParent);
    if (!parentStat.isDirectory()) {
      return NextResponse.json(
        { error: "Parent path is not a directory", code: "not_found" },
        { status: 404 }
      );
    }

    // Attempt to create the directory non-recursively.
    const createdPath = path.join(resolvedParent, safeName);
    try {
      mkdirSync(createdPath);
    } catch (error) {
      if (error instanceof Error) {
        const fsError = error as NodeJS.ErrnoException;
        if (fsError.code === "EEXIST") {
          return NextResponse.json(
            { error: "A folder with that name already exists", code: "already_exists" },
            { status: 409 }
          );
        }
        if (fsError.code === "EACCES" || fsError.code === "EPERM") {
          return NextResponse.json(
            { error: "Permission denied", code: "permission_denied" },
            { status: 403 }
          );
        }
        // Other FS errors (EIO, etc.)
        return NextResponse.json(
          { error: `Failed to create directory: ${fsError.message}`, code: "creation_failed" },
          { status: 500 }
        );
      }
      throw error;
    }

    // Register the newly created folder as an allowed root, so the user can
    // immediately select it without authorization errors.
    allowFileRoot(createdPath);

    return NextResponse.json({ path: createdPath }, { status: 200 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
