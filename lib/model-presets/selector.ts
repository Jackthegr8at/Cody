/**
 * Pure selector helpers for editing a preset's roles and fallback chains in
 * the UI. Mirrors `ModelRoles.splitSelector`'s dialect (itself mirroring
 * `lib/model-plan/derive.ts`'s effort-suffix recognition) so a selector
 * reads the same whether the role picker, the chain editor or the research
 * review is the one splitting it — and mirrors `store.ts`'s own
 * `readRoles`/`updatePreset`: an empty or absent role entry means "inherit
 * the base config".
 *
 * Client-safe: no node imports, so this can be imported from "use client"
 * components and from a plain node test alike.
 */
import { isRecognizedThinkingSuffix } from "../model-plan/derive";

/** Sentinel for "inherit the base config" — what an absent or blank role
 *  entry already means to `ModelPreset.roles` and to the PUT route (a role
 *  present with `""` is dropped server-side, same as being absent). */
export const INHERIT = "";

export interface SplitSelector {
  model: string;
  level: string;
}

/**
 * Split `provider/modelId[:level]` into its model and reasoning level.
 * `knownSelectors` are exact selectors that must never be split (a model id
 * can itself contain a colon, e.g. `ollama/qwen3:8b`); everything else is
 * only split when the trailing segment is a level OMP would recognize.
 */
export function splitPresetSelector(raw: string, knownSelectors: ReadonlySet<string>): SplitSelector {
  if (!raw) return { model: "", level: "" };
  if (knownSelectors.has(raw)) return { model: raw, level: "" };
  const colon = raw.lastIndexOf(":");
  if (colon <= raw.lastIndexOf("/") || !isRecognizedThinkingSuffix(raw.slice(colon + 1))) {
    return { model: raw, level: "" };
  }
  return { model: raw.slice(0, colon), level: raw.slice(colon + 1) };
}

/** Inverse of `splitPresetSelector`. An empty model always joins back to
 *  the inherit sentinel, even if a level is somehow still set. */
export function joinPresetSelector(model: string, level: string): string {
  if (!model) return INHERIT;
  return level ? `${model}:${level}` : model;
}

/** A preset selector as the routing layer needs it. */
export interface ParsedPresetSelector {
  provider: string;
  modelId: string;
  /** The `:level` suffix when omp would recognize it as a reasoning level,
   *  else null — a model id may itself contain a colon (`qwen3:8b`, `:free`). */
  thinkingLevel: string | null;
}

/** Parse `provider/modelId[:level]` into provider, model id and reasoning
 *  level; null when there is no provider or no model id. The ONE parser for
 *  the server (Smart resolution) and the composer (preset hints). */
export function parsePresetSelector(selector: string): ParsedPresetSelector | null {
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) return null;
  const provider = selector.slice(0, slash);
  let modelId = selector.slice(slash + 1);
  let thinkingLevel: string | null = null;
  const colon = modelId.lastIndexOf(":");
  if (colon > 0 && isRecognizedThinkingSuffix(modelId.slice(colon + 1))) {
    thinkingLevel = modelId.slice(colon + 1);
    modelId = modelId.slice(0, colon);
  }
  return modelId ? { provider, modelId, thinkingLevel } : null;
}
