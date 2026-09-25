"use client";

/**
 * Client half of the composer's model-preset picker (Smart-only — see
 * AGENTS.md "Composer model + tools controls" and
 * `lib/model-presets/types.ts`'s module doc). Owns the two GETs
 * (`/api/model-presets`, `/api/sessions/[id]/preset`), the PUT that switches
 * a live chat's preset, and the 409 `session_busy` hold. Nothing else touches
 * model or reasoning level: that happens only in DIRECT response to a user
 * pick, via the `onSmartDefaultResolved` callback the caller supplies (wired
 * to the SAME `handleModelChange`/`handleThinkingLevelChange` paths a live
 * Smart pick already uses).
 *
 * The falling-edge resend of a HELD pick (the one automatic exception to
 * "presets never re-apply themselves") is the CALLER's job
 * (`components/ChatWindow.tsx`), via `retryPendingPick`: `useAgentSession`
 * (the source of `sessionBusy`) and this hook are siblings — `sessionBusy`
 * would be a synchronous cross-hook dependency this hook cannot take without
 * an ordering cycle (`newSessionPresetId` flows the other way, into
 * `useAgentSession`'s own spawn options) — so the edge is detected once, in
 * ChatWindow, exactly like ChatInput's own usage-refresh-on-falling-edge
 * effect.
 *
 * Reads route through `hooks/useSettingsData.ts`'s shared cache: a 400
 * `{code:"unsupported"}` (the active engine is not omp — see
 * `lib/engine-guard.ts`) is cached as a value, so this hides rather than
 * retrying a route the engine refused.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { translate } from "@/lib/i18n";
import type { ModelPreset, ModelPresetsResponse, SessionPresetResponse, SmartDefault } from "@/lib/model-presets/types";
import {
  defaultPresetId,
  nextPendingPresetPick,
  type ComposerPresetOption,
  type PendingPresetPick,
} from "./session-preset-state";
import { parsePresetSelector, type ParsedPresetSelector } from "@/lib/model-presets/selector";
import { SHARED_ROUTE_TTL_MS, invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "./useSettingsData";

const PRESETS_LIST_ROUTE = "/api/model-presets";

function sessionPresetRoute(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/preset`;
}

function toComposerOption(preset: ModelPreset): ComposerPresetOption {
  const selector = preset.roles.default;
  return { id: preset.id, name: preset.name, defaultModel: selector ? parsePresetSelector(selector) : null };
}

export interface UseSessionPresetResult {
  /** Every configured preset — "Base settings" is implicit (id null) and
   *  never included here. */
  presets: ComposerPresetOption[];
  /** The user's base config.yml `default` role, pre-split for the "Base
   *  settings" row's own muted hint. */
  baseDefaultModel: ParsedPresetSelector | null;
  /** This chat's bound preset; null = Base settings; undefined = not yet
   *  known (nothing preset-related renders while unknown). */
  activePresetId: string | null | undefined;
  /** A pick the engine deferred with 409 session_busy, held until the run
   *  ends. */
  pendingPick: PendingPresetPick | null;
  /** What a brand-new chat should send `/api/agent/new` as `presetId`;
   *  undefined omits the field entirely (see `defaultPresetId`'s doc). */
  newSessionPresetId: string | null | undefined;
  /** Switch this chat's preset (live session), or set what a new chat will
   *  spawn on (no session yet). `name` is the picked option's display name,
   *  used only for a pending hold's own label. A live switch attempted while
   *  the session is busy simply comes back 409 and is held the same way a
   *  race would hold it — no separate "are we streaming" check here. */
  pickPreset: (presetId: string | null, name: string) => void;
  /** Re-send a held pick. No-op without one. The caller invokes this AT the
   *  falling edge of a run — see this module's doc. */
  retryPendingPick: () => void;
}

export function useSessionPreset(opts: {
  /** capabilities.models — presets are an omp role overlay; an engine
   *  without a roles surface has nothing for them to configure. */
  capable: boolean;
  sessionId: string | null;
  /** The chat's engine may already be spawned (ensureNewSession resolved a
   *  real id) even while `sessionId` above is still null — a new chat's
   *  `session` prop lags spawn until the first send promotes it (see
   *  `hooks/useAgentSession.ts`'s `ensureNewSession`/`sessionIdRef`). A pick
   *  made in that window must still reach the live PUT below, not just
   *  update the pre-spawn picker state the spawn already consumed. Read via
   *  a ref-wrapping function (not a plain value): `useAgentSession` is
   *  called by `ChatWindow` AFTER this hook (its `newSessionPresetId` feeds
   *  `useAgentSession`'s own spawn options), so `sessionIdRef` does not
   *  exist yet at THIS hook's call site — see ChatWindow's own comment on
   *  that ordering constraint. */
  resolveSpawnedSessionId: () => string | null;
  onSmartDefaultResolved: (smartDefault: SmartDefault) => void;
}): UseSessionPresetResult {
  const { capable, sessionId, resolveSpawnedSessionId, onSmartDefaultResolved } = opts;

  const listRoute = useSettingsRoute<ModelPresetsResponse>(PRESETS_LIST_ROUTE, { enabled: capable, ttlMs: SHARED_ROUTE_TTL_MS });
  const liveRouteUrl = sessionId ? sessionPresetRoute(sessionId) : null;
  const liveRoute = useSettingsRoute<SessionPresetResponse>(liveRouteUrl, { enabled: capable && liveRouteUrl !== null });

  const presets = useMemo(() => (listRoute.data?.presets ?? []).map(toComposerOption), [listRoute.data]);
  const baseDefaultModel = useMemo(() => {
    const selector = listRoute.data?.baseRoles.default;
    return selector ? parsePresetSelector(selector) : null;
  }, [listRoute.data]);

  // Pre-spawn: no session yet, so nothing to PUT. An explicit pick here
  // overrides the list's lastUsedPresetId default; reset naturally on
  // remount (ChatWindow is keyed per session/new-chat — see AppShell).
  const [prespawnPick, setPrespawnPick] = useState<string | null | undefined>(undefined);
  const prespawnActivePresetId = defaultPresetId(listRoute.data !== null, prespawnPick, listRoute.data?.lastUsedPresetId ?? null);

  const activePresetId: string | null | undefined = sessionId
    ? (liveRoute.data ? liveRoute.data.presetId : undefined)
    : prespawnActivePresetId;

  const resolveSpawnedSessionIdRef = useRef(resolveSpawnedSessionId);
  resolveSpawnedSessionIdRef.current = resolveSpawnedSessionId;
  // The id an actual PUT should target: the promoted session, or — before
  // promotion — whatever the engine already spawned with.
  const liveSessionId = sessionId ?? resolveSpawnedSessionIdRef.current();

  const [pendingPick, setPendingPick] = useState<PendingPresetPick | null>(null);
  // A session switch is a different chat entirely: a hold from the PREVIOUS
  // one must never carry over and get resent against this one. Tracked by
  // the LIVE id (spawned-or-promoted), not the bare `sessionId` prop: a new
  // chat's OWN promotion — `sessionId` turning from null into the exact id
  // it already spawned with — is the SAME chat, and must never be mistaken
  // for a switch that wipes a hold the spawned-id PUT below just created.
  const pendingSessionRef = useRef(liveSessionId);
  if (pendingSessionRef.current !== liveSessionId) {
    pendingSessionRef.current = liveSessionId;
    if (pendingPick !== null) setPendingPick(null);
  }

  const activePresetIdRef = useRef(activePresetId);
  activePresetIdRef.current = activePresetId;
  const onSmartDefaultResolvedRef = useRef(onSmartDefaultResolved);
  onSmartDefaultResolvedRef.current = onSmartDefaultResolved;
  // Two picks issued close together (a double-click, or a resend racing a
  // fresh manual pick) can have their PUT responses land out of order. Each
  // call claims the next number; a 409-hold or error settling after a NEWER
  // call has already started must not touch `pendingPick` — the newer
  // call's own eventual response is the one that gets to decide what the
  // composer shows there. A SUCCESS is different: it is real server truth
  // about this chat's bound preset regardless of ordering, so it is always
  // applied — `dataSeqRef` only guards against an OLDER success regressing
  // state a newer one already applied (see `applyPick`; this is what keeps
  // a superseded-but-genuine success from leaving the composer stale).
  const pickSeqRef = useRef(0);
  const dataSeqRef = useRef(0);

  const applyPick = useCallback(async (sid: string, presetId: string | null, name: string) => {
    const seq = ++pickSeqRef.current;
    const isLatestPick = () => pickSeqRef.current === seq;
    try {
      const res = await fetch(sessionPresetRoute(sid), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId }),
      });
      if (res.status === 409) {
        if (isLatestPick()) setPendingPick(nextPendingPresetPick({ presetId, name }, activePresetIdRef.current ?? null));
        return;
      }
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        if (isLatestPick()) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
        return;
      }
      const data = body as SessionPresetResponse;
      // Real server truth for THIS chat's bound preset — apply it even once
      // a newer pick has been issued (that pick's own hold or success
      // supersedes it in turn when IT settles), so a hold from a busy newer
      // pick never leaves the composer showing whatever was active before
      // this one. Only an older success arriving after a newer one already
      // landed is dropped.
      if (seq > dataSeqRef.current) {
        dataSeqRef.current = seq;
        setSettingsRouteData(sessionPresetRoute(sid), data);
        // The switch also became this instance's lastUsedPresetId server-side.
        invalidateSettingsRoutes(PRESETS_LIST_ROUTE, { exact: true });
        if (data.smartDefault) onSmartDefaultResolvedRef.current(data.smartDefault);
      }
      if (isLatestPick()) setPendingPick(null);
    } catch (error) {
      if (isLatestPick()) {
        setPendingPick(null);
        toast.error(
          translate("chatInput.presetSwitchFailed", { name }),
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }, []);

  const pickPreset = useCallback((presetId: string | null, name: string) => {
    const sid = sessionId ?? resolveSpawnedSessionIdRef.current();
    if (!sid) {
      setPrespawnPick(presetId);
      return;
    }
    if (presetId === (activePresetIdRef.current ?? null)) {
      // Nothing to switch to — and cancels a stale hold whose target this
      // chat is already running.
      setPendingPick(null);
      return;
    }
    setPendingPick(null);
    void applyPick(sid, presetId, name);
  }, [sessionId, applyPick]);

  const retryPendingPick = useCallback(() => {
    const sid = sessionId ?? resolveSpawnedSessionIdRef.current();
    if (!sid || !pendingPick) return;
    if (pendingPick.presetId === (activePresetIdRef.current ?? null)) {
      setPendingPick(null);
      return;
    }
    void applyPick(sid, pendingPick.presetId, pendingPick.name);
  }, [sessionId, pendingPick, applyPick]);

  return {
    presets,
    baseDefaultModel,
    activePresetId,
    pendingPick,
    newSessionPresetId: sessionId ? undefined : prespawnActivePresetId,
    pickPreset,
    retryPendingPick,
  };
}
