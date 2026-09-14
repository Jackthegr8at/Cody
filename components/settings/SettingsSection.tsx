"use client";

import { Children, cloneElement, isValidElement, type CSSProperties, type ReactElement, type ReactNode } from "react";

/**
 * The one card shell for a Settings › Models assignment view: a bordered,
 * `--bg-panel` box with a header (title + optional muted description +
 * optional right-side action slot) and a body. Every Assignments card
 * (Local routing, Model roles, Retry, Fallback, Fallback chains, Plan,
 * Distill) renders through this so the tab reads as one design instead of
 * five hand-tuned ones.
 *
 * `variant="rows"` is for a body that is a list of "label: control"
 * settings: children render through `SettingsRow`, each a 2-column grid
 * line with a divider between rows (never after the last), and the body
 * itself carries no padding of its own since each row supplies it.
 */

const sectionStyle: CSSProperties = {
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-panel)",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 10,
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
};

export interface SettingsSectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-side slot beside the title: a toggle, a count, a remove button. */
  action?: ReactNode;
  children: ReactNode;
  /** "rows": children are `SettingsRow`s in a 2-column label/control grid
   * with dividers; "plain" (default): children render as-is in a padded body. */
  variant?: "plain" | "rows";
  /** data-search-id for search index jump targets. */
  searchId?: string;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}

export function SettingsSection({ title, description, action, children, variant = "plain", searchId, style, bodyStyle }: SettingsSectionProps) {
  const rows = variant === "rows";
  const items = rows ? Children.toArray(children).filter(isValidElement) : null;
  return (
    <section data-search-id={searchId} style={{ ...sectionStyle, ...style }}>
      <div style={headerStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{title}</div>
          {description && <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{description}</div>}
        </div>
        {action && <div style={{ flexShrink: 0 }}>{action}</div>}
      </div>
      <div style={{ padding: rows ? 0 : "12px 14px", ...bodyStyle }}>
        {items
          ? items.map((child, index) =>
              isValidElement(child)
                ? cloneElement(child as ReactElement<{ isLast?: boolean }>, { isLast: index === items.length - 1 })
                : child,
            )
          : children}
      </div>
    </section>
  );
}

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(120px, 0.32fr) minmax(0, 1fr)",
  gap: 10,
  alignItems: "center",
  padding: "10px 14px",
};

export interface SettingsRowProps {
  label: ReactNode;
  children: ReactNode;
  /** Injected by `SettingsSection` variant="rows"; set manually only when
   * `SettingsRow` is used outside that wrapper. */
  isLast?: boolean;
}

export function SettingsRow({ label, children, isLast }: SettingsRowProps) {
  return (
    <div style={{ ...rowStyle, borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
      <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 0 }}>{label}</span>
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>{children}</div>
    </div>
  );
}
