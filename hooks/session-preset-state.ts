/**
 * Pure decision logic for the composer's model-preset picker (Smart-only —
 * see AGENTS.md "Composer model + tools controls"). Kept apart from
 * `hooks/useSessionPreset.ts` so the picker's actual decisions (what the
 * trigger says, what a pending pick resolves to, what a new chat should
 * spawn with) are unit-testable without a DOM or a fetch mock.
 *
 * Contract with the server (`lib/model-presets/types.ts`, owned by Main):
 * presets only drive a conversation while it is on Smart; switching is
 * always an explicit user action, never re-applied automatically.
 */
import type { ParsedPresetSelector } from "../lib/model-presets/selector";

/** One preset as the composer's dropdown needs it. */
export interface ComposerPresetOption {
  id: string;
  name: string;
  /** The preset's `default` role, pre-split for display; null when the
   *  preset has not configured one yet, or the stored selector is malformed. */
  defaultModel: ParsedPresetSelector | null;
}

export interface PendingPresetPick {
  presetId: string | null;
  name: string;
}

/** The composer's Smart trigger label: plain "Smart" for Base settings (or
 *  before the active preset is known), "Smart · <preset name>" once a real
 *  preset is bound. Presets are user-named (built-ins default to Max/High/
 *  Medium/Low but may be renamed), so this always reads the CURRENT name —
 *  it never derives one from the id. */
export function formatSmartTriggerLabel(baseLabel: string, presetName: string | null | undefined): string {
  return presetName ? `${baseLabel} \u00b7 ${presetName}` : baseLabel;
}

/** A held pick, replacing whatever was pending — or clearing it outright
 *  when the user picks the preset THIS CHAT IS ALREADY RUNNING: there is
 *  then nothing left to switch to, pending or otherwise. Used both for a
 *  fresh 409 hold and for a later pick arriving while one is already held. */
export function nextPendingPresetPick(
  picked: PendingPresetPick,
  activePresetId: string | null,
): PendingPresetPick | null {
  return picked.presetId === activePresetId ? null : picked;
}

/**
 * What a chat with no explicit pick of its own should show as its active
 * preset — and, unchanged, exactly what a brand-new chat should send
 * `/api/agent/new` as `presetId`. The two are definitionally the same value:
 * whatever a new chat is ABOUT to spawn on is what it already shows as
 * "active" before it exists.
 *
 * `undefined` — meaning the field is OMITTED from the spawn body entirely —
 * until the preset list has genuinely loaded. The server records a PRESENT
 * `presetId` (even explicit `null`) as `lastUsedPresetId`, so guessing here
 * before the list answers would silently overwrite the user's real last pick
 * with a default they never chose.
 */
export function defaultPresetId(
  listLoaded: boolean,
  explicitPick: string | null | undefined,
  lastUsedPresetId: string | null,
): string | null | undefined {
  if (explicitPick !== undefined) return explicitPick;
  return listLoaded ? lastUsedPresetId : undefined;
}

/** The composer's pre-spawn Smart plan — see `newSessionSpawnPlan`'s doc. */
export interface NewSessionSpawnPlan {
  /** Whether this chat is spawning under Smart resolution at all. */
  smartSpawn: boolean;
  /** False to omit provider/modelId so a bound preset's `default` role
   *  decides the model instead of the caller's own base-config resolution
   *  (which `ensureNewSession` would otherwise send as the concrete model,
   *  overwriting the preset the composer shows — PresetReview finding
   *  "New Smart chats overwrite the chosen preset's default model"). */
  sendModel: boolean;
  /** False to omit thinkingLevel for the same reason: omp's set_model
   *  re-applies the target model's own default level regardless, so a
   *  level sent alongside a Smart preset spawn would only race it. */
  sendThinkingLevel: boolean;
  /** False when a manual pre-spawn reasoning-level pick means this chat is
   *  no longer Smart at all: it spawns plain, bound to no preset — an
   *  explicit pre-spawn MODEL pick is unaffected and keeps sending
   *  `presetId` (that chat keeps its preset for its subagents). */
  sendPresetId: boolean;
}

/**
 * What `ensureNewSession`'s POST /api/agent/new body should include for
 * model, thinking-level and preset fields, given the composer's pre-spawn
 * state — and, via `.smartSpawn`, whether this chat is on Smart at all
 * (`isAutoModelSelection` reads the same field so the two can never drift
 * apart). See preset-contract.md's client/server contract ("Client, for a
 * new chat spawning in Smart mode WITH a preset: POST /api/agent/new with
 * presetId and WITHOUT provider/modelId/profileTarget-driving fields...
 * Base-settings Smart spawns are unchanged").
 */
export function newSessionSpawnPlan(inputs: {
  /** An explicit model already picked for this new chat. */
  modelPicked: boolean;
  /** Local-only routing is active for this new chat. */
  localOnly: boolean;
  /** A reasoning level picked by hand before the chat has spawned — leaves
   *  Smart exactly like an explicit model pick does. */
  manualLevelPicked: boolean;
  /** What the composer's preset picker resolved for this new chat: a real
   *  preset id, Base settings (null), or not yet known (undefined). */
  presetId: string | null | undefined;
}): NewSessionSpawnPlan {
  const smartSpawn = !inputs.modelPicked && !inputs.localOnly && !inputs.manualLevelPicked;
  // Only a REAL preset id (not Base settings' null, not an unloaded
  // undefined) has an overlay `default` role to defer to.
  const smartPresetSpawn = smartSpawn && typeof inputs.presetId === "string";
  return {
    smartSpawn,
    sendModel: !smartPresetSpawn,
    sendThinkingLevel: !smartPresetSpawn,
    sendPresetId: !inputs.manualLevelPicked,
  };
}
