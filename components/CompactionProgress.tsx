"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { isCompactionActive, type CompactionProgressValue, type CompactionStatus } from "@/lib/compaction-status";

export { compactionStatusReducer, isCompactionActive } from "@/lib/compaction-status";
export type { CompactionOutcome, CompactionProgressValue, CompactionSource, CompactionStatus, CompactionStatusAction } from "@/lib/compaction-status";

function finitePercent(progress: CompactionProgressValue | undefined): number | null {
  if (!progress) return null;
  if (typeof progress.percent === "number" && Number.isFinite(progress.percent)) return Math.max(0, Math.min(100, progress.percent));
  if (typeof progress.completed === "number" && typeof progress.total === "number" && Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.total > 0) return Math.max(0, Math.min(100, (progress.completed / progress.total) * 100));
  return null;
}

function elapsedLabel(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`;
}

/** Shared accessible visual surface. Unknown engine progress remains visibly indeterminate. */
export function CompactionProgress({ status }: { status: CompactionStatus }) {
  const { t } = useI18n();
  const active = isCompactionActive(status);
  const startedAt = active ? status.startedAt : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  if (status.status === "idle") return null;

  const label = status.status === "pending" ? t("compaction.pending")
    : status.status === "running" ? (status.source === "automatic" ? t("compaction.automatic") : t("compaction.running"))
      : status.status === "completed" ? t("compaction.completed")
        : status.status === "noop" ? (status.message || t("compaction.nothingToCompact"))
          : status.status === "cancelled" ? t("compaction.cancelled")
            : status.status === "unsupported" ? t("compaction.unsupported") : t("compaction.failed");
  const detail = active ? [status.phase, elapsedLabel(startedAt, now)].filter(Boolean).join(" · ") : status.message;
  const percent = finitePercent(status.progress);
  const tone = status.status === "failed" ? "var(--status-error)" : status.status === "unsupported" ? "var(--status-warning)" : "var(--accent)";
  return (
    <div role="status" aria-live="polite" style={{ marginBottom: 8, padding: "7px 10px", borderRadius: 7, border: `1px solid color-mix(in srgb, ${tone} 28%, transparent)`, background: `color-mix(in srgb, ${tone} 7%, transparent)`, color: tone, fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}><span style={{ fontWeight: 600 }}>{label}</span>{detail && <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{detail}</span>}</div>
      {active && <div role="progressbar" aria-label={label} aria-valuemin={percent === null ? undefined : 0} aria-valuemax={percent === null ? undefined : 100} aria-valuenow={percent === null ? undefined : Math.round(percent)} aria-valuetext={percent === null ? detail || label : `${Math.round(percent)}%`} style={{ height: 3, overflow: "hidden", borderRadius: 999, background: "color-mix(in srgb, currentColor 18%, transparent)", marginTop: 7 }}><div style={{ width: percent === null ? "40%" : `${percent}%`, height: "100%", borderRadius: "inherit", background: "currentColor", animation: percent === null ? "compaction-progress-indeterminate 1.2s ease-in-out infinite" : undefined }} /></div>}
    </div>
  );
}
