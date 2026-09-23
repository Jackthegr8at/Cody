"use client";

/**
 * The shared quota-bar primitive: a 4px pill track with a coloured fill,
 * pulled out of ChatInput so the composer's usage popover and Settings'
 * usage summaries (ProviderDirectory's "Usage" block, ProviderDetail's
 * per-account mini bar) all read a percentage with the same shape and the
 * same colour rule. `usageToneColor` (the percent→colour thresholds) lives in
 * `lib/format.ts` — re-exported here so a caller only needs one import for
 * "draw me a quota bar".
 */
import { usageToneColor } from "@/lib/format";

export { usageToneColor };

/** Percentages arriving from an engine are not always well-behaved (NaN,
 * negative, over 100 on a miscounted window) — every bar clamps before it
 * ever reaches CSS `width`. */
export function clampQuotaPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/** The one bar geometry every quota row shares: 4px track, pill radius. The
 *  de-emphasised rows dim the fill rather than changing shape, so the whole
 *  popover (or panel) reads as one system. */
export function QuotaBar({ percent, color, dimmed = false }: { percent: number; color: string; dimmed?: boolean }) {
  return (
    <div style={{ height: 4, overflow: "hidden", borderRadius: 999, background: "var(--border)" }}>
      <div style={{
        width: `${percent}%`,
        height: "100%",
        borderRadius: 999,
        background: color,
        opacity: dimmed ? 0.55 : 1,
        transition: "width var(--dur-med) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
      }} />
    </div>
  );
}
