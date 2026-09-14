"use client";

import { useCallback, useRef } from "react";
import { useI18n } from "@/lib/i18n";
import { MAX_TODO_TITLE_LENGTH } from "@/lib/project-todo-types";

export interface TodoQuickAddProps {
  onAdd: (title: string) => void;
  busy: boolean;
}

export const TodoQuickAdd = ({ onAdd, busy }: TodoQuickAddProps) => {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const trimmed = input.value.trim();
    if (trimmed) {
      onAdd(trimmed);
      input.value = "";
    }
  }, [onAdd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        inputRef.current!.value = "";
      }
    },
    [handleSubmit],
  );

  return (
    <input
      ref={inputRef}
      type="text"
      className="ui-focus-ring"
      placeholder={t("todo.addPlaceholder")}
      disabled={busy}
      maxLength={MAX_TODO_TITLE_LENGTH}
      onKeyDown={handleKeyDown}
      onBlur={handleSubmit}
      style={{
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        padding: "8px 10px",
        marginBottom: "10px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg)",
        color: "var(--text)",
        font: "inherit",
        fontSize: 13,
      }}
    />
  );
};
