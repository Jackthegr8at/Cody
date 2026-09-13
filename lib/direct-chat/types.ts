export const DIRECT_CHAT_MAX_MESSAGES = 80;
export const DIRECT_CHAT_MAX_MESSAGE_BYTES = 64 * 1024;
export const DIRECT_CHAT_MAX_TRANSCRIPT_BYTES = 512 * 1024;
export const DIRECT_CHAT_MAX_CONTEXT_BYTES = 48 * 1024;
export const DIRECT_CHAT_MAX_ATTACHMENTS = 8;
export const DIRECT_CHAT_MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;

export type DirectChatRole = "user" | "assistant";

export interface DirectChatAttachment {
  /** Existing Cody attachment payload; never a filesystem path or external URL. */
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  /** Server-validated attachment classification; clients never need to send it. */
  kind?: "image" | "text";
  /** Server-decoded UTF-8 for text/source attachments; never persisted by the client. */
  textContent?: string;
}

export interface DirectChatMessage {
  role: DirectChatRole;
  content: string;
  attachments?: DirectChatAttachment[];
}

export interface DirectChatModelCapabilities {
  reasoning: { available: boolean; efforts?: string[] };
  fast: { available: boolean };
  images: { available: boolean };
  attachments: { available: boolean };
  skills: { available: boolean };
}

export interface DirectChatModel {
  /** Opaque server-selected identifier. It is the only model routing input accepted by POST. */
  key: string;
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  available: boolean;
  reason?: string;
  capabilities: DirectChatModelCapabilities;
}

export interface DirectChatModelsResponse {
  models: DirectChatModel[];
  /** Safe stable partition for browser-only local transcript persistence. */
  accountScope: string;
}

export interface DirectChatContextCandidate {
  path: string;
  label: string;
  preview: string;
  sourceBytes: number;
  previewBytes: number;
  /** Approximation only; providers tokenize differently. */
  estimatedTokens: number;
}

export interface DirectChatContextResponse {
  candidates: DirectChatContextCandidate[];
}

export interface DirectChatRequest {
  modelKey: string;
  cwd?: string;
  messages: DirectChatMessage[];
  /** User-edited opt-in workspace instructions, never auto-added. */
  context?: string;
  reasoningEffort?: string;
  fast?: boolean;
  /** Explicit, bounded skill text selected by the user; executable plugins are never run. */
  skills?: string[];
}

export type DirectChatSseEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };
export interface DirectChatPromptAsset {
  id: string;
  name: string;
  description: string;
  content?: string;
  enabled: boolean;
  kind: "skill" | "plugin-command";
}

export interface DirectChatExtensionsResponse {
  skills: DirectChatPromptAsset[];
  pluginCommands: DirectChatPromptAsset[];
}
export type DirectChatCompactStatus = "running" | "completed" | "noop" | "failed" | "cancelled";

export interface DirectChatCompactRequest {
  modelKey: string;
  messages: DirectChatMessage[];
  /** Applied to the summary request when this model exposes that effort. */
  reasoningEffort?: string;
  /** Applied to the summary request when this model supports Fast. */
  fast?: boolean;
}

export type DirectChatCompactSseEvent =
  | { type: "progress"; status: "running"; phase: "preparing" | "summarizing"; elapsedMs: number }
  | { type: "delta"; text: string }
  | { type: "complete"; status: "completed"; messages: DirectChatMessage[]; elapsedMs: number }
  | { type: "noop"; status: "noop"; reason: string; elapsedMs: number }
  | { type: "error"; status: "failed"; message: string; elapsedMs: number }
  | { type: "cancelled"; status: "cancelled"; elapsedMs: number };
