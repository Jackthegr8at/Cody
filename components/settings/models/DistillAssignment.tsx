"use client";

/**
 * Settings › Models › Assignments › Distill: which model writes the running
 * one line summary shown on a COLLAPSED thinking box, and condenses a
 * finished reply.
 *
 * Cody-owned state, deliberately: the chain lives in Cody's own
 * `cody-distill.json` behind GET/PUT `/api/distill/config`, never in the
 * engine's config, and an entry is an opaque `provider/id[:effort]`
 * selector validated syntactically. A selector the catalog no longer lists
 * still renders and still saves — the server falls through the chain and
 * finally to the engine default at run time — so an engine that drops a
 * model degrades to the next entry instead of erroring here.
 *
 * The whole view hides when the route answers `unsupported` (an ACP engine
 * has no one-shot runner to distill with); `useDistillConfig` is the one
 * place that decision is read from.
 */
import { AlertCircle } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { toast } from "@/components/ui/toast";
import { Select, type SelectOption } from "@/components/ui/Select";
import { invalidateSettingsRoutes, setSettingsRouteData, useSettingsRoute, type SettingsRouteResult } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { formatModelDisplayName } from "@/lib/model-display";
import { chipStyle, UNAVAILABLE_BADGE } from "../primitives";
import { useSaveStatus } from "../SaveStatus";
import { SettingsActions } from "../SettingsActions";
import { SettingsSection } from "../SettingsSection";
import { ChainList, ChainRow } from "./ChainList";
import { useSettingsShell } from "../shell-context";
import { splitSelector, type RoleModelOption } from "./ModelRoles";

export const DISTILL_CONFIG_ROUTE = "/api/distill/config";

export interface DistillConfigBody {
  /** False when Distill cannot run right now (the engine binary is
   * missing, say). The chain is still editable: the reason is a state of
   * the machine, not of the feature. */
  supported: boolean;
  reason?: string;
  /** `provider/id[:effort]`, primary first. Empty = engine default. */
  chain: string[];
  canManage: boolean;
}

/** The server's ceiling on chain length (`MAX_CHAIN_LENGTH` in
 * lib/distill/config.ts, node-only so it cannot be imported here),
 * mirrored so the picker stops offering models the PUT would reject. */
export const MAX_CHAIN = 8;

/**
 * The cached Distill route plus the one boolean the surrounding hub gates
 * on. `available` is about the SURFACE: an engine with no one-shot runner
 * answers 400 `unsupported` and the segment is not rendered at all. A 200
 * with `supported: false` is a different thing — the feature exists and
 * the chain is still worth editing — so it keeps the surface and shows
 * the server's reason instead.
 *
 * It stays false until the route has actually answered, so the segment
 * never flashes in before hiding again — and a read that FAILED (any
 * error, not only `unsupported`) leaves it false too: without the current
 * chain there is nothing to edit, and an absent segment beats a broken
 * one.
 */
export function useDistillConfig(): { route: SettingsRouteResult<DistillConfigBody>; available: boolean } {
  const route = useSettingsRoute<DistillConfigBody>(DISTILL_CONFIG_ROUTE);
  return { route, available: !route.unsupported && route.data !== null };
}

const noteStyle: CSSProperties = { margin: 0, padding: "8px 10px", color: "var(--text-muted)", fontSize: 11, lineHeight: 1.45 };

/** Renders model/effort selects for a distill chain entry. */
function DistillChainRowContent({ selector, models, selectors, disabled, onModel, onEffort }: {
  selector: string;
  models: RoleModelOption[];
  selectors: ReadonlySet<string>;
  disabled: boolean;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
}) {
  const { t } = useI18n();
  const { model, effort } = splitSelector(selector, selectors);
  const assigned = models.find((item) => item.provider + "/" + item.id === model);
  const hidden = Boolean(assigned?.hidden);
  const missing = Boolean(model) && !assigned;
  const levels = (assigned?.thinkingLevels ?? []).filter((level) => level !== "off");
  const visible = models.filter((item) => !item.hidden);
  const flag = missing ? t("distillSettings.unavailable") : hidden ? t("distillSettings.hidden") : null;
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: t("distillSettings.engineDefault") },
    ...((missing || hidden) && model
      ? [{
          value: model,
          label: assigned
            ? t("distillSettings.optionHidden", { model: formatModelDisplayName(assigned.id, assigned.name) })
            : t("distillSettings.optionUnavailable", { model }),
        }]
      : []),
    ...visible.map((item) => ({
      value: item.provider + "/" + item.id,
      label: `${formatModelDisplayName(item.id, item.name)} (${item.provider}/${item.id})`,
    })),
  ];
  const effortOptions: SelectOption<string>[] = [
    { value: "", label: t("distillSettings.modelDefault") },
    ...(effort && !levels.includes(effort) ? [{ value: effort, label: effort }] : []),
    ...levels.map((level) => ({ value: level, label: level })),
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(104px, 0.35fr)", gap: 8, flex: 1, minWidth: 0 }}>
      <div>
        <Select
          value={model}
          onChange={onModel}
          options={modelOptions}
          disabled={disabled}
          aria-label={t("distillSettings.modelAria", { position: selector })}
        />
        {flag && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 3 }}>
            <span style={{ ...chipStyle, color: "var(--status-warning)", fontSize: 11 }}>{UNAVAILABLE_BADGE}</span>
            <span style={{ fontSize: 10.5, color: "var(--status-warning)" }}>{flag}</span>
          </div>
        )}
      </div>
      <Select
        value={effort}
        onChange={onEffort}
        options={effortOptions}
        disabled={disabled || levels.length === 0}
        aria-label={t("distillSettings.thinkingAria", { position: selector })}
      />
    </div>
  );
}

export function DistillAssignment({ models, panelId }: { models: RoleModelOption[]; panelId: string }) {
  const { t } = useI18n();
  const { harnessLabel } = useSettingsShell();
  const { track } = useSaveStatus(panelId);
  const { route } = useDistillConfig();
  // The server's copy is the value until the user edits: a draft of `null`
  // means "whatever the route says", so the first paint already shows the
  // saved chain instead of an empty one that fills in an effect later.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [candidate, setCandidate] = useState("");
  const selectors = useMemo(() => new Set(models.map((item) => item.provider + "/" + item.id)), [models]);

  const chain = draft ?? route.data?.chain ?? [];
  const dirty = draft !== null;
  const canManage = route.data?.canManage === true;
  const editable = canManage && !saving;
  const primary = chain[0] ?? "";
  const fallbacks = chain.slice(1);

  const setEntry = (index: number, next: { model?: string; effort?: string }) => {
    const current = splitSelector(chain[index] ?? "", selectors);
    const model = next.model ?? current.model;
    // Clearing the primary clears the chain: fallbacks with nothing to fall
    // back FROM would be saved as a primary the user never chose.
    if (index === 0 && !model) {
      setDraft([]);
      return;
    }
    if (!model) {
      setDraft(chain.filter((_, position) => position !== index));
      return;
    }
    // On a model switch the reasoning level survives only when the new
    // model advertises it, so a saved selector never carries a level that
    // model cannot take.
    const levels = models.find((item) => item.provider + "/" + item.id === model)?.thinkingLevels ?? [];
    const effort = next.model !== undefined
      ? (levels.includes(current.effort) ? current.effort : "")
      : (next.effort ?? current.effort);
    const nextChain = [...chain];
    nextChain[index] = effort ? model + ":" + effort : model;
    setDraft(nextChain);
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 1 || target >= chain.length) return;
    const next = [...chain];
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  };

  const save = () => {
    setSaving(true);
    void track(async () => {
      const response = await fetch(DISTILL_CONFIG_ROUTE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chain }) });
      const data = (await response.json().catch(() => ({}))) as Partial<DistillConfigBody> & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      // The PUT answers with the chain as STORED (duplicates collapsed,
      // entries trimmed), so that body — not the draft — becomes the
      // route's value while the confirming re-read is in flight.
      const saved = Array.isArray(data.chain) ? data.chain : chain;
      setSettingsRouteData<DistillConfigBody>(DISTILL_CONFIG_ROUTE, {
        supported: data.supported !== false,
        ...(data.reason ? { reason: data.reason } : {}),
        chain: saved,
        canManage: data.canManage !== false,
      });
      setDraft(null);
      invalidateSettingsRoutes("/api/distill");
      const head = splitSelector(saved[0] ?? "", selectors).model;
      const named = models.find((item) => item.provider + "/" + item.id === head);
      toast.success(
        t("distillSettings.savedTitle"),
        head
          ? t("distillSettings.savedBody", { model: named ? formatModelDisplayName(named.id, named.name) : head })
          : t("distillSettings.savedBodyDefault", { engine: harnessLabel }),
      );
    }).finally(() => setSaving(false));
  };

  const used = new Set(chain.map((entry) => splitSelector(entry, selectors).model));
  const full = chain.length >= MAX_CHAIN;
  const addable = full ? [] : models.filter((item) => !item.hidden && !used.has(item.provider + "/" + item.id));
  // A 200 that says the engine cannot run right now: the chain is still
  // worth setting, so the view stays and names the blocker.
  const blocked = route.data?.supported === false ? route.data.reason ?? null : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsSection
        title={t("distillSettings.title")}
        description={
          <>
            <p style={{ margin: "0 0 8px 0" }}>{t("distillSettings.intro")}</p>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)" }}>{t("distillSettings.prefsHint")}</p>
          </>
        }
      >
        {blocked && (
          <div role="status" style={{ display: "flex", alignItems: "flex-start", gap: 7, padding: "8px 10px", margin: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", fontSize: 11.5, color: "var(--status-warning)", lineHeight: 1.45 }}>
            <AlertCircle size={13} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{t("distillSettings.notReady")} {blocked}</span>
          </div>
        )}
        {route.loading && !route.data ? (
          <div style={{ padding: "10px 14px", color: "var(--text-muted)", fontSize: 12 }}>{t("distillSettings.loading")}</div>
        ) : (
          <>
            <div style={{ borderBottom: "1px solid var(--border)", padding: "10px 14px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t("distillSettings.primaryTitle")}</div>
              <ChainRow
                leading={<span style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("distillSettings.primaryLabel")}</span>}
              >
                <DistillChainRowContent
                  selector={primary}
                  models={models}
                  selectors={selectors}
                  disabled={!editable}
                  onModel={(model) => setEntry(0, { model })}
                  onEffort={(effort) => setEntry(0, { effort })}
                />
              </ChainRow>
              <p style={{ ...noteStyle, borderTop: 0, paddingTop: 6 }}>{primary ? t("distillSettings.primaryNote") : t("distillSettings.engineDefaultNote", { engine: harnessLabel })}</p>
            </div>

            {primary && (
              <div style={{ borderTop: "1px solid var(--border)", padding: "10px 14px" }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t("distillSettings.fallbackTitle")}</div>
                <p style={{ ...noteStyle, borderTop: 0, marginBottom: 8, paddingTop: 0 }}>{t("distillSettings.fallbackNote")}</p>
                <ChainList>
                  {fallbacks.length === 0 ? (
                    <p style={{ ...noteStyle, borderTop: 0, paddingTop: 0 }}>{t("distillSettings.noFallbacks")}</p>
                  ) : (
                    <>
                      {fallbacks.map((entry, index) => (
                        <ChainRow
                          key={`${entry}-${index}`}
                          leading={<span style={{ color: "var(--text-muted)", fontSize: 12 }}>{index + 1}</span>}
                          onMoveUp={index > 0 ? () => move(index + 1, -1) : undefined}
                          onMoveDown={index < fallbacks.length - 1 ? () => move(index + 1, 1) : undefined}
                          onRemove={() => setDraft(chain.filter((_, position) => position !== index + 1))}
                        >
                          <DistillChainRowContent
                            selector={entry}
                            models={models}
                            selectors={selectors}
                            disabled={!editable}
                            onModel={(model) => setEntry(index + 1, { model })}
                            onEffort={(effort) => setEntry(index + 1, { effort })}
                          />
                        </ChainRow>
                      ))}
                    </>
                  )}
                </ChainList>
                {full && <p style={{ ...noteStyle, borderTop: 0, paddingTop: 0 }}>{t("distillSettings.chainFull", { max: MAX_CHAIN })}</p>}
                <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
                  <Select
                    value={candidate || null}
                    onChange={(value) => { setCandidate(""); setDraft([...chain, value]); }}
                    options={addable.map((item) => ({
                      value: item.provider + "/" + item.id,
                      label: `${formatModelDisplayName(item.id, item.name)} (${item.provider}/${item.id})`,
                    }))}
                    placeholder={t("distillSettings.addFallback")}
                    disabled={!editable || addable.length === 0}
                    aria-label={t("distillSettings.addFallback")}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </SettingsSection>

      {route.error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 12 }}>{route.error}</div>}

      {canManage && (
        <SettingsActions
          dirty={dirty}
          onSave={save}
          saving={saving}
          saveLabel={t("distillSettings.save")}
          savingLabel={t("distillSettings.saving")}
        />
      )}
      {!canManage && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{t("distillSettings.readOnly")}</p>
      )}
    </div>
  );
}
