import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

/**
 * Which models write Distill's summaries, and where the summaries are kept.
 *
 * This is CODY state, not the engine's: the chain lives in `cody-distill.json`
 * in the instance data dir (like lib/model-visibility.ts) and never in omp's
 * config.yml or its session files, so an engine upgrade, an engine switch or a
 * user rewriting their own roles cannot change or lose it.
 *
 * A chain entry is a model selector in the same dialect omp's roles use —
 * `provider/id` with an optional `:effort` suffix (see `splitSelector` in
 * components/settings/models/ModelRoles.tsx). chain[0] is the primary and the
 * rest are fallbacks in order. Validation is deliberately SYNTACTIC only:
 * Cody must not hold an opinion about which models exist, because the catalog
 * belongs to the engine and changes under it. A selector the engine no longer
 * knows simply fails its attempt and the next one is tried — see
 * lib/distill/runner.ts, where an unknown model, a non-zero exit and an empty
 * answer are one and the same case.
 *
 * An empty chain means "use the engine's own default" (no --model at all),
 * which is also where the chain falls through to once every entry has failed.
 */

export const DISTILL_FILE = "cody-distill.json";
/** Per-session summary caches live one directory down, one file per session. */
export const DISTILL_CACHE_DIRNAME = "cody-distill";
const FILE_VERSION = 1;

/**
 * Each entry is one model spawn attempt with its own timeout, so the chain
 * length is also the worst-case latency of a distill. Eight is far more
 * fallbacks than any real configuration needs and still bounds the wait.
 */
export const MAX_CHAIN_LENGTH = 8;
/** A selector is a routing string, not free text. */
const MAX_SELECTOR_LENGTH = 200;

export function getDistillConfigPath(): string {
  return path.join(getAgentDir(), DISTILL_FILE);
}

export function getDistillCacheDir(): string {
  return path.join(getAgentDir(), DISTILL_CACHE_DIRNAME);
}

/**
 * Syntax only: a non-empty `provider/id`-shaped string. Anything the engine
 * would reject is the engine's business, and it is reported by the attempt
 * failing rather than by refusing to save.
 */
export function isValidSelector(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SELECTOR_LENGTH) return false;
  if (/[\s\n\r]/.test(trimmed)) return false;
  const slash = trimmed.indexOf("/");
  // A selector needs both halves: "/gpt" and "openai/" name nothing.
  return slash > 0 && slash < trimmed.length - 1;
}

/**
 * The on-disk form: trimmed, deduplicated, ORDER PRESERVED (unlike the sorted
 * model-visibility lists — here the order is the fallback order), junk
 * dropped. Used when reading a file that may have been edited by hand.
 */
export function normalizeChain(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const value of values) {
    if (!isValidSelector(value)) continue;
    const trimmed = value.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    chain.push(trimmed);
    if (chain.length >= MAX_CHAIN_LENGTH) break;
  }
  return chain;
}

/** The write path's stricter reading: a caller sending a malformed selector is
 * told so instead of watching it silently vanish from the list it just saved. */
export function validateChain(value: unknown): { chain: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "chain must be an array of model selectors" };
  if (value.length > MAX_CHAIN_LENGTH) {
    return { error: `chain accepts at most ${MAX_CHAIN_LENGTH} models` };
  }
  for (const entry of value) {
    if (!isValidSelector(entry)) {
      return { error: `"${String(entry).slice(0, 60)}" is not a model selector (provider/id)` };
    }
  }
  return { chain: normalizeChain(value) };
}

/** Atomic 0600 JSON write, shared with the summary cache: a crash mid-write
 * must never leave a truncated file that reads as "no chain configured". */
export function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

/** The configured chain. Missing, unreadable or corrupt all mean the same
 * thing: nothing is configured, so the engine's default is used. */
export function readDistillChain(): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getDistillConfigPath(), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.chain)) return [];
  return normalizeChain(parsed.chain);
}

/** Replace the chain. Returns what was actually stored. */
export function writeDistillChain(chain: readonly string[]): string[] {
  const normalized = normalizeChain(chain);
  writeJsonAtomic(getDistillConfigPath(), { version: FILE_VERSION, chain: normalized });
  return normalized;
}
