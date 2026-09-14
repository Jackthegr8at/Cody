export type FontSize = "13" | "14" | "15" | "16";

/** Chat font size preference: 13, 14 (default), 15, 16 px. Persisted to
 *  localStorage and broadcast to all subscribers on change. */

import { STORAGE_KEYS } from "./storage-keys";

const VALID_SIZES = new Set<FontSize>(["13", "14", "15", "16"]);
const DEFAULT_SIZE = "14" as const;

const subscribers: Set<(size: FontSize) => void> = new Set();

function parseStoredSize(val: string | null): FontSize {
  if (val && VALID_SIZES.has(val as FontSize)) return val as FontSize;
  return DEFAULT_SIZE;
}

/** Read the current chat font size from localStorage, or return the default. */
export function readChatFontSize(): FontSize {
  if (typeof window === "undefined") return DEFAULT_SIZE;
  const stored = localStorage.getItem(STORAGE_KEYS.chatFontSize);
  return parseStoredSize(stored);
}

/** Write a new chat font size to localStorage and notify all subscribers. */
export function writeChatFontSize(size: FontSize) {
  if (typeof window === "undefined") return;
  if (!VALID_SIZES.has(size)) {
    console.warn(`Invalid chat font size: ${size}, keeping current`);
    return;
  }
  localStorage.setItem(STORAGE_KEYS.chatFontSize, size);
  document.documentElement.style.setProperty("--chat-font-size", size + "px");
  for (const sub of subscribers) sub(size);
}

/** Subscribe to chat font size changes. Returns an unsubscribe function. */
export function subscribeChatFontSize(callback: (size: FontSize) => void): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}
