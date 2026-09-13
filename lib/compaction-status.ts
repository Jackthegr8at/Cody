export type CompactionSource = "manual" | "automatic";
export type CompactionOutcome = "completed" | "noop" | "failed" | "cancelled" | "unsupported";
export type CompactionProgressValue = { percent?: number; completed?: number; total?: number };

type ActiveCompactionStatus = {
  status: "pending" | "running";
  sessionId: string;
  source: CompactionSource;
  generation: number;
  startedAt: number;
  phase?: string;
  progress?: CompactionProgressValue;
};

export type CompactionStatus =
  | { status: "idle"; sessionId: string | null }
  | ActiveCompactionStatus
  | { status: CompactionOutcome; sessionId: string; source: CompactionSource; generation: number; startedAt: number; settledAt: number; phase?: string; message?: string; progress?: CompactionProgressValue };

export type CompactionStatusAction =
  | { type: "reset"; sessionId: string | null }
  | { type: "dismiss"; sessionId: string }
  | { type: "request"; sessionId: string; source: CompactionSource; now: number; generation?: number }
  | { type: "running"; sessionId: string; source: CompactionSource; now: number; generation?: number; phase?: string; progress?: CompactionProgressValue }
  | { type: "settle"; sessionId: string; outcome: CompactionOutcome; now: number; source?: CompactionSource; message?: string; phase?: string; progress?: CompactionProgressValue }
  | { type: "reconcile"; sessionId: string; active: boolean; now: number; observedAt?: number; generation?: number };

export function isCompactionActive(status: CompactionStatus): status is ActiveCompactionStatus {
  return status.status === "pending" || status.status === "running";
}

/** Shared session-scoped reducer for RPC and Direct API compaction events. */
export function compactionStatusReducer(state: CompactionStatus, action: CompactionStatusAction): CompactionStatus {
  if (action.type === "reset") return { status: "idle", sessionId: action.sessionId };
  if (action.type === "dismiss") return state.sessionId === action.sessionId ? { status: "idle", sessionId: action.sessionId } : state;
  if (state.sessionId !== null && state.sessionId !== action.sessionId) return state;
  switch (action.type) {
    case "request":
      return isCompactionActive(state) ? state : { status: "pending", sessionId: action.sessionId, source: action.source, generation: action.generation ?? 0, startedAt: action.now };
    case "running":
      return isCompactionActive(state)
        ? { ...state, status: "running", phase: action.phase ?? state.phase, progress: action.progress ?? state.progress }
        : { status: "running", sessionId: action.sessionId, source: action.source, generation: action.generation ?? 0, startedAt: action.now, phase: action.phase, progress: action.progress };
    case "settle": {
      const prior = isCompactionActive(state) ? state : null;
      if (prior && action.source && prior.source !== action.source) return state;
      return { status: action.outcome, sessionId: action.sessionId, source: prior?.source ?? action.source ?? "manual", generation: prior?.generation ?? 0, startedAt: prior?.startedAt ?? action.now, settledAt: action.now, phase: action.phase, message: action.message, progress: action.progress ?? prior?.progress };
    }
    case "reconcile":
      if (action.active) return isCompactionActive(state) ? { ...state, status: "running" } : { status: "running", sessionId: action.sessionId, source: "automatic", generation: action.generation ?? 0, startedAt: action.now };
      // A false snapshot never proves a manual request settled. Automatic
      // work clears only if the read belongs to the same monotonic generation;
      // a GET begun before a newer request is therefore rejected.
      // Manual work settles only by RPC response or observed terminal frames.
      if (isCompactionActive(state) && state.source === "automatic" && state.generation === (action.generation ?? state.generation) && (action.observedAt ?? action.now) >= state.startedAt) return { status: "idle", sessionId: action.sessionId };
      return state;
    default:
      return state;
  }
}
