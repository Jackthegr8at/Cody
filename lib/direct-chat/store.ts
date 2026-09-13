import type { DirectChatMessage } from "@/lib/direct-chat/types";

export interface DirectChatConversation {
  messages: DirectChatMessage[];
  modelKey: string | null;
  reasoningEffort: string | null;
  fast: boolean;
}

const STORAGE_PREFIX = "cody:direct-chat:v1:";
const EMPTY_CONVERSATION: DirectChatConversation = { messages: [], modelKey: null, reasoningEffort: null, fast: false };

function safePart(value: string): string {
  return encodeURIComponent(value || "no-workspace");
}

/** Browser-only partition: a direct transcript belongs to both the signed-in account and workspace. */
export function directChatStorageKey(accountScope: string, cwd: string | null): string {
  return `${STORAGE_PREFIX}${safePart(accountScope)}:${safePart(cwd ?? "")}`;
}

function validMessage(value: unknown): value is DirectChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<DirectChatMessage>;
  return (message.role === "user" || message.role === "assistant") && typeof message.content === "string";
}

export function readDirectChatConversation(accountScope: string, cwd: string | null): DirectChatConversation {
  try {
    const raw = window.localStorage.getItem(directChatStorageKey(accountScope, cwd));
    if (!raw) return EMPTY_CONVERSATION;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_CONVERSATION;
    const value = parsed as Partial<DirectChatConversation>;
    return {
      messages: Array.isArray(value.messages) ? value.messages.filter(validMessage) : [],
      modelKey: typeof value.modelKey === "string" ? value.modelKey : null,
      reasoningEffort: typeof value.reasoningEffort === "string" ? value.reasoningEffort : null,
      fast: value.fast === true,
    };
  } catch {
    return EMPTY_CONVERSATION;
  }
}

export function writeDirectChatConversation(accountScope: string, cwd: string | null, conversation: DirectChatConversation): void {
  try {
    window.localStorage.setItem(directChatStorageKey(accountScope, cwd), JSON.stringify({
      ...conversation,
      messages: conversation.messages,
    }));
  } catch {
    // Private mode and quota must not make the direct chat unusable.
  }
}

export function clearDirectChatConversation(accountScope: string, cwd: string | null): void {
  try { window.localStorage.removeItem(directChatStorageKey(accountScope, cwd)); } catch { /* best effort */ }
}
