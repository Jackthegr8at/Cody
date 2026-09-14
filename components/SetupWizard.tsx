"use client";

import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/lib/i18n";
import { missingRequirements, type SetupReadiness, type SetupRequirement } from "@/lib/setup-status";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/primitives";
import {
  DefaultModelStep, EngineStep, ModelPlanStep, PrerequisiteNotice, ProvidersStep, SignInStep,
  STEP_REQUIREMENTS, ThemeStep, WebSearchStep, getWizardSteps, type WizardStepId,
} from "./setup-wizard-steps";
import type { EnginesPayload, EngineSummary } from "./settings/EngineRoster";

/**
 * The setup workflow: one dependency-ordered flow from "no engine" to a
 * working first chat, hosted as a dialog inside the app shell.
 *
 * Three properties make it a workflow rather than a slideshow, and each one
 * replaces an observed failure on a genuinely fresh instance:
 *
 * 1. **The engine is a step, not a separate screen.** Nothing in Cody works
 *    without one, so when none is installed it leads the flow and `Next` will
 *    not step over it. Previously the picker was its own overlay offering
 *    "decide later", which dropped the user into an app where every turn
 *    failed.
 * 2. **Every step knows its prerequisite** (`STEP_REQUIREMENTS`). A step whose
 *    requirement is unmet renders a notice naming it and a button that jumps
 *    to the step that fixes it — instead of "No models discovered yet" with
 *    nowhere to go, or the engine's own `omp binary not found` text.
 * 3. **It resumes.** The flow opens on the first INCOMPLETE requirement rather
 *    than always at step one, so reopening it from the shell's resume
 *    affordance continues where the instance actually is.
 *
 * Finishing or skipping persists `setupDone` server-side so Cody never nags.
 * That flag is deliberately NOT what decides whether the instance is ready —
 * readiness is derived from facts (lib/setup-status.ts), so skipping hides the
 * wizard without ever claiming a half-configured instance is complete.
 */

export function SetupWizard({ engine, hasModelsUi, readiness, engines, onReadinessChange, onDone, onDismiss }: {
  engine: EngineSummary | null;
  hasModelsUi: boolean;
  /** Facts, from useSetupStatus. Decides the step list and the gating. */
  readiness: SetupReadiness;
  /** Roster the shell already fetched, handed to the engine step unchanged. */
  engines: EnginesPayload | null;
  /** A step changed the instance (engine installed, provider linked): re-read. */
  onReadinessChange: () => void;
  /** Finished or skipped: persisted, never offered again. */
  onDone: () => void;
  /** Dialog dismissed (X / backdrop / Esc): hide for now, offer again later. */
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const missing = missingRequirements(readiness);
  // The engine step exists while no engine is installed. Recomputing the list
  // as readiness changes is intended: installing one retires the step, and the
  // index is re-anchored below so the user does not jump sideways.
  const steps = useMemo(
    () => getWizardSteps(engine?.id ?? null, hasModelsUi, !readiness.engine),
    [engine?.id, hasModelsUi, readiness.engine],
  );
  const [step, setStep] = useState<WizardStepId>(() => steps[0] ?? "theme");
  const [finishing, setFinishing] = useState(false);

  // Open on the first thing that is actually missing. Runs once the facts are
  // known (never while pending — that would anchor on a guess), and never
  // again, so it cannot yank the user off a step they chose to revisit.
  const anchored = useRef(false);
  useEffect(() => {
    if (anchored.current || readiness.pending) return;
    anchored.current = true;
    const firstGap = steps.find((candidate) => {
      const requirement = STEP_REQUIREMENTS[candidate];
      // The step that SATISFIES the first missing requirement is the one to
      // open on: no engine → the engine step; no provider → providers.
      if (candidate === "engine") return !readiness.engine;
      if (candidate === "providers" || candidate === "signIn") return !readiness.provider;
      return false;
    });
    if (firstGap) setStep(firstGap);
  }, [readiness, steps]);

  // A step list that no longer contains the current step (the engine step
  // retiring after an install) must land somewhere real.
  useEffect(() => {
    if (!steps.includes(step)) setStep(steps[0] ?? "theme");
  }, [step, steps]);

  const stepIndex = Math.max(0, steps.indexOf(step));
  const isLast = stepIndex >= steps.length - 1;
  // The engine step is the one gate: leaving it without an engine is what
  // produced a non-functional instance, so Next waits. "Finish setup later"
  // stays available — an honest escape, and the shell keeps offering to resume.
  const blocked = step === "engine" && !readiness.engine;

  const finish = useCallback(async () => {
    setFinishing(true);
    // Best-effort: a failed write only means the wizard offers itself again
    // next load, which beats trapping the user here.
    await fetch("/api/engines/setup-complete", { method: "POST" }).catch(() => {});
    onDone();
  }, [onDone]);

  // Plain functions: both close over `steps`/`stepIndex`, which change with
  // readiness, and hand-written dependency arrays here could not be preserved
  // by the React Compiler ("Compilation Skipped"), which then bailed out of
  // optimizing the whole component. The compiler memoizes them correctly on
  // its own.
  const advance = () => {
    if (stepIndex >= steps.length - 1) void finish();
    else setStep(steps[stepIndex + 1]);
  };

  /** Jump to whichever step satisfies a requirement, for the notice's button. */
  const jumpTo = (requirement: SetupRequirement): (() => void) | null => {
    const target = requirement === "engine"
      ? steps.find((candidate) => candidate === "engine")
      : steps.find((candidate) => candidate === "providers" || candidate === "signIn");
    if (!target || target === step) return null;
    return () => setStep(target);
  };

  const titles: Record<WizardStepId, { title: string; subtitle: string }> = {
    engine: { title: t("setupWizard.engineTitle"), subtitle: t("setupWizard.engineSubtitle") },
    providers: { title: t("setupWizard.providersTitle"), subtitle: t("setupWizard.providersSubtitle") },
    webSearch: { title: t("setupWizard.webSearchTitle"), subtitle: t("setupWizard.webSearchSubtitle") },
    model: { title: t("setupWizard.modelTitle"), subtitle: t("setupWizard.modelSubtitle") },
    signIn: {
      title: t("setupWizard.authTitle", { name: engine?.shortName ?? "" }).trim(),
      subtitle: t("setupWizard.authSubtitle", { name: engine?.shortName ?? "the engine" }),
    },
    theme: { title: t("setupWizard.themeTitle"), subtitle: t("setupWizard.themeSubtitle") },
    modelPlan: { title: t("setupWizard.modelPlanTitle"), subtitle: t("setupWizard.modelPlanSubtitle") },
  };

  const requirement = STEP_REQUIREMENTS[step];
  const unmet = requirement !== null && !readiness.pending && missing.includes(requirement) ? requirement : null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !finishing) onDismiss(); }}>
      <DialogContent
        ariaLabel={t("setupWizard.title")}
        onClose={finishing ? undefined : onDismiss}
        style={{
          width: isMobile ? "calc(100vw - 16px)" : 880,
          maxWidth: "calc(100vw - 16px)",
          height: isMobile ? "calc(100dvh - 16px)" : "80vh",
          maxHeight: "calc(100dvh - 16px)",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div className="setup-wizard-head">
          <DialogTitle style={{ fontSize: 16, margin: 0, fontWeight: 600, paddingRight: 36 }}>{titles[step].title}</DialogTitle>
          <p className="setup-wizard-subtitle">{titles[step].subtitle}</p>
          <div className="setup-wizard-rail" aria-label={t("setupWizard.stepLabel", { current: String(stepIndex + 1), total: String(steps.length) })}>
            {steps.map((candidate, index) => (
              <span
                key={candidate}
                className="setup-wizard-rail-dot"
                data-state={index === stepIndex ? "current" : index < stepIndex ? "done" : "todo"}
                aria-hidden
              />
            ))}
            <span className="setup-wizard-step">
              {t("setupWizard.stepLabel", { current: String(stepIndex + 1), total: String(steps.length) })}
            </span>
          </div>
        </div>

        <div className="setup-wizard-content">
          {unmet
            ? <PrerequisiteNotice requirement={unmet} onJump={jumpTo(unmet)} />
            : (
              <>
                {step === "engine" && (
                  <EngineStep
                    initial={engines}
                    onInstalled={(engineChanged) => {
                      // A different engine invalidates the models, capabilities
                      // and sessions the shell loaded, so the shell reloads;
                      // otherwise re-read the facts and carry on in place.
                      if (engineChanged) window.location.assign("/");
                      else onReadinessChange();
                    }}
                  />
                )}
                {step === "providers" && <ProvidersStep onChanged={onReadinessChange} />}
                {step === "webSearch" && <WebSearchStep />}
                {step === "model" && <DefaultModelStep />}
                {step === "signIn" && <SignInStep engine={engine} />}
                {step === "theme" && <ThemeStep />}
                {step === "modelPlan" && <ModelPlanStep onApplied={advance} onSkip={advance} />}
              </>
            )}
        </div>

        <div className="setup-wizard-actions">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button type="button" className="engine-link" onClick={() => void finish()} disabled={finishing}>
              {t("setupWizard.skip")}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {stepIndex > 0 && (
              <button type="button" className="login-ghost engine-button setup-wizard-btn" onClick={() => setStep(steps[stepIndex - 1])} disabled={finishing}>
                <ArrowLeft size={14} aria-hidden /> {t("setupWizard.back")}
              </button>
            )}
            <button
              type="button"
              className="login-primary engine-button setup-wizard-btn"
              onClick={advance}
              disabled={finishing || blocked}
              title={blocked ? t("setupWizard.engineRequired") : undefined}
            >
              {finishing
                ? <Loader2 size={14} aria-hidden style={{ animation: "spin 0.9s linear infinite" }} />
                : isLast ? <Check size={14} aria-hidden /> : <ArrowRight size={14} aria-hidden />}
              {isLast ? t("setupWizard.finish") : t("setupWizard.next")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
