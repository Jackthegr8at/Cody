/**
 * Read-only host tools for Cody's sidebar chat, sized for the owner's local
 * P40 models (8,192-24,576 token windows, 2k-8k reserved for output — see
 * lib/sidebar-context-budget.ts). The sidebar starts with almost no context;
 * these tools are how it gets any, on demand, one bounded page at a time —
 * never a preload the model cannot refuse.
 *
 * Three of them are WORKSPACE tools and live here. The session-awareness
 * three (list_sessions, session_status, read_session) are shared with every
 * main chat and live in lib/session-tools.ts: one resolution rule, one
 * ownership gate, one condensed-transcript renderer, so the sidebar and the
 * main agent can never disagree about which session a name means or what a
 * transcript may show.
 *
 * Every result is plain text (small models read prose, not JSON) and every
 * paged result is clamped and ends with a machine-readable continuation line
 * when truncated, so a small model can page deliberately instead of
 * receiving a wall of text once.
 *
 * The registry below bundles each tool's schema AND handler together (unlike
 * the ad-hoc SERVER_HOST_TOOLS array + handleFrame switch in rpc-manager.ts,
 * which keeps schemas and handlers in separate places) specifically so
 * wiring them into a sidebar session is one loop, not one new switch case
 * each. Each entry is still structurally a HostToolDefinition, so it drops
 * straight into any HostToolDefinition[] the caller assembles.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import type { HostToolDefinition } from "./pi-types";
import {
  SESSION_AWARENESS_TOOLS,
  numberArg,
  sessionToolBudget,
  stringArg,
  withPagingHint,
  type SessionToolContext,
} from "./session-tools";
import { clampForSidebar } from "./sidebar-context-budget";

// ============================================================================
// Public types
// ============================================================================

/** What the lead's host-tool dispatch supplies to every handler below: the
 * shared session context plus the one thing only the sidebar needs, the
 * workspace root its file reads are confined to (symlink-checked). */
export interface SidebarToolContext extends SessionToolContext {
  cwd: string;
}

/** Parsed tool-call arguments; each handler validates its own fields at runtime. */
export type SidebarToolArgs = Record<string, unknown>;

/**
 * Always resolves to plain text — success or a short human-readable failure
 * — so the caller's dispatch never needs its own try/catch around a sidebar
 * tool call.
 */
export type SidebarToolHandler = (args: SidebarToolArgs, ctx: SidebarToolContext) => Promise<string>;

/** Structurally a HostToolDefinition (usable anywhere one is expected) plus
 *  the handler SERVER_HOST_TOOLS entries keep separate in rpc-manager.ts. */
export type SidebarToolDefinition = HostToolDefinition & { handler: SidebarToolHandler };

// ============================================================================
// Shared bounds
// ============================================================================

const MAX_WORKSPACE_ENTRIES = 200;

/** The char budget every paged result clamps to. The sidebar passes no
 * `charBudget`, so this is resultCharBudget's own "unknown window -> assume
 * the smallest" rule: never more than even the smallest supported model can
 * fit, at the cost of an extra page on a larger one. */
function budget(ctx: SidebarToolContext): number {
  return sessionToolBudget(ctx);
}

// ============================================================================
// Workspace file access — confined to ctx.cwd only, symlink-safe.
//
// Deliberately NOT lib/allowed-roots.ts's allowFileRoot: that widens the
// *global* multi-root file-access allow-list the main IDE file explorer
// shares across every session. The sidebar's root is exactly one directory,
// so this builds its own single-root Set per call and reuses the proven
// symlink-safe primitives lib/file-access.ts already exports (the same ones
// lib/file-access.test.mjs proves reject a symlink escape).
// ============================================================================

type WorkspacePathResult = { target: string } | { error: string };

function resolveInWorkspace(cwd: string, relPath: string): WorkspacePathResult {
  const roots = new Set([cwd]);
  const target = path.resolve(cwd, relPath);
  if (!isFilePathAllowed(target, roots)) return { error: "Error: path is outside the workspace." };
  if (!isExistingFilePathAllowed(target, roots)) return { error: "Error: path not found." };
  return { target };
}

function tryReaddir(target: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
}

function tryStat(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function tryReadFileBuffer(target: string): Buffer | null {
  try {
    return fs.readFileSync(target);
  } catch {
    return null;
  }
}

/** Minimal `*`/`?` glob, translated to a case-insensitive RegExp. No new
 *  dependency for what is, in practice, a filename filter. */
function globToRegExp(pattern: string): RegExp {
  let src = "";
  for (const ch of pattern) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, "i");
}

async function listWorkspaceFiles(args: SidebarToolArgs, ctx: SidebarToolContext): Promise<string> {
  const dir = stringArg(args, "dir") ?? ".";
  const resolved = resolveInWorkspace(ctx.cwd, dir);
  if ("error" in resolved) return resolved.error;
  const entries = tryReaddir(resolved.target);
  if (!entries) return "Error: not a directory.";

  const patternArg = stringArg(args, "pattern");
  const pattern = patternArg ? globToRegExp(patternArg) : null;
  const names = entries
    .filter((entry) => !pattern || pattern.test(entry.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((a, b) => {
      const aDir = a.endsWith("/");
      const bDir = b.endsWith("/");
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });

  if (names.length === 0) return "(empty)";
  const lines = names.slice(0, MAX_WORKSPACE_ENTRIES);
  if (names.length > MAX_WORKSPACE_ENTRIES) {
    lines.push(`\u2026 ${names.length - MAX_WORKSPACE_ENTRIES} more not shown; narrow with pattern.`);
  }
  return lines.join("\n");
}

async function readWorkspaceFile(args: SidebarToolArgs, ctx: SidebarToolContext): Promise<string> {
  const relPath = stringArg(args, "path");
  if (!relPath) return "Error: a path is required.";
  const resolved = resolveInWorkspace(ctx.cwd, relPath);
  if ("error" in resolved) return resolved.error;

  const stat = tryStat(resolved.target);
  if (!stat || !stat.isFile()) return "Error: not a file.";
  const buf = tryReadFileBuffer(resolved.target);
  if (!buf) return "Error: unable to read file.";

  const sampleLen = Math.min(buf.length, 8000);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return "Error: binary file, cannot display as text.";
  }
  if (buf.length === 0) return "(empty file)";

  const offset = numberArg(args, "offset") ?? 0;
  return withPagingHint(clampForSidebar(buf.toString("utf8"), budget(ctx), { offset }), offset);
}

// ============================================================================
// Project context — AGENTS.md / CLAUDE.md / .omp/rules at the workspace root.
// Matches the sidebar system prompt's own description (lib/rpc-manager.ts)
// and the files omp's own context-file discovery loads (see
// lib/local-model-profile.ts CONTEXT_FILE_BASENAMES; GEMINI.md is excluded
// here because neither that system prompt nor the sidebar contract mention it).
// ============================================================================

const PROJECT_CONTEXT_BASENAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const RULES_ENTRY = ".omp/rules";

/** Read a file's text only if it is still within cwd after resolving
 *  symlinks — the same guard read_workspace_file uses, applied here even
 *  though the names are fixed (not model-supplied) so a symlinked
 *  AGENTS.md/CLAUDE.md/.omp/rules cannot smuggle content from outside the
 *  workspace into the model's context. */
function readIfWithinWorkspace(cwd: string, target: string): string | null {
  const roots = new Set([cwd]);
  if (!isFilePathAllowed(target, roots) || !isExistingFilePathAllowed(target, roots)) return null;
  const buf = tryReadFileBuffer(target);
  return buf ? buf.toString("utf8") : null;
}

function collectProjectContext(cwd: string): string {
  const parts: string[] = [];
  for (const basename of PROJECT_CONTEXT_BASENAMES) {
    const text = readIfWithinWorkspace(cwd, path.join(cwd, basename));
    if (text !== null) parts.push(`## ${basename}\n\n${text}`);
  }

  const rulesTarget = path.join(cwd, RULES_ENTRY);
  const rulesStat = tryStat(rulesTarget);
  if (rulesStat?.isFile()) {
    const text = readIfWithinWorkspace(cwd, rulesTarget);
    if (text !== null) parts.push(`## ${RULES_ENTRY}\n\n${text}`);
  } else if (rulesStat?.isDirectory()) {
    const entries = tryReaddir(rulesTarget) ?? [];
    const names = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    for (const name of names) {
      const text = readIfWithinWorkspace(cwd, path.join(rulesTarget, name));
      if (text !== null) parts.push(`## ${RULES_ENTRY}/${name}\n\n${text}`);
    }
  }

  return parts.join("\n\n");
}

async function readProjectContext(args: SidebarToolArgs, ctx: SidebarToolContext): Promise<string> {
  const combined = collectProjectContext(ctx.cwd);
  if (!combined) return "No AGENTS.md, CLAUDE.md, or .omp/rules found in this workspace.";
  const offset = numberArg(args, "offset") ?? 0;
  return withPagingHint(clampForSidebar(combined, budget(ctx), { offset }), offset);
}


// ============================================================================
// Registry — schemas kept to one short sentence and minimal args; the whole
// set must stay well under the sidebar's own tool-schema budget (measured in
// the test file: JSON size of these declarations / 4). The session three are
// appended verbatim from the shared module, never re-declared here: a second
// copy of a schema is how the sidebar and the main chat start describing the
// same tool differently.

export const SIDEBAR_CONTEXT_TOOLS: SidebarToolDefinition[] = [
  {
    name: "list_workspace_files",
    description: "List files and folders in the workspace, one level deep.",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Subdirectory to list, relative to the workspace root." },
        pattern: { type: "string", description: "Optional glob filter, e.g. *.ts." },
      },
    },
    handler: listWorkspaceFiles,
  },
  {
    name: "read_workspace_file",
    description: "Read a text file from the workspace, paged if large.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace root." },
        offset: { type: "number", description: "Resume from a prior truncated result's offset." },
      },
      required: ["path"],
    },
    handler: readWorkspaceFile,
  },
  {
    name: "read_project_context",
    description: "Read the workspace's AGENTS.md/CLAUDE.md project instructions, paged if large. Call only when the task needs them.",
    parameters: {
      type: "object",
      properties: {
        offset: { type: "number", description: "Resume from a prior truncated result's offset." },
      },
    },
    handler: readProjectContext,
  },
  ...SESSION_AWARENESS_TOOLS,
];
