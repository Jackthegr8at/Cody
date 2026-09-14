"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Route } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { NativeSetting, ToggleSwitch } from "../primitives";
import { SettingsSection } from "../SettingsSection";
import { toast } from "@/components/ui/toast";

export const ROUTING_ROUTE = "/api/routing";

interface RoutingBody {
  autoBind: boolean;
  blackouts: { provider: string; accountId: string | null; kind: "quota" | "credits"; until: string | null; reason: string }[];
  bindings: { role: string; baseline: string; active: string; reason: string }[];
}

const tableStyle: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12, color: "var(--text)" };
const thStyle: CSSProperties = {
  textAlign: "left",
  padding: "4px 8px 6px",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};
const tdStyle: CSSProperties = { padding: "7px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "middle" };
const codeStyle: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11 };

/** Cody's routing tables: a header row, one row per entry, dividers that span
 * the row. The last column takes the slack so dates and model ids never wrap. */
function RoutingTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <table style={tableStyle}>
      <thead>
        <tr>{columns.map((column, index) => <th key={column} style={{ ...thStyle, width: index === columns.length - 1 ? "auto" : "1%" }}>{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((cells, rowIndex) => (
          <tr key={rowIndex}>
            {cells.map((cell, cellIndex) => <td key={cellIndex} style={{ ...tdStyle, whiteSpace: cellIndex === cells.length - 1 ? "normal" : "nowrap", ...(rowIndex === rows.length - 1 ? { borderBottom: 0 } : {}) }}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
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
      const response = await fetch(ROUTING_ROUTE, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoBind }),
      });
      const next = (await response.json().catch(() => ({}))) as Partial<RoutingBody> & { error?: string };
      if (!response.ok || next.error) throw new Error(next.error || `HTTP ${response.status}`);
      setSettingsRouteData(ROUTING_ROUTE, { ...body, ...next });
      invalidateSettingsRoutes("/api/usage");
      toast.success(autoBind ? t("routing.bindingOn") : t("routing.bindingOff"));
    })()
      .catch((error: unknown) => toast.error(t("routing.saveFailed"), error instanceof Error ? error.message : String(error)))
      .finally(() => setSaving(false));
  };

  const formatUntil = (until: string | null) => {
    if (!until) return t("routing.untilTopUp");
    const at = new Date(until);
    return Number.isNaN(at.getTime()) ? until : at.toLocaleString();
  };

  return (
    <SettingsSection
      data-search-id="routing-binding"
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Route size={15} aria-hidden="true" style={{ color: "var(--accent)" }} />
          {t("routing.title")}
        </span>
      }
      variant="plain"
      bodyStyle={{ padding: 0 }}
    >
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <NativeSetting
          label={t("routing.autoBindLabel")}
          description={t("routing.autoBindHint")}
          scope="Cody only"
          searchId="routing-auto-bind"
        >
          <ToggleSwitch checked={body.autoBind} disabled={saving} onChange={setAutoBind} />
        </NativeSetting>
      </div>

      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("routing.blackoutsTitle")}</div>
        {body.blackouts.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("routing.noBlackouts")}</div>
        ) : (
          <RoutingTable
            columns={["Provider", "Account", "Kind", "Until"]}
            rows={body.blackouts.map((entry) => [
              <code key="provider" style={codeStyle}>{entry.provider}</code>,
              <code key="account" style={codeStyle}>{entry.accountId ? entry.accountId.slice(0, 8) : "—"}</code>,
              entry.kind,
              formatUntil(entry.until),
            ])}
          />
        )}
      </div>

      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{t("routing.bindingsTitle")}</div>
        {body.bindings.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{body.autoBind ? t("routing.noBindings") : t("routing.bindingsOff")}</div>
        ) : (
          <RoutingTable
            columns={["Role", "Active model", "Restores to"]}
            rows={body.bindings.map((entry) => [<code key="role" style={codeStyle}>{entry.role}</code>, <code key="active" style={codeStyle}>{entry.active}</code>, <code key="baseline" style={codeStyle}>{entry.baseline}</code>])}
          />
        )}
      </div>
    </SettingsSection>
  );
}
