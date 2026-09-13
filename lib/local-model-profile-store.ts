import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import type { PromptProfileId } from "./local-model-profile";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

/**
 * The user's manual override of prompt-profile selection: "auto" (the
 * window-derived default from lib/local-model-profile.ts) or a pinned
 * `full`/`compact`/`minimal`, either globally or for one `provider/modelId`.
 *
 * This exists because window-derived selection is a heuristic, not a fact:
 * a model's advertised context window is not always trustworthy (a catalog
 * entry can lag reality, or a user may want the smaller prompt on a model
 * that technically fits the bigger one to leave more room for turns). The
 * override is Cody's own state — like lib/model-catalog-seen.ts and
 * lib/model-visibility.ts — so it lives in the instance data dir via
 * `getAgentDir()` and survives an engine switch or a catalog refresh.
 *
 * Unknown top-level keys are preserved on write: a future Cody version that
 * adds a sibling field to this file (the way `connectedProviders` was added
 * to ModelsData without breaking readers) must not have this store's own
 * write silently erase it.
 */

export const PROFILE_OVERRIDE_FILE = "cody-prompt-profile-overrides.json";
const FILE_VERSION = 1;

const PROFILE_OVERRIDE_VALUES: Record<PromptProfileOverrideValue, true> = { auto: true, full: true, compact: true, minimal: true };

export type PromptProfileOverrideValue = PromptProfileId | "auto";

export interface PromptProfileOverrides {
  /** Instance default. */
  default: PromptProfileOverrideValue;
  /** Per-model choices. An explicit "auto" is meaningful: it selects automatic
   * resolution for this model even if the instance default is pinned. */
  models: Record<string, PromptProfileOverrideValue>;
}

interface OverrideFile {
  version: number;
  default: PromptProfileOverrideValue;
  models: Record<string, PromptProfileOverrideValue>;
  /** Fields this version of Cody does not know about, round-tripped
   * verbatim so a newer version's data survives an older version's write. */
  [extra: string]: unknown;
}

export function isPromptProfileOverrideValue(value: unknown): value is PromptProfileOverrideValue {
  return typeof value === "string" && value in PROFILE_OVERRIDE_VALUES;
}

/** `provider/modelId`, the same dialect lib/model-visibility.ts and
 * lib/distill/config.ts use for a model key. Both halves are required —
 * "openai" alone or "/gpt" alone name nothing. */
export function isValidModelKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return false;
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1;
}

export function modelOverrideKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function getPromptProfileOverridePath(): string {
  return path.join(getAgentDir(), PROFILE_OVERRIDE_FILE);
}

function emptyFile(): OverrideFile {
  return { version: FILE_VERSION, default: "auto", models: {} };
}

function normalizeModels(value: unknown): Record<string, PromptProfileOverrideValue> {
  const models: Record<string, PromptProfileOverrideValue> = {};
  if (!isRecord(value)) return models;
  for (const [key, entry] of Object.entries(value)) {
    if (isValidModelKey(key) && isPromptProfileOverrideValue(entry)) models[key] = entry;
  }
  return models;
}

function readFile(): OverrideFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(getPromptProfileOverridePath(), "utf8"));
  } catch {
    // Missing, unreadable or corrupt all mean the same thing: no override
    // configured yet, so every model resolves purely from its window.
    return emptyFile();
  }
  if (!isRecord(parsed)) return emptyFile();
  const file: OverrideFile = {
    ...parsed,
    version: FILE_VERSION,
    default: isPromptProfileOverrideValue(parsed.default) ? parsed.default : "auto",
    models: normalizeModels(parsed.models),
  };
  return file;
}

/** Atomic 0600 write: a crash mid-write must never leave a truncated file
 * that reads as "every override cleared". */
function writeFile(file: OverrideFile): void {
  const target = getPromptProfileOverridePath();
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}

export function readPromptProfileOverrides(): PromptProfileOverrides {
  const file = readFile();
  return { default: file.default, models: { ...file.models } };
}

/** A model entry, including an explicit "auto", always takes precedence over
 * the instance default. This lookup intentionally knows nothing about catalog
 * metadata or whether a provider is local. */
export function resolvePromptProfileOverride(
  overrides: PromptProfileOverrides,
  provider: string,
  modelId: string,
): PromptProfileOverrideValue {
  const key = modelOverrideKey(provider, modelId);
  return Object.hasOwn(overrides.models, key) ? overrides.models[key]! : overrides.default;
}

export function writeGlobalPromptProfileOverride(value: PromptProfileOverrideValue): PromptProfileOverrides {
  const file = readFile();
  file.default = value;
  writeFile(file);
  return { default: file.default, models: { ...file.models } };
}

/** Persist every per-model value. "auto" means automatic selection for this
 * model, while an absent key is the separate inherit-the-instance-default state. */
export function writeModelPromptProfileOverride(
  provider: string,
  modelId: string,
  value: PromptProfileOverrideValue,
): PromptProfileOverrides {
  const file = readFile();
  file.models[modelOverrideKey(provider, modelId)] = value;
  writeFile(file);
  return { default: file.default, models: { ...file.models } };
}
