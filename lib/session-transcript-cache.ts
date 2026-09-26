import type { AgentMessage, SessionTreeNode } from "./types";
import type { TodoPhase } from "./pi-types";

/**
 * Per-session, in-memory transcript cache: the last successfully loaded
 * transcript payload per session id, so switching back to a session already
 * viewed this page load repaints instantly (stale-while-revalidate) instead
 * of sitting on "Loading session…" while the whole transcript is fetched
 * again from scratch.
 *
 * Module-scoped so it survives AppShell's per-switch `key={sessionKey}`
 * remount of ChatWindow (and the useAgentSession instance inside it) — that
 * remount is intentional (see AppShell.tsx's session-select handlers), so
 * the cache has to live ABOVE the component that gets torn down and
 * recreated on every switch, not inside it.
 *
 * This is a structural copy of `SessionData` (hooks/useAgentSession.ts)
 * rather than an import of it: lib/ modules do not depend on hooks/, and
 * TypeScript's structural typing makes a `SessionData` value assignable here
 * with no cast needed.
 *
 * A cache hit is never treated as ground truth by itself — the caller always
 * re-fetches immediately after hydrating from it (stale-while-revalidate)
 * and overwrites this entry with the fresh response. A hit only removes the
 * blank/loading flash for however long that revalidation takes to land.
 */
export interface CachedSessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    todoPhases: TodoPhase[];
  };
}

interface CacheEntry {
  data: CachedSessionData;
  cachedAt: number;
}

// Bounded small: an entry can hold a full transcript (megabytes for a long
// session), and this is a raw in-memory Map with no eviction pressure other
// than this cap — unlike the server-side (path, size, mtime) caches, there is
// no natural upper bound from disk here.
const MAX_CACHED_SESSIONS = 12;

// Long enough to help a quick back-and-forth between a handful of sessions;
// short enough that a tab left open for hours does not repaint an ancient
// transcript for even the one frame before revalidation replaces it.
const MAX_CACHE_AGE_MS = 15 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

/**
 * Pure lookup: never mutates the cache (no eviction, no recency bump), so it
 * is safe to call directly from a component's render body or a `useState`
 * initializer, not just from effects/callbacks.
 */
export function getCachedSessionData(sessionId: string, now: number = Date.now()): CachedSessionData | undefined {
  const entry = cache.get(sessionId);
  if (!entry) return undefined;
  if (now - entry.cachedAt > MAX_CACHE_AGE_MS) return undefined;
  return entry.data;
}

/** Insert-or-replace, keeping Map iteration order as recency order (oldest
 * write first) so eviction below always drops the least-recently-WRITTEN
 * entry. Every cache hit is immediately followed by a revalidating fetch, so
 * "recency" only needs to track successful writes, not reads. */
export function setCachedSessionData(sessionId: string, data: CachedSessionData, now: number = Date.now()): void {
  cache.delete(sessionId);
  cache.set(sessionId, { data, cachedAt: now });
  while (cache.size > MAX_CACHED_SESSIONS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

export function clearCachedSessionData(sessionId: string): void {
  cache.delete(sessionId);
}

/** Test-only: drop every entry so tests never leak state into each other. */
export function __resetSessionTranscriptCacheForTests(): void {
  cache.clear();
}
