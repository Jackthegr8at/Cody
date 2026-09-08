import type { AgentMessage } from "./types";

export type SessionActiveModelUseKind = "main" | "smart" | "subagent" | "fallback";

/** One reason a model belongs in this session's live usage picture. */
export interface SessionActiveModelUse {
  kind: SessionActiveModelUseKind;
  /** A localized conversation label or the human-readable subagent identity. */
  label: string;
}

/** A concrete provider/model pair currently or previously used by this session. */
export interface SessionActiveModel {
  provider: string;
  modelId: string;
  uses: SessionActiveModelUse[];
}

export interface SessionActiveModelsInput {
  /** Current session id; rejects persisted Smart state from another conversation. */
  sessionId?: string | null;
  liveModelMeta?: { provider?: unknown; modelId?: unknown } | null;
  smartPinnedModel?: { forSession?: unknown; provider?: unknown; modelId?: unknown } | null;
  subagents?: readonly {
    id?: unknown;
    agent?: unknown;
    progress?: {
      resolvedModel?: unknown;
      modelRole?: unknown;
      resolvedModelIsFallback?: unknown;
    };
  }[];
  autoModelSwitch?: {
    to?: unknown;
    role?: unknown;
    job?: { kind?: unknown; subagentId?: unknown; agent?: unknown };
  } | null;
  messages?: readonly AgentMessage[];
  /** Supplied by the caller so strings that cross the pure/UI boundary stay localized. */
  conversationLabel?: string;
}

const EXPLICIT_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Parse OMP's provider/model[:thinking-level] form without stripping real
 * model variants such as `:free`. The engine only appends a suffix for
 * explicit thinking levels, so every other colon remains part of the model id.
 */
export function parseResolvedSessionModel(value: unknown): { provider: string; modelId: string } | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator === raw.length - 1) return null;

  const provider = raw.slice(0, separator).trim();
  let modelId = raw.slice(separator + 1).trim();
  if (!provider || !modelId) return null;

  const suffixAt = modelId.lastIndexOf(":");
  if (suffixAt > 0 && suffixAt < modelId.length - 1) {
    const suffix = modelId.slice(suffixAt + 1).toLowerCase();
    if (EXPLICIT_THINKING_LEVELS.has(suffix)) modelId = modelId.slice(0, suffixAt);
  }
  return modelId ? { provider, modelId } : null;
}

function modelKey(provider: string, modelId: string): string {
  return provider.toLocaleLowerCase() + "\u0000" + modelId;
}

function addUse(
  models: Map<string, SessionActiveModel>,
  model: { provider: string; modelId: string } | null,
  use: SessionActiveModelUse,
): void {
  if (!model) return;
  const provider = nonEmptyString(model.provider);
  const modelId = nonEmptyString(model.modelId);
  const label = nonEmptyString(use.label);
  if (!provider || !modelId || !label) return;

  const key = modelKey(provider, modelId);
  const existing = models.get(key);
  if (!existing) {
    models.set(key, { provider, modelId, uses: [{ kind: use.kind, label }] });
    return;
  }
  if (!existing.uses.some((candidate) => candidate.kind === use.kind && candidate.label === label)) {
    existing.uses.push({ kind: use.kind, label });
  }
}

function subagentLabel(subagent: NonNullable<SessionActiveModelsInput["subagents"]>[number]): string {
  const agent = nonEmptyString(subagent.agent);
  const role = nonEmptyString(subagent.progress?.modelRole);
  const id = nonEmptyString(subagent.id);
  if (agent && role && agent !== role) return agent + " (" + role + ")";
  return agent ?? role ?? id ?? "subagent";
}

function fallbackLabel(
  input: SessionActiveModelsInput,
  conversationLabel: string,
): string {
  const job = input.autoModelSwitch?.job;
  if (job?.kind !== "subagent") return conversationLabel;
  const id = nonEmptyString(job.subagentId);
  const matchingSubagent = id
    ? input.subagents?.find((subagent) => nonEmptyString(subagent.id) === id)
    : undefined;
  return matchingSubagent ? subagentLabel(matchingSubagent) : nonEmptyString(job.agent) ?? id ?? "subagent";
}

/**
 * Derive the concrete models that have work attributable to THIS session.
 *
 * This intentionally joins live state with committed assistant history: a
 * model remains relevant after a turn settles, while live metadata, Smart
 * provenance, fallback frames, and child progress make in-flight routing
 * visible before that transcript exists. The result preserves first-seen model
 * order and deduplicates both provider/model identities and repeated uses.
 */
export function deriveSessionActiveModels(input: SessionActiveModelsInput): SessionActiveModel[] {
  const models = new Map<string, SessionActiveModel>();
  const conversationLabel = nonEmptyString(input.conversationLabel) ?? "this conversation";

  addUse(models, input.liveModelMeta
    ? { provider: input.liveModelMeta.provider as string, modelId: input.liveModelMeta.modelId as string }
    : null, { kind: "main", label: conversationLabel });

  const smart = input.smartPinnedModel;
  const smartSession = nonEmptyString(smart?.forSession);
  if (smart && (!input.sessionId || smartSession === input.sessionId)) {
    addUse(models, { provider: smart.provider as string, modelId: smart.modelId as string }, {
      kind: "smart",
      label: conversationLabel,
    });
  }

  for (const subagent of input.subagents ?? []) {
    const progress = subagent?.progress;
    const resolved = parseResolvedSessionModel(progress?.resolvedModel);
    if (!resolved) continue;
    addUse(models, resolved, {
      kind: progress?.resolvedModelIsFallback === true ? "fallback" : "subagent",
      label: subagentLabel(subagent),
    });
  }

  const switched = parseResolvedSessionModel(input.autoModelSwitch?.to);
  addUse(models, switched, { kind: "fallback", label: fallbackLabel(input, conversationLabel) });

  for (const message of input.messages ?? []) {
    if (message?.role !== "assistant") continue;
    addUse(models, { provider: message.provider, modelId: message.model }, { kind: "main", label: conversationLabel });
  }

  return [...models.values()];
}
