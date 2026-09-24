"use client";

/**
 * The Providers directory's "Usage" block: one glance at every account's
 * quota without opening a single drawer. Sits above "Connected" and shows,
 * per account, the single most-binding window as a thin bar (a second,
 * quieter line only when another window is itself worth worrying about),
 * grouped by provider and ordered Primary/Secondary the same way the
 * composer numbers them (ascending credential id). OpenRouter has no
 * windows — a prepaid balance takes the bar's place. A provider Cody could
 * not read at all gets one muted footer line, never a row of its own.
 *
 * Pure and fetch-free: `buildUsageRows` / `buildOpenRouterRow` do the
 * grouping and window-picking, `UsageSummary` only renders what they return.
 * The container (ProviderDirectory) owns the two polling hooks and the
 * "provider id → open this row's drawer" lookup.
 */
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import type { OpenRouterAccountSnapshot } from "@/lib/openrouter/account";
import { providerBrand } from "@/lib/provider-brand";
import { selectBindingWindow } from "@/lib/usage/select";
import type { UsageAccount, UsageWindow } from "@/lib/usage/types";
import { clampQuotaPercent, QuotaBar, usageToneColor } from "@/components/QuotaBar";
import { ProviderTile, quietButtonStyle } from "./controls";

/** A window earns a second line only when it is itself binding enough to be
 * worth the extra row — otherwise one bar per account is the whole point. */
const SECOND_WINDOW_THRESHOLD = 70;

function fallbackProviderName(provider: string): string {
  return provider
    .trim()
    .split(/[-_]/g)
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .filter(Boolean)
    .join(" ");
}

/** The product name the owner knows a provider by ("Claude", not
 * "anthropic"), falling back to a title-cased id for anything the brand map
 * has no entry for (e.g. "alibaba-token-plan" → "Alibaba Token Plan"). */
export function providerDisplayName(provider: string): string {
  return providerBrand(provider)?.name ?? fallbackProviderName(provider);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

/** "resets 4:00 PM" today, "resets Thu 4:00 PM" once it crosses a day. */
function formatReset(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ts = at.getTime();
  if (!Number.isFinite(ts)) return null;
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay ? `resets ${time}` : `resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

interface WindowView {
  percent: number;
  color: string;
  exhausted: boolean;
  /** Set from one rejected request, not a measured reading. */
  blocked: boolean;
  resetText: string | null;
}

function toWindowView(window: UsageWindow): WindowView {
  const percent = clampQuotaPercent(window.utilization);
  return {
    percent,
    color: usageToneColor(percent, window.state),
    exhausted: window.state === "exhausted",
    blocked: window.source === "block",
    resetText: formatReset(window.resetsAt),
  };
}

/** The second-most-binding window of an account, other than the one already
 * shown, and only when it clears the threshold on its own — a healthy window
 * sitting at 12% is not news. */
function secondWindowOf(account: UsageAccount, primary: UsageWindow): UsageWindow | null {
  const rest = (account.windows ?? []).filter((window) => window.id !== primary.id);
  if (rest.length === 0) return null;
  const ranked = [...rest].sort((a, b) => {
    const rankOf = (window: UsageWindow) => (window.state === "exhausted" ? 2 : window.state === "warning" ? 1 : 0);
    const rankDiff = rankOf(b) - rankOf(a);
    if (rankDiff !== 0) return rankDiff;
    return (b.utilization ?? 0) - (a.utilization ?? 0);
  });
  const candidate = ranked[0];
  if (!candidate) return null;
  return candidate.state === "exhausted" || clampQuotaPercent(candidate.utilization) >= SECOND_WINDOW_THRESHOLD ? candidate : null;
}

export interface UsageAccountRow {
  key: string;
  provider: string;
  title: string;
  primary: WindowView;
  secondary: WindowView | null;
  /** Every window is a block: nothing measured this account, so the only
   * way to learn whether it recovered is to lift the block and try again. */
  blockedOnly: boolean;
}

/**
 * Groups accounts by provider, orders each group by ascending credential id
 * (the same order Settings and the composer both number Primary/Secondary
 * by — see `ProviderLoginAccount.position`), and picks each account's single
 * binding window plus an optional second one. An account with nothing to
 * report (no windows, or one omp has disabled outright) renders no row —
 * silence is the correct answer for "no data", not a bar frozen at 0%.
 */
export function buildUsageRows(accounts: readonly UsageAccount[]): UsageAccountRow[] {
  const order: string[] = [];
  const byProvider = new Map<string, UsageAccount[]>();
  for (const account of accounts) {
    if (account.disabled) continue;
    if (!account.windows || account.windows.length === 0) continue;
    const list = byProvider.get(account.provider);
    if (list) {
      list.push(account);
    } else {
      byProvider.set(account.provider, [account]);
      order.push(account.provider);
    }
  }

  const rows: UsageAccountRow[] = [];
  for (const provider of order) {
    const group = byProvider.get(provider)!;
    const ordered = [...group].sort((a, b) => (a.credentialId ?? Number.MAX_SAFE_INTEGER) - (b.credentialId ?? Number.MAX_SAFE_INTEGER));
    const name = providerDisplayName(provider);
    ordered.forEach((account, index) => {
      const binding = selectBindingWindow([account]);
      if (!binding) return;
      const second = secondWindowOf(account, binding.window);
      const title = ordered.length > 1
        ? `${name} · ${index === 0 ? "Primary" : index === 1 ? "Secondary" : `Account ${index + 1}`}`
        : name;
      rows.push({
        key: account.id,
        provider,
        title,
        primary: toWindowView(binding.window),
        secondary: second ? toWindowView(second) : null,
        blockedOnly: account.windows.every((window) => window.source === "block"),
      });
    });
  }
  return rows;
}

export interface UsageBalanceRow {
  provider: string;
  title: string;
  text: string;
  tone: "ok" | "warn" | "error";
}

/** OpenRouter reports no windows at all — its prepaid balance takes the
 * bar's place. `available: false` (no key configured) is a value, not an
 * error, so it renders nothing rather than an empty row. */
export function buildOpenRouterRow(snapshot: OpenRouterAccountSnapshot | null | undefined): UsageBalanceRow | null {
  if (!snapshot?.available || !snapshot.credits) return null;
  const remaining = snapshot.credits.remaining;
  const tone: UsageBalanceRow["tone"] = remaining <= 0 ? "error" : remaining < 2 ? "warn" : "ok";
  return {
    provider: "openrouter",
    title: providerDisplayName("openrouter"),
    text: `${formatUsd(remaining)} left`,
    tone,
  };
}

const BALANCE_TONE_COLOR: Record<UsageBalanceRow["tone"], string> = {
  ok: "var(--text)",
  warn: "var(--status-warning)",
  error: "var(--status-error)",
};

const rowStyle = (bordered: boolean) => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  minHeight: 28,
  padding: "5px 12px",
  border: "none",
  borderTop: bordered ? "1px solid var(--border)" : "none",
  background: "var(--bg-panel)",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left" as const,
  width: "100%",
  font: "inherit",
} as const);

function WindowLine({ view, muted = false }: { view: WindowView; muted?: boolean }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1, minWidth: 40 }}>
          <QuotaBar percent={view.percent} color={view.color} dimmed={muted && !view.exhausted} />
        </span>
        <span style={{
          flexShrink: 0,
          width: 32,
          textAlign: "right",
          fontSize: muted ? 10 : 11,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: muted && !view.exhausted ? "var(--text-muted)" : view.color,
        }}>
          {Math.round(view.percent)}%
        </span>
      </span>
      {(view.exhausted || view.resetText) && (
        <span style={{ fontSize: 10, color: view.exhausted ? "var(--status-error)" : "var(--text-muted)" }}>
          {view.exhausted ? (view.blocked ? "Blocked after a rejected request, not measured" : "Exhausted") : ""}{view.exhausted && view.resetText ? " · " : ""}{view.resetText ?? ""}
        </span>
      )}
    </span>
  );
}

export interface UsageSummaryProps {
  accounts: readonly UsageAccount[];
  openRouter?: OpenRouterAccountSnapshot | null;
  unavailableProviders?: readonly { provider: string; reason: string }[];
  /** Already-formatted ("Updated 1 min ago"); the container owns the clock. */
  updatedText?: string | null;
  refreshing?: boolean;
  onRefresh?: () => void;
  onOpenAccount?: (provider: string) => void;
  /** Lift a block that nothing measured; the next real request re-tests it. */
  onRetryBlock?: (provider: string, accountId: string) => void;
  /** Account id whose block is being lifted right now. */
  retryingAccountId?: string | null;
}

/** Pure: takes already-fetched data as props, never fetches itself. Renders
 * nothing at all when there is nothing to say — no empty "Usage" header. */
export function UsageSummary({
  accounts,
  openRouter = null,
  unavailableProviders = [],
  updatedText = null,
  refreshing = false,
  onRefresh,
  onOpenAccount,
  onRetryBlock,
  retryingAccountId = null,
}: UsageSummaryProps) {
  const rows = buildUsageRows(accounts);
  const balance = buildOpenRouterRow(openRouter);
  const reportedProviders = new Set(rows.map((row) => row.provider));
  if (balance) reportedProviders.add(balance.provider);
  const unavailable = unavailableProviders.filter((entry) => !reportedProviders.has(entry.provider));

  if (rows.length === 0 && !balance && unavailable.length === 0) return null;

  return (
    <section data-search-id="usage-summary" aria-label="Usage" style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)" }}>Usage</h4>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {updatedText && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{updatedText}</span>}
          {onRefresh && (
            <button type="button" className="ui-focus-ring" onClick={onRefresh} disabled={refreshing} aria-label="Refresh usage" style={{ ...quietButtonStyle, minHeight: 24, padding: "3px 7px" }}>
              {refreshing ? <Loader2 size={12} className="icon-spin" aria-hidden="true" /> : <RefreshCw size={12} aria-hidden="true" />}
            </button>
          )}
        </div>
      </div>

      {(rows.length > 0 || balance) && (
        <div role="list" style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden", background: "var(--bg-panel)" }}>
          {rows.map((row, index) => (
            <div key={row.key} role="listitem" style={{ display: "flex", alignItems: "center", minWidth: 0, borderTop: index > 0 ? "1px solid var(--border)" : undefined }}>
            <button
              type="button"
              className="usage-summary-row ui-focus-ring"
              onClick={() => onOpenAccount?.(row.provider)}
              style={{ ...rowStyle(false), flex: 1, minWidth: 0 }}
            >
              <span aria-hidden="true" className="usage-row-icon" style={{ display: "inline-flex", flexShrink: 0 }}>
                <ProviderTile brand={row.provider} size={18} />
              </span>
              <span className="usage-row-title" style={{ width: 140, flexShrink: 0, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.title}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <WindowLine view={row.primary} />
                {row.secondary && <WindowLine view={row.secondary} muted />}
              </span>
            </button>
            {row.blockedOnly && onRetryBlock && (
              <button
                type="button"
                className="ui-focus-ring"
                onClick={() => onRetryBlock(row.provider, row.key)}
                disabled={retryingAccountId === row.key}
                title="Lift the block so the next request tries this account again"
                style={{ ...quietButtonStyle, minHeight: 24, padding: "3px 8px", margin: "0 8px", fontSize: 11, whiteSpace: "nowrap" }}
              >
                {retryingAccountId === row.key ? "Retrying…" : "Retry now"}
              </button>
            )}
            </div>
          ))}
          {balance && (
            <button
              type="button"
              role="listitem"
              className="usage-summary-row ui-focus-ring"
              onClick={() => onOpenAccount?.(balance.provider)}
              style={rowStyle(rows.length > 0)}
            >
              <span aria-hidden="true" className="usage-row-icon" style={{ display: "inline-flex", flexShrink: 0 }}>
                <ProviderTile brand={balance.provider} size={18} />
              </span>
              <span className="usage-row-title" style={{ width: 140, flexShrink: 0, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {balance.title}
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: "right", fontSize: 12, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: BALANCE_TONE_COLOR[balance.tone] }}>
                {balance.text}
              </span>
            </button>
          )}
        </div>
      )}

      {unavailable.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          <AlertCircle size={12} aria-hidden="true" />
          <span>Usage unavailable for {unavailable.map((entry) => providerDisplayName(entry.provider)).join(", ")}.</span>
        </div>
      )}

      <style>{`
        @media (max-width: 520px) {
          .usage-summary-row {
            flex-wrap: wrap;
          }
          .usage-summary-row .usage-row-title {
            width: auto !important;
          }
        }
      `}</style>
    </section>
  );
}
