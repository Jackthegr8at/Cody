/**
 * Read-only host tools for Cody's sidebar chat, sized for the owner's local
 * P40 models (8,192-24,576 token windows, 2k-8k reserved for output — see
 * lib/sidebar-context-budget.ts). The sidebar starts with almost no context;
 * these five tools are how it gets any, on demand, one bounded page at a
 * time — never a preload the model cannot refuse.
 *
 * Every result is plain text (small models read prose, not JSON) and every
 * paged result is clamped through clampForSidebar and ends with a
 * machine-readable continuation line when truncated, so a small model can
 * page deliberately instead of receiving a wall of text once.
 *
 * The registry below bundles each tool's schema AND handler together (unlike
 * the ad-hoc SERVER_HOST_TOOLS array + handleFrame switch in rpc-manager.ts,
 * which keeps schemas and handlers in separate places) specifically so
 * wiring five tools into a sidebar session is one loop over
 * SIDEBAR_CONTEXT_TOOLS, not five new switch cases. Each entry is still
 * structurally a HostToolDefinition, so it drops straight into any
 * HostToolDefinition[] the caller assembles.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { canAccessSession, filterSessionsForUser } from "./auth/session-owners";
import type { UserRecord } from "./auth/users";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import type { HostToolDefinition } from "./pi-types";
import { buildSessionContext, getSessionEntries, listAllSessions, resolveSessionPath } from "./session-reader";
import { clampForSidebar, resultCharBudget, type ClampedResult } from "./sidebar-context-budget";
import type { AgentMessage, SessionInfo } from "./types";

// ============================================================================
// Public types
// ============================================================================

/** What the lead's host-tool dispatch supplies to every handler below. */
export interface SidebarToolContext {
  /** Workspace root workspace-file reads are confined to (symlink-checked). */
  cwd: string;
  /** Acting account; null when auth is off, which (like canAccessSession) sees everything. */
  user: UserRecord | null;
  /** Session id the main chat has open; used when a call omits `session`. */
  defaultSessionId: string | null;
  /**
   * Ids of sessions with a live engine process, when the caller has them
   * (rpc-manager.ts's own registry — this module never imports rpc-manager.ts
   * itself, to avoid a wiring cycle). Omitted -> list_sessions reports
   * "unknown" rather than guessing "idle".
   */
  runningSessionIds?: ReadonlySet<string>;
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

export const SESSION_NOT_FOUND = "Session not found.";
const MAX_WORKSPACE_ENTRIES = 200;
const MAX_SESSION_LIST = 50;
const MAX_CANDIDATES_SHOWN = 10;
/** Per-message cap inside a condensed transcript — deliberately smaller than
 *  a whole result's budget so one long message cannot crowd out the rest of
 *  a page; not part of the shared budget module because it bounds one
 *  message among many, not a whole tool result. */
const PER_MESSAGE_CHAR_CAP = 400;

/**
 * The char budget every paged result clamps to. SidebarToolContext carries
 * no contextWindow (see its doc comment) because this module has no way to
 * know which model is attached — so every call uses resultCharBudget's own
 * "unknown window -> assume the smallest" rule rather than guessing. That is
 * always safe: it never exceeds what even the smallest supported model can
 * fit, at the cost of an extra page on a larger one.
 */
function budget(): number {
  return resultCharBudget(undefined);
}

/** Append a machine-readable continuation line only when the clamp actually
 *  cut something, so a small model can act on it without parsing prose. A
 *  continuation call that lands exactly on the end says so explicitly rather
 *  than returning a blank line that could read as an error. */
function withPagingHint(clamped: ClampedResult, requestedOffset: number): string {
  if (clamped.truncated) {
    const remaining = Math.max(0, clamped.totalChars - (clamped.nextOffset ?? clamped.totalChars));
    return `${clamped.text}\n[truncated, ${remaining} chars remain \u2014 call again with offset=${clamped.nextOffset}]`;
  }
  if (clamped.text.length === 0 && requestedOffset > 0) return "(end of content)";
  return clamped.text;
}

function numberArg(args: SidebarToolArgs, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArg(args: SidebarToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
  return withPagingHint(clampForSidebar(buf.toString("utf8"), budget(), { offset }), offset);
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
  return withPagingHint(clampForSidebar(combined, budget(), { offset }), offset);
}

// ============================================================================
// Sessions — list_sessions / read_session.
//
// Ownership is a security boundary, not a convenience filter: list_sessions
// filters the whole listing through filterSessionsForUser (a bulk
// equivalent of canAccessSession over the sidecar owners file) so an
// inaccessible session's id/title is never enumerated, and read_session
// re-checks the single resolved target through canAccessSession itself right
// before reading it. Either gate failing, or the session simply not
// existing, answers the identical SESSION_NOT_FOUND text — never a
// distinguishable "blocked" vs "missing" response.
// ============================================================================

function formatRunning(id: string, ctx: SidebarToolContext): string {
  if (!ctx.runningSessionIds) return "unknown";
  return ctx.runningSessionIds.has(id) ? "running" : "idle";
}

async function listSessions(args: SidebarToolArgs, ctx: SidebarToolContext): Promise<string> {
  const all = await listAllSessions();
  const accessible = filterSessionsForUser(all, ctx.user);
  const workspace = stringArg(args, "workspace");
  const filtered = workspace
    ? accessible.filter((s) => s.cwd === workspace || s.projectRoot === workspace)
    : accessible;
  if (filtered.length === 0) return "(no sessions)";

  const sorted = [...filtered].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  const capped = sorted.slice(0, MAX_SESSION_LIST);
  const lines = capped.map((s) =>
    `${s.id} | ${s.name ?? "(untitled)"} | ${s.cwd} | ${formatRunning(s.id, ctx)} | ${s.modified}`
  );
  if (sorted.length > MAX_SESSION_LIST) {
    lines.push(`\u2026 ${sorted.length - MAX_SESSION_LIST} more not shown; narrow with workspace.`);
  }
  return lines.join("\n");
}

/** User/assistant text and tool NAMES only — never a tool's arguments or its
 *  result content, and never any other message kind (toolResult, custom,
 *  bashExecution, developer, pythonExecution, fileMention): those can carry
 *  arbitrarily large or sensitive payloads a condensed transcript must not
 *  surface. */
function renderCondensedMessage(message: AgentMessage): string | null {
  if (message.role === "user") {
    const text = extractText(message.content).trim();
    return text ? `User: ${text}` : null;
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
      else if (block.type === "toolCall") parts.push(`[tool: ${block.toolName}]`);
    }
    return parts.length ? `Assistant: ${parts.join(" ")}` : null;
  }
  return null;
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function formatCandidates(query: string, matches: SessionInfo[]): string {
  const shown = matches.slice(0, MAX_CANDIDATES_SHOWN);
  const lines = [
    `Multiple sessions match "${query}"; pass the exact id:`,
    ...shown.map((s) => `${s.id} | ${s.name ?? "(untitled)"} | ${s.cwd}`),
  ];
  if (matches.length > MAX_CANDIDATES_SHOWN) {
    lines.push(`\u2026 ${matches.length - MAX_CANDIDATES_SHOWN} more matches not shown.`);
  }
  return lines.join("\n");
}

async function readSession(args: SidebarToolArgs, ctx: SidebarToolContext): Promise<string> {
  const all = await listAllSessions();
  const accessible = filterSessionsForUser(all, ctx.user);
  const accessibleIds = new Set(accessible.map((s) => s.id));

  const query = stringArg(args, "session") ?? null;
  let targetId: string | null;
  if (!query) {
    targetId = ctx.defaultSessionId;
  } else if (accessibleIds.has(query)) {
    targetId = query;
  } else {
    const needle = query.trim().toLowerCase();
    const matches = accessible.filter((s) => (s.name ?? "").toLowerCase().includes(needle));
    if (matches.length > 1) return formatCandidates(query, matches);
    targetId = matches.length === 1 ? matches[0].id : null;
  }

  if (!targetId || !accessibleIds.has(targetId) || !canAccessSession(targetId, ctx.user)) {
    return SESSION_NOT_FOUND;
  }

  const filePath = await resolveSessionPath(targetId);
  if (!filePath) return SESSION_NOT_FOUND;

  const entries = getSessionEntries(filePath);
  const context = buildSessionContext(entries);
  const tail = numberArg(args, "tail");
  const source = tail && tail > 0 ? context.messages.slice(-Math.floor(tail)) : context.messages;

  const rendered: string[] = [];
  for (const message of source) {
    const line = renderCondensedMessage(message);
    if (!line) continue;
    const clamped = clampForSidebar(line, PER_MESSAGE_CHAR_CAP);
    rendered.push(clamped.truncated ? `${clamped.text}\u2026` : clamped.text);
  }
  if (rendered.length === 0) return "(no messages)";
  rendered.reverse(); // newest first

  const offset = numberArg(args, "offset") ?? 0;
  return withPagingHint(clampForSidebar(rendered.join("\n\n"), budget(), { offset }), offset);
}

// ============================================================================
// Registry — schemas kept to one short sentence and minimal args; the whole
// set must stay well under the sidebar's own tool-schema budget (measured in
// the test file: JSON size of these five declarations / 4).
// ============================================================================

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
  {
    name: "list_sessions",
    description: "List recent chat sessions: id, title, folder, running state, last activity.",
    parameters: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Only sessions whose folder matches this path." },
      },
    },
    handler: listSessions,
  },
  {
    name: "read_session",
    description: "Read a condensed transcript of a chat session by id or title: messages and tool names only.",
    parameters: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id or title; omit for the session the user has open." },
        tail: { type: "number", description: "Only the most recent N messages." },
        offset: { type: "number", description: "Resume from a prior truncated result's offset." },
      },
    },
    handler: readSession,
  },
];
