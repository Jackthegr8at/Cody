"use client";

/**
 * Settings › Models › Assignments › Presets: replaces the old inline "Plan"
 * view (`ModelPlanPanel`, which still runs — compact — as the setup
 * wizard's last step and writes the user's BASE `modelRoles` directly).
 *
 * A preset is a complete, named role + fallback-chain overlay a conversation
 * can switch to from the composer while it is on Smart; see
 * `lib/model-presets/types.ts` for the full contract. This view owns the
 * roster (create, rename, edit intent, delete a custom one — built-ins
 * Max/High/Medium/Low can be edited and renamed but never deleted) and
 * hands off to two nested surfaces: `PresetEditor` (roles, fallback chains,
 * usage-aware fallback for one preset) and `ResearchRunView` (a real
 * web-research pass that proposes all of that for one or more presets at
 * once).
 *
 * `GET /api/model-presets` is read through the shared settings-route cache
 * ONCE here — the list, the editor and the research view all need the same
 * `presets` / `roleNames` / `baseRoles`, so every write (in this view, in
 * the editor, or in the research view) only has to invalidate this one
 * cache entry for every one of them to pick up the change.
 */
import { AlertCircle, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog, Field, TextInput } from "@/components/ui/field";
import { Select } from "@/components/ui/Select";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { toast } from "@/components/ui/toast";
import { invalidateSettingsRoutes, useSettingsRoute } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { MODEL_PRESETS_ROUTE, createModelPreset, deleteModelPreset, presetErrorMessage, updateModelPreset } from "@/lib/model-presets/client";
import { describeRoleSelector, researchStampSummary } from "@/lib/model-presets/summary";
import type { ModelPreset, ModelPresetsResponse } from "@/lib/model-presets/types";
import { chipStyle } from "../primitives";
import type { RoleModelOption } from "./ModelRoles";
import { PresetEditor } from "./PresetEditor";
import { ResearchRunView } from "./ResearchRunView";

const textareaStyle = {
  padding: "6px 9px",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "inherit",
  lineHeight: 1.5,
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
  resize: "vertical" as const,
};

const primaryButton = { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", minHeight: 32, border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const ghostButton = { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", minHeight: 32, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", fontSize: 12, fontWeight: 500, cursor: "pointer" };
const iconButtonStyle = { display: "inline-flex", padding: 6, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", borderRadius: "var(--radius-control)" };

interface PresetFormInput {
  name: string;
  intent: string;
  copyFrom?: string;
}

function PresetFormDialog({ open, mode, initialName, initialIntent, copyFromOptions, busy, error, onCancel, onSubmit }: {
  open: boolean;
  mode: "create" | "details";
  initialName: string;
  initialIntent: string;
  copyFromOptions: readonly { value: string; label: string }[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: PresetFormInput) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [intent, setIntent] = useState(initialIntent);
  const [copyFrom, setCopyFrom] = useState("");
  const [touched, setTouched] = useState(false);

  // Re-seed whenever the dialog opens, mirroring PromptDialog's own reset.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setIntent(initialIntent);
      setCopyFrom("");
      setTouched(false);
    }
  }, [open, initialName, initialIntent]);

  const nameError = touched && !name.trim() ? t("presets.nameRequired") : null;
  const title = mode === "create" ? t("presets.createTitle") : t("presets.detailsTitle");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="ui-dialog" ariaLabel={title} style={{ width: 440, maxWidth: "min(92vw, 440px)", padding: 22 }}>
        <DialogTitle>{title}</DialogTitle>
        <div style={{ height: 8 }} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (!name.trim()) return;
            onSubmit({ name: name.trim(), intent: intent.trim(), ...(mode === "create" && copyFrom ? { copyFrom } : {}) });
          }}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <Field label={t("presets.nameLabel")} error={nameError}>
            <TextInput value={name} onChange={setName} placeholder={t("presets.namePlaceholder")} disabled={busy} autoComplete="off" onBlurValidate={() => setTouched(true)} />
          </Field>
          <Field label={t("presets.intentLabel")} hint={t("presets.intentHint")}>
            <textarea value={intent} onChange={(event) => setIntent(event.target.value)} disabled={busy} rows={3} style={textareaStyle} placeholder={t("presets.intentPlaceholder")} />
          </Field>
          {mode === "create" && (
            <Field label={t("presets.startFromLabel")}>
              <Select value={copyFrom || null} onChange={setCopyFrom} placeholder={t("presets.startFromPlaceholder")} disabled={busy} options={copyFromOptions} />
            </Field>
          )}
          {error && (
            <p role="alert" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, fontSize: 12, color: "var(--status-error)" }}><AlertCircle size={13} aria-hidden /> {error}</p>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onCancel} style={{ ...ghostButton }}>{t("presets.cancel")}</button>
            <button type="submit" disabled={busy} style={{ ...primaryButton, opacity: busy ? 0.7 : 1, cursor: busy ? "wait" : "pointer" }}>
              {busy ? t("presets.saving") : mode === "create" ? t("presets.createSubmit") : t("presets.detailsSubmit")}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PresetRow({ preset, isDefault, baseRoles, models, knownSelectors, onOpen, onEditDetails, onDelete }: {
  preset: ModelPreset;
  isDefault: boolean;
  baseRoles: Record<string, string>;
  models: RoleModelOption[];
  knownSelectors: ReadonlySet<string>;
  onOpen: () => void;
  onEditDetails: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const defaultLine = describeRoleSelector(preset.roles.default, baseRoles.default, models, knownSelectors, t);
  const stampLine = researchStampSummary(preset.research, models, knownSelectors, (iso) => new Date(iso).toLocaleDateString(), t);
  return (
    <div role="listitem" style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        onClick={onOpen}
        style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4, textAlign: "left", border: "none", background: "none", padding: "10px 4px", font: "inherit", color: "inherit", cursor: "pointer" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{preset.name}</span>
          {preset.builtIn && <span style={chipStyle}>{t("presets.builtInBadge")}</span>}
          {isDefault && <span style={{ ...chipStyle, color: "var(--accent)" }}>{t("presets.defaultBadge")}</span>}
        </span>
        {preset.intent && (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>{preset.intent}</span>
        )}
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("presets.defaultModelLabel", { summary: defaultLine })}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: preset.research ? "var(--accent)" : "var(--text-dim)" }}>
          {preset.research && <Sparkles size={11} aria-hidden />} {stampLine}
        </span>
      </button>
      <span style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        <button type="button" title={t("presets.editDetails")} aria-label={t("presets.editDetailsAria", { name: preset.name })} onClick={onEditDetails} style={iconButtonStyle}><Pencil size={14} aria-hidden /></button>
        {!preset.builtIn && (
          <button type="button" title={t("presets.deletePreset")} aria-label={t("presets.deletePresetAria", { name: preset.name })} onClick={onDelete} style={iconButtonStyle}><Trash2 size={14} aria-hidden /></button>
        )}
      </span>
    </div>
  );
}

export function ModelPresets({ models, panelId, initial }: {
  models: RoleModelOption[];
  panelId: string;
  /** Painted until the shared cache answers — the same seam
   *  `EngineRoster`'s `initial` uses, since a static-markup render always
   *  sees the route cache's empty server snapshot. */
  initial?: ModelPresetsResponse | null;
}) {
  const { t, tn } = useI18n();
  const route = useSettingsRoute<ModelPresetsResponse>(MODEL_PRESETS_ROUTE);
  const data = route.data ?? initial ?? null;

  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [researchOpen, setResearchOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detailsTarget, setDetailsTarget] = useState<ModelPreset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelPreset | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const knownSelectors = useMemo(() => new Set(models.map((model) => model.provider + "/" + model.id)), [models]);

  const closeForm = () => {
    setCreating(false);
    setDetailsTarget(null);
    setFormError(null);
  };

  const submitForm = (input: PresetFormInput) => {
    setFormBusy(true);
    setFormError(null);
    if (creating) {
      void createModelPreset(input)
        .then(({ preset }) => {
          invalidateSettingsRoutes(MODEL_PRESETS_ROUTE, { exact: true });
          toast.success(t("presets.created", { name: preset.name }), t("presets.createdNote"));
          closeForm();
          setEditingPresetId(preset.id);
        })
        .catch((failure: unknown) => setFormError(presetErrorMessage(failure)))
        .finally(() => setFormBusy(false));
    } else if (detailsTarget) {
      void updateModelPreset(detailsTarget.id, { name: input.name, intent: input.intent })
        .then((result) => {
          invalidateSettingsRoutes(MODEL_PRESETS_ROUTE, { exact: true });
          const note = tn("presets.savedNote", result.restarted)
            + (result.active > 0 ? tn("presets.savedActiveNote", result.active) : "");
          toast.success(t("presets.saved", { name: input.name }), note);
          closeForm();
        })
        .catch((failure: unknown) => setFormError(presetErrorMessage(failure)))
        .finally(() => setFormBusy(false));
    }
  };

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleting(true);
    void deleteModelPreset(target.id)
      .then(({ reassigned }) => {
        invalidateSettingsRoutes(MODEL_PRESETS_ROUTE, { exact: true });
        toast.success(
          t("presets.deleted", { name: target.name }),
          reassigned > 0 ? tn("presets.deletedNote", reassigned) : undefined,
        );
        setDeleteTarget(null);
      })
      .catch((failure: unknown) => toast.error(t("presets.deleteFailed", { name: target.name }), presetErrorMessage(failure)))
      .finally(() => setDeleting(false));
  };

  if (!data) {
    return route.error
      ? <div role="alert" style={{ padding: "10px 4px", color: "var(--status-error)", fontSize: 12 }}>{route.error}</div>
      : <div role="status" style={{ padding: "10px 4px", color: "var(--text-muted)", fontSize: 12 }}>{t("presets.loading")}</div>;
  }

  const { presets, lastUsedPresetId, roleNames, baseRoles } = data;
  const defaultPreset = presets.find((preset) => preset.id === lastUsedPresetId);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-search-id="model-presets-list">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("presets.title")}</div>
          <p style={{ margin: "4px 0 0", fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
            {t("presets.description")}{" "}
            {defaultPreset ? t("presets.newChatsStartOn", { name: defaultPreset.name }) : t("presets.newChatsStartOnBase")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button type="button" style={ghostButton} data-search-id="model-presets-research" onClick={() => setResearchOpen(true)}><Sparkles size={13} aria-hidden /> {t("presets.research")}</button>
          <button type="button" style={primaryButton} onClick={() => setCreating(true)}><Plus size={13} aria-hidden /> {t("presets.new")}</button>
        </div>
      </div>

      <div role="list" style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden" }}>
        {presets.map((preset, index) => (
          <div key={preset.id} style={{ padding: "0 12px", borderTop: index === 0 ? "none" : "1px solid var(--border)" }}>
            <PresetRow
              preset={preset}
              isDefault={preset.id === lastUsedPresetId}
              baseRoles={baseRoles}
              models={models}
              knownSelectors={knownSelectors}
              onOpen={() => setEditingPresetId(preset.id)}
              onEditDetails={() => setDetailsTarget(preset)}
              onDelete={() => setDeleteTarget(preset)}
            />
          </div>
        ))}
      </div>

      <PresetFormDialog
        open={creating || detailsTarget !== null}
        mode={creating ? "create" : "details"}
        initialName={detailsTarget?.name ?? ""}
        initialIntent={detailsTarget?.intent ?? ""}
        copyFromOptions={[{ value: "base", label: t("presets.startFromBase") }, ...presets.map((preset) => ({ value: preset.id, label: preset.name }))]}
        busy={formBusy}
        error={formError}
        onCancel={closeForm}
        onSubmit={submitForm}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => { if (!next) setDeleteTarget(null); }}
        title={t("presets.deleteTitle", { name: deleteTarget?.name ?? "" })}
        description={t("presets.deleteDescription")}
        confirmLabel={t("presets.deleteConfirm")}
        cancelLabel={t("presets.cancel")}
        danger
        busy={deleting}
        onConfirm={confirmDelete}
      />

      <PresetEditor
        presetId={editingPresetId}
        presets={presets}
        models={models}
        roleNames={roleNames}
        baseRoles={baseRoles}
        panelId={panelId}
        onClose={() => setEditingPresetId(null)}
        onEditDetails={(preset) => setDetailsTarget(preset)}
      />

      <ResearchRunView
        open={researchOpen}
        presets={presets}
        models={models}
        panelId={panelId}
        onClose={() => setResearchOpen(false)}
      />
    </div>
  );
}
