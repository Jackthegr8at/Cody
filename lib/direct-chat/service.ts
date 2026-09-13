import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { readUserVisibility } from "@/lib/model-visibility";
import { peekCatalogCache, type ModelsData } from "@/lib/models-cache";
import { matchesEnabledModel, readConfiguredDirectModels, readDirectModelCuration, type ModelDefinition, type ProviderConfig } from "@/lib/harness/direct-model-config";
import { readProviderKeys } from "@/lib/harness/provider-keys";
import { isRecord } from "@/lib/type-guards";
import { supportsPriorityFastMode } from "@/lib/fast-mode";
import { isTextAttachmentFile } from "@/lib/chat-attachments";
import {
  DIRECT_CHAT_MAX_ATTACHMENTS,
  DIRECT_CHAT_MAX_CONTEXT_BYTES,
  DIRECT_CHAT_MAX_MESSAGE_BYTES,
  DIRECT_CHAT_MAX_MESSAGES,
  DIRECT_CHAT_MAX_TRANSCRIPT_BYTES,
  DIRECT_CHAT_MAX_TEXT_ATTACHMENT_BYTES,
  type DirectChatAttachment,
  type DirectChatContextCandidate,
  type DirectChatMessage,
  type DirectChatModel,
  type DirectChatModelCapabilities,
  type DirectChatRequest,
} from "./types";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const CONTEXT_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;
const CONTEXT_PREVIEW_BYTES = 12 * 1024;
const MAX_SKILL_BYTES = 24 * 1024;
const MAX_REQUEST_BYTES = DIRECT_CHAT_MAX_TRANSCRIPT_BYTES + DIRECT_CHAT_MAX_CONTEXT_BYTES + MAX_SKILL_BYTES + 128 * 1024;

type Dialect = "openai" | "anthropic";
type DirectReasoning =
  | { kind: "openai"; efforts: string[] }
  | { kind: "anthropic-adaptive" }
  | { kind: "anthropic-budget"; budgets: Record<string, number> };
type DirectFast = { kind: "openai-priority" };

interface DirectTarget {
  model: DirectChatModel;
  dialect?: Dialect;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  outputTokenField?: "max_tokens" | "max_completion_tokens";
  reasoning?: DirectReasoning;
  fast?: DirectFast;
}

const KNOWN_PROVIDERS: Record<string, { baseUrl: string; dialect: Dialect; keyEnv: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", dialect: "openai", keyEnv: "OPENAI_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", dialect: "openai", keyEnv: "OPENROUTER_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", dialect: "openai", keyEnv: "XAI_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", dialect: "openai", keyEnv: "DEEPSEEK_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", dialect: "openai", keyEnv: "GROQ_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", dialect: "openai", keyEnv: "MISTRAL_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", dialect: "openai", keyEnv: "CEREBRAS_API_KEY" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", dialect: "openai", keyEnv: "FIREWORKS_API_KEY" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", dialect: "anthropic", keyEnv: "ANTHROPIC_API_KEY" },
};

function bytes(value: string): number { return textEncoder.encode(value).byteLength; }
function cap(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
function safeString(value: unknown, maximum: number): string | null { return typeof value === "string" && value.length <= maximum ? value : null; }
function hasImageInput(model: ModelDefinition): boolean { return model.input?.includes("image") ?? false; }
function directReasoning(model: ModelDefinition, dialect: Dialect | undefined): DirectReasoning | undefined {
  if (dialect === "openai" && model.reasoning) {
    const efforts = (model.thinking?.efforts ?? []).filter((effort) => ["minimal", "low", "medium", "high"].includes(effort));
    return efforts.length ? { kind: "openai", efforts } : undefined;
  }
  if (dialect !== "anthropic") return undefined;
  const thinking = model.thinking;
  if (thinking?.mode === "adaptive") return { kind: "anthropic-adaptive" };
  const budgets: Record<string, number> = {};
  for (const effort of thinking?.efforts ?? []) {
    const budget = Number(thinking?.effortMap?.[effort]);
    if (Number.isInteger(budget) && budget >= 1024 && budget < (model.maxTokens ?? 0)) budgets[effort] = budget;
  }
  return Object.keys(budgets).length ? { kind: "anthropic-budget", budgets } : undefined;
}
function directFast(provider: string, model: ModelDefinition, dialect: Dialect | undefined): DirectFast | undefined {
  return dialect === "openai" && supportsPriorityFastMode({ provider, id: model.id, api: model.api }) ? { kind: "openai-priority" } : undefined;
}
function modelCapabilities(model: ModelDefinition | undefined, reasoning?: DirectReasoning, fast?: DirectFast): DirectChatModelCapabilities {
  const images = model ? hasImageInput(model) : false;
  const efforts = reasoning?.kind === "openai" ? reasoning.efforts : reasoning?.kind === "anthropic-budget" ? Object.keys(reasoning.budgets) : reasoning?.kind === "anthropic-adaptive" ? ["adaptive"] : undefined;
  return { reasoning: { available: Boolean(reasoning), ...(efforts ? { efforts } : {}) }, fast: { available: Boolean(fast) }, images: { available: images }, attachments: { available: true }, skills: { available: true } };
}
function keyFor(provider: string, id: string): string { return `${provider}/${id}`; }
function configuredKey(providerId: string, provider: ProviderConfig): string | undefined {
  if (provider.auth === "none") return undefined;
  if (typeof provider.apiKey === "string" && provider.apiKey.trim()) return provider.apiKey.trim();
  const known = KNOWN_PROVIDERS[providerId];
  const all = readProviderKeys();
  return known ? all[known.keyEnv] || process.env[known.keyEnv] : undefined;
}

function headerRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof item === "string") headers[key] = item;
  return Object.keys(headers).length ? headers : undefined;
}
function normalizedBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch { return undefined; }
}
function directModel(providerId: string, provider: ProviderConfig, definition: ModelDefinition): DirectTarget {
  const key = keyFor(providerId, definition.id);
  const api = definition.api ?? provider.api;
  const baseUrl = normalizedBaseUrl(definition.baseUrl ?? provider.baseUrl ?? "");
  const dialect: Dialect | undefined = api === "openai-completions" ? "openai" : api === "anthropic-messages" ? "anthropic" : undefined;
  let reason: string | undefined;
  if (provider.auth === "oauth") reason = "This provider is OAuth-only; configure an API key in Providers to use direct chat.";
  else if (!dialect) reason = "This provider's configured API dialect is not supported by direct chat.";
  else if (!baseUrl) reason = "This model has no configured API endpoint.";
  else if (provider.auth !== "none" && !configuredKey(providerId, provider)) reason = "An API key is required in Providers.";
  const reasoning = directReasoning(definition, dialect);
  const fast = directFast(providerId, definition, dialect);
  const model: DirectChatModel = {
    key, id: definition.id, name: definition.name ?? definition.id, provider: providerId,
    ...(definition.contextWindow ? { contextWindow: definition.contextWindow } : {}),
    ...(definition.maxTokens ? { maxOutputTokens: definition.maxTokens } : {}),
    available: !reason, ...(reason ? { reason } : {}), capabilities: modelCapabilities(definition, reasoning, fast),
  };
  return { model, dialect, baseUrl, apiKey: configuredKey(providerId, provider), headers: headerRecord(definition.headers ?? provider.headers), outputTokenField: dialect === "openai" && definition.reasoning ? "max_completion_tokens" : "max_tokens", reasoning, fast };
}

/** Models are derived only from static custom configuration plus an already-populated runtime cache. This function never refreshes or starts an engine. */
export function directTargets(accountId?: string): DirectTarget[] {
  const custom = readConfiguredDirectModels().providers ?? {};
  const targets = new Map<string, DirectTarget>();
  for (const [providerId, provider] of Object.entries(custom)) {
    if (!provider || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) if (model && typeof model.id === "string" && model.id) targets.set(keyFor(providerId, model.id), directModel(providerId, provider, model));
  }
  const cached = peekCatalogCache<ModelsData>("global:omp");
  for (const entry of cached?.modelList ?? []) {
    const key = keyFor(entry.provider, entry.id);
    if (targets.has(key)) continue;
    const known = KNOWN_PROVIDERS[entry.provider];
    const secret = known && (readProviderKeys()[known.keyEnv] || process.env[known.keyEnv]);
    const reason = !known ? "This provider has no direct API configuration." : !secret ? "An API key is required in Providers." : undefined;
    // The existing catalog cache is already obtained without spawning here. It
    // carries OMP's resolved effort ladder and priority capability; retain
    // only the OpenAI wire values this direct endpoint can actually encode.
    const efforts = (cached?.thinkingLevels[key] ?? []).filter((effort) => ["minimal", "low", "medium", "high"].includes(effort));
    const reasoning = known?.dialect === "openai" && entry.provider === "openai" && efforts.length ? { kind: "openai" as const, efforts } : undefined;
    const fast = known?.dialect === "openai" && entry.supportsFastMode ? { kind: "openai-priority" as const } : undefined;
    targets.set(key, {
      model: {
        key, id: entry.id, name: entry.name, provider: entry.provider,
        ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}), available: !reason, ...(reason ? { reason } : {}),
        capabilities: modelCapabilities(undefined, reasoning, fast),
      },
      dialect: known?.dialect, baseUrl: known?.baseUrl, apiKey: secret, outputTokenField: reasoning ? "max_completion_tokens" : "max_tokens", reasoning, fast,
    });
  }
  const { enabledModels, disabledProviders } = readDirectModelCuration();
  for (const [key, target] of targets) {
    if (disabledProviders.has(target.model.provider) || (enabledModels?.length && !enabledModels.some((pattern) => matchesEnabledModel(pattern, target.model.provider, target.model.id)))) targets.delete(key);
  }
  if (accountId) {
    const hidden = new Set(readUserVisibility(accountId, "omp").hidden);
    for (const [key] of targets) if (hidden.has(key)) targets.delete(key);
  }
  return [...targets.values()].sort((a, b) => a.model.provider.localeCompare(b.model.provider) || a.model.name.localeCompare(b.model.name));
}

export function accountScope(accountId?: string): string {
  return createHash("sha256").update(accountId ?? "open-instance").digest("base64url").slice(0, 18);
}

function requireAllowedCwd(cwd: string): string {
  const candidate = path.resolve(cwd);
  const stat = statSync(candidate);
  if (!stat.isDirectory()) throw new DirectChatError("Workspace path is not a directory.", 400);
  return candidate;
}

export async function getContextCandidates(cwd: string): Promise<DirectChatContextCandidate[]> {
  const workspace = requireAllowedCwd(cwd);
  const roots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(workspace, roots)) throw new DirectChatError("Workspace is not authorized for file access.", 403);
  const candidates: DirectChatContextCandidate[] = [];
  let current = workspace;
  while (true) {
    for (const name of CONTEXT_FILE_NAMES) {
      const candidate = path.join(current, name);
      if (!existsSync(candidate) || !isExistingFilePathAllowed(candidate, roots)) continue;
      const stat = statSync(candidate);
      if (!stat.isFile() || stat.size > 512 * 1024) continue;
      const full = readFileSync(candidate, "utf8");
      const preview = textDecoder.decode(textEncoder.encode(full).slice(0, CONTEXT_PREVIEW_BYTES));
      candidates.push({ path: candidate, label: path.relative(workspace, candidate) || name, preview, sourceBytes: bytes(full), previewBytes: bytes(preview), estimatedTokens: Math.ceil(bytes(full) / 4) });
    }
    const parent = path.dirname(current);
    if (parent === current || !isExistingFilePathAllowed(parent, roots)) break;
    current = parent;
  }
  return candidates;
}

export class DirectChatError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function decodeTextAttachment(dataUrl: string): string {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) throw new DirectChatError("Text attachments must be base64 data URLs.");
  const encoded = match[2];
  const raw = Buffer.from(encoded, "base64");
  if (raw.toString("base64") !== encoded || raw.byteLength > DIRECT_CHAT_MAX_TEXT_ATTACHMENT_BYTES) throw new DirectChatError("Text attachment exceeds the direct-chat limit.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { throw new DirectChatError("Text attachments must be valid UTF-8."); }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) throw new DirectChatError("Binary attachments are not supported in direct chat.");
  return text;
}

function validateAttachment(value: unknown): DirectChatAttachment {
  if (!isRecord(value)) throw new DirectChatError("Invalid attachment.");
  const id = safeString(value.id, 200); const name = safeString(value.name, 500); const mimeType = safeString(value.mimeType, 120); const dataUrl = safeString(value.dataUrl, 2 * 1024 * 1024);
  if (!id || !name || !mimeType || !dataUrl || /[\u0000-\u001F\u007F]/.test(name) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)) throw new DirectChatError("Invalid attachment.");
  const dataMime = /^data:([^;,]+);base64,/.exec(dataUrl)?.[1];
  if (!dataMime || dataMime.toLowerCase() !== mimeType.toLowerCase()) throw new DirectChatError("Attachment MIME type does not match its data URL.");
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return { id, name, mimeType, dataUrl, kind: "image" };
  if (!isTextAttachmentFile({ name, type: mimeType } as Pick<File, "name" | "type">)) throw new DirectChatError("Only bounded image or UTF-8 text/source attachments are supported in direct chat.");
  return { id, name, mimeType, dataUrl, kind: "text", textContent: decodeTextAttachment(dataUrl) };
}

export function parseDirectRequest(value: unknown): DirectChatRequest {
  if (!isRecord(value) || typeof value.modelKey !== "string" || value.modelKey.length > 500 || !Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > DIRECT_CHAT_MAX_MESSAGES) throw new DirectChatError("Invalid direct chat request.");
  const messages: DirectChatMessage[] = value.messages.map((message) => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || bytes(message.content) > DIRECT_CHAT_MAX_MESSAGE_BYTES) throw new DirectChatError("A message is invalid or exceeds the direct-chat limit.");
    const attachments = message.attachments === undefined ? undefined : Array.isArray(message.attachments) ? message.attachments.map(validateAttachment) : null;
    if (attachments === null) throw new DirectChatError("Invalid attachments.");
    return { role: message.role, content: message.content, ...(attachments?.length ? { attachments } : {}) };
  });
  const transcriptBytes = messages.reduce((total, message) => total + bytes(message.content) + (message.attachments?.reduce((attachments, attachment) => attachments + bytes(attachment.dataUrl), 0) ?? 0), 0);
  if (transcriptBytes > DIRECT_CHAT_MAX_TRANSCRIPT_BYTES) throw new DirectChatError("Conversation exceeds the direct-chat transcript limit.");
  const attachmentCount = messages.reduce((total, message) => total + (message.attachments?.length ?? 0), 0);
  if (attachmentCount > DIRECT_CHAT_MAX_ATTACHMENTS) throw new DirectChatError("Too many image attachments.");
  const context = value.context === undefined ? undefined : safeString(value.context, DIRECT_CHAT_MAX_CONTEXT_BYTES);
  if (value.context !== undefined && context === null) throw new DirectChatError("Context exceeds the direct-chat limit.");
  const skills = value.skills === undefined ? undefined : Array.isArray(value.skills) && value.skills.every((item) => typeof item === "string") ? value.skills as string[] : null;
  if (skills === null || (skills && bytes(skills.join("\n")) > MAX_SKILL_BYTES)) throw new DirectChatError("Selected skills exceed the direct-chat limit.");
  const cwd = value.cwd === undefined ? undefined : safeString(value.cwd, 4096);
  const reasoningEffort = value.reasoningEffort === undefined ? undefined : safeString(value.reasoningEffort, 40);
  return { modelKey: value.modelKey, ...(cwd ? { cwd } : {}), messages, ...(context ? { context } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(value.fast === true ? { fast: true } : {}), ...(skills?.length ? { skills } : {}) };
}

function requestOptions(input: DirectChatRequest, target: DirectTarget): { reasoning: Record<string, unknown>; fast: Record<string, unknown> } {
  if (!input.reasoningEffort) return { reasoning: {}, fast: input.fast ? (() => { if (!target.fast) throw new DirectChatError("Fast mode is unavailable for this model."); return { service_tier: "priority" }; })() : {} };
  if (!target.reasoning) throw new DirectChatError("Reasoning is unavailable for this model.");
  if (target.reasoning.kind === "openai") {
    if (!target.reasoning.efforts.includes(input.reasoningEffort)) throw new DirectChatError("That reasoning effort is unavailable for this model.");
    return { reasoning: { reasoning_effort: input.reasoningEffort }, fast: input.fast ? (() => { if (!target.fast) throw new DirectChatError("Fast mode is unavailable for this model."); return { service_tier: "priority" }; })() : {} };
  }
  if (target.reasoning.kind === "anthropic-adaptive") {
    if (input.reasoningEffort !== "adaptive") throw new DirectChatError("That reasoning effort is unavailable for this model.");
    return { reasoning: { thinking: { type: "adaptive" } }, fast: {} };
  }
  const budget = target.reasoning.budgets[input.reasoningEffort];
  if (!budget) throw new DirectChatError("That reasoning effort is unavailable for this model.");
  return { reasoning: { thinking: { type: "enabled", budget_tokens: budget } }, fast: {} };
}

function requestMessages(input: DirectChatRequest, target: DirectTarget): unknown[] {
  if (input.fast && !target.model.capabilities.fast.available) throw new DirectChatError("Fast mode is unavailable for this model.");
  const prefix = [input.context ? `Selected workspace instructions:\n${input.context}` : "", input.skills?.length ? `Selected skills:\n${input.skills.join("\n\n")}` : ""].filter(Boolean).join("\n\n");
  return input.messages.map((message, index) => {
    const baseContent = index === 0 && prefix ? `${prefix}\n\n${message.content}` : message.content;
    const textAttachments = message.attachments?.filter((attachment) => attachment.kind === "text") ?? [];
    const content = [baseContent, ...textAttachments.map((attachment) => {
      const longestFence = attachment.textContent?.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
      const fence = "`".repeat(Math.max(3, longestFence + 1));
      return `Attached file: ${attachment.name} (${attachment.mimeType})\n${fence}\n${attachment.textContent}\n${fence}`;
    })].filter(Boolean).join("\n\n");
    const images = message.attachments?.filter((attachment) => attachment.kind === "image") ?? [];
    if (!images.length) return { role: message.role, content };
    if (!target.model.capabilities.images.available) throw new DirectChatError("Image attachments are unavailable for this model.");
    if (target.dialect === "anthropic") return { role: message.role, content: [...images.map((attachment) => ({ type: "image", source: { type: "base64", media_type: attachment.mimeType, data: attachment.dataUrl.slice(attachment.dataUrl.indexOf(",") + 1) } })), { type: "text", text: content }] };
    return { role: message.role, content: [{ type: "text", text: content }, ...images.map((attachment) => ({ type: "image_url", image_url: { url: attachment.dataUrl } }))] };
  });
}

function textAttachmentPromptBytes(attachment: DirectChatAttachment): number {
  if (attachment.kind !== "text" || !attachment.textContent) return 0;
  const longestFence = attachment.textContent.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  const fence = Math.max(3, longestFence + 1);
  return bytes(attachment.textContent) + bytes(attachment.name) + bytes(attachment.mimeType) + (fence * 2) + 24;
}

function ensureTextFitsContext(input: DirectChatRequest, target: DirectTarget): void {
  if (!target.model.contextWindow) return;
  const promptBytes = input.messages.reduce((total, message) => total + bytes(message.content) + (message.attachments?.reduce((attachmentBytes, attachment) => attachmentBytes + textAttachmentPromptBytes(attachment), 0) ?? 0), 0)
    + bytes(input.context ?? "") + bytes(input.skills?.join("\n") ?? "");
  // This is intentionally conservative and explicitly only an approximation:
  // providers tokenize text differently, but never silently prune a transcript.
  const estimatedInputTokens = Math.ceil(promptBytes / 4);
  const outputReserve = cap(target.model.maxOutputTokens ?? 4096, 1, target.model.contextWindow);
  if (estimatedInputTokens + outputReserve > target.model.contextWindow) {
    throw new DirectChatError("Conversation exceeds this model's context budget; reduce messages or opt-in context.");
  }
}

function safeUpstreamMessage(error: unknown): string {
  if (error instanceof DirectChatError) return error.message;
  return "The direct model request failed.";
}
function sse(type: "delta" | "done" | "error", payload: object): Uint8Array { return textEncoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`); }

async function* parseSse(stream: ReadableStream<Uint8Array>, dialect: Dialect): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let reading = true;
  let sawTerminal = false;
  try {
    while (reading) {
      const result = await reader.read();
      if (result.done) {
        buffered += decoder.decode();
        reading = false;
      } else {
        buffered += decoder.decode(result.value, { stream: true });
      }
      if (buffered.length > 256 * 1024) throw new DirectChatError("The direct model sent an oversized stream event.", 502);
      let events: string[];
      if (reading) {
        events = buffered.split(/\r?\n\r?\n/);
        buffered = events.pop() ?? "";
      } else {
        events = buffered.trim() ? [buffered] : [];
        buffered = "";
      }
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { sawTerminal = true; continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw new DirectChatError("The direct model sent malformed stream data.", 502); }
        if (!isRecord(parsed)) throw new DirectChatError("The direct model sent malformed stream data.", 502);
        if (parsed.type === "error" || isRecord(parsed.error)) throw new DirectChatError("The direct model reported an error.", 502);
        if (dialect === "anthropic" && parsed.type === "message_stop") sawTerminal = true;
        if (dialect === "openai" && Array.isArray(parsed.choices) && isRecord(parsed.choices[0]) && parsed.choices[0].finish_reason !== null && parsed.choices[0].finish_reason !== undefined) sawTerminal = true;
        const text = dialect === "anthropic"
          ? isRecord(parsed.delta) && typeof parsed.delta.text === "string" ? parsed.delta.text : ""
          : Array.isArray(parsed.choices) && isRecord(parsed.choices[0]) && isRecord(parsed.choices[0].delta) && typeof parsed.choices[0].delta.content === "string" ? parsed.choices[0].delta.content : "";
        if (text) yield text;
      }
    }
    if (!sawTerminal) throw new DirectChatError("The direct model stream ended before completion.", 502);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function streamDirectChat(target: DirectTarget, input: DirectChatRequest, requestSignal: AbortSignal): ReadableStream<Uint8Array> {
  if (!target.model.available || !target.dialect || !target.baseUrl) throw new DirectChatError(target.model.reason ?? "This model is unavailable.");
  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  if (requestSignal.aborted) abortUpstream();
  else requestSignal.addEventListener("abort", abortUpstream, { once: true });
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async start(output) {
      const finish = (type: "done" | "error", payload: object) => { if (!closed) { closed = true; output.enqueue(sse(type, payload)); output.close(); } };
      try {
        ensureTextFitsContext(input, target);
        const messages = requestMessages(input, target);
        const endpoint = target.dialect === "anthropic" ? `${target.baseUrl}/messages` : `${target.baseUrl}/chat/completions`;
        const options = requestOptions(input, target);
        const maxOutputTokens = cap(target.model.maxOutputTokens ?? 4096, 1, 16_384);
        const body = target.dialect === "anthropic"
          ? { model: target.model.id, max_tokens: maxOutputTokens, messages, stream: true, ...options.reasoning }
          : { model: target.model.id, messages, stream: true, [target.outputTokenField ?? "max_tokens"]: maxOutputTokens, ...options.reasoning, ...options.fast };
        const headers: Record<string, string> = { Accept: "text/event-stream", "Content-Type": "application/json", ...(target.headers ?? {}) };
        if (target.dialect === "anthropic") { headers["anthropic-version"] = "2023-06-01"; if (target.apiKey) headers["x-api-key"] = target.apiKey; }
        else if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
        const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok || !response.body) throw new Error("Upstream direct model request failed");
        for await (const delta of parseSse(response.body, target.dialect as Dialect)) { if (!closed) output.enqueue(sse("delta", { text: delta })); }
        finish("done", {});
      } catch (error) {
        if (controller.signal.aborted) { closed = true; output.close(); }
        else finish("error", { message: safeUpstreamMessage(error) });
      } finally {
        requestSignal.removeEventListener("abort", abortUpstream);
      }
    },
    cancel() { controller.abort(); closed = true; },
  });
}

export async function parseJsonRequest(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new DirectChatError("Request exceeds the direct-chat limit.", 413);
  const text = await request.text();
  if (bytes(text) > MAX_REQUEST_BYTES) throw new DirectChatError("Request exceeds the direct-chat limit.", 413);
  try { return JSON.parse(text); } catch { throw new DirectChatError("Request body must be JSON."); }
}
