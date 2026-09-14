"use client";

import { Gauge } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { nativeOptionStyle, nativeSelectStyle } from "./settings/primitives";

export type PromptProfileId = "full" | "compact" | "minimal";
export type PromptProfileOverride = PromptProfileId | "auto";
export interface LocalModelProfileSelection { provider: string; modelId: string; isLocal: boolean; override: PromptProfileOverride; resolvedProfile: PromptProfileId; appliedProfile: PromptProfileId | null; appliesOnNextProviderCall: boolean; }
export interface LocalModelProfileBody { overrides: { default: PromptProfileOverride; models: Record<string, PromptProfileOverride> }; selection?: LocalModelProfileSelection; }
const PROFILE_IDS: readonly PromptProfileId[] = ["full", "compact", "minimal"];
export function promptProfileLabel(t: (key: string) => string, profile: PromptProfileId | PromptProfileOverride): string { return t(`localModelProfile.${profile}`); }

export function PromptProfileIndicator({ selection, isMobile, onOpen }: { selection?: LocalModelProfileSelection; isMobile: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  // A non-local model can only ever resolve to "full" (lib/local-model-profile-runtime.ts
  // short-circuits on anything but a confirmed local endpoint), so the chip would be a
  // permanent no-op occupying composer width. Show it only where a profile can differ.
  if (!selection || !selection.isLocal) return null;
  const applied = selection.appliedProfile;
  const state = applied ? t("localModelProfile.applied") : t("localModelProfile.nextLaunch");
  const label = selection.appliesOnNextProviderCall && applied
    ? `${state}: ${promptProfileLabel(t, applied)} · ${t("localModelProfile.nextLaunch")}: ${promptProfileLabel(t, selection.resolvedProfile)}`
    : `${state}: ${promptProfileLabel(t, applied ?? selection.resolvedProfile)}`;
  return <button type="button" className="ui-focus-ring" onClick={onOpen} title={label} aria-label={label} style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, height: isMobile ? 38 : 28, padding: isMobile ? 0 : "0 6px", border: "none", borderRadius: 7, background: "none", color: applied ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}><Gauge size={14} strokeWidth={1.8} aria-hidden="true" />{!isMobile && <span>{label}</span>}</button>;
}

function ProfileSelect({ value, label, disabled, onChange }: { value: PromptProfileOverride; label: string; disabled?: boolean; onChange: (value: PromptProfileOverride) => void }) {
  const { t } = useI18n();
  return <select value={value} aria-label={label} disabled={disabled} onChange={(event) => onChange(event.target.value as PromptProfileOverride)} style={{ ...nativeSelectStyle, minWidth: 128, opacity: disabled ? 0.55 : 1 }}><option value="auto" style={nativeOptionStyle}>{promptProfileLabel(t, "auto")}</option>{PROFILE_IDS.map((profile) => <option key={profile} value={profile} style={nativeOptionStyle}>{promptProfileLabel(t, profile)}</option>)}</select>;
}

export function LocalModelProfileCard({ body, models, selectedModelKey, onSelectedModelKeyChange, saving, onChange }: { body: LocalModelProfileBody; models: readonly { provider: string; id: string; name: string }[]; selectedModelKey: string; onSelectedModelKeyChange: (key: string) => void; saving: boolean; onChange: (scope: "global" | "model", value: PromptProfileOverride, model?: { provider: string; modelId: string }) => void }) {
  const { t } = useI18n(); const selected = models.find((model) => `${model.provider}/${model.id}` === selectedModelKey) ?? null; const value = selected ? body.overrides.models[selectedModelKey] ?? "auto" : "auto"; const selection = body.selection;
  return <section data-search-id="local-model-prompt-profile" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden" }}><div style={{ padding: "12px 14px" }}><div style={{ fontSize: 12.5, fontWeight: 600 }}><Gauge size={15} aria-hidden="true" style={{ color: "var(--accent)", verticalAlign: "middle", marginRight: 8 }} />{t("localModelProfile.title")}</div><p style={{ margin: "8px 0 0", fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>{t("localModelProfile.guidance")}</p></div><div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--border)", alignItems: "center" }}><span style={{ fontSize: 12 }}>{t("localModelProfile.global")}</span><ProfileSelect value={body.overrides.default} label={t("localModelProfile.global")} disabled={saving} onChange={(next) => onChange("global", next)} /></div><div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}><div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10 }}><select value={selectedModelKey} aria-label={t("localModelProfile.model")} disabled={!models.length || saving} onChange={(event) => onSelectedModelKeyChange(event.target.value)} style={{ ...nativeSelectStyle, minWidth: 0, width: "100%" }}>{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`} style={nativeOptionStyle}>{model.name} ({model.provider})</option>)}</select><ProfileSelect value={value} label={t("localModelProfile.perModel")} disabled={!selected || saving} onChange={(next) => selected && onChange("model", next, { provider: selected.provider, modelId: selected.id })} /></div>{selection && <p role="status" style={{ margin: 0, fontSize: 11, color: selection.appliedProfile ? "var(--accent)" : "var(--text-dim)" }}>{selection.appliedProfile && t("localModelProfile.appliedStatus", { profile: promptProfileLabel(t, selection.appliedProfile) })}{selection.appliesOnNextProviderCall && `${selection.appliedProfile ? " " : ""}${t("localModelProfile.nextStatus", { profile: promptProfileLabel(t, selection.resolvedProfile) })}`}{!selection.appliedProfile && !selection.appliesOnNextProviderCall && t("localModelProfile.nextStatus", { profile: promptProfileLabel(t, selection.resolvedProfile) })}</p>}</div></section>;
}
