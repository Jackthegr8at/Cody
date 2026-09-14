"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/**
 * The one row shape for an ordered chain of models. RetryFallbackPanel's
 * fallback chains and DistillAssignment's summarize/condense chain both
 * render through this: a `leading` slot (a position digit for Retry, a
 * "Primary" / "Fallback #N" label for Distill), the row's own content —
 * static name + selector text for Retry, live model/effort selects for
 * Distill — and the same move-up / move-down / remove icon buttons.
 */

const iconButtonStyle: CSSProperties = {
  display: "inline-flex",
  padding: 2,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};

function iconStyle(disabled: boolean): CSSProperties {
  return { ...iconButtonStyle, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1 };
}

export interface ChainRowProps {
  leading: ReactNode;
  children: ReactNode;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  moveUpDisabled?: boolean;
  moveDownDisabled?: boolean;
  removeDisabled?: boolean;
  moveUpLabel?: string;
  moveDownLabel?: string;
  removeLabel?: string;
  /** Suppresses the divider below the last row; set by the caller's `.map`. */
  isLast?: boolean;
}

export function ChainRow({
  leading,
  children,
  onMoveUp,
  onMoveDown,
  onRemove,
  moveUpDisabled = false,
  moveDownDisabled = false,
  removeDisabled = false,
  moveUpLabel = "Move up",
  moveDownLabel = "Move down",
  removeLabel = "Remove",
  isLast = false,
}: ChainRowProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
      <div style={{ flexShrink: 0 }}>{leading}</div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
        {onMoveUp && (
          <button type="button" disabled={moveUpDisabled} onClick={onMoveUp} title={moveUpLabel} aria-label={moveUpLabel} style={iconStyle(moveUpDisabled)}>
            <ArrowUp size={14} aria-hidden="true" />
          </button>
        )}
        {onMoveDown && (
          <button type="button" disabled={moveDownDisabled} onClick={onMoveDown} title={moveDownLabel} aria-label={moveDownLabel} style={iconStyle(moveDownDisabled)}>
            <ArrowDown size={14} aria-hidden="true" />
          </button>
        )}
        {onRemove && (
          <button type="button" disabled={removeDisabled} onClick={onRemove} title={removeLabel} aria-label={removeLabel} style={iconStyle(removeDisabled)}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Groups `ChainRow`s under a card body with no extra chrome of its own —
 * the divider between rows comes from each row, the border from the card. */
export function ChainList({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
