/**
 * Model presets: named, per-conversation role configurations.
 *
 * A preset is a complete answer to "which model, at which reasoning level,
 * serves each omp role" — plus the fallback chains that go with it. Presets
 * live in Cody's own instance data dir (`cody-model-presets.json`), never in
 * omp's config.yml. A conversation bound to a preset gets it as a
 * `PI_CONFIG_FILES` overlay on ITS engine process only (see
 * lib/model-presets/overlay.ts), so one chat can run Max while another runs
 * Low, and the user's own config.yml is never rewritten by a switch.
 *
 * Contract with the composer: a preset drives a conversation's OWN model and
 * reasoning only while that conversation is on Smart. Picking a model or a
 * reasoning level by hand leaves Smart; the chat keeps its preset for its
 * subagents, and the preset picker is hidden until Smart is chosen again.
 *
 * Pure types: imported by server and client alike.
 */

/** Built-in preset ids. They can be edited and renamed, never deleted. */
export const BUILTIN_PRESET_IDS = ["max", "high", "medium", "low"] as const;
export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

/** omp roles that are not chat models (image generation, search, speech…).
 *  A preset never assigns them: they need a specific modality, and the user's
 *  base config keeps them. */
export const NON_CHAT_ROLES: readonly string[] = ["image", "web", "speech", "dictation", "judge"];

export interface PresetRationale {
  /** omp role id the note is about, or "overall". */
  role: string;
  text: string;
  /** Source URLs the research cited for this choice. */
  sources: string[];
}

/** Where a preset's current assignments came from. */
export interface PresetResearchStamp {
  runId: string;
  plannerModel: string;
  completedAt: string;
  rationale: PresetRationale[];
}

export interface ModelPreset {
  /** Built-ins use their BuiltinPresetId; custom presets a random id. */
  id: string;
  name: string;
  /** What the preset is for, in the user's words. Shown in the UI and given
   *  to the research planner as the tier's brief. */
  intent: string;
  builtIn: boolean;
  /**
   * role → omp selector, `provider/modelId` with an optional `:level`
   * reasoning suffix (`openai-codex/gpt-6-astra:high`). A role absent here
   * inherits the user's base config.yml. An empty object means the preset has
   * not been configured yet.
   */
  roles: Record<string, string>;
  /** `retry.fallbackChains` entries layered for this preset. */
  chains: Record<string, string[]>;
  /** `retry.usageAwareFallback`; undefined inherits the base config. */
  usageAwareFallback?: boolean;
  research?: PresetResearchStamp;
  updatedAt: string;
}

/** GET /api/model-presets */
export interface ModelPresetsResponse {
  presets: ModelPreset[];
  /** The preset a new chat starts on (the one last picked), or null for base settings. */
  lastUsedPresetId: string | null;
  /** Chat roles a preset may assign, in omp's order. */
  roleNames: string[];
  /** The user's base config.yml modelRoles, for "inherits: …" display. */
  baseRoles: Record<string, string>;
}

/** Body of PUT /api/model-presets/[id]; every field optional. */
export interface ModelPresetUpdate {
  name?: string;
  intent?: string;
  roles?: Record<string, string>;
  chains?: Record<string, string[]>;
  /** null clears the override (inherit base). */
  usageAwareFallback?: boolean | null;
  /** null clears the stamp (manual edits after research do NOT clear it). */
  research?: PresetResearchStamp | null;
}

/** What Smart resolves to for one conversation: the effective `default`
 *  role, split into the model and its reasoning level. */
export interface SmartDefault {
  provider: string;
  modelId: string;
  /** Reasoning level from the selector's `:level` suffix, or null to leave
   *  the engine's own default. */
  thinkingLevel: string | null;
}

/** GET/PUT /api/sessions/[id]/preset */
export interface SessionPresetResponse {
  presetId: string | null;
  smartDefault: SmartDefault | null;
  /** PUT only: whether the engine process was restarted onto the preset. */
  restarted?: boolean;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

export type ResearchSourceKind = "benchmark" | "review" | "forum" | "social" | "official" | "other";

export interface ResearchSource {
  url: string;
  title: string;
  kind: ResearchSourceKind;
}

export interface ModelEvidence {
  /** Roster selector (`provider/modelId`). */
  selector: string;
  /** One or two sentences: what the evidence says this model is good for. */
  verdict: string;
  strengths: string[];
  weaknesses: string[];
  sources: ResearchSource[];
}

export interface PresetProposal {
  roles: Record<string, string>;
  chains: Record<string, string[]>;
  usageAwareFallback: boolean;
  rationale: PresetRationale[];
  /** Validation notes (e.g. an unknown model replaced, a level clamped). */
  warnings: string[];
}

export interface ResearchResult {
  /** Overall conclusion in a few sentences. */
  summary: string;
  models: ModelEvidence[];
  /** presetId → proposal, for every preset the run was asked to fill. */
  proposals: Record<string, PresetProposal>;
}

export type ResearchProgressKind = "search" | "read" | "thinking" | "note" | "error";

export interface ResearchProgressItem {
  at: string;
  kind: ResearchProgressKind;
  text: string;
  url?: string;
}

export type ResearchStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ResearchRunSnapshot {
  id: string;
  status: ResearchStatus;
  plannerModel: string;
  presetIds: string[];
  startedAt: string;
  finishedAt: string | null;
  /** Newest last, bounded. */
  progress: ResearchProgressItem[];
  error?: string;
  result?: ResearchResult;
}

/** GET /api/model-presets/research */
export interface ResearchStateResponse {
  run: ResearchRunSnapshot | null;
  plannerCandidates: { selector: string; label: string; provider: string }[];
  suggested: string | null;
}
