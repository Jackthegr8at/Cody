/**
 * Structural problems with a single filesystem entry name (a new file or
 * folder, or a rename target) — pure string checks, no I/O, no Node built-ins.
 * Safe to import from a client bundle.
 *
 * Shared by the server's lib/file-ops.ts (validateEntryName, the authority
 * for /api/files/ops and /api/cwd/mkdir) and DirectoryPicker's live "New
 * folder" validation, so client and server never drift on what makes a name
 * invalid — a name the client accepts is guaranteed to pass the server's own
 * check too.
 */
export type EntryNameProblem = "slash" | "dots";

export function findEntryNameProblem(name: string): EntryNameProblem | null {
  if (name === "." || name === "..") return "dots";
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return "slash";
  return null;
}
