"use client";

import { RotateCcw } from "lucide-react";
import type { CSSProperties } from "react";

/**
 * The Save / Reset row every Assignments card ends on. Save is the primary
 * action and is only enabled once there is a draft to persist; Reset (when
 * the view has one) is the secondary, destructive-toned action beside it.
 * A view with no draft state at all (RetryFallbackPanel's toggles save
 * instantly) omits `onSave` and gets Reset alone.
 */

function saveStyle(dirty: boolean, saving: boolean): CSSProperties {
  return {
    padding: "7px 12px",
    minHeight: 32,
    border: "none",
    borderRadius: "var(--radius-control)",
    background: dirty ? "var(--accent)" : "var(--bg-hover)",
    color: dirty ? "var(--on-accent)" : "var(--text-dim)",
    cursor: saving ? "wait" : dirty ? "pointer" : "default",
    fontSize: 12,
    fontWeight: 600,
  };
}

function resetStyle(disabled: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 12px",
    minHeight: 32,
    border: "1px solid var(--status-error)",
    borderRadius: "var(--radius-control)",
    background: "none",
    color: "var(--status-error)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
    fontSize: 12,
    fontWeight: 500,
  };
}

export interface SettingsActionsProps {
  dirty?: boolean;
  onSave?: () => void;
  saving?: boolean;
  saveLabel?: string;
  savingLabel?: string;
  onReset?: () => void;
  resetLabel?: string;
  resetDisabled?: boolean;
}

export function SettingsActions({
  dirty = false,
  onSave,
  saving = false,
  saveLabel = "Save",
  savingLabel = "Saving…",
  onReset,
  resetLabel = "Reset to defaults",
  resetDisabled = false,
}: SettingsActionsProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
      <div>
        {onReset && (
          <button type="button" onClick={onReset} disabled={resetDisabled} style={resetStyle(resetDisabled)}>
            <RotateCcw size={13} aria-hidden="true" /> {resetLabel}
          </button>
        )}
      </div>
      {onSave && (
        <button type="button" onClick={onSave} disabled={!dirty || saving} style={saveStyle(dirty, saving)}>
          {saving ? savingLabel : saveLabel}
        </button>
      )}
    </div>
  );
}
