"use client";

import { Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast";
import { useI18n } from "@/lib/i18n";
import { setSettingsRouteData, useSettingsRoute } from "@/hooks/useSettingsData";
import { Select, type SelectOption } from "@/components/ui/Select";
import { useSaveStatus } from "../SaveStatus";
import { SettingsActions } from "../SettingsActions";
import { SettingsSection, SettingsRow } from "../SettingsSection";
import { ChainList, ChainRow } from "./ChainList";
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
function ModelSelect({ body, value, label, emptyLabel, onChange, disabled }: { body: LocalRoutingBody; value: LocalRoutingModelRef | null; label: string; emptyLabel?: string; onChange: (value: LocalRoutingModelRef | null) => void; disabled?: boolean; }) {
  const { t } = useI18n();
  const options: SelectOption<string>[] = [
    { value: "", label: emptyLabel ?? t("localRouting.unset") },
    ...body.models.map((model) => ({
      value: `${model.provider}/${model.modelId}`,
      label: `${modelLabel(model)} (${model.provider})`,
    })),
  ];
  return (
    <Select
      value={value ? refKey(value) : ""}
      onChange={(key) => onChange(fromKey(key))}
      options={options}
      disabled={disabled}
      aria-label={label}
    />
  );
}
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsSection
        title={t("localRouting.title")}
        description={t("localRouting.hint")}
      >
        <div style={{ padding: "10px 14px" }}>
          <ModelSelect body={body} value={config.primary} label={t("localRouting.primary")} onChange={(primary) => setDraft({ ...config, primary })} disabled={saving} />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("localRouting.fallbacks")}
      >
        <ChainList>
          {config.fallbacks.map((fallback, index) => (
            <ChainRow
              key={`${refKey(fallback)}:${index}`}
              leading={<span style={{ color: "var(--text-muted)", fontSize: 12 }}>{index + 1}</span>}
              onRemove={() => setDraft({ ...config, fallbacks: config.fallbacks.filter((_, i) => i !== index) })}
              onMoveUp={index > 0 ? () => {
                const newFallbacks = [...config.fallbacks];
                [newFallbacks[index - 1], newFallbacks[index]] = [newFallbacks[index], newFallbacks[index - 1]];
                setDraft({ ...config, fallbacks: newFallbacks });
              } : undefined}
              onMoveDown={index < config.fallbacks.length - 1 ? () => {
                const newFallbacks = [...config.fallbacks];
                [newFallbacks[index], newFallbacks[index + 1]] = [newFallbacks[index + 1], newFallbacks[index]];
                setDraft({ ...config, fallbacks: newFallbacks });
              } : undefined}
            >
              <ModelSelect body={body} value={fallback} label={t("localRouting.fallback", { position: index + 1 })} onChange={(value) => setDraft({ ...config, fallbacks: config.fallbacks.map((entry, i) => i === index ? value : entry).filter((entry): entry is LocalRoutingModelRef => entry !== null) })} disabled={saving} />
            </ChainRow>
          ))}
        </ChainList>
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <button type="button" className="ui-focus-ring" disabled={saving || !models.some((model) => ![refKey(config.primary), ...config.fallbacks.map(refKey)].includes(`${model.provider}/${model.modelId}`))} onClick={() => { const next = models.find((model) => ![refKey(config.primary), ...config.fallbacks.map(refKey)].includes(`${model.provider}/${model.modelId}`)); if (next) setDraft({ ...config, fallbacks: [...config.fallbacks, { provider: next.provider, modelId: next.modelId }] }); }} style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: 30, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: saving || !models.some((model) => ![refKey(config.primary), ...config.fallbacks.map(refKey)].includes(`${model.provider}/${model.modelId}`)) ? "wait" : "pointer", fontSize: 11, fontWeight: 500, opacity: saving || !models.some((model) => ![refKey(config.primary), ...config.fallbacks.map(refKey)].includes(`${model.provider}/${model.modelId}`)) ? 0.55 : 1 }}><Plus size={14} aria-hidden="true" /> Add fallback</button>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t("localRouting.roles")}
        description={t("localRouting.rolesFuture")}
        variant="rows"
      >
        {body.roleIds.map((role) => (
          <SettingsRow key={role} label={<code style={{ fontSize: 12, color: "var(--text-muted)" }}>{role}</code>}>
            <ModelSelect body={body} value={config.roles[role] ?? null} label={t("localRouting.role", { role })} emptyLabel={t("localRouting.usePrimary")} onChange={(value) => setDraft({ ...config, roles: { ...config.roles, [role]: value } })} disabled={saving} />
          </SettingsRow>
        ))}
      </SettingsSection>

      <SettingsActions
        dirty={dirty}
        onSave={save}
        saving={saving}
        saveLabel={t("localRouting.save")}
        savingLabel={t("localRouting.saving")}
      />
    </div>
  );
}
