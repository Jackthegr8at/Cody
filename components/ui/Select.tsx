"use client";

import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/**
 * The one dropdown Cody draws. A native `<select>` is painted by the
 * browser — a different popup on every platform, and one that ignores the
 * theme — so every choice control renders through this instead: a trigger
 * on the design tokens and a popup on the same `dropdown-surface` /
 * `dropdown-item` classes the composer's Smart/reasoning menus use, so the
 * whole app opens the same menu. Built on base-ui's Select for the parts a
 * hand-rolled popup always gets wrong (keyboard navigation, typeahead,
 * positioning that flips at the viewport edge, focus return, a portal that
 * escapes overflow:hidden ancestors).
 */

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Secondary muted line under the label. */
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectGroup<V extends string = string> {
  label: ReactNode;
  options: readonly SelectOption<V>[];
}

interface SelectProps<V extends string> {
  value: V | null;
  onChange: (value: V) => void;
  /** Flat options, or grouped sections; groups render a muted header row. */
  options: readonly SelectOption<V>[] | readonly SelectGroup<V>[];
  placeholder?: ReactNode;
  disabled?: boolean;
  /** Trigger height. `sm` (26px) for toolbars, `md` (32px, default) for forms. */
  size?: "sm" | "md";
  /** Shown before the value on the trigger. */
  icon?: ReactNode;
  /** Trigger width; defaults to filling its container. */
  width?: CSSProperties["width"];
  id?: string;
  name?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  /** Popup min/max width; defaults to at least the trigger's width. */
  popupWidth?: CSSProperties["minWidth"];
  invalid?: boolean;
}

function isGrouped<V extends string>(options: SelectProps<V>["options"]): options is readonly SelectGroup<V>[] {
  return options.length > 0 && "options" in options[0];
}

export function Select<V extends string = string>({
  value, onChange, options, placeholder, disabled, size = "md", icon, width, id, name, invalid, popupWidth,
  "aria-label": ariaLabel, "data-testid": testId,
}: SelectProps<V>) {
  const groups: readonly SelectGroup<V>[] = isGrouped(options) ? options : [{ label: null, options }];
  const flat = groups.flatMap((group) => group.options);
  const selected = flat.find((option) => option.value === value) ?? null;
  const height = size === "sm" ? 26 : 32;

  return (
    <BaseSelect.Root<V>
      value={value}
      onValueChange={(next) => { if (next !== null && next !== value) onChange(next); }}
      disabled={disabled}
      name={name}
      items={flat.map((option) => ({ value: option.value, label: option.label }))}
    >
      <BaseSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        className="ui-focus-ring ui-select-trigger"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: width ?? "100%",
          minWidth: 0,
          height,
          padding: size === "sm" ? "0 6px 0 8px" : "0 8px 0 10px",
          fontSize: size === "sm" ? 12 : 13,
          lineHeight: 1,
          textAlign: "left",
          color: selected ? "var(--text)" : "var(--text-dim)",
          background: "var(--bg-panel)",
          border: `1px solid ${invalid ? "var(--status-error)" : "var(--border)"}`,
          borderRadius: "var(--radius-control)",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.55 : 1,
        }}
      >
        {icon && <span style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>{icon}</span>}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <BaseSelect.Value>{selected ? selected.label : placeholder ?? ""}</BaseSelect.Value>
        </span>
        <BaseSelect.Icon style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-muted)" }}>
          <ChevronDown size={size === "sm" ? 12 : 14} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} alignItemWithTrigger={false} style={{ zIndex: 1200 }}>
          <BaseSelect.Popup
            className="dropdown-surface"
            style={{ minWidth: popupWidth ?? "var(--anchor-width)", maxWidth: "min(420px, calc(100vw - 16px))", maxHeight: "min(360px, var(--available-height))", overflowY: "auto", padding: 4 }}
          >
            <BaseSelect.List>
              {groups.map((group, groupIndex) => (
                <BaseSelect.Group key={groupIndex}>
                  {group.label !== null && group.label !== undefined && (
                    <BaseSelect.GroupLabel style={{ padding: "6px 10px 3px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)" }}>
                      {group.label}
                    </BaseSelect.GroupLabel>
                  )}
                  {group.options.map((option) => (
                    <BaseSelect.Item
                      key={option.value}
                      value={option.value}
                      disabled={option.disabled}
                      className="dropdown-item"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: option.description ? "6px 10px" : "6px 10px",
                        borderRadius: "calc(var(--radius-control) - 2px)",
                        fontSize: 12.5,
                        cursor: option.disabled ? "default" : "pointer",
                        opacity: option.disabled ? 0.5 : 1,
                        outline: "none",
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <BaseSelect.ItemText style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{option.label}</BaseSelect.ItemText>
                        {option.description && <span style={{ display: "block", fontSize: 11, color: "var(--text-dim)", whiteSpace: "normal" }}>{option.description}</span>}
                      </span>
                      <BaseSelect.ItemIndicator style={{ display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
                        <Check size={13} />
                      </BaseSelect.ItemIndicator>
                    </BaseSelect.Item>
                  ))}
                </BaseSelect.Group>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
