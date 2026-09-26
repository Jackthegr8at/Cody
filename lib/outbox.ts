/**
 * Per-session send outbox: client-side delivery reliability for the composer.
 *
 * The bug this replaces: the composer cleared only after the server ack, so a
 * slow or dropped ack left a message stuck in the input with no sign it had
 * (or had not) gone anywhere. Now every send becomes an entry here BEFORE the
 * network call — the composer clears immediately, and this entry's status
 * (sending → queued|started → delivered, or failed) is the only place the
 * text lives until the server has genuinely accepted it.
 *
 * Pure state machine and storage only: no network, no React, no i18n. The
 * HTTP call and the wiring into messages/queuedMessages live in
 * hooks/useAgentSession.ts; the chip UI lives in components/ChatInput.tsx.
 */

import { SESSION_STORAGE_PREFIXES } from "./storage-keys";

export type OutboxBehavior = "steer" | "followUp";
export type OutboxStatus = "sending" | "queued" | "started" | "delivered" | "failed";

export interface OutboxImage {
  data: string;
  mimeType: string;
  name?: string;
}

export interface OutboxEntry {
  /** Also the wire clientMessageId: the server's idempotency key. */
  id: string;
  sessionId: string;
  text: string;
  images: OutboxImage[];
  behavior: OutboxBehavior;
  status: OutboxStatus;
  /** Delivery attempts made so far (0 = never attempted yet). */
  attempt: number;
  /** Epoch ms a scheduled retry should fire, or null when none is pending. */
  nextRetryAt: number | null;
  /** Epoch ms the current retry streak began — reset by a manual Retry or a
   *  resume-after-reload, so either gives the entry a fresh give-up budget. */
  retryingSince: number;
  createdAt: number;
  /** Last retry/failure detail, for the failed chip. */
  error?: string;
}

/** Shared by the queue mirror match and delivery resolution: a delivered
 *  frame's text is compared against what was sent, ignoring incidental
 *  whitespace differences from the round trip. */
export function normalizeOutboxText(text: string): string {
  return text.trim();
}

export function createClientMessageId(): string {
  const cryptoObj = typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Fallback rfc4122-ish v4 uuid for environments without crypto.randomUUID.
  let hex = "";
  for (let i = 0; i < 32; i += 1) hex += Math.floor(Math.random() * 16).toString(16);
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createOutboxEntry(input: {
  sessionId: string;
  text: string;
  images?: OutboxImage[];
  behavior: OutboxBehavior;
  id?: string;
  now?: number;
}): OutboxEntry {
  const now = input.now ?? Date.now();
  return {
    id: input.id ?? createClientMessageId(),
    sessionId: input.sessionId,
    text: input.text,
    images: input.images ?? [],
    behavior: input.behavior,
    status: "sending",
    attempt: 0,
    nextRetryAt: null,
    retryingSince: now,
    createdAt: now,
  };
}

// ---- retry classification --------------------------------------------------

/** First retry delay after a failed attempt. */
const RETRY_BASE_DELAY_MS = 1_000;
/**
 * Ceiling for the doubling backoff AND the elapsed-time give-up budget (the
 * contract's "backoff up to ~2 min, then failed"): mirrors
 * `RECONNECT_MAX_DELAY_MS`/`RECONNECT_GIVE_UP_MS` in lib/stream-recovery.ts,
 * here collapsed into one constant because the two happen to coincide.
 */
export const OUTBOX_RETRY_MAX_MS = 120_000;

/** Delay before retry attempt `attempt` (1-based, the attempt that just
 *  failed): 1s, 2s, 4s, …, capped at OUTBOX_RETRY_MAX_MS. */
export function backoffDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, OUTBOX_RETRY_MAX_MS);
}

/** True once the current retry streak (since the entry was created, or since
 *  its last manual Retry/resume) has run longer than the budget — a stream
 *  that keeps failing stops being retried automatically and becomes a failed
 *  chip with a manual Retry, rather than looping forever. */
export function shouldGiveUpRetrying(entry: OutboxEntry, now: number = Date.now()): boolean {
  return now - entry.retryingSince >= OUTBOX_RETRY_MAX_MS;
}

/** The raw shape of one delivery attempt's result — deliberately decoupled
 *  from `fetch`/`Response` so this stays unit-testable with plain objects.
 *  `status: null` means the request never got a response at all (network
 *  error, abort, timeout). */
export interface RawDeliveryResponse {
  status: number | null;
  success?: boolean;
  pending?: boolean;
  code?: string;
  error?: string;
  data?: { delivery?: "started" | "queued" };
}

export type DeliveryOutcome =
  | { kind: "success"; delivery: "started" | "queued" }
  | { kind: "pending" }
  | { kind: "retry"; detail?: string }
  | { kind: "failed"; detail: string };

/**
 * Classifies one raw HTTP outcome per the send contract (local://send-contract.md):
 * network error, 202 pending, 409 session_restarting, and 503 are retried
 * with the same clientMessageId; everything else (including an ACP engine's
 * definitive session_busy) is a failure the outbox does not retry on its own.
 */
export function classifyDeliveryOutcome(response: RawDeliveryResponse): DeliveryOutcome {
  if (response.status === null) return { kind: "retry", detail: response.error };
  if (response.status === 200 && response.success) {
    return { kind: "success", delivery: response.data?.delivery === "queued" ? "queued" : "started" };
  }
  if (response.status === 202 && response.pending) return { kind: "pending" };
  if (response.status === 409 && response.code === "session_restarting") return { kind: "retry", detail: response.error };
  if (response.status === 503) return { kind: "retry", detail: response.error };
  return { kind: "failed", detail: response.error || response.code || `HTTP ${response.status}` };
}

// ---- entry-list transitions -------------------------------------------------
// Every function below is a pure `(entries) => entries` transform so the
// hook can pair it with a single React state setter and a single persist call.

/** Marks the start of one delivery attempt: bumps the attempt counter and
 *  clears any stale scheduled-retry timestamp. */
export function beginAttempt(entries: readonly OutboxEntry[], id: string): OutboxEntry[] {
  return entries.map((entry) => (entry.id === id
    ? { ...entry, attempt: entry.attempt + 1, nextRetryAt: null, status: "sending" as const }
    : entry));
}

export function applyOutcome(
  entries: readonly OutboxEntry[],
  id: string,
  outcome: DeliveryOutcome,
  now: number = Date.now(),
): OutboxEntry[] {
  return entries.map((entry): OutboxEntry => {
    if (entry.id !== id) return entry;
    switch (outcome.kind) {
      case "success":
        return { ...entry, status: outcome.delivery, nextRetryAt: null, error: undefined };
      case "pending":
        return shouldGiveUpRetrying(entry, now)
          ? { ...entry, status: "failed", nextRetryAt: null, error: entry.error }
          : { ...entry, nextRetryAt: now + backoffDelayMs(entry.attempt) };
      case "retry":
        return shouldGiveUpRetrying(entry, now)
          ? { ...entry, status: "failed", nextRetryAt: null, error: outcome.detail ?? entry.error }
          : { ...entry, nextRetryAt: now + backoffDelayMs(entry.attempt), error: outcome.detail ?? entry.error };
      case "failed":
        return { ...entry, status: "failed", nextRetryAt: null, error: outcome.detail };
    }
  });
}

/** A user-initiated Retry on a failed entry: re-arms it for an immediate
 *  attempt with a fresh give-up budget, keeping the same clientMessageId
 *  (the point of the whole design). */
export function retryEntry(entries: readonly OutboxEntry[], id: string, now: number = Date.now()): OutboxEntry[] {
  return entries.map((entry) => (entry.id === id
    ? { ...entry, status: "sending" as const, attempt: 0, nextRetryAt: null, retryingSince: now, error: undefined }
    : entry));
}

/**
 * A delivered user message (message_end) resolves the FIRST still-open entry
 * (any status but "delivered") whose normalized text matches — mirroring the
 * existing queue mirror's `indexOf`-first-match semantics. A entry that had
 * already given up as "failed" is still eligible: hard proof of delivery
 * outranks a client-side timeout.
 */
export function resolveDelivered(
  entries: readonly OutboxEntry[],
  text: string,
): { entries: OutboxEntry[]; resolvedId: string | null } {
  const target = normalizeOutboxText(text);
  const index = entries.findIndex((entry) => entry.status !== "delivered" && normalizeOutboxText(entry.text) === target);
  if (index === -1) return { entries: entries as OutboxEntry[], resolvedId: null };
  const resolvedId = entries[index].id;
  const next = entries.map((entry, i) => (i === index ? { ...entry, status: "delivered" as const, nextRetryAt: null } : entry));
  return { entries: next, resolvedId };
}

/** Edit on a failed chip: hand the entry back to the caller (to repopulate
 *  the composer with its text + images) and drop it from the outbox — the
 *  next Enter creates a fresh entry/clientMessageId, exactly like any send. */
export function restoreForEdit(entries: readonly OutboxEntry[], id: string): { entry: OutboxEntry | null; entries: OutboxEntry[] } {
  const entry = entries.find((candidate) => candidate.id === id) ?? null;
  return { entry, entries: entries.filter((candidate) => candidate.id !== id) };
}

/** Prepares a persisted outbox for a fresh mount/session-switch-back: a
 *  reload can never know whether an in-flight "sending" attempt actually
 *  reached the server, so every unfinished entry (anything but delivered or
 *  failed) is re-armed with a fresh give-up budget for an immediate resume
 *  attempt, rather than trusting a stale backoff clock or an elapsed streak
 *  that ran out while nobody was watching. Entries already given up as
 *  failed stay failed — only an explicit Retry restarts those. */
export function reviveForResume(entries: readonly OutboxEntry[], now: number = Date.now()): OutboxEntry[] {
  return entries
    .filter((entry) => entry.status !== "delivered")
    .map((entry) => (entry.status === "failed"
      ? entry
      : { ...entry, status: "sending" as const, attempt: 0, nextRetryAt: null, retryingSince: now }));
}

// ---- persistence (sessionStorage; best-effort, size-bounded) ---------------

/** Generous enough for several image-laden entries (the 900 KiB single-frame
 *  budget becomes ~1.2 MB of base64) while leaving room under a typical
 *  sessionStorage quota for the other keys this app already keeps there. */
const OUTBOX_STORAGE_MAX_CHARS = 3_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutboxImage(value: unknown): value is OutboxImage {
  return isPlainObject(value)
    && typeof value.data === "string"
    && typeof value.mimeType === "string"
    && (value.name === undefined || typeof value.name === "string");
}

const OUTBOX_STATUSES: readonly OutboxStatus[] = ["sending", "queued", "started", "delivered", "failed"];

function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!isPlainObject(value)) return false;
  return typeof value.id === "string"
    && typeof value.sessionId === "string"
    && typeof value.text === "string"
    && Array.isArray(value.images) && value.images.every(isOutboxImage)
    && (value.behavior === "steer" || value.behavior === "followUp")
    && typeof value.status === "string" && OUTBOX_STATUSES.includes(value.status as OutboxStatus)
    && typeof value.attempt === "number"
    && (value.nextRetryAt === null || typeof value.nextRetryAt === "number")
    && typeof value.retryingSince === "number"
    && typeof value.createdAt === "number"
    && (value.error === undefined || typeof value.error === "string");
}

export function serializeOutboxEntries(entries: readonly OutboxEntry[]): string {
  return JSON.stringify(entries);
}

/** Malformed or foreign JSON (a stale shape from a previous version, a
 *  quota-truncated write) degrades to an empty outbox rather than throwing —
 *  a corrupt mirror must never break the composer. */
export function deserializeOutboxEntries(raw: string): OutboxEntry[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isOutboxEntry);
  } catch {
    return [];
  }
}

export function readPersistedOutbox(sessionId: string): OutboxEntry[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_PREFIXES.outbox + sessionId);
    return raw ? deserializeOutboxEntries(raw) : [];
  } catch {
    return [];
  }
}

/** Read → apply → persist in one call, so every caller that transitions a
 *  session's outbox (a fresh send, a delivery outcome, a manual Retry, a
 *  delivered resolution) does it against the current on-disk state without
 *  repeating the read/persist plumbing at each call site. Returns the
 *  resulting entries so the caller can also update live React state when
 *  this is the currently-displayed session. */
export function mutatePersistedOutbox(sessionId: string, updater: (entries: OutboxEntry[]) => OutboxEntry[]): OutboxEntry[] {
  const next = updater(readPersistedOutbox(sessionId));
  persistOutbox(sessionId, next);
  return next;
}

/** Delivered entries are transient (the chip is about to disappear) and are
 *  never persisted at all; everything else is kept, trimming images off the
 *  oldest entries first and finally dropping the oldest entries outright if
 *  the payload still will not fit the bound — mirrors persistQueue's
 *  size-bounded, best-effort strategy in hooks/useAgentSession.ts. */
export function persistOutbox(sessionId: string, entries: readonly OutboxEntry[]): void {
  try {
    if (typeof window === "undefined") return;
    const key = SESSION_STORAGE_PREFIXES.outbox + sessionId;
    const live = entries.filter((entry) => entry.status !== "delivered");
    if (live.length === 0) {
      window.sessionStorage.removeItem(key);
      return;
    }
    let payload = live;
    let raw = serializeOutboxEntries(payload);
    let index = 0;
    while (raw.length > OUTBOX_STORAGE_MAX_CHARS && index < payload.length) {
      if (payload[index].images.length > 0) {
        payload = payload.map((entry, i) => (i === index ? { ...entry, images: [] } : entry));
        raw = serializeOutboxEntries(payload);
      }
      index += 1;
    }
    while (raw.length > OUTBOX_STORAGE_MAX_CHARS && payload.length > 1) {
      payload = payload.slice(1);
      raw = serializeOutboxEntries(payload);
    }
    if (raw.length > OUTBOX_STORAGE_MAX_CHARS) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, raw);
  } catch {
    // Best-effort only (quota exceeded, private mode, SSR).
  }
}

export function clearPersistedOutbox(sessionId: string): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(SESSION_STORAGE_PREFIXES.outbox + sessionId);
  } catch {
    // ignore storage errors
  }
}
