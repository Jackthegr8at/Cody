/**
 * Pure Local-only routing policy.  This module deliberately has no filesystem,
 * engine, or endpoint knowledge: callers prove candidate locality before they
 * arrive here, so provider names, model names, and price are never evidence.
 */

export const MAX_LOCAL_ROUTING_FALLBACKS = 8;
const MAX_REFERENCE_PART_LENGTH = 200;

export interface LocalModelReference {
  provider: string;
  modelId: string;
}

/** A candidate that has already been confirmed to use a local/private endpoint. */
export interface LocalRoutingCandidate extends LocalModelReference {
  contextWindow: number;
  maxTokens: number;
}

export interface LocalRoutingEnvelope {
  /** A matched pair from the tightest destination, never independent minima. */
  contextWindow: number;
  maxTokens: number;
}

export interface LocalRoutingConfig {
  primary: LocalModelReference | null;
  fallbacks: LocalModelReference[];
  /** Null means this installed role inherits the Local-only primary. */
  roles: Record<string, LocalModelReference | null>;
}

export interface LocalRoutingIntent {
  enabled: boolean;
  primary?: LocalModelReference;
  fallbackChain?: LocalModelReference[];
  roleModels?: Record<string, LocalModelReference>;
  envelope?: LocalRoutingEnvelope;
  /** Present only when Local-only was requested but cannot be safely applied. */
  error?: string;
}

export type LocalRoutingValidation =
  | { ok: true; config: LocalRoutingConfig; envelope: LocalRoutingEnvelope }
  | { ok: false; error: string };

export function localModelKey(model: LocalModelReference): string {
  return `${model.provider}/${model.modelId}`;
}

export function isLocalModelReference(value: unknown): value is LocalModelReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { provider, modelId } = value as Record<string, unknown>;
  return isReferencePart(provider) && isReferencePart(modelId);
}

function isReferencePart(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_REFERENCE_PART_LENGTH
    && value.trim() === value
    && !/[\s\r\n]/.test(value);
}

function isUsableCandidate(value: LocalRoutingCandidate): boolean {
  return Number.isSafeInteger(value.contextWindow)
    && Number.isSafeInteger(value.maxTokens)
    && value.contextWindow > value.maxTokens
    && value.maxTokens > 0;
}

function copyReference(value: LocalModelReference): LocalModelReference {
  return { provider: value.provider, modelId: value.modelId };
}

function normalizeFallbacks(value: unknown): LocalModelReference[] | null {
  if (!Array.isArray(value) || value.length > MAX_LOCAL_ROUTING_FALLBACKS) return null;
  const seen = new Set<string>();
  const refs: LocalModelReference[] = [];
  for (const item of value) {
    if (!isLocalModelReference(item)) return null;
    const reference = copyReference(item);
    const key = localModelKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(reference);
  }
  return refs;
}

/**
 * Chooses one real candidate whose input budget is the minimum across the
 * routing roster.  Taking min(window) and min(maxTokens) separately can invent
 * an envelope no destination actually has, which is unsafe for a fallback.
 */
export function tightestLocalRoutingEnvelope(candidates: readonly LocalRoutingCandidate[]): LocalRoutingEnvelope | null {
  const usable = candidates.filter(isUsableCandidate);
  if (usable.length !== candidates.length || usable.length === 0) return null;
  let tightest = usable[0];
  let smallestBudget = tightest.contextWindow - tightest.maxTokens;
  for (const candidate of usable.slice(1)) {
    const budget = candidate.contextWindow - candidate.maxTokens;
    if (budget < smallestBudget) {
      tightest = candidate;
      smallestBudget = budget;
    }
  }
  return { contextWindow: tightest.contextWindow, maxTokens: tightest.maxTokens };
}

/**
 * Validates a write against endpoint-confirmed candidates and the installed
 * engine roster.  Every primary, role target, and fallback must be one of
 * those candidates; nothing is inferred from an identifier.
 */
export function validateLocalRoutingConfig(
  value: unknown,
  candidates: readonly LocalRoutingCandidate[],
  roleIds: readonly string[],
): LocalRoutingValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "Local-only routing must be an object." };
  }
  const input = value as Record<string, unknown>;
  if (!isLocalModelReference(input.primary)) {
    return { ok: false, error: "Choose a configured local primary model; Local-only never falls back to cloud models." };
  }
  const fallbacks = normalizeFallbacks(input.fallbacks);
  if (!fallbacks) {
    return { ok: false, error: `Fallbacks must be an ordered list of at most ${MAX_LOCAL_ROUTING_FALLBACKS} local models.` };
  }
  if (typeof input.roles !== "object" || input.roles === null || Array.isArray(input.roles)) {
    return { ok: false, error: "Role assignments must be an object." };
  }

  const roster = new Set(roleIds);
  const assignedRoles: Record<string, LocalModelReference | null> = {};
  for (const [role, target] of Object.entries(input.roles as Record<string, unknown>)) {
    if (!roster.has(role)) return { ok: false, error: `"${role}" is not an installed model role.` };
    if (target !== null && !isLocalModelReference(target)) {
      return { ok: false, error: `Role "${role}" must select a local model or inherit the primary.` };
    }
    assignedRoles[role] = target === null ? null : copyReference(target);
  }

  const candidateByKey = new Map(candidates.map((candidate) => [localModelKey(candidate), candidate]));
  const primary = copyReference(input.primary);
  const targets = [primary, ...fallbacks, ...Object.values(assignedRoles).flatMap((target) => target ? [target] : [])];
  const unknown = targets.find((target) => !candidateByKey.has(localModelKey(target)));
  if (unknown) {
    return {
      ok: false,
      error: `${localModelKey(unknown)} is not a configured usable local model; Local-only will not fall back to cloud models.`,
    };
  }

  const effectiveRoleTargets = roleIds.map((role) => assignedRoles[role] ?? primary);
  const envelope = tightestLocalRoutingEnvelope(
    [...targets, ...effectiveRoleTargets].map((target) => candidateByKey.get(localModelKey(target))!),
  );
  if (!envelope) {
    return { ok: false, error: "Every Local-only destination needs a positive context window and output limit." };
  }

  const primaryKey = localModelKey(primary);
  return {
    ok: true,
    config: {
      primary,
      // Repeating the primary makes a retry loop, never a useful fallback.
      fallbacks: fallbacks.filter((fallback) => localModelKey(fallback) !== primaryKey),
      roles: assignedRoles,
    },
    envelope,
  };
}

/** Resolves every installed role eagerly so engine defaults never reach cloud configuration. */
export function resolveLocalRoutingIntent(
  config: LocalRoutingConfig,
  candidates: readonly LocalRoutingCandidate[],
  roleIds: readonly string[],
): LocalRoutingIntent {
  const validated = validateLocalRoutingConfig(config, candidates, roleIds);
  if (!validated.ok) return { enabled: false, error: validated.error };

  const roleModels: Record<string, LocalModelReference> = {};
  for (const role of roleIds) {
    roleModels[role] = copyReference(validated.config.roles[role] ?? validated.config.primary!);
  }
  return {
    enabled: true,
    primary: copyReference(validated.config.primary!),
    fallbackChain: validated.config.fallbacks.map(copyReference),
    roleModels,
    envelope: validated.envelope,
  };
}
