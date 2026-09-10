/**
 * Does an assistant reply ask the USER something?
 *
 * omp's todo reminder (`todo-tracker.ts` `isAwaitingUserAnswer`) only looks at
 * the LAST line of the reply before auto-continuing an unfinished todo list. A
 * question followed by a summary line ("Which do you prefer?\n\nSummary: …")
 * is therefore overridden, and the agent carries on as if the user had
 * answered. This helper applies omp's own line rules to EVERY prose line so
 * the rpc wrapper can pause the continuation instead (see rpc-manager's
 * `todo_reminder` case).
 *
 * Pure: no engine types, no I/O.
 */

const MARKDOWN_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;
const QUESTION_WORD_RE =
  /^(?:what|which|when|where|why|how|who|whom|whose|do|does|did|can|could|would|will|should|is|are|am|may|shall)\b/i;
const USER_DIRECTED_RE = /\b(?:you|your|we|our)\b/i;
const RESPONSE_CUE_RE =
  /^(?:please\s+)?(?:confirm|reply|choose|pick|decide|advise|answer|let\s+me\s+know|tell\s+me)\b/i;
const NON_ASCII_RE = /[^\x00-\x7F]/;
/** Trailing `?` (or fullwidth), tolerating closing emphasis: `**Which one?**`. */
const ENDS_WITH_QUESTION_MARK_RE = /[?？][*_\s]*$/;
const TRAILING_PUNCTUATION_RE = /[.!?。！？]+$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
/** `foo?: string` (optional property / ternary-with-type) and URLs carry a
 * `?` that asks nothing. */
const CODE_LIKE_RE = /\?:|:\/\/|\bwww\./;
const INLINE_CODE_RE = /`[^`]*`/g;

/** True when any prose line of `text` is a user-directed question or a
 * response cue ("please confirm…"). Fenced code and code-looking lines are
 * ignored. */
export function replyAsksUser(text: string): boolean {
  let fenced = false;
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.replace(INLINE_CODE_RE, "").trim();
    if (!line || CODE_LIKE_RE.test(line)) continue;
    const unprefixed = line.replace(MARKDOWN_PREFIX_RE, "").trim();
    const candidate = unprefixed.replace(PROMPT_LABEL_RE, "").trim();
    const labelled = candidate !== unprefixed;
    if (ENDS_WITH_QUESTION_MARK_RE.test(candidate)) {
      if (labelled || QUESTION_WORD_RE.test(candidate) || USER_DIRECTED_RE.test(candidate) || NON_ASCII_RE.test(candidate)) {
        return true;
      }
    }
    if (RESPONSE_CUE_RE.test(candidate.replace(TRAILING_PUNCTUATION_RE, "").trim())) return true;
  }
  return false;
}

/** Concatenated text of an assistant `message_end` frame's message, or null
 * for any other frame. Blocks join with a newline (as omp's own todo-tracker
 * does) so a `?` ending one block cannot merge into the next block's line. */
export function assistantReplyText(frame: { type: string; [key: string]: unknown }): string | null {
  const message = frame.message;
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return null;
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") continue;
    if ("text" in block && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}
