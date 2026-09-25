/**
 * Browser-safe fetch wrappers for the model-presets and research routes
 * (`app/api/model-presets/**`, owned by Main and ResearchPipeline — see
 * `local://preset-contract.md`). Nothing here imports `./store`: the store
 * is node-only (reads/writes the instance data dir) and importing it into
 * a "use client" bundle would either fail to build or drag node built-ins
 * into the browser, so every read and write goes over HTTP instead.
 */
import type {
  ModelPreset,
  ModelPresetsResponse,
  ModelPresetUpdate,
  ResearchRunSnapshot,
  ResearchStateResponse,
} from "./types";

export const MODEL_PRESETS_ROUTE = "/api/model-presets";
export const MODEL_PRESETS_RESEARCH_ROUTE = "/api/model-presets/research";

interface ApiErrorBody {
  error?: string;
  code?: string;
  run?: ResearchRunSnapshot;
}

/**
 * One HTTP failure from a model-presets or research route: the server's own
 * message, its machine-readable `code` when it sent one (`"builtin"`,
 * `"not_found"`, `"session_busy"`, `"research_running"`, …) and, for the
 * one route that answers 409 with the run already in flight
 * (`POST …/research`), that run — so a caller can recover by showing it
 * instead of just reporting an error.
 */
export class ModelPresetsApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly run?: ResearchRunSnapshot;

  constructor(message: string, opts: { status: number; code?: string; run?: ResearchRunSnapshot }) {
    super(message);
    this.name = "ModelPresetsApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.run = opts.run;
  }
}

async function parseBody<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
  throw new ModelPresetsApiError(body?.error || `HTTP ${response.status}`, { status: response.status, code: body?.code, run: body?.run });
}

function request<T>(input: string, init?: RequestInit): Promise<T> {
  const headers: HeadersInit = init?.body ? { "Content-Type": "application/json" } : {};
  return fetch(input, { ...init, headers: { ...headers, ...init?.headers }, cache: "no-store" }).then((response) => parseBody<T>(response));
}

export function fetchModelPresets(opts?: { signal?: AbortSignal }): Promise<ModelPresetsResponse> {
  return request<ModelPresetsResponse>(MODEL_PRESETS_ROUTE, { signal: opts?.signal });
}

export function createModelPreset(body: { name: string; intent?: string; copyFrom?: string }, opts?: { signal?: AbortSignal }): Promise<{ preset: ModelPreset }> {
  return request(MODEL_PRESETS_ROUTE, { method: "POST", body: JSON.stringify(body), signal: opts?.signal });
}

/** `restarted`/`active` count the preset's own bound chats the write just
 *  reached (idle ones restarted onto it now, active ones will at their next
 *  restart) — the same pair `ModelRoles`' save toasts about. */
export function updateModelPreset(id: string, body: ModelPresetUpdate, opts?: { signal?: AbortSignal }): Promise<{ preset: ModelPreset; restarted: number; active: number }> {
  return request(`${MODEL_PRESETS_ROUTE}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body), signal: opts?.signal });
}

export function deleteModelPreset(id: string, opts?: { signal?: AbortSignal }): Promise<{ ok: true; reassigned: number }> {
  return request(`${MODEL_PRESETS_ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE", signal: opts?.signal });
}

export function fetchResearchState(opts?: { signal?: AbortSignal }): Promise<ResearchStateResponse> {
  return request<ResearchStateResponse>(MODEL_PRESETS_RESEARCH_ROUTE, { signal: opts?.signal });
}

/** 202 on success; 409 `{code:"research_running", run}` when one is already
 *  in flight — `ModelPresetsApiError.run` carries that run so the caller can
 *  switch straight to watching it instead of surfacing a bare error. */
export function startResearch(body: { plannerModel: string; presetIds: string[] }, opts?: { signal?: AbortSignal }): Promise<{ run: ResearchRunSnapshot }> {
  return request(MODEL_PRESETS_RESEARCH_ROUTE, { method: "POST", body: JSON.stringify(body), signal: opts?.signal });
}

export function fetchResearchRun(runId: string, opts?: { signal?: AbortSignal }): Promise<{ run: ResearchRunSnapshot }> {
  return request(`${MODEL_PRESETS_RESEARCH_ROUTE}/${encodeURIComponent(runId)}`, { signal: opts?.signal });
}

export function cancelResearchRun(runId: string, opts?: { signal?: AbortSignal }): Promise<{ run: ResearchRunSnapshot }> {
  return request(`${MODEL_PRESETS_RESEARCH_ROUTE}/${encodeURIComponent(runId)}`, { method: "DELETE", signal: opts?.signal });
}

export function presetErrorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
