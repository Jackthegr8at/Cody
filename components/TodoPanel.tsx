"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  ListTodo,
  Loader2,
  MoreHorizontal,
  MessageSquare,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/field";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/primitives";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import type { TodoColor, TodoDocument, TodoItem, TodoOperation } from "@/lib/project-todo";
import type { ChatInputHandle } from "./ChatInput";
import { TasksPanel } from "./TasksPanel";
const TODO_COLORS: readonly TodoColor[] = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"];



const COLOR_TONES: Record<TodoColor, string> = {
  gray: "var(--todo-color-gray)",
  red: "var(--todo-color-red)",
  orange: "var(--todo-color-orange)",
  yellow: "var(--todo-color-yellow)",
  green: "var(--todo-color-green)",
  blue: "var(--todo-color-blue)",
  purple: "var(--todo-color-purple)",
  pink: "var(--todo-color-pink)",
};

const ASK_AGENT_PROMPT = "Work through my to-do list in .cody/todo.json in order. Use the cody_todo tool if you have it, otherwise read the file. Complete each item only when it is actually done and leave a short note on anything you skip.";
type TodoItemChanges = Omit<Extract<TodoOperation, { op: "update" }>, "id" | "op">;


interface TodoLoadResponse {
  status?: "loaded" | "missing";
  path?: string;
  doc?: TodoDocument;
  error?: string;
}

interface TodoMutationResponse {
  doc?: TodoDocument;
  error?: string;
}

interface TasksConfigResponse {
  state?: "missing" | "invalid" | "loaded";
}

export interface TodoPanelProps {
  cwd: string | null;
  /** Switch the shell to the terminal that received a project command. */
  onOpenTerminalTask?: (terminalId?: string) => void;
  /** Composer insertion surface owned by AppShell. */
  chatInputRef?: RefObject<ChatInputHandle | null>;
  /** The mounted right-panel tab is currently visible. */
  active?: boolean;
  /** Monotonic request from PreviewPanel to expand the Commands section. */
  openCommandsRequest?: number;
}

export interface TodoPanelContentProps {
  cwd?: string | null;
  doc: TodoDocument;
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  commandsAvailable?: boolean;
  active?: boolean;
  openCommandsRequest?: number;
  defaultDoneOpen?: boolean;
  defaultHistoryOpen?: boolean;
  defaultCommandsOpen?: boolean;
  onAdd?: (title: string) => Promise<boolean>;
  onUpdate?: (id: string, changes: TodoItemChanges) => Promise<boolean>;
  onComplete?: (id: string) => Promise<boolean>;
  onReopen?: (id: string) => Promise<boolean>;
  onDelete?: (id: string) => Promise<boolean>;
  onReorder?: (ids: string[]) => Promise<boolean>;
  onRefresh?: () => void;
  onAskAgent?: () => void;
  onOpenTerminalTask?: (terminalId?: string) => void;
  onCommandsStateChange?: (state: "missing" | "invalid" | "loaded" | null) => void;
}




function colorTone(color?: TodoColor): string {
  return color ? COLOR_TONES[color] : "var(--text-dim)";
}

function iconButtonStyle(disabled = false): CSSProperties {
  return {
    width: 30,
    height: 30,
    minWidth: 30,
    minHeight: 30,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg)",
    color: disabled ? "var(--text-dim)" : "var(--text-muted)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.55 : 1,
    touchAction: "manipulation",
  };
}

function compactButtonStyle(disabled = false, accent = false): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: 30,
    padding: "4px 8px",
    border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
    borderRadius: "var(--radius-control)",
    background: accent ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))" : "var(--bg)",
    color: accent ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    opacity: disabled ? 0.55 : 1,
    touchAction: "manipulation",
  };
}

function inputStyle(): CSSProperties {
  return {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    padding: "7px 9px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 12,
    outline: "none",
  };
}

function formatHistoryTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function CollapsedSection({
  title,
  count,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  count?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", overflow: "hidden" }}>
        <CollapsibleTrigger
          className="ui-focus-ring"
          style={{
            width: "100%",
            minHeight: 38,
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "7px 10px",
            border: "none",
            background: "transparent",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
            touchAction: "manipulation",
          }}
        >
          {open ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 650 }}>{title}</span>
          {typeof count === "number" && (
            <span style={{ color: "var(--text-dim)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{count}</span>
          )}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div style={{ padding: "0 10px 10px", borderTop: "1px solid var(--border)" }}>{children}</div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

function TodoItemCard({
  item,
  done,
  position,
  activeCount,
  busy,
  onComplete,
  onReopen,
  onUpdate,
  onMove,
  onDelete,
}: {
  item: TodoItem;
  done: boolean;
  position: number;
  activeCount: number;
  busy: boolean;
  onComplete?: (id: string) => Promise<boolean>;
  onReopen?: (id: string) => Promise<boolean>;
  onUpdate?: (id: string, changes: TodoItemChanges) => Promise<boolean>;
  onMove?: (id: string, direction: -1 | 1) => Promise<boolean>;
  onDelete?: (item: TodoItem) => void;
}) {
  const { t } = useI18n();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(item.title);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(item.notes ?? "");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(item.title);
  }, [editingTitle, item.title]);

  useEffect(() => {
    if (!notesOpen) setNotesDraft(item.notes ?? "");
  }, [item.notes, notesOpen]);

  const saveTitle = useCallback(async () => {
    const title = titleDraft.trim();
    if (!title) {
      setTitleError(t("todo.titleRequired"));
      return;
    }
    const saved = await onUpdate?.(item.id, { title });
    if (saved !== false) {
      setEditingTitle(false);
      setTitleError(null);
    }
  }, [item.id, onUpdate, t, titleDraft]);

  const saveNotes = useCallback(async () => {
    const saved = await onUpdate?.(item.id, { notes: notesDraft });
    if (saved !== false) setNotesOpen(false);
  }, [item.id, notesDraft, onUpdate]);

  const chooseColor = useCallback(async (color: TodoColor) => {
    const saved = await onUpdate?.(item.id, { color: item.color === color ? null : color });
    if (saved !== false) setPaletteOpen(false);
  }, [item.color, item.id, onUpdate]);

  const toggleStatus = useCallback(async () => {
    if (done) await onReopen?.(item.id);
    else await onComplete?.(item.id);
  }, [done, item.id, onComplete, onReopen]);

  const titleInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveTitle();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditingTitle(false);
      setTitleError(null);
    }
  }, [saveTitle]);

  return (
    <article
      style={{
        position: "relative",
        padding: "7px 8px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        background: "var(--bg-panel)",
        opacity: done ? 0.76 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? t("todo.reopenItem", { title: item.title }) : t("todo.complete", { title: item.title })}
          title={done ? t("todo.reopenItem", { title: item.title }) : t("todo.complete", { title: item.title })}
          disabled={busy}
          className="ui-focus-ring"
          onClick={() => { void toggleStatus(); }}
          style={{
            ...iconButtonStyle(busy),
            width: 26,
            height: 26,
            minWidth: 26,
            minHeight: 26,
            flexShrink: 0,
            borderColor: done ? "color-mix(in srgb, var(--status-success) 55%, var(--border))" : "var(--border)",
            background: done ? "color-mix(in srgb, var(--status-success) 13%, var(--bg))" : "var(--bg)",
            color: done ? "var(--status-success)" : "var(--text-dim)",
          }}
        >
          {done && <Check size={14} strokeWidth={2.6} aria-hidden="true" />}
        </button>

        {done ? (
          <span aria-hidden="true" style={{ width: 20, minWidth: 20, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", color: colorTone(item.color) }}>
            <Circle size={13} fill={item.color ? colorTone(item.color) : "var(--bg)"} />
          </span>
        ) : (
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              className="ui-focus-ring"
              disabled={busy}
              aria-label={t("todo.changeColor", { title: item.title })}
              aria-expanded={paletteOpen}
              aria-haspopup="menu"
              title={t("todo.changeColor", { title: item.title })}
              onClick={() => setPaletteOpen((open) => !open)}
              style={{ ...iconButtonStyle(busy), width: 26, height: 26, minWidth: 26, minHeight: 26 }}
            >
              <Circle size={13} fill={item.color ? colorTone(item.color) : "var(--bg)"} color={colorTone(item.color)} aria-hidden="true" />
            </button>
            {paletteOpen && (
              <div
                role="menu"
                aria-label={t("todo.colorPicker")}
                style={{
                  position: "absolute",
                  zIndex: 5,
                  top: "calc(100% + 4px)",
                  left: 0,
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 28px)",
                  gap: 3,
                  padding: 5,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-card)",
                  background: "var(--bg-panel)",
                  boxShadow: "var(--shadow-pop)",
                }}
              >
                {TODO_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="menuitemcheckbox"
                    className="ui-focus-ring"
                    disabled={busy}
                    aria-label={t("todo.color." + color)}
                    aria-checked={item.color === color}
                    title={t("todo.color." + color)}
                    onClick={() => { void chooseColor(color); }}
                    style={{
                      ...iconButtonStyle(busy),
                      width: 28,
                      height: 28,
                      minWidth: 28,
                      minHeight: 28,
                      borderColor: item.color === color ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    <Circle size={13} fill={colorTone(color)} color={colorTone(color)} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0, paddingTop: 3 }}>
          {editingTitle ? (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 5 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  autoFocus
                  value={titleDraft}
                  aria-label={t("todo.editTitle", { title: item.title })}
                  aria-invalid={titleError ? true : undefined}
                  onChange={(event) => {
                    setTitleDraft(event.target.value);
                    if (titleError) setTitleError(null);
                  }}
                  onKeyDown={titleInputKeyDown}
                  style={{ ...inputStyle(), fontSize: 13, borderColor: titleError ? "var(--status-error)" : "var(--border)" }}
                />
                {titleError && <div role="alert" style={{ marginTop: 4, color: "var(--status-error)", fontSize: 11 }}>{titleError}</div>}
              </div>
              <button type="button" className="ui-focus-ring" disabled={busy} title={t("todo.save")} aria-label={t("todo.save")} onClick={() => { void saveTitle(); }} style={iconButtonStyle(busy)}>
                <Check size={14} aria-hidden="true" />
              </button>
              <button type="button" className="ui-focus-ring" disabled={busy} title={t("todo.cancel")} aria-label={t("todo.cancel")} onClick={() => { setEditingTitle(false); setTitleError(null); }} style={iconButtonStyle(busy)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.35, textDecoration: done ? "line-through" : undefined, overflowWrap: "anywhere" }}>
              {item.title}
            </div>
          )}
          {!notesOpen && item.notes && (
            <div style={{ marginTop: 2, color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.35, overflow: "hidden", overflowWrap: "anywhere", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}>
              {item.notes}
            </div>
          )}
        </div>

        {!done && !editingTitle && !notesOpen && (
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              className="ui-focus-ring"
              disabled={busy}
              aria-label={t("todo.actions", { title: item.title })}
              aria-expanded={actionsOpen}
              aria-haspopup="menu"
              title={t("todo.actions", { title: item.title })}
              onClick={() => setActionsOpen((open) => !open)}
              style={{ ...iconButtonStyle(busy), width: 26, height: 26, minWidth: 26, minHeight: 26 }}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
            {actionsOpen && (
              <div
                role="menu"
                aria-label={t("todo.actions", { title: item.title })}
                style={{
                  position: "absolute",
                  zIndex: 4,
                  top: "calc(100% + 4px)",
                  right: 0,
                  width: 178,
                  padding: 4,
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-card)",
                  background: "var(--bg-panel)",
                  boxShadow: "var(--shadow-pop)",
                }}
              >
                <button type="button" role="menuitem" className="ui-focus-ring" disabled={busy} onClick={() => { setActionsOpen(false); setEditingTitle(true); }} style={{ ...compactButtonStyle(busy), width: "100%", minHeight: 28, justifyContent: "flex-start", padding: "4px 6px", border: "none", background: "transparent" }}>
                  <Pencil size={13} aria-hidden="true" />
                  {t("todo.editTitle", { title: item.title })}
                </button>
                <button type="button" role="menuitem" className="ui-focus-ring" disabled={busy} onClick={() => { setActionsOpen(false); setNotesOpen(true); }} style={{ ...compactButtonStyle(busy), width: "100%", minHeight: 28, justifyContent: "flex-start", padding: "4px 6px", border: "none", background: "transparent" }}>
                  <MessageSquare size={13} aria-hidden="true" />
                  {t("todo.editNotes", { title: item.title })}
                </button>
                <button type="button" role="menuitem" className="ui-focus-ring" disabled={busy || position === 0} onClick={() => { setActionsOpen(false); void onMove?.(item.id, -1); }} style={{ ...compactButtonStyle(busy || position === 0), width: "100%", minHeight: 28, justifyContent: "flex-start", padding: "4px 6px", border: "none", background: "transparent" }}>
                  <ArrowUp size={13} aria-hidden="true" />
                  {t("todo.moveUp", { title: item.title })}
                </button>
                <button type="button" role="menuitem" className="ui-focus-ring" disabled={busy || position === activeCount - 1} onClick={() => { setActionsOpen(false); void onMove?.(item.id, 1); }} style={{ ...compactButtonStyle(busy || position === activeCount - 1), width: "100%", minHeight: 28, justifyContent: "flex-start", padding: "4px 6px", border: "none", background: "transparent" }}>
                  <ArrowDown size={13} aria-hidden="true" />
                  {t("todo.moveDown", { title: item.title })}
                </button>
                <button type="button" role="menuitem" className="ui-focus-ring" disabled={busy || !onDelete} onClick={() => { setActionsOpen(false); onDelete?.(item); }} style={{ ...compactButtonStyle(busy || !onDelete), width: "100%", minHeight: 28, justifyContent: "flex-start", padding: "4px 6px", border: "none", background: "transparent", color: "var(--status-error)" }}>
                  <Trash2 size={13} aria-hidden="true" />
                  {t("todo.delete")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {!done && notesOpen && (
        <div style={{ marginTop: 7, paddingTop: 7, borderTop: "1px solid var(--border)" }}>
          <label style={{ display: "block", marginBottom: 5, color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>{t("todo.notes")}</label>
          <textarea
            value={notesDraft}
            onChange={(event) => setNotesDraft(event.target.value)}
            maxLength={4000}
            rows={3}
            aria-label={t("todo.editNotes", { title: item.title })}
            style={{ ...inputStyle(), minHeight: 70, resize: "vertical", lineHeight: 1.45, fontFamily: "inherit" }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
            <button type="button" className="ui-focus-ring" disabled={busy} onClick={() => { setNotesOpen(false); setNotesDraft(item.notes ?? ""); }} style={compactButtonStyle(busy)}>{t("todo.cancel")}</button>
            <button type="button" className="ui-focus-ring" disabled={busy} onClick={() => { void saveNotes(); }} style={compactButtonStyle(busy, true)}>{t("todo.saveNotes")}</button>
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * Presentational Todo surface. Exported so SSR tests can assert the user-visible
 * partitioning without a browser fetch.
 */
export function TodoPanelContent({
  cwd = null,
  doc,
  loading = false,
  error = null,
  busy = false,
  commandsAvailable = false,
  active = true,
  openCommandsRequest = 0,
  defaultDoneOpen = false,
  defaultHistoryOpen = false,
  defaultCommandsOpen = false,
  onAdd,
  onUpdate,
  onComplete,
  onReopen,
  onDelete,
  onReorder,
  onRefresh,
  onAskAgent,
  onOpenTerminalTask,
  onCommandsStateChange,
}: TodoPanelContentProps) {
  const { t } = useI18n();
  const [quickTitle, setQuickTitle] = useState("");
  const [doneOpen, setDoneOpen] = useState(defaultDoneOpen);
  const [historyOpen, setHistoryOpen] = useState(defaultHistoryOpen);
  const [commandsOpen, setCommandsOpen] = useState(defaultCommandsOpen);
  const [deleteTarget, setDeleteTarget] = useState<TodoItem | null>(null);
  const consumedCommandsRequest = useRef(0);

  useEffect(() => {
    if (!active || openCommandsRequest <= consumedCommandsRequest.current) return;
    consumedCommandsRequest.current = openCommandsRequest;
    setCommandsOpen(true);
  }, [active, openCommandsRequest]);

  const items = useMemo(() => [...doc.items].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)), [doc.items]);
  const activeItems = useMemo(() => items.filter((item) => item.status === "active"), [items]);
  const doneItems = useMemo(() => items.filter((item) => item.status === "done"), [items]);
  const history = useMemo(() => [...doc.history].sort((a, b) => b.ts.localeCompare(a.ts)), [doc.history]);

  const submitQuickAdd = useCallback(async () => {
    const title = quickTitle.trim();
    if (!title || busy) return;
    const added = await onAdd?.(title);
    if (added !== false) setQuickTitle("");
  }, [busy, onAdd, quickTitle]);

  const moveItem = useCallback(async (id: string, direction: -1 | 1) => {
    const index = activeItems.findIndex((item) => item.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= activeItems.length) return false;
    const nextActive = [...activeItems];
    [nextActive[index], nextActive[nextIndex]] = [nextActive[nextIndex], nextActive[index]];
    const reordered = [...nextActive, ...doneItems].map((item) => item.id);
    return onReorder?.(reordered) ?? true;
  }, [activeItems, doneItems, onReorder]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const deleted = await onDelete?.(deleteTarget.id);
    if (deleted !== false) setDeleteTarget(null);
  }, [deleteTarget, onDelete]);

return (
    <section aria-label={t("todo.title")} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg)" }}>
      <div className="workspace-subtitle-bar" style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <ListTodo size={15} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, color: "var(--text)", fontSize: 12, fontWeight: 650 }}>{t("todo.title")}</span>
        <button
          type="button"
          className="ui-focus-ring"
          disabled={!onAskAgent || !cwd}
          onClick={onAskAgent}
          style={{ ...compactButtonStyle(!onAskAgent || !cwd), minHeight: 26, padding: "3px 7px", flexShrink: 0, whiteSpace: "nowrap" }}
        >
          <MessageSquare size={13} aria-hidden="true" />
          {t("todo.askAgent")}
        </button>
        <button type="button" className="ui-focus-ring" disabled={loading} onClick={onRefresh} title={t("todo.refresh")} aria-label={t("todo.refresh")} style={{ ...iconButtonStyle(loading), flexShrink: 0 }}>
          <RotateCw size={14} aria-hidden="true" style={loading ? { animation: "spin 0.8s linear infinite" } : undefined} />
        </button>
      </div>

      {cwd && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitQuickAdd();
          }}
          style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <input
              id="todo-quick-add"
              value={quickTitle}
              maxLength={200}
              placeholder={t("todo.addPlaceholder")}
              aria-label={t("todo.addPlaceholder")}
              disabled={busy}
              onChange={(event) => setQuickTitle(event.target.value)}
              style={inputStyle()}
            />
            <button type="submit" className="ui-focus-ring" disabled={busy || !quickTitle.trim()} style={{ ...compactButtonStyle(busy || !quickTitle.trim(), true), flexShrink: 0 }}>
              <Plus size={14} aria-hidden="true" />
              {t("todo.add")}
            </button>
          </div>
        </form>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 10 }}>
        {!cwd ? (
          <div style={{ padding: 12, border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>
            {t("todo.noWorkspace")}
          </div>
        ) : (
          <>
            {error && (
              <div role="alert" style={{ padding: "8px 10px", border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))", borderRadius: "var(--radius-control)", background: "color-mix(in srgb, var(--status-error) 9%, var(--bg-panel))", color: "var(--status-error)", fontSize: 12, lineHeight: 1.45 }}>
                {error}
              </div>
            )}

            {loading && activeItems.length === 0 && doneItems.length === 0 && (
              <div role="status" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: error ? 10 : 0, color: "var(--text-dim)", fontSize: 12 }}>
                <Loader2 size={14} aria-hidden="true" style={{ animation: "spin 0.8s linear infinite" }} />
                {t("todo.loading")}
              </div>
            )}

            <div role="list" style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: error || loading ? 10 : 0 }}>
              {activeItems.length === 0 && !loading ? (
                <div style={{ padding: 12, border: "1px dashed var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", textAlign: "center" }}>
                  <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("todo.emptyTitle")}</div>
                  <div style={{ margin: "5px auto 0", maxWidth: 400, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45 }}>{t("todo.emptyDescription")}</div>
                </div>
              ) : (
                activeItems.map((item, index) => (
                  <TodoItemCard
                    key={item.id}
                    item={item}
                    done={false}
                    position={index}
                    activeCount={activeItems.length}
                    busy={busy}
                    onComplete={onComplete}
                    onReopen={onReopen}
                    onUpdate={onUpdate}
                    onMove={moveItem}
                    onDelete={setDeleteTarget}
                  />
                ))
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              <CollapsedSection title={t("todo.done")} count={doneItems.length} open={doneOpen} onOpenChange={setDoneOpen}>
                {doneItems.length === 0 ? (
                  <div style={{ paddingTop: 8, color: "var(--text-dim)", fontSize: 12 }}>{t("todo.doneEmpty")}</div>
                ) : (
                  <div role="list" style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8 }}>
                    {doneItems.map((item) => (
                      <TodoItemCard
                        key={item.id}
                        item={item}
                        done
                        position={0}
                        activeCount={0}
                        busy={busy}
                        onReopen={onReopen}
                      />
                    ))}
                  </div>
                )}
              </CollapsedSection>

              <CollapsedSection title={t("todo.history")} count={history.length} open={historyOpen} onOpenChange={setHistoryOpen}>
                {history.length === 0 ? (
                  <div style={{ paddingTop: 8, color: "var(--text-dim)", fontSize: 12 }}>{t("todo.historyEmpty")}</div>
                ) : (
                  <ol style={{ display: "flex", flexDirection: "column", margin: 0, padding: "4px 0 0", listStyle: "none" }}>
                    {history.map((entry, index) => {
                      const matchingItem = doc.items.find((item) => item.id === entry.itemId);
                      const canReopen = entry.action === "completed" && matchingItem?.status === "done";
                      return (
                        <li key={`${entry.ts}-${entry.itemId}-${index}`} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: "6px 0", borderBottom: index === history.length - 1 ? "none" : "1px solid var(--border)" }}>
                          <div style={{ flex: 1, minWidth: 0, color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.35, overflowWrap: "anywhere" }}>
                            <strong style={{ color: "var(--text)", fontWeight: 650 }}>{entry.actor.label}</strong>{" "}{t("todo.history." + entry.action)}{" "}{entry.title}
                            {entry.detail && <><span aria-hidden="true"> · </span>{entry.detail}</>}
                            <span aria-hidden="true"> · </span><time dateTime={entry.ts} style={{ color: "var(--text-dim)" }}>{formatHistoryTime(entry.ts)}</time>
                          </div>
                          {canReopen && (
                            <button type="button" className="ui-focus-ring" disabled={busy} aria-label={t("todo.reopenItem", { title: entry.title })} onClick={() => { void onReopen?.(entry.itemId); }} style={{ ...compactButtonStyle(busy), minHeight: 26, padding: "3px 6px", flexShrink: 0 }}>
                              {t("todo.reopen")}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </CollapsedSection>

              {commandsAvailable && (
                <CollapsedSection title={t("todo.commands")} open={commandsOpen} onOpenChange={setCommandsOpen}>
                  {commandsOpen && (
                    <div style={{ paddingTop: 8 }}>
                      <TasksPanel
                        cwd={cwd}
                        active={active && commandsOpen}
                        embedded
                        onOpenTerminal={onOpenTerminalTask ?? (() => {})}
                        onConfigStateChange={onCommandsStateChange}
                      />
                    </div>
                  )}
                </CollapsedSection>
              )}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("todo.deleteConfirmTitle", { title: deleteTarget?.title ?? "" })}
        description={t("todo.deleteConfirmDescription")}
        confirmLabel={t("todo.delete")}
        cancelLabel={t("todo.cancel")}
        danger
        busy={busy}
        onConfirm={() => { void confirmDelete(); }}
      />
    </section>
  );
}

export default function TodoPanel({
  cwd,
  onOpenTerminalTask,
  chatInputRef,
  active = true,
  openCommandsRequest = 0,
}: TodoPanelProps) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<TodoDocument>(() => ({ version: 1, items: [], history: [] }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commandsAvailable, setCommandsAvailable] = useState(false);
  const [watchPath, setWatchPath] = useState<string | null>(null);
  const [watchRevision, setWatchRevision] = useState(0);
  const requestRef = useRef(0);
  const commandsRequestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      commandsRequestRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (!active) abortRef.current?.abort();
  }, [active]);

  const load = useCallback(async (showLoading = false) => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();

    if (!cwd) {
      setDoc({ version: 1, items: [], history: [] });
      setError(null);
      setLoading(false);
      setWatchPath(null);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    if (showLoading) setLoading(true);

    try {
      const response = await fetch(`/api/todo?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
      const data = await response.json().catch(() => ({})) as TodoLoadResponse;
      if (controller.signal.aborted || requestId !== requestRef.current || !mountedRef.current || !activeRef.current) return;
      if (!response.ok || !data.doc) {
        setError(data.error ?? t("todo.loadError"));
        setLoading(false);
        return;
      }
      setDoc(data.doc);
      setError(null);
      setWatchPath(data.status === "loaded" && data.path ? data.path : null);
    } catch (cause) {
      if (controller.signal.aborted || requestId !== requestRef.current || !mountedRef.current || !activeRef.current) return;
      setError(cause instanceof Error ? cause.message : t("todo.loadError"));
      setWatchPath(null);
    } finally {
      if (requestId === requestRef.current && mountedRef.current && activeRef.current) setLoading(false);
    }
  }, [cwd, t]);

  const probeCommands = useCallback(async () => {
    const requestId = ++commandsRequestRef.current;
    if (!cwd) {
      setCommandsAvailable(false);
      return;
    }
    try {
      const response = await fetch(`/api/tasks?cwd=${encodeURIComponent(cwd)}`);
      const data = await response.json().catch(() => ({})) as TasksConfigResponse;
      if (requestId !== commandsRequestRef.current || !mountedRef.current || !activeRef.current) return;
      setCommandsAvailable(response.ok && data.state === "loaded");
    } catch {
      if (requestId === commandsRequestRef.current && mountedRef.current && activeRef.current) setCommandsAvailable(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!active) return;
    void load(true);
    void probeCommands();
    const interval = window.setInterval(() => {
      void load();
      void probeCommands();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [active, load, probeCommands]);

  useEffect(() => {
    if (!active || !watchPath) return;
    const params = new URLSearchParams({ type: "watch" });
    const source = new EventSource(`/api/files/${encodeFilePathForApi(watchPath)}?${params.toString()}`);
    const refreshAfterChange = () => {
      void load();
      setWatchRevision((revision) => revision + 1);
    };
    source.addEventListener("change", refreshAfterChange);
    return () => source.close();
  }, [active, load, watchPath, watchRevision]);

  const mutate = useCallback(async (operation: TodoOperation): Promise<boolean> => {
    if (!cwd || busy) return false;
    setBusy(true);
    try {
      const response = await fetch(`/api/todo?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(operation),
      });
      const data = await response.json().catch(() => ({})) as TodoMutationResponse;
      if (!response.ok || !data.doc) {
        setError(data.error ?? t("todo.updateError"));
        return false;
      }
      setDoc(data.doc);
      setError(null);
      setWatchRevision((revision) => revision + 1);
      void load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("todo.updateError"));
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, cwd, load, t]);

  const add = useCallback((title: string) => mutate({ op: "add", title }), [mutate]);
  const update = useCallback((id: string, changes: TodoItemChanges) => mutate({ op: "update", id, ...changes }), [mutate]);
  const complete = useCallback((id: string) => mutate({ op: "complete", id }), [mutate]);
  const reopen = useCallback((id: string) => mutate({ op: "reopen", id }), [mutate]);
  const remove = useCallback((id: string) => mutate({ op: "delete", id }), [mutate]);
  const reorder = useCallback((ids: string[]) => mutate({ op: "reorder", ids }), [mutate]);
  const askAgent = useCallback(() => {
    chatInputRef?.current?.insertIfEmpty(ASK_AGENT_PROMPT);
  }, [chatInputRef]);
  const commandsStateChange = useCallback((state: "missing" | "invalid" | "loaded" | null) => {
    if (state !== "loaded") setCommandsAvailable(false);
  }, []);

  return (
    <TodoPanelContent
      cwd={cwd}
      doc={doc}
      loading={loading}
      error={error}
      busy={busy}
      commandsAvailable={commandsAvailable}
      active={active}
      openCommandsRequest={openCommandsRequest}
      onAdd={add}
      onUpdate={update}
      onComplete={complete}
      onReopen={reopen}
      onDelete={remove}
      onReorder={reorder}
      onRefresh={() => { void load(true); void probeCommands(); }}
      onAskAgent={askAgent}
      onOpenTerminalTask={onOpenTerminalTask}
      onCommandsStateChange={commandsStateChange}
    />
  );
}
