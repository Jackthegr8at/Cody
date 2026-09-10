"use client";

/**
 * Client half of Distill: one small store over `POST /api/distill`, read by
 * the transcript.
 *
 * The route answers `text/event-stream` (one JSON object per `data:` line)
 * and always ends in exactly one terminal event — `done` carrying the FULL
 * text, or `error` carrying a code. Deltas are an optimization: a stream that
 * produces none still finishes with the whole answer in its `done`, so every
 * consumer here treats `done.text` as a replace and never depends on having
 * seen a delta.
 *
 * Everything is dormant-by-default and dormant-on-failure. Nothing is
 * requested unless the user asked for it AND `/api/distill/config` says the
 * active engine can serve it; any failure (an ACP engine, no model in the
 * chain, a dead child, a dropped stream) leaves the caller rendering the full
 * original text exactly as it does today. A distill is an addition to the
 * transcript, never a dependency of it.
 *
 * Two concurrency limits matter and both live here: the server runs at most
 * two distills, and the browser must not answer a scroll through a long
 * history by opening a dozen streams at once (HTTP/1.1 would starve the rest
 * of the app), so requests queue FIFO behind two in-flight fetches. A newer
 * request for a key supersedes an older one — aborting it if it started,
 * replacing it if it is still queued.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SHARED_ROUTE_TTL_MS, useSettingsRoute } from "@/hooks/useSettingsData";
import {
  getDistillPreferences,
  subscribeDistillPreferences,
  type DistillPreferences,
  type DistillReplyMode,
  type DistillVerbosity,
} from "@/lib/distill-preferences";

export const DISTILL_CONFIG_ROUTE = "/api/distill/config";

export interface DistillConfigPayload {
  supported: boolean;
  reason?: string;
  chain: string[];
  canManage: boolean;
}

export type DistillKind = "thinking" | "reply";
export type DistillErrorCode = "unsupported" | "no_model" | "failed" | "too_large";

export interface DistillState {
  status: "idle" | "running" | "done" | "error";
  /** The distilled text: streamed so far, or final. Empty until one arrives. */
  text: string;
  /** The source text this distillation was asked about — lets a consumer tell
   *  whether a summary still describes the block it is rendered under. */
  source: string;
  /** Selector the server actually used (the chain entry that answered). */
  model: string | null;
  /** Server cache hit: render at once, with no reveal animation. */
  cached: boolean;
  errorCode: DistillErrorCode | null;
}

export interface DistillRequest {
  /** Store key. `${sessionId}:${entryId ?? "live"}:${blockIndex}` for
   *  thinking, `${sessionId}:${entryId}:reply:${verbosity}` for replies. */
  key: string;
  sessionId: string;
  entryId?: string;
  blockIndex?: number;
  kind: DistillKind;
  text: string;
  verbosity?: DistillVerbosity;
  final: boolean;
}

const IDLE_DISTILL: DistillState = {
  status: "idle",
  text: "",
  source: "",
  model: null,
  cached: false,
  errorCode: null,
};

const MAX_CONCURRENT = 2;
/** Distilled answers are small; this bounds a long browsing session, not one
 *  transcript. Entries with a listener or a live run are never evicted. */
const MAX_ENTRIES = 240;

const ERROR_CODES: Record<string, DistillErrorCode> = {
  unsupported: "unsupported",
  no_model: "no_model",
  failed: "failed",
  too_large: "too_large",
};

interface Entry {
  state: DistillState;
  listeners: Set<() => void>;
  controller: AbortController | null;
  /** Queued but not started; replaced wholesale when superseded. */
  pending: DistillRequest | null;
  /** Most recent body, for de-duplication and for the retry affordance. */
  last: DistillRequest | null;
  runId: number;
}

const entries = new Map<string, Entry>();
const waiting: string[] = [];
let running = 0;

// ── Process-wide dormancy ─────────────────────────────────────────────────
// The engine answering `unsupported` (or the session no longer being ours)
// is a fact about the whole page, not about one message: latch it once so a
// transcript full of blocks stops asking.

let dormant = false;
const dormantListeners = new Set<() => void>();

const readDormant = () => dormant;
const readNotDormant = () => false;

function markDormant(): void {
  if (dormant) return;
  dormant = true;
  dormantListeners.forEach((listener) => listener());
}

function subscribeDormant(onChange: () => void): () => void {
  dormantListeners.add(onChange);
  return () => { dormantListeners.delete(onChange); };
}

/** Tests only: drop every distilled answer, queue entry and the latch. */
export function resetDistillStore(): void {
  for (const entry of entries.values()) entry.controller?.abort();
  entries.clear();
  waiting.length = 0;
  running = 0;
  dormant = false;
}

// ── Store ─────────────────────────────────────────────────────────────────

function ensureEntry(key: string): Entry {
  const existing = entries.get(key);
  if (existing) return existing;
  const created: Entry = {
    state: IDLE_DISTILL,
    listeners: new Set(),
    controller: null,
    pending: null,
    last: null,
    runId: 0,
  };
  entries.set(key, created);
  if (entries.size > MAX_ENTRIES) {
    for (const [oldKey, oldEntry] of entries) {
      if (oldEntry.listeners.size > 0 || oldEntry.controller !== null || oldEntry.pending !== null) continue;
      entries.delete(oldKey);
      if (entries.size <= MAX_ENTRIES) break;
    }
  }
  return created;
}

function setState(entry: Entry, patch: Partial<DistillState>): void {
  entry.state = { ...entry.state, ...patch };
  entry.listeners.forEach((listener) => listener());
}

/** What the transcript would render for a key right now. The hook's snapshot
 *  and the store's test seam are the same read, so a test observes exactly
 *  what a message observes. */
export function readDistillState(key: string | null): DistillState {
  if (key === null) return IDLE_DISTILL;
  return entries.get(key)?.state ?? IDLE_DISTILL;
}

function subscribeDistillState(key: string | null, onChange: () => void): () => void {
  if (key === null) return () => {};
  const entry = ensureEntry(key);
  entry.listeners.add(onChange);
  return () => { entry.listeners.delete(onChange); };
}

/**
 * Ask for a distillation. Identical to the last request for this key: a
 * no-op (so an effect may fire on every render without consequence).
 * Anything else supersedes what is in flight or queued for that key.
 */
export function requestDistill(request: DistillRequest): void {
  if (dormant) return;
  const entry = ensureEntry(request.key);
  const last = entry.last;
  if (last !== null
    && last.text === request.text
    && last.final === request.final
    && last.kind === request.kind
    && last.verbosity === request.verbosity) return;
  entry.last = request;
  entry.pending = request;
  if (entry.controller !== null) {
    entry.runId += 1;
    entry.controller.abort();
    entry.controller = null;
  }
  if (!waiting.includes(request.key)) waiting.push(request.key);
  pump();
}

/** Re-issue the last request for a key after a failure, clearing the error. */
export function retryDistill(key: string): void {
  const entry = entries.get(key);
  const last = entry?.last ?? null;
  if (entry === undefined || last === null) return;
  entry.last = null;
  setState(entry, { errorCode: null });
  requestDistill(last);
}

function pump(): void {
  while (running < MAX_CONCURRENT && waiting.length > 0) {
    const key = waiting.shift();
    if (key === undefined) return;
    const entry = entries.get(key);
    const request = entry?.pending ?? null;
    if (entry === undefined || request === null) continue;
    entry.pending = null;
    running += 1;
    void runDistill(entry, request);
  }
}

/** One `data:` line → its parsed object, or null for anything unrecognized
 *  (comments, keep-alives, a frame shape a future server sends). */
function parseSseData(line: string): Record<string, unknown> | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload === "") return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function runDistill(entry: Entry, request: DistillRequest): Promise<void> {
  const controller = new AbortController();
  entry.runId += 1;
  const runId = entry.runId;
  entry.controller = controller;
  // Text and model survive the transition on purpose: a thinking block being
  // re-summarized keeps showing the previous sentence until the new one
  // lands, instead of blinking back to the shimmer.
  setState(entry, { status: "running", source: request.text, cached: false, errorCode: null });
  let sawDelta = false;
  let terminal = false;
  try {
    const response = await fetch("/api/distill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: request.sessionId,
        entryId: request.entryId,
        blockIndex: request.blockIndex,
        kind: request.kind,
        text: request.text,
        verbosity: request.verbosity,
        final: request.final,
      }),
      signal: controller.signal,
    });
    if (entry.runId !== runId) return;
    if (!response.ok) {
      terminal = true;
      // A 4xx is about THIS request — a body the route rejected, a session it
      // will not read, an expired sign-in — and a Retry click cannot fix any
      // of them, so it stays silent (`unsupported` is the code consumers
      // render nothing for). 401/403 additionally settles the whole page:
      // asking again for every other block would be noise. A 5xx IS
      // transient, so it earns the retry footer.
      if (response.status === 401 || response.status === 403) markDormant();
      setState(entry, { status: "error", errorCode: response.status >= 500 ? "failed" : "unsupported" });
      return;
    }
    if (response.body === null) {
      // A 200 with nothing to read is a plumbing fault, not an answer.
      terminal = true;
      setState(entry, { status: "error", errorCode: "failed" });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const event = parseSseData(line);
        if (event === null) continue;
        if (entry.runId !== runId) return;
        if (event.type === "delta") {
          if (typeof event.text !== "string" || event.text === "") continue;
          setState(entry, { text: sawDelta ? entry.state.text + event.text : event.text });
          sawDelta = true;
        } else if (event.type === "done") {
          terminal = true;
          const full = typeof event.text === "string" && event.text !== "" ? event.text : entry.state.text;
          setState(entry, {
            status: "done",
            text: full,
            // "" means the engine's own default answered: Cody is never told
            // which model that was, so there is no name to show.
            model: typeof event.model === "string" && event.model !== "" ? event.model : null,
            cached: event.cached === true,
            errorCode: null,
          });
        } else if (event.type === "error") {
          terminal = true;
          // The server drops a queued thinking request when a newer one for
          // the same block arrives. That is not a failure: the newer answer
          // is already on its way, so the previous summary simply stays.
          if (event.message === "superseded") {
            setState(entry, { status: entry.state.text === "" ? "idle" : "done", errorCode: null });
            continue;
          }
          const code = typeof event.code === "string" ? ERROR_CODES[event.code] : undefined;
          if (code === "unsupported") markDormant();
          setState(entry, { status: "error", errorCode: code ?? "failed" });
        }
        // Any other frame shape is ignored: an engine or server that grows a
        // new event type must not break a transcript that is already correct.
      }
    }
  } catch {
    // Aborted (superseded), offline, or a stream that died mid-flight. The
    // `terminal` check below reports it once, quietly.
  } finally {
    running -= 1;
    if (entry.runId === runId) {
      entry.controller = null;
      if (!terminal) setState(entry, { status: "error", errorCode: "failed" });
    }
    pump();
  }
}

// ── Hooks ─────────────────────────────────────────────────────────────────

const readIdleState = () => IDLE_DISTILL;

export function useDistillState(key: string | null): DistillState {
  const subscribe = useCallback((onChange: () => void) => subscribeDistillState(key, onChange), [key]);
  const snapshot = useCallback(() => readDistillState(key), [key]);
  return useSyncExternalStore(subscribe, snapshot, readIdleState);
}

export function useDistillPreferences(): DistillPreferences {
  return useSyncExternalStore(subscribeDistillPreferences, getDistillPreferences, getDistillPreferences);
}

export interface DistillChatSettings {
  /** The engine can distill AND the user asked for something. */
  supported: boolean;
  replies: DistillReplyMode;
  thinking: boolean;
}

/**
 * What the transcript needs to know: the user's two preferences, and whether
 * the instance can serve them at all. The config route is only consulted once
 * a preference is on, so a user who never enables Distill never pays for it.
 */
export function useDistillChatSettings(): DistillChatSettings {
  const prefs = useDistillPreferences();
  const wanted = prefs.replies !== "off" || prefs.thinking;
  const config = useSettingsRoute<DistillConfigPayload>(DISTILL_CONFIG_ROUTE, { enabled: wanted, ttlMs: SHARED_ROUTE_TTL_MS });
  const gone = useSyncExternalStore(subscribeDormant, readDormant, readNotDormant);
  const supported = wanted && !gone && config.data?.supported === true;
  return useMemo(() => ({ supported, replies: prefs.replies, thinking: prefs.thinking }), [supported, prefs.replies, prefs.thinking]);
}

/**
 * A ref callback plus "this element has been on screen at least once".
 * History distills are driven by it, so opening a long session distills
 * nothing until the reader actually scrolls to a block.
 */
export function useSeenOnScreen(enabled: boolean): [(node: HTMLElement | null) => void, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!enabled || seen || node === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver((records) => {
      if (!records.some((record) => record.isIntersecting)) return;
      setSeen(true);
      observer.disconnect();
    }, { rootMargin: "200px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, seen, node]);
  return [setNode, seen];
}
