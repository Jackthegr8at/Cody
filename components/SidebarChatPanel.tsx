"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { History, MessageSquarePlus, Send, Square, Trash2 } from "lucide-react";
import { useAgentSession } from "@/hooks/useAgentSession";
import { useI18n } from "@/lib/i18n";
import { formatModelDisplayName } from "@/lib/model-display";
import { thinkingLevelLabel } from "@/lib/thinking-level-labels";
import type { AgentMessage, SessionInfo } from "@/lib/types";
import { MessageView } from "./MessageView";
import { LiveDot } from "./ui/LiveDot";
import { toast } from "./ui/toast";

/**
 * The sidebar chat: an ordinary omp session spawned with `kind: "sidebar"`
 * (no tools, skills, extensions or rules; its own session dir under
 * cody-sidebar-chats/), driven by the SAME hook and renderer as the main
 * chat, so streaming, thinking blocks, usage and every provider the engine
 * can reach behave identically. This panel is only chrome: a toolbar, the
 * transcript, a composer. Everything stateful lives in useAgentSession.
 */

interface SidebarChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

const SIDEBAR_CHATS_ROUTE = "/api/sidebar-chats";

const toolbarSelectStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  height: 26,
  padding: "0 22px 0 8px",
  fontSize: 12,
  color: "var(--text)",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  appearance: "none",
  backgroundImage: "linear-gradient(45deg, transparent 50%, var(--text-muted) 50%), linear-gradient(135deg, var(--text-muted) 50%, transparent 50%)",
  backgroundPosition: "calc(100% - 12px) 11px, calc(100% - 8px) 11px",
  backgroundSize: "4px 4px",
  backgroundRepeat: "no-repeat",
};

const iconButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 26,
  height: 26,
  flexShrink: 0,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "var(--bg-panel)",
  color: "var(--text-muted)",
  cursor: "pointer",
};

async function fetchSidebarChats(cwd: string): Promise<SidebarChatSummary[]> {
  const response = await fetch(`${SIDEBAR_CHATS_ROUTE}?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) return [];
  const body = await response.json() as SidebarChatSummary[] | { chats?: SidebarChatSummary[] };
  return Array.isArray(body) ? body : body.chats ?? [];
}

export function SidebarChatPanel({ cwd, active = true }: { cwd: string; active?: boolean }) {
  const { t } = useI18n();
  const [chats, setChats] = useState<SidebarChatSummary[]>([]);
  // `chosenId` is what the user picked (history entry or New chat) and keys
  // the session view, so switching chats remounts the hook. A session the
  // hook CREATES on first send is adopted without remounting — the hook
  // already tracks its own id — and only recorded here so the history menu
  // can highlight it and a later "New chat" starts from a null session.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [chosenNonce, setChosenNonce] = useState(0);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const selectedId = chosenId ?? createdId;
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const reloadChats = useCallback(async () => {
    setChats(await fetchSidebarChats(cwd).catch(() => []));
  }, [cwd]);

  useEffect(() => {
    if (active) void reloadChats();
  }, [active, reloadChats]);

  useEffect(() => {
    if (!historyOpen) return;
    const close = (event: MouseEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [historyOpen]);

  const deleteChat = useCallback(async (id: string) => {
    const response = await fetch(`${SIDEBAR_CHATS_ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (!response?.ok) {
      toast.error(t("sidebarChat.deleteFailed"));
      return;
    }
    setChats((current) => current.filter((chat) => chat.id !== id));
    if (selectedId === id) { setChosenId(null); setCreatedId(null); setChosenNonce((n) => n + 1); }
  }, [selectedId, t]);

  const session = useMemo<SessionInfo | null>(() => chosenId
    ? { id: chosenId, path: "", cwd, created: "", modified: "", messageCount: 0, firstMessage: "" }
    : null, [chosenId, cwd]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg)" }}>
      <div className="workspace-subtitle-bar" style={{ display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("sidebarChat.title")}</span>
        <div ref={historyRef} style={{ position: "relative" }}>
          <button type="button" className="ui-focus-ring" style={{ ...iconButtonStyle, width: 22, height: 20 }} title={t("sidebarChat.history")} aria-label={t("sidebarChat.history")} aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            <History size={12} />
          </button>
          {historyOpen && (
            <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 30, width: 260, maxHeight: 280, overflowY: "auto", padding: 4, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-pop)" }}>
              {chats.length === 0
                ? <div style={{ padding: "8px 10px", fontSize: 12, color: "var(--text-dim)", fontWeight: 400 }}>{t("sidebarChat.noHistory")}</div>
                : chats.map((chat) => (
                  <div key={chat.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button
                      type="button"
                      role="menuitem"
                      className="ui-focus-ring"
                      onClick={() => { setChosenId(chat.id); setCreatedId(null); setHistoryOpen(false); }}
                    >
                      {chat.title || t("sidebarChat.empty")}
                    </button>
                    <button type="button" className="ui-focus-ring" title={t("sidebarChat.delete")} aria-label={t("sidebarChat.delete")} onClick={() => void deleteChat(chat.id)} style={{ ...iconButtonStyle, width: 24, height: 24, border: 0, background: "transparent" }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        <button type="button" className="ui-focus-ring" style={{ ...iconButtonStyle, width: 22, height: 20 }} title={t("sidebarChat.newChat")} aria-label={t("sidebarChat.newChat")} onClick={() => { setChosenId(null); setCreatedId(null); setChosenNonce((n) => n + 1); setHistoryOpen(false); }}>
        </button>
      </div>
      <SidebarChatSession
        key={chosenId ?? `new-${chosenNonce}`}
        session={session}
        cwd={cwd}
        onSessionCreated={(id) => { setCreatedId(id); void reloadChats(); }}
        onTurnEnd={() => void reloadChats()}
      />
    </div>
  );
}

function SidebarChatSession({ session, cwd, onSessionCreated, onTurnEnd }: {
  session: SessionInfo | null;
  cwd: string;
  onSessionCreated: (id: string) => void;
  onTurnEnd: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const {
    messages, entryIds, streamState, agentRunning, loading,
    currentModel, modelList, modelNames, modelThinkingLevels, thinkingLevel, thinkingLevelPending,
    contextUsage, sessionStats,
    handleSend, handleSteer, handleAbort, handleModelChange, handleThinkingLevelChange,
    scrollContainerRef, messagesEndRef,
  } = useAgentSession({
    session,
    newSessionCwd: session ? null : cwd,
    sessionKind: "sidebar",
    advisorEnabled: false,
    thinkingDefaultExpanded: false,
    onAgentEnd: onTurnEnd,
    onSessionCreated: (created) => onSessionCreated(created.id),
  });

  const modelValue = currentModel ? `${currentModel.provider}:${currentModel.modelId}` : "";
  const thinkingOptions = currentModel ? modelThinkingLevels[`${currentModel.provider}:${currentModel.modelId}`] ?? [] : [];

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    const accepted = agentRunning ? (await handleSteer(text), true) : await handleSend(text);
    if (!accepted) setDraft(text);
  }, [agentRunning, draft, handleSend, handleSteer]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const percent = contextUsage?.percent ?? null;
  const usageColor = percent === null ? "var(--text-dim)" : percent >= 90 ? "var(--status-error)" : percent >= 70 ? "var(--status-warning)" : "var(--text-muted)";
  const totalTokens = sessionStats?.tokens.total ?? null;

  return (
    <>
      <div style={{ display: "flex", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
        <select
          className="ui-focus-ring"
          aria-label={t("sidebarChat.model")}
          style={{ ...toolbarSelectStyle, flex: 2 }}
          value={modelValue}
          disabled={agentRunning || modelList.length === 0}
          onChange={(event) => {
            const [provider, ...rest] = event.target.value.split(":");
            if (provider && rest.length) void handleModelChange(provider, rest.join(":"));
          }}
        >
          {!modelValue && <option value="">{t("sidebarChat.selectModel")}</option>}
          {modelList.map((model) => (
            <option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
              {formatModelDisplayName(model.id, modelNames[`${model.provider}:${model.id}`] ?? model.name)}
            </option>
          ))}
        </select>
        <select
          className="ui-focus-ring"
          aria-label={t("sidebarChat.thinking")}
          style={{ ...toolbarSelectStyle, flex: 1, opacity: thinkingOptions.length ? 1 : 0.55 }}
          value={thinkingLevel ?? ""}
          disabled={!thinkingOptions.length || thinkingLevelPending}
          onChange={(event) => void handleThinkingLevelChange(event.target.value)}
        >
          {thinkingOptions.map((level) => <option key={level} value={level}>{thinkingLevelLabel(level, t)}</option>)}
        </select>
      </div>

      <div ref={scrollContainerRef} className="chat-scroll-region" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 10px 4px" }}>
        {messages.length === 0 && !streamState.isStreaming && !loading && (
          <div style={{ padding: "40px 12px", textAlign: "center", fontSize: 12, color: "var(--text-dim)" }}>{t("sidebarChat.empty")}</div>
        )}
        {messages.map((message, index) => (
          <div key={entryIds[index] ?? `idx-${index}`} className="chat-turn" data-turn-key={entryIds[index] ?? `idx-${index}`}>
            <MessageView message={message} modelNames={modelNames} cwd={cwd} entryId={entryIds[index]} sessionId={session?.id} thinkingDefaultExpanded={false} activityDisplayMode="compact" />
          </div>
        ))}
        {streamState.isStreaming && streamState.streamingMessage && (
          <div className="chat-turn chat-turn--live">
            <MessageView message={streamState.streamingMessage as AgentMessage} isStreaming modelNames={modelNames} cwd={cwd} sessionId={session?.id} thinkingDefaultExpanded={false} activityDisplayMode="compact" />
          </div>
        )}
        {agentRunning && !streamState.streamingMessage && (
          <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px", fontSize: 12, color: "var(--text-muted)" }}>
            <LiveDot />
            {t("sidebarChat.thinkingStatus")}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ borderTop: "1px solid var(--border)", padding: "8px 8px calc(8px + var(--safe-bottom))", background: "var(--bg)" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 6, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", padding: 6 }}>
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={agentRunning ? t("sidebarChat.steerPlaceholder") : t("sidebarChat.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            style={{ flex: 1, minWidth: 0, minHeight: 34, maxHeight: 160, padding: "7px 8px", resize: "none", border: 0, outline: "none", background: "transparent", color: "var(--text)", fontSize: "var(--chat-font-size)", lineHeight: 1.5, fieldSizing: "content" } as CSSProperties}
          />
          {agentRunning ? (
            <button type="button" className="ui-focus-ring" onClick={() => void handleAbort()} title={t("sidebarChat.stop")} aria-label={t("sidebarChat.stop")} style={{ ...iconButtonStyle, width: 30, height: 30, color: "var(--status-error)" }}>
              <Square size={13} />
            </button>
          ) : null}
          <button type="button" className="ui-focus-ring" onClick={() => void submit()} disabled={!draft.trim()} title={t("sidebarChat.send")} aria-label={t("sidebarChat.send")} style={{ ...iconButtonStyle, width: 30, height: 30, border: 0, background: draft.trim() ? "var(--accent)" : "var(--bg-hover)", color: draft.trim() ? "var(--accent-contrast, #fff)" : "var(--text-dim)" }}>
            <Send size={13} />
          </button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 5, padding: "0 2px", fontSize: 11, color: usageColor, fontVariantNumeric: "tabular-nums" }}>
          <span>{percent === null ? t("sidebarChat.usageUnknown") : t("sidebarChat.usagePercent", { percent: Math.round(percent) })}</span>
          <span style={{ color: "var(--text-dim)" }}>{totalTokens === null ? "" : t("sidebarChat.usageTokens", { tokens: totalTokens.toLocaleString() })}</span>
        </div>
      </div>
    </>
  );
}
