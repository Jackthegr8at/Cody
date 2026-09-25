"use client";

/**
 * Settings › Models › Assignments › Presets › Research: a user-chosen strong
 * model does real web research (benchmarks, reviews, forum/social threads,
 * official claims) and proposes roles + fallback chains for one or more
 * presets, which the user reviews and applies preset by preset.
 *
 * The run lives entirely on the server (`ResearchRunSnapshot`), so this view
 * is a thin poller: `GET …/research` once for the planner roster and the
 * latest run (resuming it if one is already going), then `GET …/research/
 * [runId]` every ~2s while it is `running`. Closing this drawer does not
 * cancel the run — reopening it re-reads the same latest run, which is what
 * "survives closing the dialog" means.
 */
import { AlertCircle, ExternalLink, Globe, Info, Loader2, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Check, ConfirmDialog, Field } from "@/components/ui/field";
import { Select } from "@/components/ui/Select";
import { toast } from "@/components/ui/toast";
import { invalidateSettingsRoutes } from "@/hooks/useSettingsData";
import { useI18n } from "@/lib/i18n";
import { formatModelDisplayName } from "@/lib/model-display";
import {
  MODEL_PRESETS_ROUTE,
  ModelPresetsApiError,
  cancelResearchRun,
  fetchResearchRun,
  fetchResearchState,
  presetErrorMessage,
  startResearch,
  updateModelPreset,
} from "@/lib/model-presets/client";
import { diffPresetProposal } from "@/lib/model-presets/proposal";
import { describeRoleSelector, displayNameForModel } from "@/lib/model-presets/summary";
import type {
  ModelPreset,
  PresetProposal,
  ResearchProgressKind,
  ResearchRunSnapshot,
  ResearchSourceKind,
  ResearchStateResponse,
} from "@/lib/model-presets/types";
import { Drawer } from "../Drawer";
import { useSaveStatus } from "../SaveStatus";
import { SettingsSection } from "../SettingsSection";
import type { RoleModelOption } from "./ModelRoles";

const PROGRESS_ICON: Record<ResearchProgressKind, typeof Search> = {
  search: Search,
  read: Globe,
  thinking: Sparkles,
  note: Info,
  error: AlertCircle,
};

const SOURCE_KIND_LABEL: Record<ResearchSourceKind, string> = {
  benchmark: "Benchmarks",
  review: "Reviews",
  forum: "Forum & community",
  social: "Social",
  official: "Official",
  other: "Other sources",
};

const cardStyle = { border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: 12, display: "flex", flexDirection: "column" as const, gap: 8 };
const primaryButton = { padding: "7px 12px", minHeight: 32, border: "none", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--on-accent)", fontSize: 12, fontWeight: 600, cursor: "pointer" };
const ghostButton = { padding: "7px 12px", minHeight: 32, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", fontSize: 12, fontWeight: 500, cursor: "pointer" };

function disabledStyle<T extends object>(style: T, disabled: boolean): T {
  return disabled ? { ...style, opacity: 0.6, cursor: "default" } : style;
}

export function elapsedLabel(seconds: number): string {
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function ResearchRunBody({ presets, models, panelId }: { presets: ModelPreset[]; models: RoleModelOption[]; panelId: string }) {
  const { t, tn } = useI18n();
  const knownSelectors = useMemo(() => new Set(models.map((model) => model.provider + "/" + model.id)), [models]);
  const [meta, setMeta] = useState<ResearchStateResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [run, setRun] = useState<ResearchRunSnapshot | null | undefined>(undefined);
  const [showSetup, setShowSetup] = useState(false);
  const [planner, setPlanner] = useState("");
  const [selectedPresetIds, setSelectedPresetIds] = useState<Set<string>>(() => new Set(presets.filter((preset) => preset.builtIn).map((preset) => preset.id)));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({});
  const [confirmTarget, setConfirmTarget] = useState<{ kind: "one"; presetId: string } | { kind: "all" } | null>(null);
  const { track } = useSaveStatus(panelId);

  useEffect(() => {
    let cancelled = false;
    void fetchResearchState()
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setRun(data.run);
        setPlanner(data.suggested ?? data.plannerCandidates[0]?.selector ?? "");
      })
      .catch((failure: unknown) => {
        if (!cancelled) setLoadError(presetErrorMessage(failure));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the run every ~2s while it is running; a resumed run (already
  // running when this view opened) polls the same way.
  useEffect(() => {
    if (!run || run.status !== "running") return;
    let stopped = false;
    const id = setInterval(() => {
      void fetchResearchRun(run.id)
        .then(({ run: next }) => { if (!stopped) setRun(next); })
        .catch(() => {});
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [run?.id, run?.status]);

  useEffect(() => {
    if (!run || run.status !== "running") return;
    const started = new Date(run.startedAt).getTime();
    const tick = () => setElapsedSec(Math.max(0, Math.round((Date.now() - started) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [run?.id, run?.status, run?.startedAt]);

  const togglePreset = (id: string, checked: boolean) => {
    setSelectedPresetIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const startRun = () => {
    setStarting(true);
    setStartError(null);
    void startResearch({ plannerModel: planner, presetIds: [...selectedPresetIds] })
      .then(({ run: started }) => {
        setRun(started);
        setShowSetup(false);
      })
      .catch((failure: unknown) => {
        // A 409 means one is already going — watch it instead of erroring.
        if (failure instanceof ModelPresetsApiError && failure.code === "research_running" && failure.run) {
          setRun(failure.run);
          setShowSetup(false);
          return;
        }
        setStartError(presetErrorMessage(failure));
      })
      .finally(() => setStarting(false));
  };

  const cancelRun = () => {
    if (!run) return;
    setCancelling(true);
    void cancelResearchRun(run.id)
      .then(({ run: cancelled }) => setRun(cancelled))
      .catch((failure: unknown) => toast.error(t("presets.researchCancelFailed"), presetErrorMessage(failure)))
      .finally(() => setCancelling(false));
  };

  const proposals: Record<string, PresetProposal> = run?.result?.proposals ?? {};
  // Every proposal for a real preset is worth SHOWING — a "the planner
  // looked at Low and had nothing to assign" result stays visible, warnings
  // and all — but only ones with at least one role are worth OFFERING to
  // apply: an empty proposal would wipe every role and chain a configured
  // preset already has.
  const proposalIds = Object.keys(proposals).filter((id) => presets.some((preset) => preset.id === id));
  const applicableIds = proposalIds.filter((id) => Object.keys(proposals[id].roles).length > 0);

  const applyToPreset = (presetId: string): Promise<boolean> => {
    const proposal = proposals[presetId];
    const preset = presets.find((entry) => entry.id === presetId);
    if (!proposal || !preset || !run) return Promise.resolve(false);
    setApplying((current) => ({ ...current, [presetId]: true }));
    setApplyErrors((current) => { const next = { ...current }; delete next[presetId]; return next; });
    return track(async () => {
      const result = await updateModelPreset(presetId, {
        roles: proposal.roles,
        chains: proposal.chains,
        usageAwareFallback: proposal.usageAwareFallback,
        research: { runId: run.id, plannerModel: run.plannerModel, completedAt: run.finishedAt ?? new Date().toISOString(), rationale: proposal.rationale },
      });
      invalidateSettingsRoutes(MODEL_PRESETS_ROUTE, { exact: true });
      toast.success(
        t("presets.researchApplied", { name: preset.name }),
        tn("presets.researchAppliedNote", result.restarted)
          + (result.active > 0 ? tn("presets.savedActiveNote", result.active) : ""),
      );
    })
      .then((ok) => {
        if (!ok) setApplyErrors((current) => ({ ...current, [presetId]: t("presets.researchApplyFailed") }));
        return ok;
      })
      .finally(() => {
        setApplying((current) => { const next = { ...current }; delete next[presetId]; return next; });
      });
  };

  const requestApply = (presetId: string) => {
    if (Object.keys(proposals[presetId]?.roles ?? {}).length === 0) return;
    const preset = presets.find((entry) => entry.id === presetId);
    if (preset && Object.keys(preset.roles).length > 0) {
      setConfirmTarget({ kind: "one", presetId });
      return;
    }
    void applyToPreset(presetId);
  };

  const requestApplyAll = () => {
    const anyConfigured = applicableIds.some((id) => {
      const preset = presets.find((entry) => entry.id === id);
      return preset && Object.keys(preset.roles).length > 0;
    });
    if (anyConfigured) {
      setConfirmTarget({ kind: "all" });
      return;
    }
    for (const id of applicableIds) void applyToPreset(id);
  };

  if (!meta && !loadError) {
    return (
      <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 12 }}>
        <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} /> {t("presets.researchLoading")}
      </div>
    );
  }

  if (loadError && !meta) {
    return (
      <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--status-error)", fontSize: 12.5, margin: 0 }}><AlertCircle size={14} aria-hidden /> {loadError}</p>
      </div>
    );
  }

  const phase: "setup" | "running" | "result" = showSetup || !run ? "setup" : run.status === "running" ? "running" : "result";

  if (phase === "setup") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
          {t("presets.researchSetupIntro")}
        </p>
        <Field label={t("presets.researchPlannerLabel")}>
          <Select
            value={planner || null}
            onChange={setPlanner}
            placeholder={t("presets.researchPlannerPlaceholder")}
            options={(meta?.plannerCandidates ?? []).map((candidate) => ({
              value: candidate.selector,
              label: `${formatModelDisplayName(candidate.selector.slice(candidate.selector.indexOf("/") + 1), candidate.label)} (${candidate.selector})`,
            }))}
          />
        </Field>
        {(meta?.plannerCandidates.length ?? 0) === 0 && (
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--status-warning)" }}>{t("presets.researchNoPlanners")}</p>
        )}
        <SettingsSection title={t("presets.researchPresetsToFill")} variant="plain">
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px" }}>
            {presets.map((preset) => (
              <Check key={preset.id} label={`${preset.name}${preset.builtIn ? "" : t("presets.researchCustomSuffix")}`} checked={selectedPresetIds.has(preset.id)} onChange={(checked) => togglePreset(preset.id, checked)} />
            ))}
          </div>
        </SettingsSection>
        {startError && (
          <p role="alert" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, color: "var(--status-error)", fontSize: 12 }}><AlertCircle size={13} aria-hidden /> {startError}</p>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={disabledStyle(primaryButton, starting || !planner || selectedPresetIds.size === 0)} disabled={starting || !planner || selectedPresetIds.size === 0} onClick={startRun}>
            {starting ? t("presets.researchStarting") : t("presets.researchStart")}
          </button>
          {run && <button type="button" style={ghostButton} onClick={() => setShowSetup(false)}>{t("presets.researchBackToResults")}</button>}
        </div>
      </div>
    );
  }

  if (phase === "running" && run) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
            <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} /> {t("presets.researchRunning", { elapsed: elapsedLabel(elapsedSec) })}
          </span>
          <button type="button" style={disabledStyle(ghostButton, cancelling)} disabled={cancelling} onClick={cancelRun}>{cancelling ? t("presets.researchCancelling") : t("presets.researchCancel")}</button>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg)", maxHeight: 420, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          {run.progress.length === 0 ? (
            <div style={{ padding: 14, color: "var(--text-dim)", fontSize: 12 }}>{t("presets.researchStartingUp")}</div>
          ) : (
            run.progress.map((item, index) => {
              const Icon = PROGRESS_ICON[item.kind];
              return (
                <div key={index} style={{ display: "flex", gap: 8, padding: "7px 12px", borderTop: index === 0 ? "none" : "1px solid var(--border)", fontSize: 11.5, color: item.kind === "error" ? "var(--status-error)" : "var(--text-muted)" }}>
                  <Icon size={13} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                  <span style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
                    {item.text}
                    {item.url && (
                      <>
                        {" "}
                        <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{item.url}</a>
                      </>
                    )}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // phase === "result"
  if (!run) return null;

  if (run.status === "failed") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p role="alert" style={{ display: "flex", alignItems: "center", gap: 7, margin: 0, color: "var(--status-error)", fontSize: 12.5 }}><AlertCircle size={14} aria-hidden /> {run.error ?? t("presets.researchFailed")}</p>
        <button type="button" style={primaryButton} onClick={() => setShowSetup(true)}>{t("presets.researchTryAgain")}</button>
      </div>
    );
  }
  if (run.status === "cancelled") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12.5 }}>{t("presets.researchCancelled")}</p>
        <button type="button" style={primaryButton} onClick={() => setShowSetup(true)}>{t("presets.researchTryAgain")}</button>
      </div>
    );
  }
  if (!run.result) return null;
  const { result } = run;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text)", lineHeight: 1.55 }}>{result.summary}</p>
        <button type="button" style={{ ...ghostButton, flexShrink: 0 }} onClick={() => setShowSetup(true)}>{t("presets.researchRunAgain")}</button>
      </div>

      {result.models.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("presets.researchEvidenceTitle")}</div>
          {result.models.map((model) => {
            const grouped = model.sources.reduce<Record<string, typeof model.sources>>((acc, source) => {
              (acc[source.kind] ??= []).push(source);
              return acc;
            }, {});
            return (
              <div key={model.selector} style={cardStyle}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{displayNameForModel(model.selector, models)}</span>
                  <code style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{model.selector}</code>
                </div>
                <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{model.verdict}</p>
                {model.strengths.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "var(--status-success)", lineHeight: 1.5 }}>
                    {model.strengths.map((line, index) => <li key={index}>{line}</li>)}
                  </ul>
                )}
                {model.weaknesses.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "var(--status-warning)", lineHeight: 1.5 }}>
                    {model.weaknesses.map((line, index) => <li key={index}>{line}</li>)}
                  </ul>
                )}
                {Object.entries(grouped).length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {Object.entries(grouped).map(([kind, sources]) => (
                      <div key={kind} style={{ fontSize: 10.5, color: "var(--text-dim)" }}>
                        <span style={{ fontWeight: 600 }}>{SOURCE_KIND_LABEL[kind as ResearchSourceKind] ?? kind}: </span>
                        {sources.map((source, index) => (
                          <span key={source.url}>
                            {index > 0 && ", "}
                            <a href={source.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 2 }}>
                              {source.title} <ExternalLink size={9} aria-hidden />
                            </a>
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {proposalIds.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t("presets.researchProposalsTitle")}</div>
            {applicableIds.length > 1 && <button type="button" style={ghostButton} onClick={requestApplyAll}>{t("presets.researchApplyAll")}</button>}
          </div>
          {proposalIds.map((id) => {
            const preset = presets.find((entry) => entry.id === id);
            const proposal = proposals[id];
            if (!preset || !proposal) return null;
            const hasRoles = Object.keys(proposal.roles).length > 0;
            return (
              <div key={id} style={cardStyle}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{preset.name}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {Object.entries(proposal.roles).map(([role, selector]) => (
                    <div key={role} style={{ display: "flex", gap: 8, fontSize: 11.5 }}>
                      <code style={{ minWidth: 64, color: "var(--text-muted)" }}>{role}</code>
                      <span style={{ color: "var(--text)" }}>{describeRoleSelector(selector, undefined, models, knownSelectors, t)}</span>
                    </div>
                  ))}
                </div>
                {proposal.rationale.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4 }}>
                    {proposal.rationale.map((line, index) => (
                      <li key={index} style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
                        <code style={{ color: "var(--text)" }}>{line.role}</code> {line.text}
                        {line.sources.length > 0 && (
                          <>
                            {" "}
                            {line.sources.map((url, sourceIndex) => (
                              <span key={url}>{sourceIndex > 0 ? ", " : ""}<a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>{t("presets.researchSourceLink")}</a></span>
                            ))}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {proposal.warnings.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {proposal.warnings.map((warning, index) => (
                      <span key={index} style={{ display: "flex", alignItems: "flex-start", gap: 5, fontSize: 11, color: "var(--status-warning)" }}><AlertCircle size={12} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} /> {warning}</span>
                    ))}
                  </div>
                )}
                {applyErrors[id] && (
                  <p role="alert" style={{ margin: 0, fontSize: 11, color: "var(--status-error)" }}>{applyErrors[id]}</p>
                )}
                {!hasRoles && (
                  <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)" }}>{t("presets.researchApplyUnavailable")}</p>
                )}
                <button type="button" style={disabledStyle(primaryButton, Boolean(applying[id]) || !hasRoles)} disabled={Boolean(applying[id]) || !hasRoles} onClick={() => requestApply(id)}>
                  {applying[id] ? t("presets.researchApplying") : t("presets.researchApplyOne", { name: preset.name })}
                </button>
              </div>
            );
          })}
        </section>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(next) => { if (!next) setConfirmTarget(null); }}
        title={confirmTarget?.kind === "all" ? t("presets.researchOverwriteAllTitle") : t("presets.researchOverwriteOneTitle", { name: presets.find((preset) => preset.id === (confirmTarget?.kind === "one" ? confirmTarget.presetId : ""))?.name ?? "" })}
        description={
          confirmTarget?.kind === "one"
            ? describeApplyDiff(presets.find((preset) => preset.id === confirmTarget.presetId), proposals[confirmTarget.presetId], t, tn)
            : t("presets.researchOverwriteAllDescription")
        }
        confirmLabel={t("presets.researchApplyConfirm")}
        cancelLabel={t("presets.cancel")}
        danger
        onConfirm={() => {
          const target = confirmTarget;
          setConfirmTarget(null);
          if (!target) return;
          if (target.kind === "one") void applyToPreset(target.presetId);
          else for (const id of applicableIds) void applyToPreset(id);
        }}
      />
    </div>
  );
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type TranslatePlural = (key: string, count: number, vars?: Record<string, string | number>) => string;

export function describeApplyDiff(preset: ModelPreset | undefined, proposal: PresetProposal | undefined, t: Translate, tn: TranslatePlural): string {
  if (!preset || !proposal) return t("presets.researchOverwriteFallback");
  const diff = diffPresetProposal(preset, proposal);
  const parts: string[] = [];
  if (diff.roles.length > 0) parts.push(tn("presets.diffRoles", diff.roles.length));
  if (diff.chainsChanged.length > 0) parts.push(tn("presets.diffChains", diff.chainsChanged.length));
  if (diff.usageAwareChanged) parts.push(t("presets.diffUsageAware"));
  if (parts.length === 0) return t("presets.researchOverwriteSame", { name: preset.name });
  return t("presets.researchOverwriteChanges", { parts: parts.join(t("presets.listSeparator")), name: preset.name });
}

export function ResearchRunView({ open, presets, models, panelId, onClose }: {
  open: boolean;
  presets: ModelPreset[];
  models: RoleModelOption[];
  panelId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const title = t("presets.researchDrawerTitle");
  return (
    <Drawer open={open} title={title} presentation="side" onClose={onClose} width={640} ariaLabel={title}>
      {open && <ResearchRunBody presets={presets} models={models} panelId={panelId} />}
    </Drawer>
  );
}
