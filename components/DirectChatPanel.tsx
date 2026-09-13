"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChevronDown, FileText, ImagePlus, LoaderCircle, MessageCircle, Paperclip, Plus, Settings2, Square, X } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { CompactionProgress, compactionStatusReducer, isCompactionActive, type CompactionStatus } from "./CompactionProgress";
import { useI18n } from "@/lib/i18n";
import { DIRECT_CHAT_MAX_ATTACHMENTS, DIRECT_CHAT_MAX_CONTEXT_BYTES, DIRECT_CHAT_MAX_MESSAGES, DIRECT_CHAT_MAX_MESSAGE_BYTES, DIRECT_CHAT_MAX_TRANSCRIPT_BYTES, type DirectChatAttachment, type DirectChatCompactRequest, type DirectChatCompactSseEvent, type DirectChatContextCandidate, type DirectChatExtensionsResponse, type DirectChatMessage, type DirectChatModel, type DirectChatModelsResponse, type DirectChatPromptAsset, type DirectChatRequest, type DirectChatSseEvent } from "@/lib/direct-chat/types";
import { clearDirectChatConversation, readDirectChatConversation, writeDirectChatConversation } from "@/lib/direct-chat/store";
import { MAX_ATTACHED_IMAGE_BYTES, MAX_ATTACHED_IMAGES } from "@/lib/image-attachments";
import { MAX_ATTACHED_TEXT_BYTES, isTextAttachmentFile } from "@/lib/chat-attachments";
import { prepareImageForAttachment, SUPPORTED_IMAGE_FORMAT_LABEL } from "@/lib/image-compress";

interface Props {
  cwd: string | null;
  active: boolean;
  onOpenProviders: () => void;
  onOpenExtensions: () => void;
}

interface LocalAttachment extends DirectChatAttachment { previewUrl?: string; }

const NO_MODELS: readonly DirectChatModel[] = [];

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function estimateTokens(text: string): number {
  return Math.ceil(byteLength(text) / 4);
}

function dataUrlFromText(file: File, content: string): string {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${file.type || "text/plain"};base64,${btoa(binary)}`;
}

function selectedContextText(candidates: readonly DirectChatContextCandidate[], selected: ReadonlySet<string>): string {
  return candidates.filter((candidate) => selected.has(candidate.path))
    .map((candidate) => `# ${candidate.label}\n\n${candidate.preview}`)
    .join("\n\n---\n\n");
}

function parseSse<T>(buffer: string, onEvent: (event: T) => void): string {
  const blocks = buffer.split("\n\n");
  const incomplete = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data) continue;
    try {
          const eventType = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
          const payload: unknown = JSON.parse(data);
          onEvent((eventType && payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, type: eventType } : payload) as T);
        } catch { /* malformed framing is ignored; the server closes with an error */ }
  }
  return incomplete;
}
export function DirectChatPanel({ cwd, active, onOpenProviders, onOpenExtensions }: Props) {
  const { t } = useI18n();
  const [models, setModels] = useState<readonly DirectChatModel[]>(NO_MODELS);
  const [accountScope, setAccountScope] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(true);
  const [messages, setMessages] = useState<DirectChatMessage[]>([]);
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [fast, setFast] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextCandidates, setContextCandidates] = useState<DirectChatContextCandidate[]>([]);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextSelected, setContextSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [contextText, setContextText] = useState("");
  const [contextConfirmed, setContextConfirmed] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<DirectChatPromptAsset[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<ReadonlyMap<string, string>>(() => new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [compactionStatus, dispatchCompaction] = useReducer(compactionStatusReducer, { status: "idle", sessionId: null } as CompactionStatus);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nearBottomRef = useRef(true);

  const compactAbortRef = useRef<AbortController | null>(null);
  const selectedModel = useMemo(() => models.find((model) => model.key === modelKey) ?? null, [models, modelKey]);
  const availableModels = useMemo(() => models.filter((model) => model.available), [models]);
  const contextBytes = byteLength(contextText);
  const contextWithinLimit = contextBytes <= DIRECT_CHAT_MAX_CONTEXT_BYTES;
  const directSessionId = `direct:${accountScope ?? "loading"}:${cwd ?? "no-workspace"}`;

  const loadModels = useCallback(async () => {
    const controller = new AbortController();
    setLoadingModels(true);
    setModelsError(null);
    try {
      const response = await fetch("/api/direct-chat/models", { cache: "no-store", signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object") throw new Error(t("directChat.modelsUnavailable"));
      const data = body as DirectChatModelsResponse;
      if (!Array.isArray(data.models) || typeof data.accountScope !== "string") throw new Error(t("directChat.modelsUnavailable"));
      setModels(data.models);
      setAccountScope(data.accountScope);
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") setModelsError(caught instanceof Error ? caught.message : t("directChat.modelsUnavailable"));
    } finally { setLoadingModels(false); }
    return () => controller.abort();
  }, [t]);

  useEffect(() => { void loadModels(); }, [loadModels]);

  useEffect(() => {
    if (!accountScope) return;
    const saved = readDirectChatConversation(accountScope, cwd);
    setMessages(saved.messages);
    setModelKey((current) => saved.modelKey ?? current);
    setReasoningEffort(saved.reasoningEffort);
    setFast(saved.fast);
    setDraft("");
    setAttachments((previous) => { previous.forEach((attachment) => attachment.previewUrl && URL.revokeObjectURL(attachment.previewUrl)); return []; });
    setContextSelected(new Set());
    setContextText("");
    setContextConfirmed(false);
    setSelectedSkills(new Map());
    setError(null);
    dispatchCompaction({ type: "reset", sessionId: directSessionId });
  }, [accountScope, cwd, directSessionId]);

  useEffect(() => {
    if (!modelKey && availableModels[0]) setModelKey(availableModels[0].key);
    if (modelKey && !availableModels.some((model) => model.key === modelKey)) setModelKey(availableModels[0]?.key ?? null);
  }, [availableModels, modelKey]);

  useEffect(() => {
    if (!accountScope) return;
    writeDirectChatConversation(accountScope, cwd, { messages, modelKey, reasoningEffort, fast });
  }, [accountScope, cwd, messages, modelKey, reasoningEffort, fast]);

  useEffect(() => () => {
      abortRef.current?.abort();
      compactAbortRef.current?.abort();
    }, []);
  
    useEffect(() => {
      if (compactionStatus.status === "idle" || isCompactionActive(compactionStatus)) return;
      const timeout = window.setTimeout(() => dispatchCompaction({ type: "dismiss", sessionId: compactionStatus.sessionId }), compactionStatus.status === "noop" ? 5_000 : 8_000);
      return () => window.clearTimeout(timeout);
    }, [compactionStatus]);

  useEffect(() => {
    if (!active || !nearBottomRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [active, messages, streaming]);

  const loadContext = useCallback(async () => {
    if (!cwd || contextLoading) return;
    setContextLoading(true);
    setContextError(null);
    try {
      const response = await fetch(`/api/direct-chat/context?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || !Array.isArray((body as { candidates?: unknown }).candidates)) throw new Error(t("directChat.contextUnavailable"));
      setContextCandidates((body as { candidates: DirectChatContextCandidate[] }).candidates);
    } catch (caught) {
      setContextError(caught instanceof Error ? caught.message : t("directChat.contextUnavailable"));
    } finally { setContextLoading(false); }
  }, [contextLoading, cwd, t]);

  useEffect(() => {
    if (contextOpen) void loadContext();
  }, [contextOpen, loadContext]);

  const updateContextSelection = useCallback((path: string) => {
    setContextSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path); else next.add(path);
      setContextText(selectedContextText(contextCandidates, next));
      return next;
    });
    setContextConfirmed(false);
  }, [contextCandidates]);
  const loadSkills = useCallback(async () => {
    if (!cwd || skillsLoading || !selectedModel?.capabilities.skills.available) return;
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const response = await fetch(`/api/direct-chat/extensions?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object" || !Array.isArray((body as { skills?: unknown }).skills)) throw new Error(t("directChat.skillsUnavailable"));
      const extensions = body as DirectChatExtensionsResponse;
      setSkills([...extensions.skills, ...extensions.pluginCommands]);
    } catch (caught) {
      setSkillsError(caught instanceof Error ? caught.message : t("directChat.skillsUnavailable"));
    } finally { setSkillsLoading(false); }
  }, [cwd, selectedModel?.capabilities.skills.available, skillsLoading, t]);

  useEffect(() => {
    if (skillsOpen) void loadSkills();
  }, [skillsOpen, loadSkills]);

  const toggleSkill = useCallback(async (skill: DirectChatPromptAsset) => {
    if (!skill.enabled) return;
    if (selectedSkills.has(skill.id)) {
      setSelectedSkills((previous) => { const next = new Map(previous); next.delete(skill.id); return next; });
      return;
    }
    if (!cwd) return;
    try {
      const response = await fetch(`/api/direct-chat/extensions?cwd=${encodeURIComponent(cwd)}&asset=${encodeURIComponent(skill.id)}`, { cache: "no-store" });
      const body: unknown = await response.json();
      const asset = body && typeof body === "object" ? (body as { asset?: unknown }).asset : null;
      const content = asset && typeof asset === "object" ? (asset as { content?: unknown }).content : null;
      if (!response.ok || typeof content !== "string") throw new Error(t("directChat.skillReadFailed"));
      const selectedBytes = Array.from(selectedSkills.values()).reduce((total, value) => total + byteLength(value), 0);
      if (selectedBytes + byteLength(content) > 24 * 1024) throw new Error(t("directChat.skillsTooLarge"));
      setSelectedSkills((previous) => new Map(previous).set(skill.id, content));
    } catch (caught) { setSkillsError(caught instanceof Error ? caught.message : t("directChat.skillReadFailed")); }
  }, [cwd, selectedSkills, t]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!selectedModel?.capabilities.attachments.available) {
      setAttachmentError(t("directChat.attachmentsUnavailable"));
      return;
    }
    const remaining = DIRECT_CHAT_MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0) { setAttachmentError(t("directChat.attachmentLimit")); return; }
    const incoming = files.slice(0, remaining);
    const accepted: LocalAttachment[] = [];
    for (const file of incoming) {
      try {
        if (file.type.startsWith("image/")) {
          if (!selectedModel.capabilities.images.available) throw new Error(t("directChat.imagesUnavailable"));
          if (file.size > MAX_ATTACHED_IMAGE_BYTES || accepted.filter((item) => item.mimeType.startsWith("image/")).length >= MAX_ATTACHED_IMAGES) throw new Error(t("directChat.imageTooLarge"));
          const prepared = await prepareImageForAttachment(file, (name) => `${name} ${t("directChat.imageUndecodable", { formats: SUPPORTED_IMAGE_FORMAT_LABEL })}`);
          accepted.push({ id: crypto.randomUUID(), name: file.name, mimeType: prepared.mimeType, dataUrl: `data:${prepared.mimeType};base64,${prepared.data}`, previewUrl: URL.createObjectURL(file) });
        } else {
          if (!isTextAttachmentFile(file) || file.size > MAX_ATTACHED_TEXT_BYTES) throw new Error(t("directChat.fileUnsupported"));
          const content = await file.text();
          if (content.includes("\0") || content.includes("\uFFFD")) throw new Error(t("directChat.fileUnsupported"));
          accepted.push({ id: crypto.randomUUID(), name: file.name, mimeType: file.type || "text/plain", dataUrl: dataUrlFromText(file, content) });
        }
      } catch (caught) {
        setAttachmentError(caught instanceof Error ? caught.message : t("directChat.fileUnsupported"));
      }
    }
    if (accepted.length) { setAttachments((previous) => [...previous, ...accepted]); setAttachmentError(null); }
  }, [attachments.length, selectedModel, t]);
  const compact = useCallback(async () => {
    if (!selectedModel || messages.length === 0 || streaming || isCompactionActive(compactionStatus)) return;
    dispatchCompaction({ type: "request", sessionId: directSessionId, source: "manual", now: Date.now() });
    const controller = new AbortController();
    compactAbortRef.current = controller;
    let terminal = false;
    try {
      const request: DirectChatCompactRequest = { modelKey: selectedModel.key, messages };
      const response = await fetch("/api/direct-chat/compact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
      if (!response.ok || !response.body) throw new Error((await response.text()) || t("directChat.compactFailed"));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const handleEvent = (event: DirectChatCompactSseEvent) => {
        if (event.type === "progress") dispatchCompaction({ type: "running", sessionId: directSessionId, source: "manual", now: Date.now(), phase: event.phase });
        if (event.type === "complete") { terminal = true; setMessages(event.messages); dispatchCompaction({ type: "settle", sessionId: directSessionId, outcome: "completed", now: Date.now() }); }
        if (event.type === "noop") { terminal = true; dispatchCompaction({ type: "settle", sessionId: directSessionId, outcome: "noop", now: Date.now(), message: event.reason }); }
        if (event.type === "error") { terminal = true; dispatchCompaction({ type: "settle", sessionId: directSessionId, outcome: "failed", now: Date.now(), message: event.message }); }
                if (event.type === "cancelled") { terminal = true; dispatchCompaction({ type: "settle", sessionId: directSessionId, outcome: "cancelled", now: Date.now() }); }
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = parseSse(buffer + decoder.decode(chunk.value, { stream: true }), handleEvent);
      }
      if (buffer.trim()) parseSse(`${buffer}\n\n`, handleEvent);
      if (!terminal) dispatchCompaction({ type: "settle", sessionId: directSessionId, outcome: "failed", now: Date.now(), message: t("directChat.compactFailed") });
    } catch (caught) {
      dispatchCompaction({ type: "settle", sessionId: directSessionId, outcome: (caught as Error).name === "AbortError" ? "cancelled" : "failed", now: Date.now(), message: (caught as Error).name === "AbortError" ? undefined : (caught instanceof Error ? caught.message : t("directChat.compactFailed")) });
    } finally { compactAbortRef.current = null; }
  }, [compactionStatus, directSessionId, messages, selectedModel, streaming, t]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (streaming || isCompactionActive(compactionStatus) || !selectedModel || (!content && attachments.length === 0)) return;
    if (contextText && (!contextConfirmed || !contextWithinLimit)) {
      setError(contextWithinLimit ? t("directChat.contextNeedsConfirmation") : t("directChat.contextTooLarge"));
      return;
    }
    const user: DirectChatMessage = { role: "user", content, ...(attachments.length ? { attachments: attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, dataUrl: attachment.dataUrl })) } : {}) };
    const transcript = [...messages, user];
    const transcriptBytes = transcript.reduce((total, message) => total + byteLength(message.content) + (message.attachments?.reduce((attachmentTotal, attachment) => attachmentTotal + byteLength(attachment.dataUrl), 0) ?? 0), 0);
    if (byteLength(content) > DIRECT_CHAT_MAX_MESSAGE_BYTES) {
      setError(t("directChat.messageTooLarge"));
      return;
    }
    if (transcript.length > DIRECT_CHAT_MAX_MESSAGES || transcriptBytes > DIRECT_CHAT_MAX_TRANSCRIPT_BYTES) {
      setError(t("directChat.historyTooLarge"));
      return;
    }
    const request: DirectChatRequest = {
      modelKey: selectedModel.key,
      ...(cwd ? { cwd } : {}),
      messages: transcript,
      ...(contextText ? { context: contextText } : {}),
      ...(reasoningEffort && selectedModel.capabilities.reasoning.available ? { reasoningEffort } : {}),
      ...(fast && selectedModel.capabilities.fast.available ? { fast: true } : {}),
      ...(selectedSkills.size ? { skills: Array.from(selectedSkills.values()) } : {}),
    };
    setMessages([...transcript, { role: "assistant", content: "" }]);
    setDraft("");
    setError(null);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let succeeded = false;
    try {
      const response = await fetch("/api/direct-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
      if (!response.ok || !response.body) {
        const detail = await response.text();
        throw new Error(detail || t("directChat.sendFailed"));
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let serverError: string | null = null;
      const handleEvent = (event: DirectChatSseEvent) => {
        if (event.type === "delta") setMessages((previous) => previous.map((message, index) => index === previous.length - 1 ? { ...message, content: message.content + event.text } : message));
        if (event.type === "error") serverError = event.message;
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = parseSse(buffer + decoder.decode(chunk.value, { stream: true }), handleEvent);
      }
      if (buffer.trim()) parseSse(`${buffer}\n\n`, handleEvent);
      if (serverError) throw new Error(serverError);
      succeeded = true;
    } catch (caught) {
      if ((caught as Error).name === "AbortError") {
        setMessages((previous) => previous[previous.length - 1]?.content ? previous : previous.slice(0, -1));
      } else {
        setMessages((previous) => previous.slice(0, -1));
        setDraft(content);
        setError(caught instanceof Error ? caught.message : t("directChat.sendFailed"));
      }
    } finally {
      abortRef.current = null;
      if (succeeded) setAttachments((previous) => { previous.forEach((attachment) => attachment.previewUrl && URL.revokeObjectURL(attachment.previewUrl)); return []; });
      setStreaming(false);
    }
  }, [attachments, compactionStatus, contextConfirmed, contextText, contextWithinLimit, cwd, draft, fast, messages, reasoningEffort, selectedModel, selectedSkills, streaming, t]);

  const applyCommand = useCallback((command: string) => {
    const [name, ...rest] = command.trim().replace(/^\//, "").split(/\s+/);
    const value = rest.join(" ");
    if (name === "model") {
      const model = availableModels.find((item) => item.name.toLowerCase() === value.toLowerCase() || item.id.toLowerCase() === value.toLowerCase());
      if (model) { setModelKey(model.key); setDraft(""); return; }
    }
    if (name === "reasoning" && selectedModel?.capabilities.reasoning.available && selectedModel.capabilities.reasoning.efforts?.includes(value)) { setReasoningEffort(value); setDraft(""); return; }
    if (name === "fast" && selectedModel?.capabilities.fast.available) { setFast((previous) => !previous); setDraft(""); return; }
    if (name === "compact") { setDraft(""); void compact(); return; }
        if (name === "new") {
          if (accountScope) clearDirectChatConversation(accountScope, cwd);
          setMessages([]);
          setDraft("");
          setContextSelected(new Set());
          setContextText("");
          setContextConfirmed(false);
          setSelectedSkills(new Map());
          setError(null);
          return;
        }
    setError(t("directChat.commandUnavailable"));
  }, [accountScope, availableModels, compact, cwd, selectedModel, t]);

  const hasConfiguredModel = availableModels.length > 0;
  return <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg)" }}>
    <header style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 7, background: "var(--bg-panel)", flexShrink: 0 }}>
      <MessageCircle size={15} aria-hidden="true" color="var(--accent)" />
      <span style={{ fontWeight: 650, fontSize: 12 }}>{t("workspace.chat")}</span>
      <span style={{ color: "var(--text-dim)", fontSize: 10, letterSpacing: ".04em", textTransform: "uppercase" }}>{t("directChat.apiLabel")}</span>
      <div style={{ flex: 1 }} />
      <button className="shell-toolbar-btn ui-focus-ring" type="button" disabled={isCompactionActive(compactionStatus)} title={t("directChat.newChat")} aria-label={t("directChat.newChat")} onClick={() => { if (accountScope) clearDirectChatConversation(accountScope, cwd); setMessages([]); setDraft(""); setContextSelected(new Set()); setContextText(""); setContextConfirmed(false); setSelectedSkills(new Map()); setError(null); }}><Plus size={15} /></button>
    </header>

    <div style={{ padding: "7px 10px", borderBottom: "1px solid var(--border)", display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
      <label style={{ minWidth: 0, flex: 1 }}>
        <span className="sr-only">{t("directChat.model")}</span>
        <select value={modelKey ?? ""} disabled={loadingModels || streaming} onChange={(event) => { setModelKey(event.target.value); setReasoningEffort(null); setFast(false); }} className="ui-focus-ring" style={{ width: "100%", minWidth: 0, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 7px", fontSize: 11 }}>
          {loadingModels && <option>{t("directChat.loadingModels")}</option>}
          {!loadingModels && models.map((model) => <option key={model.key} value={model.key} disabled={!model.available}>{model.name}{model.available ? "" : ` — ${model.reason ?? t("directChat.unavailable")}`}</option>)}
        </select>
      </label>
      {selectedModel?.capabilities.reasoning.available && <select value={reasoningEffort ?? ""} aria-label={t("directChat.reasoning")} onChange={(event) => setReasoningEffort(event.target.value || null)} disabled={streaming} className="ui-focus-ring" style={{ maxWidth: 88, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px", fontSize: 11 }}><option value="">{t("directChat.reasoning")}</option>{selectedModel.capabilities.reasoning.efforts?.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select>}
      {selectedModel?.capabilities.fast.available && <button type="button" className="ui-focus-ring" aria-pressed={fast} onClick={() => setFast((value) => !value)} title={t("directChat.fastHint")} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "5px 7px", background: fast ? "var(--bg-selected)" : "var(--bg)", color: "var(--text)", fontSize: 11 }}>{t("directChat.fast")}</button>}
    </div>

    {(modelsError || !hasConfiguredModel) && <div role="alert" style={{ margin: "10px", padding: "8px", border: "1px solid color-mix(in srgb, var(--status-error) 35%, var(--border))", borderRadius: 7, color: "var(--text-muted)", fontSize: 11 }}><div>{modelsError ?? t("directChat.noModels")}</div><button type="button" onClick={onOpenProviders} className="ui-focus-ring" style={{ marginTop: 6, border: 0, padding: 0, background: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer" }}><Settings2 size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />{t("directChat.openProviders")}</button></div>}

    <div ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; nearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px" }}>
      {messages.length === 0 && hasConfiguredModel && <div style={{ color: "var(--text-dim)", fontSize: 12, padding: "12px 2px" }}>{t("directChat.empty")}</div>}
      {messages.map((message, index) => <article key={`${message.role}-${index}`} style={{ marginBottom: 12, display: "flex", flexDirection: "column", alignItems: message.role === "user" ? "flex-end" : "stretch" }}>
        <div style={{ maxWidth: message.role === "user" ? "92%" : "100%", borderRadius: 8, padding: message.role === "user" ? "7px 9px" : "0", background: message.role === "user" ? "var(--bg-selected)" : "transparent", fontSize: 12, lineHeight: 1.5, whiteSpace: message.role === "user" ? "pre-wrap" : undefined }}>
          {message.role === "assistant" ? (message.content ? <MarkdownBody isStreaming={streaming && index === messages.length - 1} cwd={cwd ?? undefined}>{message.content}</MarkdownBody> : streaming ? <LoaderCircle size={14} className="spin" aria-label={t("directChat.streaming")} /> : null) : message.content}
        </div>
        {message.attachments?.length ? <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>{message.attachments.map((attachment) => <span key={attachment.id} style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "3px 5px", color: "var(--text-muted)", fontSize: 10 }}><FileText size={11} style={{ verticalAlign: "-2px", marginRight: 3 }} />{attachment.name}</span>)}</div> : null}
      </article>)}
    </div>
    <CompactionProgress status={compactionStatus} />

    <section style={{ borderTop: "1px solid var(--border)", background: "var(--bg-panel)", padding: "7px 10px max(7px, var(--safe-bottom))", flexShrink: 0 }}>
      {error && <div role="alert" style={{ color: "var(--status-error)", fontSize: 11, marginBottom: 6 }}>{error}</div>}
      {attachmentError && <div role="alert" style={{ color: "var(--status-error)", fontSize: 11, marginBottom: 6 }}>{attachmentError}</div>}
      {attachments.length > 0 && <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>{attachments.map((attachment, index) => <span key={attachment.id} style={{ display: "inline-flex", alignItems: "center", gap: 3, border: "1px solid var(--border)", borderRadius: 5, padding: "3px 4px", fontSize: 10 }}><FileText size={11} />{attachment.name}<button type="button" aria-label={`${t("directChat.removeAttachment")} ${attachment.name}`} onClick={() => setAttachments((previous) => { const removed = previous[index]; if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl); return previous.filter((_, itemIndex) => itemIndex !== index); })} style={{ border: 0, background: "none", color: "var(--text-muted)", padding: 0 }}><X size={12} /></button></span>)}</div>}
      <button type="button" onClick={() => setContextOpen((value) => !value)} className="ui-focus-ring" aria-expanded={contextOpen} style={{ display: "inline-flex", gap: 4, alignItems: "center", border: 0, background: "none", color: contextText ? "var(--accent)" : "var(--text-muted)", padding: "2px 0 5px", fontSize: 11, cursor: "pointer" }}><ChevronDown size={13} style={{ transform: contextOpen ? "rotate(180deg)" : undefined }} />{t("directChat.context")}{contextText ? ` · ~${estimateTokens(contextText)}` : ""}</button>
      {contextOpen && <div style={{ border: "1px solid var(--border)", borderRadius: 7, padding: 7, marginBottom: 6, fontSize: 11 }}>
        <p style={{ margin: "0 0 6px", color: "var(--text-muted)" }}>{t("directChat.contextDisclosure")}</p>
        {contextLoading && <span>{t("directChat.loadingContext")}</span>}
        {contextError && <div role="alert" style={{ color: "var(--status-error)" }}>{contextError}</div>}
        {contextCandidates.map((candidate) => <label key={candidate.path} style={{ display: "flex", gap: 5, alignItems: "center", margin: "4px 0" }}><input type="checkbox" checked={contextSelected.has(candidate.path)} onChange={() => updateContextSelection(candidate.path)} /><span>{candidate.label} <span style={{ color: "var(--text-dim)" }}>~{candidate.estimatedTokens}</span></span></label>)}
        {contextText && <><textarea value={contextText} onChange={(event) => { setContextText(event.target.value); setContextConfirmed(false); }} aria-label={t("directChat.contextPreview")} rows={5} style={{ width: "100%", boxSizing: "border-box", marginTop: 6, resize: "vertical", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", padding: 6, font: "11px var(--font-mono)" }} /><div style={{ marginTop: 4, color: contextWithinLimit ? "var(--text-dim)" : "var(--status-error)" }}>{contextBytes.toLocaleString()} B · ~{estimateTokens(contextText)} {contextWithinLimit ? "" : `· ${t("directChat.contextTooLarge")}`}</div><label style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 5 }}><input type="checkbox" checked={contextConfirmed} onChange={(event) => setContextConfirmed(event.target.checked)} />{t("directChat.confirmContext")}</label></>}
      </div>}
      {selectedModel?.capabilities.skills.available && <details open={skillsOpen} onToggle={(event) => setSkillsOpen((event.currentTarget as HTMLDetailsElement).open)} style={{ marginBottom: 6, fontSize: 11 }}>
        <summary className="ui-focus-ring" style={{ cursor: "pointer", color: selectedSkills.size ? "var(--accent)" : "var(--text-muted)" }}>{t("directChat.skills")}{selectedSkills.size ? ` · ${selectedSkills.size}` : ""}</summary>
        <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6, marginTop: 5 }}>
          <p style={{ margin: "0 0 5px", color: "var(--text-muted)" }}>{t("directChat.skillsDisclosure")}</p>
          {skillsLoading && <span>{t("directChat.loadingSkills")}</span>}
          {skillsError && <div role="alert" style={{ color: "var(--status-error)" }}>{skillsError}</div>}
          {skills.map((skill) => <label key={skill.id} style={{ display: "flex", gap: 5, alignItems: "flex-start", margin: "4px 0", opacity: skill.enabled ? 1 : .55 }}><input type="checkbox" disabled={!skill.enabled} checked={selectedSkills.has(skill.id)} onChange={() => void toggleSkill(skill)} /><span><strong>{skill.name}</strong>{skill.description ? ` — ${skill.description}` : ""}</span></label>)}
          {Array.from(selectedSkills.entries()).map(([id, content]) => <details key={id} style={{ marginTop: 5 }}><summary>{skills.find((skill) => skill.id === id)?.name ?? id}</summary><pre style={{ maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", margin: "4px 0 0", padding: 5, background: "var(--bg)", borderRadius: 4 }}>{content}</pre></details>)}
          {!skillsLoading && !skillsError && skills.length === 0 && <span style={{ color: "var(--text-dim)" }}>{t("directChat.noSkills")}</span>}
          <p style={{ margin: "6px 0 0", color: "var(--text-dim)" }}>{t("directChat.pluginsExcluded")}</p>
        </div>
          {!skillsLoading && !skillsError && skills.length === 0 && <button type="button" onClick={onOpenExtensions} className="ui-focus-ring" style={{ display: "block", marginTop: 5, padding: 0, border: 0, background: "none", color: "var(--accent)", fontSize: 11 }}>{t("directChat.refreshPromptCommands")}</button>}
      </details>}
      <textarea ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (draft.startsWith("/")) applyCommand(draft); else void send(); } }} disabled={!hasConfiguredModel || streaming || isCompactionActive(compactionStatus)} placeholder={t("directChat.placeholder")} rows={2} className="ui-focus-ring" style={{ width: "100%", boxSizing: "border-box", resize: "vertical", maxHeight: 160, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, color: "var(--text)", padding: "7px 8px", font: "12px var(--font-sans)" }} />
      {draft.startsWith("/") && <div style={{ color: "var(--text-dim)", fontSize: 10, marginTop: 4 }}>{t("directChat.commandsHint")}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6 }}>
        <input ref={fileRef} type="file" multiple hidden onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        <button type="button" className="shell-toolbar-btn ui-focus-ring" disabled={!selectedModel?.capabilities.attachments.available || streaming} onClick={() => fileRef.current?.click()} title={t("directChat.attach")} aria-label={t("directChat.attach")}><Paperclip size={15} /></button>
        <button type="button" className="shell-toolbar-btn ui-focus-ring" disabled={!selectedModel?.capabilities.images.available || streaming} onClick={() => fileRef.current?.click()} title={t("directChat.attachImage")} aria-label={t("directChat.attachImage")}><ImagePlus size={15} /></button>
        <div style={{ flex: 1 }} />
        {streaming || isCompactionActive(compactionStatus) ? <button type="button" onClick={() => { abortRef.current?.abort(); compactAbortRef.current?.abort(); }} className="ui-focus-ring" style={{ border: 0, borderRadius: 7, padding: "6px 9px", background: "var(--status-error)", color: "white", fontSize: 11 }}><Square size={11} style={{ marginRight: 4 }} />{t("directChat.stop")}</button> : <button type="button" onClick={() => void send()} disabled={!hasConfiguredModel || (!draft.trim() && attachments.length === 0)} className="ui-focus-ring" style={{ border: 0, borderRadius: 7, padding: "6px 10px", background: (draft.trim() || attachments.length) ? "var(--accent-strong)" : "var(--bg)", color: (draft.trim() || attachments.length) ? "var(--on-accent)" : "var(--text-dim)", fontSize: 11 }}>{t("directChat.send")}</button>}
      </div>
    </section>
  </div>;
}
