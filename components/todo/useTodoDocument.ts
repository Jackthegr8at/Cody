"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { useI18n } from "@/lib/i18n";
import type { TodoColor, TodoDocument, TodoItem, TodoOperation } from "@/lib/project-todo-types";

export type TodoItemChanges = Omit<Extract<TodoOperation, { op: "update" }>, "id" | "op">;

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

function emptyDocument(): TodoDocument {
  return { version: 1, items: [] };
}

function nextOrder(items: readonly TodoItem[]): number {
  return items.reduce((highest, item) => Math.max(highest, item.order), -1) + 1;
}

let optimisticSequence = 0;
/** A locally-fabricated id for an item the server has not confirmed yet. Never
 * matches `TODO_ID_RE` (`t_` + 8 alnum), so it cannot collide with a real id;
 * the server's response replaces it with the real item on success. */
function optimisticId(): string {
  optimisticSequence += 1;
  return `optimistic-${String(Date.now())}-${String(optimisticSequence)}`;
}

export interface UseTodoDocumentResult {
  doc: TodoDocument;
  loading: boolean;
  error: string | null;
  busy: boolean;
  add: (title: string, notes?: string | null, color?: TodoColor | null) => Promise<boolean>;
  update: (id: string, changes: TodoItemChanges) => Promise<boolean>;
  complete: (id: string) => Promise<boolean>;
  reopen: (id: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  reorder: (ids: string[]) => Promise<boolean>;
  refresh: () => void;
}

/**
 * Loads, polls (5s), watches (SSE on the resolved file path), and mutates the
 * project `.cody/todo.json` document.
 *
 * Every mutator applies an optimistic local transform the instant it is
 * called — the row a user clicked updates before the network round-trip
 * starts — then reconciles with the server's response. Mutations are not
 * client-serialized (the server already serializes writes per project root),
 * so a `mutationId` guard skips applying a response that arrived after a
 * newer mutation already superseded it, and a failure resyncs from the
 * server (`load(false, true)`) instead of hand-rolling an undo stack.
 * Background refreshes (poll/watch) skip applying their doc while a
 * mutation is in flight, so they never clobber an unconfirmed optimistic
 * change; explicit refreshes (mount, refresh button, error recovery) always
 * apply.
 */
export function useTodoDocument(cwd: string | null, active: boolean): UseTodoDocumentResult {
  const { t } = useI18n();
  const [doc, setDoc] = useState<TodoDocument>(emptyDocument);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [watchPath, setWatchPath] = useState<string | null>(null);
  const [watchRevision, setWatchRevision] = useState(0);

  const requestRef = useRef(0);
  const pendingMutations = useRef(0);
  const latestMutationId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (!active) abortRef.current?.abort();
  }, [active]);

  const load = useCallback(async (showLoading = false, force = false) => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();

    if (!cwd) {
      setDoc(emptyDocument());
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
      const data = (await response.json().catch(() => ({}))) as TodoLoadResponse;
      if (controller.signal.aborted || requestId !== requestRef.current || !mountedRef.current || !activeRef.current) return;
      if (!response.ok || !data.doc) {
        setError(data.error ?? t("todo.loadError"));
        setLoading(false);
        return;
      }
      if (force || pendingMutations.current === 0) {
        setDoc(data.doc);
        setError(null);
      }
      setWatchPath(data.status === "loaded" && data.path ? data.path : null);
    } catch (cause) {
      if (controller.signal.aborted || requestId !== requestRef.current || !mountedRef.current || !activeRef.current) return;
      setError(cause instanceof Error ? cause.message : t("todo.loadError"));
      setWatchPath(null);
    } finally {
      if (requestId === requestRef.current && mountedRef.current && activeRef.current) setLoading(false);
    }
  }, [cwd, t]);

  useEffect(() => {
    if (!active) return;
    void load(true, true);
    const interval = window.setInterval(() => { void load(); }, 5_000);
    return () => window.clearInterval(interval);
  }, [active, load]);

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

  const mutate = useCallback(async (
    operation: TodoOperation,
    apply: (current: TodoDocument) => TodoDocument,
  ): Promise<boolean> => {
    if (!cwd) return false;
    const mutationId = ++latestMutationId.current;
    pendingMutations.current += 1;
    setBusy(true);
    setDoc(apply);
    try {
      const response = await fetch(`/api/todo?cwd=${encodeURIComponent(cwd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(operation),
      });
      const data = (await response.json().catch(() => ({}))) as TodoMutationResponse;
      if (!mountedRef.current) return response.ok && !!data.doc;
      if (!response.ok || !data.doc) {
        setError(data.error ?? t("todo.updateError"));
        void load(false, true);
        return false;
      }
      if (mutationId === latestMutationId.current) {
        setDoc(data.doc);
        setError(null);
      }
      setWatchRevision((revision) => revision + 1);
      return true;
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : t("todo.updateError"));
        void load(false, true);
      }
      return false;
    } finally {
      pendingMutations.current = Math.max(0, pendingMutations.current - 1);
      if (mountedRef.current && pendingMutations.current === 0) setBusy(false);
    }
  }, [cwd, load, t]);

  const add = useCallback((title: string, notes?: string | null, color?: TodoColor | null) => {
    const trimmedTitle = title.trim();
    return mutate(
      { op: "add", title: trimmedTitle, ...(notes !== undefined ? { notes } : {}), ...(color !== undefined ? { color } : {}) },
      (current) => {
        const now = new Date().toISOString();
        const item: TodoItem = {
          id: optimisticId(),
          title: trimmedTitle,
          status: "active",
          order: nextOrder(current.items),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        };
        if (notes) item.notes = notes;
        if (color) item.color = color;
        return { ...current, items: [...current.items, item] };
      },
    );
  }, [mutate]);

  const update = useCallback((id: string, changes: TodoItemChanges) => mutate(
    { op: "update", id, ...changes },
    (current) => ({
      ...current,
      items: current.items.map((item) => {
        if (item.id !== id) return item;
        const next: TodoItem = { ...item, updatedAt: new Date().toISOString() };
        if (changes.title !== undefined) next.title = changes.title;
        if (changes.notes !== undefined) {
          if (changes.notes) next.notes = changes.notes;
          else delete next.notes;
        }
        if (changes.color !== undefined) {
          if (changes.color) next.color = changes.color;
          else delete next.color;
        }
        return next;
      }),
    }),
  ), [mutate]);

  const complete = useCallback((id: string) => mutate(
    { op: "complete", id },
    (current) => {
      const now = new Date().toISOString();
      return {
        ...current,
        items: current.items.map((item) => (item.id === id ? { ...item, status: "done" as const, completedAt: now, updatedAt: now } : item)),
      };
    },
  ), [mutate]);

  const reopen = useCallback((id: string) => mutate(
    { op: "reopen", id },
    (current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? { ...item, status: "active" as const, completedAt: null, updatedAt: new Date().toISOString() } : item)),
    }),
  ), [mutate]);

  const remove = useCallback((id: string) => mutate(
    { op: "delete", id },
    (current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }),
  ), [mutate]);

  const reorder = useCallback((ids: string[]) => mutate(
    { op: "reorder", ids },
    (current) => {
      const order = new Map(ids.map((id, index) => [id, index]));
      return {
        ...current,
        items: current.items.map((item) => (order.has(item.id) ? { ...item, order: order.get(item.id)! } : item)),
      };
    },
  ), [mutate]);

  const refresh = useCallback(() => { void load(true, true); }, [load]);

  return { doc, loading, error, busy, add, update, complete, reopen, remove, reorder, refresh };
}
