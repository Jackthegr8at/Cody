import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { stringify } from "yaml";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { atomicJsonWrite, getPreset, presetRoleNames } from "./store";
import type { ModelPreset } from "./types";

/**
 * Which preset each conversation runs on, and the config overlay that
 * applies it.
 *
 * A binding lives in `cody-session-presets.json` (session id → preset id).
 * No binding means base settings: an old conversation never starts running a
 * preset because the user picked one somewhere else.
 *
 * The overlay is a content-addressed YAML file handed to that conversation's
 * engine process ONLY, through `PI_CONFIG_FILES` (omp deep-merges config
 * layers per key — verified: an overlay's `modelRoles.default` wins while the
 * base config's other roles stay). A changed preset therefore yields a new
 * path, which is how a relaunch knows its settings moved. It carries
 * `modelRoles` (with `:level` reasoning suffixes), `retry.fallbackChains` and
 * `retry.usageAwareFallback` — nothing else, so the user's own config.yml
 * keeps deciding everything a preset does not name.
 */

const SESSIONS_FILE = "cody-session-presets.json";
const OVERLAY_DIRECTORY = "cody-model-presets";
const VERSION = 1;

interface StoredBindings {
  version: number;
  sessions: Record<string, string>;
}

function sessionsPath(): string {
  return path.join(getAgentDir(), SESSIONS_FILE);
}

function validSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000\r\n]/.test(value);
}

function readBindings(): StoredBindings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sessionsPath(), "utf8"));
  } catch {
    return { version: VERSION, sessions: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.sessions)) return { version: VERSION, sessions: {} };
  const sessions: Record<string, string> = {};
  for (const [sessionId, presetId] of Object.entries(parsed.sessions)) {
    if (validSessionId(sessionId) && typeof presetId === "string" && presetId) sessions[sessionId] = presetId;
  }
  return { version: VERSION, sessions };
}

function writeBindings(file: StoredBindings): void {
  atomicJsonWrite(sessionsPath(), file);
}

/** The preset id this conversation is bound to, or null for base settings.
 *  A binding to a preset that has since been deleted reads as base. */
export function readSessionPresetId(sessionId: string | undefined): string | null {
  if (!sessionId || !validSessionId(sessionId)) return null;
  const presetId = readBindings().sessions[sessionId];
  return presetId && getPreset(presetId) ? presetId : null;
}

export function setSessionPreset(sessionId: string, presetId: string | null): void {
  if (!validSessionId(sessionId)) throw new Error("Invalid session id.");
  if (presetId !== null && !getPreset(presetId)) throw new Error("That preset no longer exists.");
  const file = readBindings();
  if ((file.sessions[sessionId] ?? null) === presetId) return;
  if (presetId === null) delete file.sessions[sessionId];
  else file.sessions[sessionId] = presetId;
  writeBindings(file);
}

/** Move the pre-spawn binding onto omp's real session id. */
export function renameSessionPreset(fromSessionId: string, toSessionId: string): void {
  if (!validSessionId(fromSessionId) || !validSessionId(toSessionId) || fromSessionId === toSessionId) return;
  const file = readBindings();
  const presetId = file.sessions[fromSessionId];
  if (presetId === undefined) return;
  delete file.sessions[fromSessionId];
  file.sessions[toSessionId] = presetId;
  writeBindings(file);
}

/** A fork keeps its parent's preset; the parent keeps it too. */
export function copySessionPreset(fromSessionId: string, toSessionId: string): void {
  if (!validSessionId(fromSessionId) || !validSessionId(toSessionId) || fromSessionId === toSessionId) return;
  const file = readBindings();
  const presetId = file.sessions[fromSessionId];
  if (presetId === undefined) return;
  file.sessions[toSessionId] = presetId;
  writeBindings(file);
}

export function forgetSessionPreset(sessionId: string): void {
  if (!validSessionId(sessionId)) return;
  const file = readBindings();
  if (file.sessions[sessionId] === undefined) return;
  delete file.sessions[sessionId];
  writeBindings(file);
}

/** Ids of every conversation bound to `presetId`. */
export function sessionsOnPreset(presetId: string): string[] {
  return Object.entries(readBindings().sessions).filter(([, id]) => id === presetId).map(([sessionId]) => sessionId);
}

/** Drop every binding to a deleted preset: those chats go back to base. */
export function unbindPreset(presetId: string): number {
  const file = readBindings();
  const bound = Object.keys(file.sessions).filter((sessionId) => file.sessions[sessionId] === presetId);
  if (bound.length === 0) return 0;
  for (const sessionId of bound) delete file.sessions[sessionId];
  writeBindings(file);
  return bound.length;
}

/** The overlay document for a preset, or null when it sets nothing (an
 *  unconfigured preset runs exactly like base settings). Roles the engine no
 *  longer has are left out rather than written as unknown keys. */
export function presetOverlayDocument(preset: ModelPreset, roleNames: readonly string[] = presetRoleNames()): Record<string, unknown> | null {
  const modelRoles = Object.fromEntries(Object.entries(preset.roles).filter(([role]) => roleNames.includes(role)));
  const retry: Record<string, unknown> = {};
  if (Object.keys(preset.chains).length > 0) retry.fallbackChains = preset.chains;
  if (preset.usageAwareFallback !== undefined) retry.usageAwareFallback = preset.usageAwareFallback;
  const document: Record<string, unknown> = {};
  if (Object.keys(modelRoles).length > 0) document.modelRoles = modelRoles;
  if (Object.keys(retry).length > 0) document.retry = retry;
  return Object.keys(document).length > 0 ? document : null;
}

/** Whether two presets (or "no preset", as null) would materialize to the
 *  same overlay document. Compares the MATERIALIZED shape, not raw fields,
 *  key-order independent — so a name/intent/research-stamp-only edit (roles,
 *  chains and usageAwareFallback all untouched) reads as unchanged even
 *  though the ModelPreset objects themselves differ, and every chat bound to
 *  the preset is spared a restart it does not need. */
export function presetOverlayEquals(a: ModelPreset | null, b: ModelPreset | null, roleNames: readonly string[] = presetRoleNames()): boolean {
  return stableStringify(a ? presetOverlayDocument(a, roleNames) : null) === stableStringify(b ? presetOverlayDocument(b, roleNames) : null);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Write (once) and return the overlay path for a preset, or null. */
export function materializePresetOverlay(preset: ModelPreset): string | null {
  const document = presetOverlayDocument(preset);
  if (!document) return null;
  const digest = createHash("sha256").update(JSON.stringify({ version: VERSION, document })).digest("hex");
  const directory = path.join(getAgentDir(), OVERLAY_DIRECTORY);
  const overlayPath = path.join(directory, `${digest}.yml`);
  if (!existsSync(overlayPath)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${overlayPath}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, stringify(document), { mode: 0o600 });
    try {
      renameSync(temporary, overlayPath);
    } catch (error) {
      if (!existsSync(overlayPath)) throw error;
    }
  }
  return overlayPath;
}

/** The overlay path for this conversation's preset, or null (base settings,
 *  or a preset that sets nothing). Never throws: a broken preset store must
 *  cost the chat its preset, never its ability to start. */
export function sessionPresetOverlay(sessionId: string | undefined): string | null {
  try {
    const presetId = readSessionPresetId(sessionId);
    const preset = presetId ? getPreset(presetId) : null;
    return preset ? materializePresetOverlay(preset) : null;
  } catch {
    return null;
  }
}
