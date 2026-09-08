export interface SessionControlScope {
  sessionId: string | null;
  provider: string | null;
  modelId: string | null;
}

export type ScopedModel = { provider: string; modelId: string } | null | undefined;

/** A session control reply may only update the session/model that sent it. */
export function sessionControlScope(sessionId: string | null, model: ScopedModel): SessionControlScope {
  return {
    sessionId,
    provider: model?.provider ?? null,
    modelId: model?.modelId ?? null,
  };
}

export function sameSessionControlScope(left: SessionControlScope, right: SessionControlScope): boolean {
  return left.sessionId === right.sessionId
    && left.provider === right.provider
    && left.modelId === right.modelId;
}

/** Only the engine's explicit Fast capability rejection disables its control. */
export function isFastModeUnavailableError(error: unknown): boolean {
  const record = typeof error === "object" && error !== null ? error as { code?: unknown } : null;
  if (record?.code === "unsupported") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fast mode is unavailable for the current model/i.test(message);
}
