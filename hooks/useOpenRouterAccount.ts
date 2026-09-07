"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenRouterAccountSnapshot } from "@/lib/openrouter/account";
import { USAGE_ACTIVE_INTERVAL_MS, USAGE_BACKGROUND_INTERVAL_MS } from "./useUsage";

/**
 * Client state for the OpenRouter credit balance (GET /api/openrouter/account).
 *
 * Same cadence as `useUsage` — deliberately, so a composer showing both plan
 * quota and a credit balance refreshes them together instead of twitching on
 * two different clocks.
 *
 * `enabled` is the important parameter: this must poll ONLY when an OpenRouter
 * model is actually selected. An Anthropic-only user has no OpenRouter key,
 * and polling anyway would spend a request every 90 seconds to be told so.
 */

export interface UseOpenRouterAccountResult {
  snapshot: OpenRouterAccountSnapshot | null;
  loading: boolean;
  failed: boolean;
  /** Re-read from cache. */
  refresh: () => void;
  /** Bypass the server's 30s cache — "did my top-up land?". Resolves with the
   * fresh snapshot so a caller can compare balances itself. */
  refreshNow: () => Promise<OpenRouterAccountSnapshot | null>;
}

export function useOpenRouterAccount(enabled = true): UseOpenRouterAccountResult {
  const [snapshot, setSnapshot] = useState<OpenRouterAccountSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  // Held so `refreshNow` can resolve without being re-created on every poll.
  const cancelledRef = useRef(false);

  const refresh = useCallback(() => setRefreshVersion((version) => version + 1), []);

  const load = useCallback(async (force: boolean): Promise<OpenRouterAccountSnapshot | null> => {
    try {
      const response = await fetch(`/api/openrouter/account${force ? "?refresh=1" : ""}`, { cache: "no-store" });
      const value: unknown = await response.json();
      if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("OpenRouter account read failed.");
      }
      const next = value as OpenRouterAccountSnapshot;
      if (!cancelledRef.current) {
        setSnapshot(next);
        setFailed(false);
      }
      return next;
    } catch {
      if (!cancelledRef.current) setFailed(true);
      return null;
    }
  }, []);

  const refreshNow = useCallback(async () => {
    setLoading(true);
    try {
      return await load(true);
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        await load(false);
      } finally {
        inFlight = false;
        if (!cancelledRef.current) {
          setLoading(false);
          const active = document.visibilityState === "visible"
            && (typeof document.hasFocus === "function" ? document.hasFocus() : true);
          timer = setTimeout(poll, active ? USAGE_ACTIVE_INTERVAL_MS : USAGE_BACKGROUND_INTERVAL_MS);
        }
      }
    };

    const onFocus = () => { void poll(); };
    void poll();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, refreshVersion, load]);

  return { snapshot, loading, failed, refresh, refreshNow };
}
