"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageView } from "@/components/MessageView";
import type { AssistantContentBlock, AssistantMessage } from "@/lib/types";
import { FIXTURE_REPLY, FIXTURE_THINKING } from "./fixture";

/**
 * /dev/stream-lab — regression harness for the Zed-style streaming model
 * (append raw text, re-parse the whole block's markdown every frame) that
 * replaced the old character-pacer animation. It replays a bundled markdown
 * transcript through the REAL MessageView at a selectable synthetic token
 * rate and reports frame timing while it runs, so a re-parse-per-frame
 * regression shows up as a rising long-frame count / p95 instead of a vague
 * "streaming felt janky" impression. Replaces the deleted /dev/stream-tuner,
 * which tuned the pacer this page no longer needs.
 */

type RateModeId = "r10" | "r40" | "r120" | "bursty" | "stall";

interface RateModeDef {
  id: RateModeId;
  label: string;
  delayMs: number;
  chars: number;
}

const RATE_MODES: RateModeDef[] = [
  { id: "r10", label: "10 chars / 16ms", delayMs: 16, chars: 10 },
  { id: "r40", label: "40 chars / 16ms", delayMs: 16, chars: 40 },
  { id: "r120", label: "120 chars / 16ms", delayMs: 16, chars: 120 },
  { id: "bursty", label: "Bursty (400 / 300ms)", delayMs: 300, chars: 400 },
  { id: "stall", label: "Stall (40/16ms + 1.5s pauses)", delayMs: 16, chars: 40 },
];

const STALL_MIN_GAP_CHARS = 500;
const STALL_GAP_JITTER_CHARS = 300;
const STALL_PAUSE_MS = 1500;
const LONG_FRAME_MS = 32;
const STATS_FLUSH_MS = 250;

type Phase = "idle" | "running" | "paused" | "done";

function contentAt(blockIndex: 0 | 1, offset: number): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [
    { type: "thinking", thinking: blockIndex === 0 ? FIXTURE_THINKING.slice(0, offset) : FIXTURE_THINKING },
  ];
  if (blockIndex === 1) {
    blocks.push({ type: "text", text: FIXTURE_REPLY.slice(0, offset) });
  }
  return blocks;
}

function messageAt(blockIndex: 0 | 1, offset: number): AssistantMessage {
  return { role: "assistant", model: "stream-lab", provider: "stream-lab", content: contentAt(blockIndex, offset) };
}

function computeP95(deltas: number[]): number {
  if (deltas.length === 0) return 0;
  const sorted = [...deltas].sort((a, b) => a - b);
  const idx = Math.floor(0.95 * (sorted.length - 1));
  return sorted[idx];
}

interface FrameStats {
  frames: number;
  longFrames: number;
  p95Ms: number;
  elapsedMs: number;
}

const EMPTY_STATS: FrameStats = { frames: 0, longFrames: 0, p95Ms: 0, elapsedMs: 0 };

const BUTTON_BASE = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
} as const;

const ACTIVE_BUTTON = {
  background: "var(--accent)",
  borderColor: "var(--accent)",
  color: "var(--on-accent)",
  fontWeight: 500,
} as const;

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 style={{ margin: "14px 0 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-dim)" }}>
      {children}
    </h3>
  );
}

export default function StreamLabPage() {
  const [rateMode, setRateMode] = useState<RateModeId>("r40");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<AssistantMessage>(() => messageAt(0, 0));
  const [stats, setStats] = useState<FrameStats>(EMPTY_STATS);

  // Reveal ticker state; refs so each tick reads the latest values, never a
  // stale closure from the render that scheduled it.
  const rateModeRef = useRef(rateMode);
  rateModeRef.current = rateMode;
  const blockIndexRef = useRef<0 | 1>(0);
  const offsetRef = useRef(0);
  const stallSinceGapRef = useRef(0);
  const stallNextGapRef = useRef(STALL_MIN_GAP_CHARS);
  const tickTimeoutRef = useRef<number | null>(null);

  // Frame monitor state.
  const rafIdRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const deltasRef = useRef<number[]>([]);
  const frameCountRef = useRef(0);
  const longFrameCountRef = useRef(0);
  const lastFlushRef = useRef(0);
  const runStartRef = useRef<number | null>(null);
  const pausedAccumRef = useRef(0);

  const clearTick = useCallback(() => {
    if (tickTimeoutRef.current !== null) {
      window.clearTimeout(tickTimeoutRef.current);
      tickTimeoutRef.current = null;
    }
  }, []);

  const stopFrameLoop = useCallback(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const flushStats = useCallback((now: number) => {
    const elapsedMs = pausedAccumRef.current + (runStartRef.current !== null ? now - runStartRef.current : 0);
    setStats({ frames: frameCountRef.current, longFrames: longFrameCountRef.current, p95Ms: computeP95(deltasRef.current), elapsedMs });
  }, []);

  const frameLoop = useCallback(
    (now: number) => {
      const last = lastFrameTimeRef.current;
      if (last !== null) {
        const delta = now - last;
        deltasRef.current.push(delta);
        frameCountRef.current += 1;
        if (delta > LONG_FRAME_MS) longFrameCountRef.current += 1;
      }
      lastFrameTimeRef.current = now;
      rafIdRef.current = window.requestAnimationFrame(frameLoop);
      if (now - lastFlushRef.current >= STATS_FLUSH_MS) {
        lastFlushRef.current = now;
        flushStats(now);
      }
    },
    [flushStats],
  );

  const startFrameLoopFresh = useCallback(() => {
    deltasRef.current = [];
    frameCountRef.current = 0;
    longFrameCountRef.current = 0;
    lastFrameTimeRef.current = null;
    pausedAccumRef.current = 0;
    const now = window.performance.now();
    runStartRef.current = now;
    lastFlushRef.current = now;
    setStats(EMPTY_STATS);
    stopFrameLoop();
    rafIdRef.current = window.requestAnimationFrame(frameLoop);
  }, [frameLoop, stopFrameLoop]);

  const pauseFrameLoop = useCallback(() => {
    stopFrameLoop();
    const now = window.performance.now();
    if (runStartRef.current !== null) {
      pausedAccumRef.current += now - runStartRef.current;
      runStartRef.current = null;
    }
    lastFrameTimeRef.current = null;
    flushStats(now);
  }, [stopFrameLoop, flushStats]);

  const resumeFrameLoop = useCallback(() => {
    runStartRef.current = window.performance.now();
    lastFrameTimeRef.current = null;
    stopFrameLoop();
    rafIdRef.current = window.requestAnimationFrame(frameLoop);
  }, [frameLoop, stopFrameLoop]);

  const resetFrameLoop = useCallback(() => {
    stopFrameLoop();
    runStartRef.current = null;
    lastFrameTimeRef.current = null;
    deltasRef.current = [];
    frameCountRef.current = 0;
    longFrameCountRef.current = 0;
    pausedAccumRef.current = 0;
    setStats(EMPTY_STATS);
  }, [stopFrameLoop]);

  const finishRun = useCallback(() => {
    clearTick();
    pauseFrameLoop();
    setPhase("done");
  }, [clearTick, pauseFrameLoop]);

  const tick = useCallback(() => {
    const def = RATE_MODES.find((m) => m.id === rateModeRef.current) ?? RATE_MODES[1];
    let blockIndex = blockIndexRef.current;
    let offset = offsetRef.current;
    let remaining = def.chars;
    while (remaining > 0) {
      const fullLen = blockIndex === 0 ? FIXTURE_THINKING.length : FIXTURE_REPLY.length;
      if (offset < fullLen) {
        const take = Math.min(remaining, fullLen - offset);
        offset += take;
        remaining -= take;
      } else if (blockIndex === 0) {
        blockIndex = 1;
        offset = 0;
      } else {
        break;
      }
    }
    blockIndexRef.current = blockIndex;
    offsetRef.current = offset;
    setMessage(messageAt(blockIndex, offset));

    const finished = blockIndex === 1 && offset >= FIXTURE_REPLY.length;
    if (finished) {
      finishRun();
      return;
    }

    let delay = def.delayMs;
    if (def.id === "stall") {
      stallSinceGapRef.current += def.chars;
      if (stallSinceGapRef.current >= stallNextGapRef.current) {
        stallSinceGapRef.current = 0;
        stallNextGapRef.current = STALL_MIN_GAP_CHARS + Math.random() * STALL_GAP_JITTER_CHARS;
        delay = STALL_PAUSE_MS;
      }
    }
    tickTimeoutRef.current = window.setTimeout(tick, delay);
  }, [finishRun]);

  const handleStart = useCallback(() => {
    clearTick();
    blockIndexRef.current = 0;
    offsetRef.current = 0;
    stallSinceGapRef.current = 0;
    stallNextGapRef.current = STALL_MIN_GAP_CHARS + Math.random() * STALL_GAP_JITTER_CHARS;
    setMessage(messageAt(0, 0));
    setPhase("running");
    startFrameLoopFresh();
    const def = RATE_MODES.find((m) => m.id === rateModeRef.current) ?? RATE_MODES[1];
    tickTimeoutRef.current = window.setTimeout(tick, def.delayMs);
  }, [clearTick, startFrameLoopFresh, tick]);

  const handlePauseResume = useCallback(() => {
    if (phase === "running") {
      clearTick();
      pauseFrameLoop();
      setPhase("paused");
    } else if (phase === "paused") {
      resumeFrameLoop();
      tickTimeoutRef.current = window.setTimeout(tick, 16);
      setPhase("running");
    }
  }, [phase, clearTick, pauseFrameLoop, resumeFrameLoop, tick]);

  const handleReset = useCallback(() => {
    clearTick();
    resetFrameLoop();
    blockIndexRef.current = 0;
    offsetRef.current = 0;
    stallSinceGapRef.current = 0;
    stallNextGapRef.current = STALL_MIN_GAP_CHARS;
    setMessage(messageAt(0, 0));
    setPhase("idle");
  }, [clearTick, resetFrameLoop]);

  useEffect(() => {
    return () => {
      clearTick();
      stopFrameLoop();
    };
  }, [clearTick, stopFrameLoop]);

  const canPauseResume = phase === "running" || phase === "paused";

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", color: "var(--text)" }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "20px 24px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>Stream lab</h1>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>regression harness · real MessageView, synthetic token feed</span>
          </div>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 16px" }}>
            Replays a bundled ~6KB transcript through the production message renderer at a chosen synthetic rate. Watch the frame monitor on the right while it streams.
          </p>
          <MessageView message={message} isStreaming={phase === "running"} thinkingDefaultExpanded activityDisplayMode="full" />
        </div>
      </div>

      <div style={{ width: 300, flexShrink: 0, overflowY: "auto", padding: "20px 16px", borderLeft: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <SectionTitle>Playback rate</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          {RATE_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setRateMode(mode.id)}
              style={{ ...BUTTON_BASE, ...(rateMode === mode.id ? ACTIVE_BUTTON : {}), textAlign: "left" }}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <SectionTitle>Controls</SectionTitle>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <button type="button" onClick={handleStart} style={{ ...BUTTON_BASE, ...ACTIVE_BUTTON, flex: 1 }}>
            {phase === "idle" ? "Start" : "Restart"}
          </button>
          <button
            type="button"
            onClick={handlePauseResume}
            disabled={!canPauseResume}
            style={{ ...BUTTON_BASE, flex: 1, opacity: canPauseResume ? 1 : 0.5, cursor: canPauseResume ? "pointer" : "default" }}
          >
            {phase === "paused" ? "Resume" : "Pause"}
          </button>
          <button type="button" onClick={handleReset} style={BUTTON_BASE}>
            Reset
          </button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12 }}>Phase: {phase}</div>

        <SectionTitle>Frame monitor</SectionTitle>
        <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)", lineHeight: 1.7 }}>
          Frames: {stats.frames} | Long frames (&gt;32ms): {stats.longFrames} | p95 frame time: {stats.p95Ms.toFixed(1)}ms | Elapsed: {(stats.elapsedMs / 1000).toFixed(1)}s
        </div>
      </div>
    </div>
  );
}
