"use client";

import { AlertTriangle, ArrowRight, X } from "lucide-react";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { missingRequirements, type SetupReadiness } from "@/lib/setup-status";

/**
 * Says what is still missing, and reopens the setup flow at it.
 *
 * This is the half of onboarding that did not exist. Skipping or dismissing
 * the wizard used to leave a fresh instance with no engine, no credentials and
 * no route back: the only trace was a static "Get Started" list, and the first
 * message failed with the engine's own CLI advice. So the offer is driven by
 * FACTS (lib/setup-status.ts), not by whether the wizard was shown — an
 * instance that skipped setup and still cannot answer a turn keeps saying so.
 *
 * Correspondingly it is silent whenever there is nothing true to report:
 * while any fact is still pending, once every requirement is met, and for a
 * member (only an admin can install an engine or add a provider — the shell
 * gates on `canManage`). Dismissal lasts the page load; the condition it
 * describes is a real defect, so it is not something to remember as read.
 */
export function SetupResumeBar({ readiness, onResume }: {
  readiness: SetupReadiness;
  onResume: () => void;
}) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(false);
  const missing = missingRequirements(readiness);
  if (hidden || missing.length === 0) return null;
  // The nearest dependency is the actionable one: naming all three at once
  // ("no engine, no provider, no models") reads as three problems when it is
  // one with consequences.
  const next = missing[0];

  return (
    <div className="setup-resume" role="status">
      <AlertTriangle size={14} aria-hidden style={{ color: "var(--status-warning)", flexShrink: 0 }} />
      <span className="setup-resume-text">{t(`setupWizard.incomplete.${next}`)}</span>
      <button type="button" className="setup-resume-action" onClick={onResume}>
        {t("setupWizard.resume")}
        <ArrowRight size={12} aria-hidden />
      </button>
      <button
        type="button"
        className="setup-resume-close ui-focus-ring"
        onClick={() => setHidden(true)}
        aria-label={t("setupWizard.resumeDismiss")}
        title={t("setupWizard.resumeDismiss")}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}
