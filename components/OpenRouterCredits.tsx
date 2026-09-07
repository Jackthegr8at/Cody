"use client";

/**
 * The OpenRouter credit section of the composer's usage popover.
 *
 * Why this is a section and not another `QuotaWindowRow`: every other provider
 * in that popover sells a SUBSCRIPTION, and `QuotaBar` is built for one — a
 * percentage of a window that refills at a known time. OpenRouter sells a
 * PREPAID BALANCE. It does not refill, it runs out, and there is no honest
 * "percent used" to draw: the denominator is whatever the user last topped up,
 * so the same $5 remaining is 50% or 5% depending on history, and "resets at"
 * is a time that never comes.
 *
 * So the headline is the DOLLARS LEFT, which is the number that actually
 * predicts whether the next turn works. The bar underneath is deliberately
 * scoped to the current top-up cycle (spent vs. purchased) and captioned as
 * such, rather than pretending to be a quota window.
 *
 * The top-up control is a deep link, not a purchase. OpenRouter REMOVED its
 * programmatic credit API (`POST /credits/coinbase` → 410 Gone; the docs say
 * to use the web flow, and there is no replacement endpoint). Cody therefore
 * does the two things it honestly can: send the user to the real credits page,
 * and watch the balance afterwards so the loop visibly closes. The alternative
 * — an in-app amount field that "buys" credits — would be a fake checkout.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import type { OpenRouterAccountSnapshot } from "@/lib/openrouter/account";
import type { UseOpenRouterAccountResult } from "@/hooks/useOpenRouterAccount";

/** OpenRouter's own credits page — the only surface that sells credits. */
const TOPUP_URL = "https://openrouter.ai/settings/credits";

/** Below this many credits the balance is the most urgent thing on screen: a
 * long turn on a frontier model can cost more than this, so the next request
 * may simply fail. Warn rather than wait for zero. */
const LOW_BALANCE_CREDITS = 2;

/** Money, not tokens: the popover is 320px wide and a raw float would wrap.
 * Sub-cent balances still show two decimals — "$0.00 left" while a turn is
 * running would read as broken. */
function formatCredits(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

export function OpenRouterCredits({ account }: { account: UseOpenRouterAccountResult }) {
  const { t, locale } = useI18n();
  const { snapshot, loading, refreshNow } = account;
  const [checking, setChecking] = useState(false);
  // The balance at the moment the user left for the credits page. Comparing
  // against it is what lets Cody say "your top-up landed" instead of just
  // showing a number that silently changed.
  const awaitingTopUpRef = useRef<number | null>(null);

  const confirmTopUp = useCallback(async (): Promise<void> => {
    setChecking(true);
    try {
      const fresh = await refreshNow();
      const before = awaitingTopUpRef.current;
      const after = fresh?.credits?.remaining ?? null;
      if (before !== null && after !== null && after > before + 0.001) {
        toast.success(t("openrouter.topUpLanded", { amount: formatCredits(after - before, locale) }));
        awaitingTopUpRef.current = null;
      } else if (before !== null) {
        toast.info(t("openrouter.topUpNotYet"));
      }
    } finally {
      setChecking(false);
    }
  }, [refreshNow, t, locale]);

  // Coming back to the tab is the natural moment to check: the user has just
  // finished on OpenRouter's page. Only armed after they actually left.
  useEffect(() => {
    const onFocus = () => {
      if (awaitingTopUpRef.current !== null) void confirmTopUp();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [confirmTopUp]);

  const openTopUp = () => {
    awaitingTopUpRef.current = snapshot?.credits?.remaining ?? 0;
    window.open(TOPUP_URL, "_blank", "noopener,noreferrer");
  };

  // No key, or the balance read failed: say nothing. An OpenRouter model can
  // be selected on an instance whose key lives only in the engine, and an
  // error box over a working composer is worse than an absent section.
  if (!snapshot || !snapshot.available || !snapshot.credits) {
    if (snapshot && !snapshot.available && snapshot.error?.code === "no_key") return null;
    if (!snapshot && loading) {
      return (
        <Section>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{t("openrouter.checking")}</div>
        </Section>
      );
    }
    if (snapshot?.error && snapshot.error.code !== "no_key") {
      return (
        <Section>
          <div style={{ fontSize: 10, lineHeight: 1.45, color: "var(--text-dim)" }}>{snapshot.error.message}</div>
        </Section>
      );
    }
    return null;
  }

  const { credits, key } = snapshot;
  const low = credits.remaining < LOW_BALANCE_CREDITS;
  const empty = credits.remaining <= 0;
  const tone = empty ? "var(--status-error)" : low ? "var(--status-warning)" : "var(--text)";
  // Share of the CURRENT top-up cycle that is spent. Only drawn when the
  // account has ever been funded, so a fresh account shows no misleading track.
  const spentFraction = credits.totalCredits > 0
    ? Math.max(0, Math.min(1, credits.totalUsage / credits.totalCredits))
    : null;

  return (
    <Section>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>{t("openrouter.creditsTitle")}</div>
        <div style={{ flexShrink: 0, fontSize: 13, fontWeight: 700, color: tone, fontVariantNumeric: "tabular-nums" }}>
          {formatCredits(credits.remaining, locale)}
        </div>
      </div>
      <div style={{ marginTop: 2, fontSize: 10, color: "var(--text-muted)" }}>
        {empty
          ? t("openrouter.creditsEmpty")
          : low
            ? t("openrouter.creditsLow")
            : t("openrouter.creditsRemaining")}
      </div>

      {spentFraction !== null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 4, borderRadius: 999, background: "var(--bg-hover)", overflow: "hidden" }}>
            <div
              style={{
                width: `${spentFraction * 100}%`,
                height: "100%",
                borderRadius: 999,
                background: empty ? "var(--status-error)" : low ? "var(--status-warning)" : "var(--accent-strong)",
              }}
            />
          </div>
          <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            {t("openrouter.creditsCycle", {
              used: formatCredits(credits.totalUsage, locale),
              total: formatCredits(credits.totalCredits, locale),
            })}
          </div>
        </div>
      )}

      {/* This key's own spend, which is NOT the account balance: a capped key
          can be exhausted while the account still holds credits, and only the
          cap explains why requests started failing. */}
      {key && (key.limit !== null || key.usageDaily !== null) && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 2 }}>
          {key.usageDaily !== null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: "var(--text-muted)" }}>
              <span>{t("openrouter.spentToday")}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatCredits(key.usageDaily, locale)}</span>
            </div>
          )}
          {key.limit !== null && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: "var(--text-muted)" }}>
              <span>{t("openrouter.keyLimit")}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {key.limitRemaining !== null
                  ? t("openrouter.keyLimitRemaining", {
                    remaining: formatCredits(key.limitRemaining, locale),
                    limit: formatCredits(key.limit, locale),
                  })
                  : formatCredits(key.limit, locale)}
              </span>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={openTopUp}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 9px",
            border: "none",
            borderRadius: 5,
            background: low ? "var(--accent-strong)" : "transparent",
            color: low ? "var(--on-accent)" : "var(--text-muted)",
            boxShadow: low ? "none" : "inset 0 0 0 1px var(--border)",
            cursor: "pointer",
            fontSize: 10,
            fontWeight: low ? 600 : 400,
          }}
        >
          <ExternalLink size={11} aria-hidden="true" />
          {t("openrouter.addCredits")}
        </button>
        <button
          type="button"
          onClick={() => void confirmTopUp()}
          disabled={checking}
          aria-label={t("openrouter.recheck")}
          title={t("openrouter.recheck")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 7px",
            border: "none",
            borderRadius: 5,
            background: "transparent",
            color: "var(--text-muted)",
            boxShadow: "inset 0 0 0 1px var(--border)",
            cursor: checking ? "wait" : "pointer",
            fontSize: 10,
          }}
        >
          {checking
            ? <Loader2 size={11} aria-hidden="true" className="icon-spin" />
            : <RefreshCw size={11} aria-hidden="true" />}
        </button>
      </div>
      {/* Said once, plainly: the button leaves Cody, because it must. */}
      <div style={{ marginTop: 6, fontSize: 10, lineHeight: 1.45, color: "var(--text-dim)" }}>
        {t("openrouter.topUpNote")}
      </div>
    </Section>
  );
}

/** The popover's section frame: same 12px rhythm and hairline rule every other
 * block in `QuotaPopover` uses, so this reads as one of them. */
function Section({ children }: { children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
      {children}
    </section>
  );
}

export type { OpenRouterAccountSnapshot };
