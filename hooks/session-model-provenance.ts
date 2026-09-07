export interface SmartModelProvenance {
  /** Concrete session identity; never infer source intent from a model value. */
  forSession: string;
  /** Omitted while an ensured Smart session has not reported its resolved model. */
  provider?: string;
  modelId?: string;
}

export interface ResolvedModel {
  provider: string;
  modelId: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Accept only explicit, session-scoped Smart provenance persisted by this UI. */
export function parseSmartModelProvenance(value: unknown): SmartModelProvenance | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SmartModelProvenance>;
  if (!nonEmptyString(candidate.forSession)) return null;
  if (candidate.provider !== undefined && !nonEmptyString(candidate.provider)) return null;
  if (candidate.modelId !== undefined && !nonEmptyString(candidate.modelId)) return null;
  if ((candidate.provider === undefined) !== (candidate.modelId === undefined)) return null;
  return candidate.provider === undefined
    ? { forSession: candidate.forSession }
    : { forSession: candidate.forSession, provider: candidate.provider, modelId: candidate.modelId };
}

/** The first authoritative model resolves an explicitly Smart session. */
export function resolveSmartModel(
  provenance: SmartModelProvenance | null,
  sessionId: string,
  model: ResolvedModel,
): SmartModelProvenance | null {
  if (!provenance || provenance.forSession !== sessionId) return provenance;
  return { forSession: sessionId, provider: model.provider, modelId: model.modelId };
}

/** Engine-driven model changes retain Smart provenance instead of looking manual. */
export function advanceSmartModelForAutomaticChange(
  provenance: SmartModelProvenance | null,
  sessionId: string,
  model: ResolvedModel,
): SmartModelProvenance | null {
  return resolveSmartModel(provenance, sessionId, model);
}

/** A failed manual model command must not erase truthful existing provenance. */
export function clearSmartModelAfterManualSelection(
  provenance: SmartModelProvenance | null,
  sessionId: string,
  accepted: boolean,
): SmartModelProvenance | null {
  if (!accepted || !provenance || provenance.forSession !== sessionId) return provenance;
  return null;
}

/** A stored record may only be restored by the session that owns it. */
export function smartModelForSession(
  provenance: SmartModelProvenance | null,
  sessionId: string | null | undefined,
): SmartModelProvenance | null {
  return sessionId && provenance?.forSession === sessionId ? provenance : null;
}
