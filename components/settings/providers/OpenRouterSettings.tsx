"use client";

/**
 * OpenRouter's own controls inside its provider drawer: the balance, the spend
 * cap on the key Cody is using, and the routing preferences that decide WHICH
 * upstream serves a request.
 *
 * Only three of the things openrouter.ai lets you change are reachable from
 * here, and the split is not arbitrary — it is what the API and the engine
 * actually permit:
 *
 *   - **Balance** is read-only from any key. Purchasing is not in the API at
 *     all (`POST /credits/coinbase` → 410 Gone, no replacement), so the
 *     control is a deep link plus a re-check, never a checkout.
 *   - **Key spend cap** is a real write, but only with a MANAGEMENT key
 *     (`PATCH /keys/{hash}`), so the card offers one when it is missing rather
 *     than showing a control that would 401.
 *   - **Routing** is not an OpenRouter account setting at all: `order`/`only`
 *     are per-request options. omp models them as `compat.openRouterRouting`
 *     in models.yml and emits them as the request's `provider` block, so this
 *     writes there — the same channel `AdvancedForm` already uses — rather
 *     than inventing a Cody-side preference the engine would ignore.
 *
 * Account-level preferences on openrouter.ai (training/data-collection policy,
 * ZDR-only, the default provider sort) have NO API surface. They are not
 * mirrored here: a toggle that silently failed to apply would be worse than
 * the link that does work.
 */
import { AlertCircle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { useSettingsRoute } from "@/hooks/useSettingsData";
import type { ModelsFileData, ProviderEntry } from "@/components/ModelsConfig";
import type { OpenRouterAccountSnapshot } from "@/lib/openrouter/account";
import type { OpenRouterManagedKey } from "@/lib/openrouter/api";
import { nativeInputStyle } from "../primitives";
import { buttonStyle, cardStyle, primaryButtonStyle, quietButtonStyle } from "./controls";

const TOPUP_URL = "https://openrouter.ai/settings/credits";
const MANAGEMENT_KEYS_URL = "https://openrouter.ai/settings/provisioning-keys";

/** Response of GET /api/openrouter/keys. */
interface ManagedKeysBody {
  keys: OpenRouterManagedKey[] | null;
  error: { code: string; message: string } | null;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{label}</span>
      <span style={{ fontSize: 12, color: "var(--text)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>{value}</span>
    </div>
  );
}

/** Balance, this key's spend, and the only top-up path that exists. */
function CreditsCard({ canEdit }: { canEdit: boolean }) {
  const account = useSettingsRoute<OpenRouterAccountSnapshot>("/api/openrouter/account");
  const [checking, setChecking] = useState(false);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      // `?refresh=1` bypasses the server's 30s cache: after a purchase, a
      // cached answer is exactly the wrong one.
      await fetch("/api/openrouter/account?refresh=1", { cache: "no-store" });
      await account.reload();
    } finally {
      setChecking(false);
    }
  }, [account]);

  const snapshot = account.data;
  if (account.loading && !snapshot) {
    return <div style={{ ...cardStyle, fontSize: 12, color: "var(--text-muted)" }}>Reading your OpenRouter balance…</div>;
  }
  if (!snapshot?.available || !snapshot.credits) {
    const message = snapshot?.error?.code === "no_key"
      ? "Save an OpenRouter API key above to see your balance."
      : snapshot?.error?.message ?? "Could not read your OpenRouter balance.";
    return (
      <div style={{ ...cardStyle, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <AlertCircle size={13} aria-hidden="true" style={{ flexShrink: 0 }} />
          {message}
        </span>
      </div>
    );
  }

  const { credits, key } = snapshot;
  const low = credits.remaining < 2;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Remaining balance</span>
        <span style={{
          fontSize: 18,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: credits.remaining <= 0 ? "var(--status-error)" : low ? "var(--status-warning)" : "var(--text)",
        }}>
          {formatUsd(credits.remaining)}
        </span>
      </div>
      <Row label="Purchased in total" value={formatUsd(credits.totalCredits)} />
      <Row label="Spent in total" value={formatUsd(credits.totalUsage)} />
      {key?.usageDaily !== null && key?.usageDaily !== undefined && (
        <Row label="Spent today (this key)" value={formatUsd(key.usageDaily)} />
      )}
      {key?.label && <Row label="Key" value={<code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{key.label}</code>} />}
      {snapshot.keySource === "engine" && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
          Read with the key stored in the engine&apos;s own credentials, not one saved in Cody.
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <a
          href={TOPUP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="ui-focus-ring"
          style={{ ...(low ? primaryButtonStyle : buttonStyle), textDecoration: "none" }}
        >
          <ExternalLink size={13} aria-hidden="true" /> Add credits
        </a>
        <button type="button" className="ui-focus-ring" onClick={() => void recheck()} disabled={checking} style={quietButtonStyle}>
          {checking ? <Loader2 size={13} aria-hidden="true" className="icon-spin" /> : <RefreshCw size={13} aria-hidden="true" />}
          Re-check
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
        OpenRouter has no API for buying credits, so purchases happen on their site.
        {canEdit ? " Re-check brings the new balance back here." : ""}
      </div>
    </div>
  );
}

/** The spend cap on each key — the one useful write a management key unlocks. */
function KeyLimitsCard() {
  const roster = useSettingsRoute<ManagedKeysBody>("/api/openrouter/keys");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const keys = roster.data?.keys ?? null;
  const error = roster.data?.error ?? null;

  // Seed each field from the live cap so an untouched field round-trips the
  // existing value rather than reading as "no limit".
  useEffect(() => {
    if (!keys) return;
    setDraft((current) => {
      const next = { ...current };
      for (const key of keys) {
        if (!(key.hash in next)) next[key.hash] = key.limit === null ? "" : String(key.limit);
      }
      return next;
    });
  }, [keys]);

  const save = async (key: OpenRouterManagedKey) => {
    const raw = (draft[key.hash] ?? "").trim();
    // Empty means "no cap" — the API's `null`, not zero. Zero would be a key
    // that can never spend anything, which is a very different instruction.
    let limit: number | null;
    if (raw === "") {
      limit = null;
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("Enter a dollar amount, or leave it empty for no limit.");
        return;
      }
      limit = parsed;
    }
    setSaving(key.hash);
    try {
      const response = await fetch("/api/openrouter/keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash: key.hash, limit }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      toast.success(limit === null ? `Removed the limit on ${key.name}` : `${key.name} capped at ${formatUsd(limit)}`);
      await roster.reload();
    } catch (failure) {
      toast.error("Could not update the key limit", failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(null);
    }
  };

  if (roster.loading && !roster.data) {
    return <div style={{ ...cardStyle, fontSize: 12, color: "var(--text-muted)" }}>Reading your OpenRouter keys…</div>;
  }

  // The expected state for most people: no management key. Offer one instead
  // of showing a broken control.
  if (!keys) {
    return (
      <div style={{ ...cardStyle, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
        <span>
          Add an <strong style={{ color: "var(--text)" }}>OpenRouter management key</strong> above to see this
          account&apos;s API keys and set a spend limit on each. OpenRouter gates both behind a
          provisioning-scoped key, so your normal API key cannot do it.
        </span>
        {error && error.code !== "management_key_required" && (
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{error.message}</span>
        )}
        <a
          href={MANAGEMENT_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="ui-focus-ring"
          style={{ ...buttonStyle, textDecoration: "none", alignSelf: "flex-start" }}
        >
          <ExternalLink size={13} aria-hidden="true" /> Create a management key
        </a>
      </div>
    );
  }

  if (keys.length === 0) {
    return <div style={{ ...cardStyle, fontSize: 12, color: "var(--text-muted)" }}>This account has no API keys.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {keys.map((key) => {
        const dirty = (draft[key.hash] ?? "") !== (key.limit === null ? "" : String(key.limit));
        return (
          <div key={key.hash} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, minWidth: 0 }}>
              <span style={{ minWidth: 0, fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {key.name}
              </span>
              {key.disabled && <span style={{ flexShrink: 0, fontSize: 11, color: "var(--status-warning)" }}>Disabled</span>}
            </div>
            {key.usage !== null && <Row label="Spent" value={formatUsd(key.usage)} />}
            <label style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Spend limit</span>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                placeholder="No limit"
                value={draft[key.hash] ?? ""}
                onChange={(event) => setDraft((current) => ({ ...current, [key.hash]: event.target.value }))}
                style={{ ...nativeInputStyle, width: 120 }}
              />
              <button
                type="button"
                className="ui-focus-ring"
                onClick={() => void save(key)}
                disabled={!dirty || saving === key.hash}
                style={dirty ? primaryButtonStyle : buttonStyle}
              >
                {saving === key.hash ? <Loader2 size={13} aria-hidden="true" className="icon-spin" /> : null}
                Save
              </button>
            </label>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Leave empty for no limit.</div>
          </div>
        );
      })}
    </div>
  );
}

/** OpenRouter provider slugs, for the routing pickers. */
interface ProvidersListBody {
  data?: { slug?: string; name?: string }[];
}

/**
 * Which upstream serves a request.
 *
 * Written to `providers.openrouter.compat.openRouterRouting` in models.yml,
 * which omp emits verbatim as the request's `provider` block. `order` is a
 * preference (it falls back past the list); `only` is a restriction (it fails
 * rather than leaving the list), and the copy has to keep them apart — a user
 * who reads "only" as "prefer" will be confused by a hard failure.
 */
function RoutingCard({ readOnly }: { readOnly: boolean }) {
  const config = useSettingsRoute<ModelsFileData>("/api/models-config");
  const catalog = useSettingsRoute<ProvidersListBody>("/api/openrouter/providers");
  const [order, setOrder] = useState<string | null>(null);
  const [only, setOnly] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const entry = config.data?.providers?.openrouter;
  const routing = (entry?.compat as { openRouterRouting?: { order?: string[]; only?: string[] } } | undefined)?.openRouterRouting;
  const savedOrder = (routing?.order ?? []).join(", ");
  const savedOnly = (routing?.only ?? []).join(", ");
  // `null` means untouched, so the fields track the file until the user types.
  const orderValue = order ?? savedOrder;
  const onlyValue = only ?? savedOnly;
  const dirty = orderValue !== savedOrder || onlyValue !== savedOnly;

  const slugs = (catalog.data?.data ?? []).map((provider) => provider.slug).filter((slug): slug is string => Boolean(slug));

  const save = async () => {
    setSaving(true);
    try {
      const parse = (value: string) => value.split(",").map((part) => part.trim()).filter(Boolean);
      const nextOrder = parse(orderValue);
      const nextOnly = parse(onlyValue);
      const providers: Record<string, ProviderEntry> = { ...(config.data?.providers ?? {}) };
      const current: ProviderEntry = { ...(providers.openrouter ?? {}) };
      const compat: Record<string, unknown> = { ...(current.compat ?? {}) };
      // An empty list must REMOVE the key, not write `[]`: omp assigns the
      // routing block straight onto the request's `provider` field, and an
      // empty `only` would restrict routing to no providers at all.
      const nextRouting: Record<string, string[]> = {};
      if (nextOrder.length > 0) nextRouting.order = nextOrder;
      if (nextOnly.length > 0) nextRouting.only = nextOnly;
      if (Object.keys(nextRouting).length > 0) compat.openRouterRouting = nextRouting;
      else delete compat.openRouterRouting;
      if (Object.keys(compat).length > 0) current.compat = compat;
      else delete current.compat;
      providers.openrouter = current;

      const response = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(config.data ?? {}), providers }),
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok || body?.error) throw new Error(body?.error || `HTTP ${response.status}`);
      toast.success("Routing preferences saved");
      setOrder(null);
      setOnly(null);
      await config.reload();
    } catch (failure) {
      toast.error("Could not save routing preferences", failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={cardStyle}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Preferred providers</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
          Tried in this order; OpenRouter still falls back to others if they all fail.
          Comma-separated slugs.
        </span>
        <input
          type="text"
          list="openrouter-provider-slugs"
          placeholder="e.g. anthropic, google-vertex"
          value={orderValue}
          disabled={readOnly}
          onChange={(event) => setOrder(event.target.value)}
          style={nativeInputStyle}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>Restrict to providers</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>
          A hard limit: requests fail rather than routing anywhere else. Leave empty for no
          restriction.
        </span>
        <input
          type="text"
          list="openrouter-provider-slugs"
          placeholder="No restriction"
          value={onlyValue}
          disabled={readOnly}
          onChange={(event) => setOnly(event.target.value)}
          style={nativeInputStyle}
        />
      </label>
      <datalist id="openrouter-provider-slugs">
        {slugs.map((slug) => <option key={slug} value={slug} />)}
      </datalist>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={() => void save()}
          disabled={!dirty || saving || readOnly}
          style={dirty && !readOnly ? primaryButtonStyle : buttonStyle}
        >
          {saving ? <Loader2 size={13} aria-hidden="true" className="icon-spin" /> : null}
          Save routing
        </button>
        {dirty && !readOnly && (
          <button type="button" className="ui-focus-ring" onClick={() => { setOrder(null); setOnly(null); }} style={quietButtonStyle}>
            Reset
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>
        Applies to every OpenRouter model. Training and privacy policies are account-wide settings
        with no API, so they stay on openrouter.ai.
      </div>
    </div>
  );
}

export function OpenRouterCreditsSection({ canEdit }: { canEdit: boolean }) {
  return <CreditsCard canEdit={canEdit} />;
}

export function OpenRouterKeyLimitsSection() {
  return <KeyLimitsCard />;
}

export function OpenRouterRoutingSection({ readOnly }: { readOnly: boolean }) {
  return <RoutingCard readOnly={readOnly} />;
}
