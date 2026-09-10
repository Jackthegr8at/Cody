import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";

/**
 * Whether the plan keeper (lib/plan-keeper/keeper.ts) runs at all for this
 * Cody instance, and where its per-session overlay files live.
 *
 * This is CODY state, like Distill's chain (lib/distill/config.ts): a simple
 * on/off switch in the instance data dir, never in the engine's own config.yml
 * or session files, so an engine upgrade, an engine switch or a user editing
 * their own roles cannot change or lose it. Default is enabled — the keeper
 * is meant to be invisible until it does something, not an opt-in a user has
 * to discover first.
 */

export const PLAN_KEEPER_FILE = "cody-plan-keeper.json";
/** Per-session overlays live one directory down, one file per session. */
export const PLAN_KEEPER_OVERLAY_DIRNAME = "cody-plan";
const FILE_VERSION = 1;

export function getPlanKeeperConfigPath(): string {
  return path.join(getAgentDir(), PLAN_KEEPER_FILE);
}

export function getPlanKeeperOverlayDir(): string {
  return path.join(getAgentDir(), PLAN_KEEPER_OVERLAY_DIRNAME);
}

/** Atomic 0600 JSON write. Kept as its own copy (same body as
 * lib/distill/config.ts's) rather than a shared import: the two features
 * share no other code, and a crash mid-write must never leave either one's
 * file truncated. */
export function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

export interface PlanKeeperConfig {
  enabled: boolean;
}

/** Missing, unreadable or corrupt all mean the default: enabled. */
export function readPlanKeeperConfig(): PlanKeeperConfig {
  const configPath = getPlanKeeperConfigPath();
  if (!existsSync(configPath)) return { enabled: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { enabled: true };
  }
  if (!isRecord(parsed) || typeof parsed.enabled !== "boolean") return { enabled: true };
  return { enabled: parsed.enabled };
}

/** Replace the config. Returns what was actually stored. */
export function writePlanKeeperConfig(config: PlanKeeperConfig): PlanKeeperConfig {
  const normalized: PlanKeeperConfig = { enabled: config.enabled !== false };
  writeJsonAtomic(getPlanKeeperConfigPath(), { version: FILE_VERSION, enabled: normalized.enabled });
  return normalized;
}
