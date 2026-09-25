"use client";

/**
 * Settings › Models › Assignments › Presets: the per-preset role, fallback
 * chain and usage-aware fallback editor, opened from `ModelPresets`'s list.
 *
 * Every field here is a DRAFT: one Save button writes the whole thing with
 * `PUT /api/model-presets/[id]`, the same replace-the-whole-field semantics
 * `updatePreset` already enforces server-side — `roles` and `chains` are
 * sent in full each time, not merged, so the local draft is seeded from
 * the complete `preset.roles` / `preset.chains` on open and never narrowed
 * to just the roles this view renders (a role or chain key omp's live
 * vocabulary no longer has would otherwise be silently dropped on save).
 *
 * A manual save never touches `research`: the field is left out of the PUT
 * body entirely (not sent as `null`), which is what keeps an existing
 * research stamp intact after a hand edit — only applying a NEW research
 * result is allowed to replace it (`ResearchRunView`).
 */
import { AlertCircle, Plus, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Select, type SelectOption } from "@/components/ui/Select";
import { toast } from "@/components/ui/toast";
import { invalidateSettingsRoutes } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { formatModelDisplayName } from "@/lib/model-display";
import { MODEL_PRESETS_ROUTE, presetErrorMessage, updateModelPreset } from "@/lib/model-presets/client";
import { joinPresetSelector, splitPresetSelector } from "@/lib/model-presets/selector";
import { researchStampSummary } from "@/lib/model-presets/summary";
import type { ModelPreset } from "@/lib/model-presets/types";
import { chipStyle, UNAVAILABLE_BADGE } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { SettingsActions } from "../SettingsActions";
import { SettingsSection, SettingsRow } from "../SettingsSection";
import { Drawer } from "../Drawer";
import { ChainList, ChainRow } from "./ChainList";
import type { RoleModelOption } from "./ModelRoles";

const INHERIT_VALUE = "__inherit__";

/** A role's model + reasoning-level pair, with an "Inherit base" first
 *  option naming what the base config currently resolves to. */
function RoleSelectorRow({ role, selector, base, models, knownSelectors, disabled, onChange }: {
  role: string;
  selector: string;
  base: string | undefined;
  models: RoleModelOption[];
  knownSelectors: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const { model, level } = splitPresetSelector(selector, knownSelectors);
  const assigned = models.find((item) => item.provider + "/" + item.id === model);
  const assignedHidden = Boolean(assigned?.hidden);
  const modelKnown = !model || Boolean(assigned);
  const unavailable = assignedHidden
    ? "hidden — still used until changed"
    : !modelKnown
      ? "not currently available — still used until changed"
      : null;
  const baseLabel = base ? (() => {
    const split = splitPresetSelector(base, knownSelectors);
    const baseAssigned = models.find((item) => item.provider + "/" + item.id === split.model);
    const name = baseAssigned ? formatModelDisplayName(baseAssigned.id, baseAssigned.name) : split.model;
    return split.level ? `${name} · ${split.level}` : name;
  })() : "engine default";
  const visible = models.filter((item) => !item.hidden);
  const modelOptions: SelectOption<string>[] = [
    { value: INHERIT_VALUE, label: `Inherit base (${baseLabel})` },
    ...(model && (!modelKnown || assignedHidden)
      ? [{ value: model, label: `${assigned ? formatModelDisplayName(assigned.id, assigned.name) : model} (${assignedHidden ? "hidden" : "not currently available"})` }]
      : []),
    ...visible.map((item) => ({ value: item.provider + "/" + item.id, label: `${formatModelDisplayName(item.id, item.name)} (${item.provider}/${item.id})` })),
  ];
  const levelOptions: SelectOption<string>[] = [
    { value: "", label: "Model default" },
    ...(assigned?.thinkingLevels ?? []).filter((entry) => entry !== "off").map((entry) => ({ value: entry, label: entry })),
  ];
  return (
    <SettingsRow
      label={
        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <code style={{ color: "var(--text-muted)" }}>{role}</code>
          {unavailable && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ ...chipStyle, color: "var(--status-warning)" }}>{UNAVAILABLE_BADGE}</span>
              <span style={{ fontSize: 11, color: "var(--status-warning)" }}>{unavailable}</span>
            </span>
          )}
        </span>
      }
    >
      <div className="model-role-row" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(148px, 0.4fr)", gap: 8, flex: 1, minWidth: 0 }}>
        <Select
          value={model || INHERIT_VALUE}
          disabled={disabled}
          onChange={(next) => onChange(next === INHERIT_VALUE ? "" : joinPresetSelector(next, level))}
          options={modelOptions}
          aria-label={`${role} model`}
        />
        <Select
          value={level}
          disabled={disabled || !assigned}
          onChange={(next) => onChange(joinPresetSelector(model, next))}
          options={levelOptions}
          aria-label={`${role} reasoning level`}
        />
      </div>
    </SettingsRow>
  );
}

/** One fallback-chain entry: a concrete model (never "inherit" — an empty
 *  slot is removed, not blanked) plus its reasoning level. */
function ChainEntryRow({ position, selector, models, knownSelectors, disabled, onChange }: {
  position: string;
  selector: string;
  models: RoleModelOption[];
  knownSelectors: ReadonlySet<string>;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const { model, level } = splitPresetSelector(selector, knownSelectors);
  const assigned = models.find((item) => item.provider + "/" + item.id === model);
  const visible = models.filter((item) => !item.hidden);
  const flagged = Boolean(model) && (!assigned || assigned.hidden);
  const levelOptions: SelectOption<string>[] = [
    { value: "", label: "Model default" },
    ...(assigned?.thinkingLevels ?? []).filter((entry) => entry !== "off").map((entry) => ({ value: entry, label: entry })),
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(104px, 0.35fr)", gap: 8, flex: 1, minWidth: 0 }}>
      <div>
        <Select
          value={model}
          disabled={disabled}
          onChange={(next) => onChange(joinPresetSelector(next, level))}
          options={[
            ...(flagged ? [{ value: model, label: `${assigned ? formatModelDisplayName(assigned.id, assigned.name) : model} (${assigned?.hidden ? "hidden" : "not currently available"})` }] : []),
            ...visible.map((item) => ({ value: item.provider + "/" + item.id, label: `${formatModelDisplayName(item.id, item.name)} (${item.provider}/${item.id})` })),
          ]}
          aria-label={`${position} model`}
        />
        {flagged && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
            <span style={{ ...chipStyle, color: "var(--status-warning)", fontSize: 11 }}>{UNAVAILABLE_BADGE}</span>
          </div>
        )}
      </div>
      <Select value={level} disabled={disabled || !assigned} onChange={(next) => onChange(joinPresetSelector(model, next))} options={levelOptions} aria-label={`${position} reasoning level`} />
    </div>
  );
}

interface PresetEditorFormProps {
  preset: ModelPreset;
  models: RoleModelOption[];
  roleNames: string[];
  baseRoles: Record<string, string>;
  panelId: string;
  onEditDetails: () => void;
}

function PresetEditorForm({ preset, models, roleNames, baseRoles, panelId, onEditDetails }: PresetEditorFormProps) {
  const { t, tn } = useI18n();
  const { track } = useSaveStatus(panelId);
  const knownSelectors = useMemo(() => new Set(models.map((model) => model.provider + "/" + model.id)), [models]);
  const [roles, setRoles] = useState<Record<string, string>>(() => Object.fromEntries(roleNames.map((role) => [role, preset.roles[role] ?? ""])));
  const [chains, setChains] = useState<Record<string, string[]>>(() => ({ ...preset.chains }));
  const [usageAware, setUsageAware] = useState<boolean | null>(preset.usageAwareFallback ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addChainRole, setAddChainRole] = useState("");
  const [chainCandidate, setChainCandidate] = useState<Record<string, string>>({});

  const setRole = (role: string, next: string) => {
    setRoles((current) => ({ ...current, [role]: next }));
    setDirty(true);
  };

  const visibleChainRoles = roleNames.filter((role) => role in chains);
  const addableChainRoles = roleNames.filter((role) => !(role in chains));

  const setChainEntries = (role: string, entries: string[]) => {
    setChains((current) => ({ ...current, [role]: entries }));
    setDirty(true);
  };
  const addChainCard = (role: string) => {
    setChains((current) => ({ ...current, [role]: [] }));
    setDirty(true);
  };
  const removeChainCard = (role: string) => {
    setChains((current) => {
      const next = { ...current };
      delete next[role];
      return next;
    });
    setChainCandidate((current) => { const next = { ...current }; delete next[role]; return next; });
    setDirty(true);
  };

  const save = () => {
    setSaving(true);
    setError(null);
    void track(async () => {
      const payload = {
        roles,
        chains: Object.fromEntries(Object.entries(chains).filter(([, entries]) => entries.length > 0)),
        usageAwareFallback: usageAware,
      };
      try {
        const result = await updateModelPreset(preset.id, payload);
        setDirty(false);
        invalidateSettingsRoutes(MODEL_PRESETS_ROUTE, { exact: true });
        toast.success(
          t("presets.saved", { name: preset.name }),
          tn("presets.savedNote", result.restarted)
            + (result.active > 0 ? tn("presets.savedActiveNote", result.active) : ""),
        );
      } catch (failure) {
        setError(presetErrorMessage(failure));
        throw failure;
      }
    }).finally(() => setSaving(false));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {preset.research && (
        <div style={{ display: "flex", gap: 8, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
          <Sparkles size={13} aria-hidden style={{ color: "var(--accent)", flexShrink: 0, marginTop: 2 }} />
          <span>
            {t("presets.researchStampNote", { stamp: researchStampSummary(preset.research, models, knownSelectors, (iso) => new Date(iso).toLocaleDateString(), t) })}
          </span>
        </div>
      )}

      <button type="button" onClick={onEditDetails} style={{ alignSelf: "flex-start", padding: 0, border: "none", background: "none", color: "var(--accent)", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
        {t("presets.editDetails")}
      </button>

      <SettingsSection title={t("presets.editorRolesTitle")} description={t("presets.editorRolesDescription")} variant="rows">
        {roleNames.map((role) => (
          <RoleSelectorRow
            key={role}
            role={role}
            selector={roles[role] ?? ""}
            base={baseRoles[role]}
            models={models}
            knownSelectors={knownSelectors}
            disabled={saving}
            onChange={(next) => setRole(role, next)}
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title={t("presets.editorChainsTitle")}
        description={t("presets.editorChainsDescription")}
        variant="plain"
        bodyStyle={{ padding: 0 }}
      >
        {visibleChainRoles.length === 0 ? (
          <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 12 }}>{t("presets.editorNoChains")}</div>
        ) : (
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {visibleChainRoles.map((role) => {
              const entries = chains[role] ?? [];
              const candidate = chainCandidate[role] ?? "";
              const unused = models.filter((item) => !item.hidden && !entries.includes(item.provider + "/" + item.id));
              return (
                <SettingsSection
                  key={role}
                  variant="plain"
                  bodyStyle={{ padding: 0 }}
                  title={<code style={{ fontSize: 12, color: "var(--text-muted)" }}>{role}</code>}
                  action={<button type="button" onClick={() => removeChainCard(role)} disabled={saving} title={t("presets.editorRemoveChainTitle", { role })} style={{ padding: 3, border: "none", background: "transparent", color: "var(--text-muted)", cursor: saving ? "default" : "pointer" }}><Trash2 size={13} /></button>}
                >
                  {entries.length === 0 ? (
                    <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 11, lineHeight: 1.45 }}>{t("presets.editorNotSavedYet")}</div>
                  ) : (
                    <ChainList>
                      {entries.map((entry, index) => (
                        <ChainRow
                          key={`${entry}-${index}`}
                          leading={<span style={{ width: 16, color: "var(--text-dim)", fontSize: 12 }}>{index + 1}</span>}
                          onMoveUp={index > 0 ? () => {
                            const next = [...entries];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                            setChainEntries(role, next);
                          } : undefined}
                          onMoveDown={index < entries.length - 1 ? () => {
                            const next = [...entries];
                            [next[index], next[index + 1]] = [next[index + 1], next[index]];
                            setChainEntries(role, next);
                          } : undefined}
                          onRemove={() => setChainEntries(role, entries.filter((_, at) => at !== index))}
                          isLast={index === entries.length - 1}
                        >
                          <ChainEntryRow
                            position={`${role} fallback ${index + 1}`}
                            selector={entry}
                            models={models}
                            knownSelectors={knownSelectors}
                            disabled={saving}
                            onChange={(next) => setChainEntries(role, entries.map((value, at) => (at === index ? next : value)))}
                          />
                        </ChainRow>
                      ))}
                    </ChainList>
                  )}
                  <div style={{ display: "flex", gap: 8, padding: 10, borderTop: entries.length > 0 ? "1px solid var(--border)" : undefined }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Select value={candidate || null} disabled={saving} onChange={(value) => setChainCandidate((current) => ({ ...current, [role]: value }))} options={unused.map((item) => ({ value: item.provider + "/" + item.id, label: formatModelDisplayName(item.id, item.name) }))} placeholder={t("presets.editorAddModelPlaceholder")} />
                    </div>
                    <button
                      type="button"
                      disabled={!candidate || saving}
                      onClick={() => { setChainEntries(role, [...entries, candidate]); setChainCandidate((current) => ({ ...current, [role]: "" })); }}
                      style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, cursor: candidate && !saving ? "pointer" : "default", opacity: candidate && !saving ? 1 : 0.6, display: "inline-flex", alignItems: "center", gap: 4 }}
                    >
                      <Plus size={13} /> {t("presets.editorAdd")}
                    </button>
                  </div>
                </SettingsSection>
              );
            })}
          </div>
        )}
        {addableChainRoles.length > 0 && (
          <div style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--border)" }}>
            <div style={{ flex: 1, minWidth: 0, maxWidth: 260 }}>
              <Select value={addChainRole || null} disabled={saving} onChange={setAddChainRole} options={addableChainRoles.map((role) => ({ value: role, label: role }))} placeholder={t("presets.editorAddChainPlaceholder")} />
            </div>
            <button
              type="button"
              disabled={!addChainRole || saving}
              onClick={() => { addChainCard(addChainRole); setAddChainRole(""); }}
              style={{ padding: "6px 10px", border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, cursor: addChainRole && !saving ? "pointer" : "default", opacity: addChainRole && !saving ? 1 : 0.6 }}
            >
              {t("presets.editorAddChain")}
            </button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("presets.editorUsageAwareTitle")} description={t("presets.editorUsageAwareDescription")} variant="plain">
        <Select
          value={usageAware === null ? "inherit" : usageAware ? "on" : "off"}
          disabled={saving}
          onChange={(value) => { setUsageAware(value === "inherit" ? null : value === "on"); setDirty(true); }}
          options={[
            { value: "inherit", label: t("presets.usageAwareInherit") },
            { value: "on", label: t("presets.usageAwareOn") },
            { value: "off", label: t("presets.usageAwareOff") },
          ]}
        />
      </SettingsSection>

      {error && (
        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--status-error)", fontSize: 12 }}>
          <AlertCircle size={13} aria-hidden /> {error}
        </div>
      )}

      <SettingsActions dirty={dirty} onSave={save} saving={saving} saveLabel={t("presets.editorSave")} savingLabel={t("presets.saving")} />
    </div>
  );
}

export function PresetEditor({ presetId, presets, models, roleNames, baseRoles, panelId, onClose, onEditDetails }: {
  presetId: string | null;
  presets: ModelPreset[];
  models: RoleModelOption[];
  roleNames: string[];
  baseRoles: Record<string, string>;
  panelId: string;
  onClose: () => void;
  onEditDetails: (preset: ModelPreset) => void;
}) {
  const preset = presetId ? presets.find((entry) => entry.id === presetId) ?? null : null;
  return (
    <Drawer open={presetId !== null} title={preset?.name ?? ""} presentation="side" onClose={onClose} width={560} ariaLabel={preset ? `Edit ${preset.name}` : "Edit preset"}>
      {preset && (
        <PresetEditorForm
          key={preset.id}
          preset={preset}
          models={models}
          roleNames={roleNames}
          baseRoles={baseRoles}
          panelId={panelId}
          onEditDetails={() => onEditDetails(preset)}
        />
      )}
    </Drawer>
  );
}
