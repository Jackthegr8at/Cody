"use client";

import { useState } from "react";
import { Route } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { NativeSetting, ToggleSwitch } from "../primitives";
import { toast } from "@/components/ui/toast";

export const ROUTING_ROUTE = "/api/routing";

interface RoutingBody {
  autoBind: boolean;
  blackouts: { provider: string; accountId: string | null; kind: "quota" | "credits"; until: string | null; reason: string }[];
  bindings: { role: string; baseline: string; active: string; reason: string }[];
}

/**
 * The one switch for usage-aware role binding, plus a plain reading of what
 * it is doing: which providers Cody considers out, and which roles it has
 * re-pointed (with the assignment it will restore). Cody-owned state — it
 * lives beside the blackout registry, never in the engine's config — so it
 * needs no restart and survives an engine update.
 */
export function RoutingBindingCard() {
  const { t } = useI18n();
  const route = useSettingsRoute<RoutingBody>(ROUTING_ROUTE, { ttlMs: 30_000 });
  const [saving, setSaving] = useState(false);
  const body = route.data;
  if (!body || route.unsupported) return null;

  const setAutoBind = (autoBind: boolean) => {
    setSaving(true);
    void (async () => {
      const response = await fetch(ROUTING_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoBind }) });
      const next = (await response.json().catch(() => ({}))) as Partial<RoutingBody> & { error?: string };
      if (!response.ok || next.error) throw new Error(next.error || `HTTP ${response.status}`);
      setSettingsRouteData(ROUTING_ROUTE, { ...body, ...next });
      invalidateSettingsRoutes("/api/usage");
      toast.success(autoBind ? t("routing.bindingOn") : t("routing.bindingOff"));
    })().catch((error: unknown) => toast.error(t("routing.saveFailed"), error instanceof Error ? error.message : String(error)))
      .finally(() => setSaving(false));
  };

  const formatUntil = (until: string | null) => {
    if (!until) return t("routing.untilTopUp");
    const at = new Date(until);
    return Number.isNaN(at.getTime()) ? until : at.toLocaleString();
  };

  return (
    <section data-search-id="routing-binding" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
        <Route size={15} aria-hidden="true" style={{ color: "var(--accent)" }} />
        {t("routing.title")}
      </div>
      <NativeSetting
        label={t("routing.autoBindLabel")}
        description={t("routing.autoBindHint")}
        scope="Cody only"
        searchId="routing-auto-bind"
      >
        <ToggleSwitch checked={body.autoBind} disabled={saving} onChange={setAutoBind} />
      </NativeSetting>

      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{t("routing.blackoutsTitle")}</div>
        {body.blackouts.length === 0
          ? <div style={{ color: "var(--text-dim)" }}>{t("routing.noBlackouts")}</div>
          : body.blackouts.map((entry) => (
            <div key={`${entry.provider}:${entry.accountId ?? ""}`} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{entry.provider}{entry.accountId ? ` · ${entry.accountId.slice(0, 8)}` : ""}</code>
              <span>{entry.reason}</span>
              <span style={{ color: "var(--text-dim)" }}>{t("routing.until", { time: formatUntil(entry.until) })}</span>
            </div>
          ))}
      </div>

      <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>{t("routing.bindingsTitle")}</div>
        {body.bindings.length === 0
          ? <div style={{ color: "var(--text-dim)" }}>{body.autoBind ? t("routing.noBindings") : t("routing.bindingsOff")}</div>
          : body.bindings.map((entry) => (
            <div key={entry.role} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <code style={{ fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{entry.role}</code>
              <span>{entry.active}</span>
              <span style={{ color: "var(--text-dim)" }}>{t("routing.restoresTo", { model: entry.baseline })}</span>
            </div>
          ))}
      </div>
    </section>
  );
}
