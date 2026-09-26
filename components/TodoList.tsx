"use client";

import { useEffect, useState } from "react";
import { Ban, CheckCircle2, ChevronDown, Circle, CircleAlert, CircleDotDashed, ListChecks, Wand2, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { PlanOverlay, TodoItem, TodoPhase } from "@/lib/pi-types";

function TodoStatusIcon({ status, size = 14 }: { status: TodoItem["status"]; size?: number }) {
  const props = { size, strokeWidth: 1.8, "aria-hidden": true as const };
  if (status === "completed") return <CheckCircle2 {...props} color="var(--accent)" />;
  if (status === "in_progress") return <CircleDotDashed {...props} color="var(--accent)" />;
  if (status === "blocked") return <CircleAlert {...props} color="var(--text-muted)" />;
  if (status === "abandoned") return <Ban {...props} color="var(--text-dim)" />;
  return <Circle {...props} color="var(--text-dim)" />;
}

interface TodoListProps {
  phases?: TodoPhase[];
  /** Current chat; dismissing a completed list must not hide another chat's list. */
  sessionId?: string | null;
  /** Plan-keeper overlay: subtasks nested under their exact parent task
   * content, and which top-level task contents the keeper (rather than the
   * model) marked complete. Absent/null renders exactly as it did before the
   * keeper existed — purely additive, never required. */
  overlay?: PlanOverlay | null;
  /** Render as a composer-attached panel: the header row becomes a
   * collapse/expand toggle and the section margin is dropped. */
  collapsible?: boolean;
  /** Initial expansion when `collapsible` (default: collapsed). */
  defaultExpanded?: boolean;
}

const DISMISSED_TASKS_STORAGE_PREFIX = "cody:dismissed-tasks:v1:";

/** A compact, stable identity without retaining task text in browser storage. */
export function todoListIdentity(phases: readonly TodoPhase[]): string {
  const source = JSON.stringify(phases.map((phase) => [phase.id ?? null, phase.name, phase.tasks.map((task) => [task.id ?? null, task.content])]));
  let hashA = 0x811c9dc5;
  let hashB = 0x9e3779b9;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    hashA = Math.imul(hashA ^ code, 0x01000193);
    hashB = Math.imul(hashB ^ code, 0x85ebca6b);
  }
  return `${source.length}:${(hashA >>> 0).toString(16)}:${(hashB >>> 0).toString(16)}`;
}

export function TodoList({ phases = [], overlay = null, sessionId = null, collapsible = false, defaultExpanded = false }: TodoListProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(collapsible ? !defaultExpanded : false);
  const tasks = phases.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  const allCompleted = tasks.length > 0 && done === tasks.length;
  const listIdentity = todoListIdentity(phases);
  const storageKey = sessionId ? `${DISMISSED_TASKS_STORAGE_PREFIX}${sessionId}` : null;
  const dismissIdentity = `${sessionId ?? "unsaved"}:${listIdentity}`;
  const [dismissedIdentity, setDismissedIdentity] = useState<string | null>(null);

  useEffect(() => {
    if (!storageKey || !allCompleted) return;
    try {
      if (window.localStorage.getItem(storageKey) === listIdentity) setDismissedIdentity(dismissIdentity);
    } catch {
      // Storage may be disabled; dismissal still works until this panel unmounts.
    }
  }, [storageKey, listIdentity, dismissIdentity, allCompleted]);

  useEffect(() => {
    if (!storageKey || tasks.length === 0 || allCompleted) return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // A denied storage write must not prevent an active task list appearing.
    }
    setDismissedIdentity(null);
  }, [storageKey, tasks.length, allCompleted]);

  if (phases.length === 0 || (allCompleted && dismissedIdentity === dismissIdentity)) return null;

  const dismiss = () => {
    setDismissedIdentity(dismissIdentity);
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, listIdentity);
    } catch {
      // Keep the immediate dismissal even when persistence is unavailable.
    }
  };
  let remainingPreviewTasks = 5;
  const displayedPhases = (expanded ? phases : phases.slice(0, 4)).map((phase) => {
    const displayedTasks = expanded ? phase.tasks : phase.tasks.slice(0, remainingPreviewTasks);
    remainingPreviewTasks -= displayedTasks.length;
    return { ...phase, tasks: displayedTasks };
  }).filter((phase) => phase.tasks.length > 0);
  const isTruncated = displayedPhases.reduce((count, phase) => count + phase.tasks.length, 0) < tasks.length;
  // Top-level task contents the KEEPER (not the model) marked complete —
  // the only thing the quiet Wand2 marker keys off. Subtask completion has
  // no separate "auto" flag: every subtask is keeper-owned, so a completed
  // one is inherently automatic and never wears the marker itself.
  const autoCompletedTasks = new Set(overlay?.autoCompleted ?? []);

  const headerRowClass = "flex items-center gap-2 px-3 py-2 text-xs text-text-muted";
  const headerBorderClass = collapsed ? "" : "border-b border-border";
  const progress = t("chatWindow.todoProgress", { done, total: tasks.length });

  return (
    <section
      aria-label={t("chatWindow.todoList")}
      className={`overflow-hidden border border-border bg-bg-subtle ${collapsible ? "" : "my-2"}`}
      // Composer variant fills its row so the stacked panels stay aligned in
      // every expansion state; the standalone variant keeps hugging content.
      style={{ borderRadius: "var(--radius-card)", width: collapsible ? "100%" : "fit-content", maxWidth: "100%" }}
    >
      {collapsible ? (
        <div className={`${headerRowClass} ${headerBorderClass}`}>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? t("chatWindow.expandPanel") : t("chatWindow.collapsePanel")}
          className="ui-focus-ring flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          style={{ background: "none" }}
        >
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          <span className="ml-auto">{progress}</span>
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            aria-hidden
            style={{
              color: "var(--text-dim)",
              transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
              transition: "transform var(--dur-fast) var(--ease-out-warm)",
            }}
          />
        </button>
        {allCompleted && (
          <button type="button" onClick={dismiss} className="ui-focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-dim hover:bg-bg-hover hover:text-text" aria-label={t("chatWindow.dismissCompletedTasks")} title={t("chatWindow.dismissCompletedTasks")}>
            <X size={14} strokeWidth={1.8} aria-hidden />
          </button>
        )}
        </div>
      ) : (
        <div className={`${headerRowClass} ${headerBorderClass}`}>
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          <strong className="font-medium text-text">{t("chatWindow.todoList")}</strong>
          <span className="ml-auto">{progress}</span>
          {allCompleted && (
            <button type="button" onClick={dismiss} className="ui-focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-dim hover:bg-bg-hover hover:text-text" aria-label={t("chatWindow.dismissCompletedTasks")} title={t("chatWindow.dismissCompletedTasks")}>
              <X size={14} strokeWidth={1.8} aria-hidden />
            </button>
          )}
        </div>
      )}
      {!collapsed && (
        <>
      <div className="grid gap-3 px-3 py-2.5" style={{ maxHeight: "min(40vh, 320px)", overflowY: "auto" }}>
        {displayedPhases.map((phase, phaseIndex) => (
          <div key={phase.id ?? `${phase.name}-${phaseIndex}`} className="grid gap-1.5">
            <div className="text-[11px] font-medium text-text-muted">{phase.name}</div>
            <div className="grid gap-1.5">
              {phase.tasks.map((task, taskIndex) => {
                const subtasks = overlay?.subtasks?.[task.content];
                const autoMarked = autoCompletedTasks.has(task.content);
                return (
                  <div key={task.id ?? `${task.content}-${taskIndex}`} className="grid gap-1">
                    <div
                      className="flex min-w-0 items-start gap-2 text-[13px] text-text"
                      aria-label={`${t(`chatWindow.todoStatus.${task.status}`)}: ${task.content}`}
                    >
                      <span className="mt-0.5 shrink-0"><TodoStatusIcon status={task.status} /></span>
                      <span className="min-w-0">
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <span className={task.status === "completed" || task.status === "abandoned" ? "text-text-dim line-through" : undefined}>
                            {task.content}
                          </span>
                          {subtasks && subtasks.length > 0 && (
                            <span className="text-[10px] text-text-dim">
                              {t("planKeeper.subtaskCount", { done: subtasks.filter((subtask) => subtask.status === "completed").length, total: subtasks.length })}
                            </span>
                          )}
                          {autoMarked && (
                            <span title={t("planKeeper.autoMarked")} data-testid="todo-auto-mark" className="inline-flex shrink-0">
                              <Wand2 size={11} strokeWidth={1.8} aria-hidden color="var(--text-dim)" />
                            </span>
                          )}
                        </span>
                        {task.blocker && (
                          <span className="mt-0.5 block text-[11px] text-text-muted">
                            {t("chatWindow.todoBlocker", { blocker: task.blocker })}
                          </span>
                        )}
                      </span>
                    </div>
                    {subtasks && subtasks.length > 0 && (
                      <div className="ml-1.5 grid min-w-0 gap-1 border-l border-border pl-3">
                        {subtasks.map((subtask, subtaskIndex) => (
                          <div
                            key={`${task.content}-sub-${subtaskIndex}`}
                            data-testid="todo-subtask"
                            className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-dim"
                            aria-label={`${t(`chatWindow.todoStatus.${subtask.status}`)}: ${subtask.content}`}
                          >
                            <span className="shrink-0"><TodoStatusIcon status={subtask.status} size={11} /></span>
                            <span className={`min-w-0 truncate${subtask.status === "completed" ? " line-through" : ""}`}>
                              {subtask.content}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {(isTruncated || expanded) && (
        <button
          type="button"
          className="border-t border-border px-3 py-2 text-left text-xs text-accent hover:text-accent-hover"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("chatWindow.todoShowLess") : t("chatWindow.todoShowAll")}
        </button>
      )}
        </>
      )}
    </section>
  );
}
