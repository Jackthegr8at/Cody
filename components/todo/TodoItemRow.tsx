"use client";

import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { MAX_TODO_NOTES_LENGTH, MAX_TODO_TITLE_LENGTH, TODO_COLORS, type TodoColor, type TodoItem } from "@/lib/project-todo-types";
import { Check, ChevronRight, GripVertical, Trash2 } from "lucide-react";
import type { TodoItemChanges } from "./useTodoDocument";

export interface TodoItemRowProps {
  item: TodoItem;
  done: boolean;
  dragActive: boolean;
  dropIndicator: "before" | "after" | null;
  coarsePointer: boolean;
  onComplete: (id: string) => Promise<boolean>;
  onReopen: (id: string) => Promise<boolean>;
  onUpdate: (id: string, changes: TodoItemChanges) => Promise<boolean>;
  onDelete: (item: TodoItem) => void;
  onReorderKeyboard: (id: string, direction: -1 | 1) => void;
  onDragStart: (id: string) => void;
  onDragMove: (clientX: number, clientY: number) => void;
  onDragEnd: () => void;
}

function colorTone(color?: TodoColor): string {
  return color ? `var(--todo-color-${color})` : "var(--text-dim)";
}

const TodoItemRowComponent = ({
  item,
  done,
  dragActive,
  dropIndicator,
  coarsePointer,
  onComplete,
  onReopen,
  onUpdate,
  onDelete,
  onReorderKeyboard,
  onDragStart,
  onDragMove,
  onDragEnd,
}: TodoItemRowProps) => {
  const { t } = useI18n();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [completing, setCompleting] = useState(false);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const paletteButtonRef = useRef<HTMLButtonElement>(null);
  const completingTimeoutRef = useRef<number | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (editingTitle) {
      setTitleDraft(item.title);
      setTitleError(null);
      titleInputRef.current?.select();
    }
  }, [editingTitle, item.title]);

  useEffect(() => {
    if (notesOpen) {
      setNotesDraft(item.notes ?? "");
      notesRef.current?.focus();
    }
  }, [notesOpen, item.notes]);

  useEffect(() => () => {
    if (completingTimeoutRef.current !== null) window.clearTimeout(completingTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!paletteOpen) return;
    const handleOutsideClick = (e: Event) => {
      if (!(e.target instanceof HTMLElement)) return;
      if (paletteButtonRef.current?.contains(e.target)) return;
      setPaletteOpen(false);
    };
    window.addEventListener("mousedown", handleOutsideClick);
    return () => window.removeEventListener("mousedown", handleOutsideClick);
  }, [paletteOpen]);

  const saveTitle = useCallback(async () => {
    if (!titleDraft) {
      setTitleError(t("todo.titleRequired"));
      return;
    }
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setTitleError(t("todo.titleRequired"));
      return;
    }
    if (titleDraft === item.title) {
      setEditingTitle(false);
      return;
    }
    const saved = await onUpdate(item.id, { title: trimmed });
    if (saved) {
      setEditingTitle(false);
    }
  }, [titleDraft, item.id, item.title, onUpdate, t]);

  const handleTitleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void saveTitle();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditingTitle(false);
        setTitleError(null);
      }
    },
    [saveTitle],
  );

  const handleTitleBlur = useCallback(() => {
    void saveTitle();
  }, [saveTitle]);

  const commitNotes = useCallback(() => {
    setNotesOpen(false);
    if (notesDraft === (item.notes ?? "")) return;
    void onUpdate(item.id, { notes: notesDraft });
  }, [item.id, item.notes, notesDraft, onUpdate]);

  const notesKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.currentTarget.blur();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }, []);

  const handleCheckboxClick = useCallback(() => {
    if (done) {
      onReopen(item.id);
      return;
    }
    if (completing) return;
    setCompleting(true);
    completingTimeoutRef.current = window.setTimeout(() => {
      completingTimeoutRef.current = null;
      onComplete(item.id);
    }, 180);
  }, [completing, done, item.id, onComplete, onReopen]);

  const handleGripPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (done) return;
      dragPointerIdRef.current = e.pointerId;
      onDragStart(item.id);
    },
    [done, item.id, onDragStart],
  );

  const handleGripPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (dragPointerIdRef.current !== e.pointerId) return;
      onDragMove(e.clientX, e.clientY);
    },
    [onDragMove],
  );

  const handleGripPointerUp = useCallback(() => {
    dragPointerIdRef.current = null;
    onDragEnd();
  }, [onDragEnd]);

  const handleGripKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (!e.altKey) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        onReorderKeyboard(item.id, -1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onReorderKeyboard(item.id, 1);
      }
    },
    [item.id, onReorderKeyboard],
  );

  const checked = done || completing;

  return (
    <div
      data-todo-row-id={item.id}
      className="todo-row"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        borderBottom: "1px solid var(--border)",
        background: dragActive ? "var(--bg-hover)" : "transparent",
        opacity: dragActive ? 0.6 : 1,
        boxShadow:
          dropIndicator === "before"
            ? "inset 0 2px 0 var(--accent)"
            : dropIndicator === "after"
              ? "inset 0 -2px 0 var(--accent)"
              : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minHeight: 38,
          padding: "0 8px",
        }}
      >
        {/* Grip */}
        {!done && (
          <button
            type="button"
            className="todo-row-action ui-focus-ring"
            style={{
              width: 18,
              height: 24,
              minWidth: 18,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "grab",
              padding: 0,
              touchAction: "none",
              opacity: coarsePointer ? 1 : undefined,
            }}
            aria-label={t("todo.reorder", { title: item.title })}
            title={t("todo.reorder", { title: item.title })}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onPointerDown={handleGripPointerDown}
            onPointerMove={handleGripPointerMove}
            onPointerUp={handleGripPointerUp}
            onPointerCancel={handleGripPointerUp}
            onKeyDown={handleGripKeyDown}
          >
            <GripVertical size={14} aria-hidden="true" />
          </button>
        )}

        {/* Checkbox */}
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={done ? t("todo.reopenItem", { title: item.title }) : t("todo.complete", { title: item.title })}
          title={done ? t("todo.reopenItem", { title: item.title }) : t("todo.complete", { title: item.title })}
          disabled={completing}
          className="ui-focus-ring"
          onClick={handleCheckboxClick}
          style={{
            width: 22,
            height: 22,
            minWidth: 22,
            minHeight: 22,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: `1.5px solid ${checked ? "color-mix(in srgb, var(--status-success) 55%, var(--border))" : "var(--border)"}`,
            touchAction: "manipulation",
          }}
        >
          {checked && (
            <Check
              size={13}
              strokeWidth={3}
              aria-hidden="true"
              style={{
                strokeDasharray: 16,
                strokeDashoffset: completing ? undefined : 0,
                animation: completing ? "saved-check-draw 180ms var(--ease-out-warm)" : undefined,
              }}
            />
          )}
        </button>

        {/* Color dot */}
        {!done && (
          <div style={{ position: "relative" }}>
            <button
              ref={paletteButtonRef}
              type="button"
              className="ui-focus-ring"
              style={{
                width: 16,
                height: 16,
                minWidth: 16,
                minHeight: 16,
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                borderRadius: "999px",
                background: colorTone(item.color),
                padding: 0,
                cursor: "pointer",
              }}
              aria-label={t("todo.changeColor", { title: item.title })}
              title={t("todo.changeColor", { title: item.title })}
              onClick={() => setPaletteOpen(!paletteOpen)}
            />
            {paletteOpen && (
              <div
                className="animate-scale-in"
                style={{
                  position: "absolute",
                  top: "100%",
                  left: 0,
                  marginTop: 4,
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: 4,
                  padding: 6,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  background: "var(--bg-panel)",
                  boxShadow: "var(--shadow-card)",
                  zIndex: 1000,
                }}
              >
                {TODO_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="ui-focus-ring"
                    style={{
                      width: 24,
                      height: 24,
                      padding: 0,
                      border: item.color === color ? `2px solid var(--accent)` : "none",
                      borderRadius: "999px",
                      background: `var(--todo-color-${color})`,
                      cursor: "pointer",
                      transition: "transform var(--dur-fast) var(--ease-out-warm)",
                    }}
                    aria-label={t("todo.color." + color)}
                    title={t("todo.color." + color)}
                    onClick={() => {
                      if (item.color === color) {
                        void onUpdate(item.id, { color: null });
                      } else {
                        void onUpdate(item.id, { color });
                      }
                      setPaletteOpen(false);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Title */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {done ? (
            <span
              style={{
                display: "block",
                color: "var(--text)",
                font: "inherit",
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.35,
                textDecoration: "line-through",
                opacity: 0.7,
              }}
            >
              {item.title}
            </span>
          ) : editingTitle ? (
            <input
              ref={titleInputRef}
              type="text"
              className="ui-focus-ring"
              value={titleDraft}
              maxLength={MAX_TODO_TITLE_LENGTH}
              aria-label={t("todo.editTitle", { title: item.title })}
              aria-invalid={titleError ? true : undefined}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              onBlur={handleTitleBlur}
              style={{
                display: "block",
                width: "100%",
                minWidth: 0,
                boxSizing: "border-box",
                padding: "1px 4px",
                margin: "-1px -4px",
                border: "1px solid var(--border)",
                borderRadius: 4,
                background: "var(--bg)",
                color: "var(--text)",
                font: "inherit",
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.35,
                textAlign: "left",
                outline: "none",
              }}
            />
          ) : (
            <button
              type="button"
              className="todo-row-title ui-focus-ring"
              onClick={() => setEditingTitle(true)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "1px 4px",
                margin: "-1px -4px",
                border: "1px solid transparent",
                borderRadius: 4,
                background: "transparent",
                color: "var(--text)",
                font: "inherit",
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.35,
                cursor: "text",
                textDecoration: "none",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item.title}
            </button>
          )}
          {titleError && (
            <div style={{ marginTop: 2, fontSize: 11, color: "var(--status-error)", fontStyle: "italic" }}>
              {titleError}
            </div>
          )}
        </div>

        {/* Notes chevron (active only) */}
        {!done && (
          <button
            type="button"
            className={item.notes ? "ui-focus-ring" : "todo-row-action ui-focus-ring"}
            style={{
              width: 24,
              height: 24,
              minWidth: 24,
              minHeight: 24,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              borderRadius: "var(--radius-control)",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              padding: 0,
              opacity: coarsePointer ? 1 : undefined,
            }}
            aria-label={item.notes ? t("todo.editNotes", { title: item.title }) : t("todo.notesAdd", { title: item.title })}
            title={item.notes ? t("todo.editNotes", { title: item.title }) : t("todo.notesAdd", { title: item.title })}
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((open) => !open)}
          >
            <ChevronRight
              size={14}
              aria-hidden="true"
              style={{
                transition: "transform var(--dur-fast) var(--ease-out-warm)",
                transform: notesOpen ? "rotate(90deg)" : "rotate(0deg)",
              }}
            />
          </button>
        )}

        {/* Trash (active only) */}
        {!done && (
          <button
            type="button"
            className="todo-row-action todo-row-delete ui-focus-ring"
            style={{
              width: 24,
              height: 24,
              minWidth: 24,
              minHeight: 24,
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              borderRadius: "var(--radius-control)",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              padding: 0,
              opacity: coarsePointer ? 1 : undefined,
            }}
            aria-label={t("todo.delete")}
            title={t("todo.delete")}
            onClick={() => onDelete(item)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Notes textarea (active, open) */}
      {!done && notesOpen && (
        <div
          style={{
            padding: "0 8px 8px 34px",
          }}
        >
          <textarea
            ref={notesRef}
            value={notesDraft}
            maxLength={MAX_TODO_NOTES_LENGTH}
            rows={3}
            aria-label={t("todo.editNotes", { title: item.title })}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={commitNotes}
            onKeyDown={notesKeyDown}
            style={{
              display: "block",
              width: "100%",
              boxSizing: "border-box",
              padding: "4px 6px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--bg)",
              color: "var(--text)",
              font: "inherit",
              fontSize: 12,
              lineHeight: 1.4,
              resize: "vertical",
              outline: "none",
            }}
          />
        </div>
      )}

      {/* Notes preview (read-only) */}
      {!notesOpen && item.notes && (
        <div
          style={{
            padding: "0 8px 8px 34px",
            color: "var(--text-dim)",
            fontSize: 11.5,
            lineHeight: 1.4,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {item.notes}
        </div>
      )}
    </div>
  );
};

export const TodoItemRow = memo(TodoItemRowComponent);
