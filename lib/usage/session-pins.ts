import { open } from "node:fs/promises";

/**
 * Which account served a conversation, read from omp's own record of it.
 *
 * After every assistant turn omp appends a `credential_pin` entry to the
 * session file whenever the account that served the turn changed
 * (src/session/credential-pin.ts): `{type, provider, hash, timestamp}`, where
 * `hash` digests the account's billing scope. The latest pin per provider is
 * therefore the account the conversation is actually on — the engine's own
 * answer, as opposed to a guess from quota headroom, which is biased AWAY from
 * the account in use (it has the most recent burn).
 *
 * Session files are append-only JSONL (the fixed-width title slot on line 1
 * is rewritten in place, never resized), so each file is scanned once and
 * afterwards only the bytes appended since are read. A file that shrank was
 * replaced, and is rescanned from the start.
 */

export interface SessionCredentialPin {
  /** omp's credential-pin digest (sha256 hex). */
  hash: string;
  /** When omp recorded it, or null. */
  timestamp: string | null;
}

interface PinScanState {
  /** Offset just past the last complete line consumed. */
  offset: number;
  pins: Map<string, SessionCredentialPin>;
}

declare global {
  var __codySessionPinScans: Map<string, PinScanState> | undefined;
}

const MAX_TRACKED_FILES = 64;
const CHUNK_BYTES = 1 << 20;
/** Cheap pre-filter so ordinary lines are never JSON-parsed. */
const PIN_MARKER = '"credential_pin"';

function scans(): Map<string, PinScanState> {
  if (!globalThis.__codySessionPinScans) globalThis.__codySessionPinScans = new Map();
  return globalThis.__codySessionPinScans;
}

/** Folds one JSONL line into `pins` when it is a well-formed pin entry. */
export function applyPinLine(line: string, pins: Map<string, SessionCredentialPin>): void {
  if (!line.includes(PIN_MARKER)) return;
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return; }
  if (!entry || typeof entry !== "object") return;
  const record = entry as Record<string, unknown>;
  if (record.type !== "credential_pin") return;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const hash = typeof record.hash === "string" && /^[0-9a-f]{64}$/.test(record.hash) ? record.hash : null;
  if (!provider || !hash) return;
  const timestamp = typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
    ? new Date(record.timestamp).toISOString()
    : null;
  // Entries are appended in time order, so the last one read wins.
  pins.set(provider, { hash, timestamp });
}

/**
 * The latest `credential_pin` per provider in one session file. Never throws:
 * an unreadable file answers with whatever was known (an empty map at first),
 * which callers treat as "this conversation has not used the provider".
 */
export async function readSessionCredentialPins(filePath: string): Promise<ReadonlyMap<string, SessionCredentialPin>> {
  const all = scans();
  let state = all.get(filePath);
  let handle;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    if (!state || size < state.offset) state = { offset: 0, pins: new Map() };
    if (size > state.offset) {
      // Split on the newline BYTE so the resume offset stays exact even when a
      // multibyte character straddles a chunk boundary.
      let pending: Buffer = Buffer.alloc(0);
      let position = state.offset;
      let consumed = state.offset;
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      while (position < size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const data = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          pending = Buffer.from(data);
          continue;
        }
        for (const line of data.toString("utf8", 0, lastNewline).split("\n")) applyPinLine(line, state.pins);
        pending = Buffer.from(data.subarray(lastNewline + 1));
        consumed = position - pending.length;
      }
      // A trailing partial line is left for the next read: omp may still be
      // writing it.
      state.offset = consumed;
    }
    // Re-insert so the Map's order is least-recently-used first.
    all.delete(filePath);
    all.set(filePath, state);
    while (all.size > MAX_TRACKED_FILES) {
      const oldest = all.keys().next().value;
      if (oldest === undefined) break;
      all.delete(oldest);
    }
    return state.pins;
  } catch {
    return state?.pins ?? new Map();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
