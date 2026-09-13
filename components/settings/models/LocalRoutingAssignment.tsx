"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { nativeOptionStyle, nativeSelectStyle } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { useSettingsShell } from "../shell-context";

export interface LocalRoutingModelRef {
  provider: string;
  modelId: string;
}

export interface LocalRoutingBody {
  engineSupported?: boolean;
  supported: boolean;
  config: { primary: LocalRoutingModelRef | null; fallbacks: LocalRoutingModelRef[]; roles: Record<string, LocalRoutingModelRef | null> };
  models: { provider: string; modelId: string; name?: string; label?: string; contextWindow?: number }[];
  roleIds: string[];
}

export const LOCAL_ROUTING_ROUTE = "/api/local-routing";

function refKey(ref: LocalRoutingModelRef | null): string {
  return ref ? `${ref.provider}/${ref.modelId}` : "";
}

function fromKey(key: string): LocalRoutingModelRef | null {
  const slash = key.indexOf("/");
  return slash > 0 && slash < key.length - 1 ? { provider: key.slice(0, slash), modelId: key.slice(slash + 1) } : null;
}

function modelLabel(model: LocalRoutingBody["models"][number]): string {
  return model.name || model.label || model.modelId;
}
function ModelSelect({ body, value, label, emptyLabel, onChange, disabled }: { body: LocalRoutingBody; value: LocalRoutingModelRef | null; label: string; emptyLabel?: string; onChange: (value: LocalRoutingModelRef | null) => void; disabled?: boolean; }) { const { t } = useI18n(); return <select disabled={disabled} value={refKey(value)} aria-label={label} onChange={(event) => onChange(fromKey(event.target.value))} style={{ ...nativeSelectStyle, minWidth: 0, width: "100%", opacity: disabled ? 0.55 : 1 }}><option value="" style={nativeOptionStyle}>{emptyLabel ?? t("localRouting.unset")}</option>{body.models.map((model) => <option key={`${model.provider}/${model.modelId}`} value={`${model.provider}/${model.modelId}`} style={nativeOptionStyle}>{modelLabel(model)} ({model.provider})</option>)}</select>; }
export function useLocalRoutingConfig(enabled = true) {
  const route = useSettingsRoute<LocalRoutingBody>(LOCAL_ROUTING_ROUTE, { enabled, ttlMs: 60_000 });
  return { route, available: route.data?.engineSupported === true };
}

export function LocalRoutingAssignment({ panelId }: { panelId: string }) {
  const { t } = useI18n();
  const { busy } = useSettingsShell();
  const { track } = useSaveStatus(panelId);
  const { route } = useLocalRoutingConfig();
  const body = route.data;
  const [draft, setDraft] = useState<LocalRoutingBody["config"] | null>(null);
  const [saving, setSaving] = useState(false);
  const models = useMemo(() => body?.models ?? [], [body]);
  const config = draft ?? body?.config;
  const dirty = draft !== null;
  useEffect(() => saving ? busy.hold(t("localRouting.title")) : dirty ? busy.hold("Unsaved changes") : undefined, [busy, dirty, saving, t]);
  if (!body || !body.engineSupported || !config) return null;

  const save = () => {
    setSaving(true);
    void track(async () => {
      const response = await fetch(LOCAL_ROUTING_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) });
      const data = await response.json().catch(() => ({})) as LocalRoutingBody & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      setSettingsRouteData(LOCAL_ROUTING_ROUTE, { ...data, engineSupported: body.engineSupported });
      setDraft(null);
      toast.success(t("localRouting.saved"));
    }).catch((error: unknown) => toast.error(t("localRouting.saveFailed"), error instanceof Error ? error.message : String(error))).finally(() => setSaving(false));
  };

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("localRouting.title")}</div>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t("localRouting.hint")}</p>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", background: "var(--bg-panel)", fontSize: 12, fontWeight: 600 }}>{t("localRouting.primary")}</div>
        <div style={{ padding: 12 }}><ModelSelect body={body} value={config.primary} label={t("localRouting.primary")} onChange={(primary) => setDraft({ ...config, primary })} disabled={saving} /></div>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", background: "var(--bg-panel)", fontSize: 12, fontWeight: 600 }}>{t("localRouting.fallbacks")}</div>
        {config.fallbacks.map((fallback, index) => (
          <div key={`${refKey(fallback)}:${index}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "center", padding: 12, borderTop: "1px solid var(--border)" }}>
            <ModelSelect body={body} value={fallback} label={t("localRouting.fallback", { position: index + 1 })} onChange={(value) => setDraft({ ...config, fallbacks: config.fallbacks.map((entry, i) => i === index ? value : entry).filter((entry): entry is LocalRoutingModelRef => entry !== null) })} disabled={saving} />
            <button type="button" className="ui-focus-ring" disabled={saving} aria-label={t("localRouting.removeFallback", { position: index + 1 })} title={t("localRouting.removeFallback", { position: index + 1 })} onClick={() => setDraft({ ...config, fallbacks: config.fallbacks.filter((_, i) => i !== index) })} style={{ width: 32, height: 32, padding: 0, border: "none", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer" }}><Trash2 size={14} aria-hidden="true" /></button>
          </div>
        ))}
        <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}><button type="button" className="ui-focus-ring" disabled={saving || !models.some((model) => ![refKey(config.primary), ...config.fallbacks.map(refKey)].includes(`${model.provider}/${model.modelId}`))} onClick={() => { const next = models.find((model) => ![refKey(config.primary), ...config.fallbacks.map(refKey)].includes(`${model.provider}/${model.modelId}`)); if (next) setDraft({ ...config, fallbacks: [...config.fallbacks, { provider: next.provider, modelId: next.modelId }] }); }} style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 30, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: saving ? "wait" : "pointer" }}><Plus size={13} aria-hidden="true" />{t("localRouting.addFallback")}</button></div>
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", overflow: "hidden" }}>
        <div style={{ padding: "10px 12px", background: "var(--bg-panel)", fontSize: 12, fontWeight: 600 }}>{t("localRouting.roles")}</div>
        <p style={{ margin: 0, padding: "8px 12px", borderTop: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 }}>{t("localRouting.rolesFuture")}</p>
        {body.roleIds.map((role) => <div key={role} style={{ display: "grid", gridTemplateColumns: "minmax(82px, 0.25fr) minmax(0, 1fr)", gap: 10, alignItems: "center", padding: 12, borderTop: "1px solid var(--border)", fontSize: 12 }}><span style={{ color: "var(--text-muted)" }}>{role}</span><ModelSelect body={body} value={config.roles[role] ?? null} label={t("localRouting.role", { role })} emptyLabel={t("localRouting.usePrimary")} onChange={(value) => setDraft({ ...config, roles: { ...config.roles, [role]: value } })} disabled={saving} /></div>)}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}><button type="button" className="ui-focus-ring" disabled={!dirty || saving} onClick={save} style={{ minHeight: 32, padding: "5px 12px", border: "none", borderRadius: "var(--radius-control)", background: dirty ? "var(--accent)" : "var(--bg-hover)", color: dirty ? "var(--accent-text)" : "var(--text-dim)", cursor: saving ? "wait" : dirty ? "pointer" : "default", fontSize: 12, fontWeight: 600, opacity: saving ? 0.65 : 1 }}>{saving ? t("localRouting.saving") : t("localRouting.save")}</button></div>
    </section>
  );
}
