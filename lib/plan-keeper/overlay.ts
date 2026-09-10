import { readFileSync } from "fs";
import path from "path";
import { isRecord } from "../type-guards";
import type { PlanOverlay, PlanOverlaySubtask } from "../pi-types";
import { getPlanKeeperOverlayDir, writeJsonAtomic } from "./config";

/**
 * Per-session persistence for the plan keeper's overlay (subtasks + which
 * top-level tasks the keeper itself completed). Cody's own derived state,
 * like Distill's summary cache (lib/distill/cache.ts): never written into the
 * engine's session file, one JSON file per session, session id validated the
 * same way before it ever reaches a path.
 */

export type { PlanOverlay, PlanOverlaySubtask };

/** Session ids come from the engine and end up in a file name. Anything that
 * is not a plain id is simply not persisted — there is no safe way to spell a
 * path separator in one, and refusing beats sanitizing into a collision. */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function overlayPath(sessionId: string): string | null {
  if (!SAFE_ID_RE.test(sessionId) || sessionId === "." || sessionId === "..") return null;
  return path.join(getPlanKeeperOverlayDir(), `${sessionId}.json`);
}

function readSubtaskList(value: unknown): PlanOverlaySubtask[] {
  if (!Array.isArray(value)) return [];
  const out: PlanOverlaySubtask[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.content !== "string" || !entry.content.trim()) continue;
    out.push({ content: entry.content, status: entry.status === "completed" ? "completed" : "pending" });
  }
  return out;
}

/** The session's overlay, or null when there is none yet — the keeper never
 * ran, or the file is missing/corrupt. Both read as "nothing to show", same
 * as a brand new session. */
export function readPlanOverlay(sessionId: string): PlanOverlay | null {
  const file = overlayPath(sessionId);
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const subtasks: Record<string, PlanOverlaySubtask[]> = {};
  if (isRecord(parsed.subtasks)) {
    for (const [key, value] of Object.entries(parsed.subtasks)) {
      const list = readSubtaskList(value);
      if (list.length > 0) subtasks[key] = list;
    }
  }
  const autoCompleted = Array.isArray(parsed.autoCompleted)
    ? parsed.autoCompleted.filter((value): value is string => typeof value === "string")
    : [];
  const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
  return { subtasks, autoCompleted, updatedAt };
}

/** Replace the session's overlay. A write that fails just means the next
 * reload shows the previous overlay — never a crash, never a half-written
 * file (writeJsonAtomic). */
export function writePlanOverlay(sessionId: string, overlay: PlanOverlay): void {
  const file = overlayPath(sessionId);
  if (!file) return;
  try {
    writeJsonAtomic(file, { version: 1, ...overlay });
  } catch (error) {
    // A slower feature next time, not a broken one now.
    console.debug("[plan-keeper] could not persist the overlay:", error);
  }
}

/**
 * Drop subtasks/autoCompleted entries for task contents that no longer exist
 * in the CURRENT phases. A phase list the model replaced wholesale (a new
 * plan for a new stretch of work) must not drag a stale checklist under a
 * task name that happens to repeat, and an overlay must not grow forever
 * across a very long session.
 */
export function prunePlanOverlay(overlay: PlanOverlay, liveTaskContents: ReadonlySet<string>): PlanOverlay {
  const subtasks: Record<string, PlanOverlaySubtask[]> = {};
  for (const [content, list] of Object.entries(overlay.subtasks)) {
    if (liveTaskContents.has(content)) subtasks[content] = list;
  }
  return {
    subtasks,
    autoCompleted: overlay.autoCompleted.filter((content) => liveTaskContents.has(content)),
    updatedAt: overlay.updatedAt,
  };
}

/** An overlay with nothing in it yet — what a session without one behaves as. */
export function emptyPlanOverlay(): PlanOverlay {
  return { subtasks: {}, autoCompleted: [], updatedAt: 0 };
}
