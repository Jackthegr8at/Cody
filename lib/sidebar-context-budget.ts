/**
 * How much of a small model's context one sidebar tool result may occupy.
 *
 * The sidebar is meant to run on the owner's local P40 models as well as the
 * hosted ones, and those are genuinely small:
 *
 *   qwen3.5-4b    8,192 window / 2,048 output  ->  ~6,100 for prompt + results
 *   gemma4-e4b   16,384 window / 4,096 output  -> ~12,200
 *   qwen3.8-27b  24,576 window / 8,192 output  -> ~16,300
 *
 * With a 144-token baseline prompt the window is almost entirely available —
 * and exactly for that reason it is easy to destroy: a single unbounded
 * `read_workspace_file` on a 4,000-line file, or the 43,000-token AGENTS.md
 * this redesign stopped preloading, would blow an 8k window in one call and
 * the turn would fail rather than degrade.
 *
 * So every result is clamped to a fraction of what remains, and truncation is
 * always REPORTED with the offset to continue from. A small model paging
 * deliberately through four 1.5k slices works; the same model handed one 6k
 * wall does not. That is the whole design: bounded reads the model drives,
 * never a preload it cannot refuse.
 */

/** The smallest window the sidebar supports; also the assumption when unknown. */
export const SMALLEST_SUPPORTED_WINDOW = 8_192;

/** Reserved for the reply when the model reports no `maxTokens`. */
const DEFAULT_OUTPUT_RESERVE = 0.25;

/** One result may take at most this share of the room left after the reserve. */
const RESULT_SHARE = 0.25;

/** Even on the smallest window a read must return something worth reading. */
const MIN_RESULT_TOKENS = 300;

/** Chars per token. Deliberately crude and deliberately consistent: the same
 * ratio is used for every clamp, so the budget is comparable across tools. */
export const CHARS_PER_TOKEN = 4;

/**
 * Tokens a single tool result may occupy.
 *
 * An unknown window is treated as the SMALLEST supported one, never as
 * unlimited: guessing large is how an 8k model gets a result it cannot fit,
 * and the cost of guessing small is only an extra page.
 */
export function resultTokenBudget(contextWindow: number | undefined, maxTokens?: number): number {
	const window = typeof contextWindow === "number" && contextWindow > 0
		? contextWindow
		: SMALLEST_SUPPORTED_WINDOW;
	const reserve = typeof maxTokens === "number" && maxTokens > 0 && maxTokens < window
		? maxTokens
		: Math.round(window * DEFAULT_OUTPUT_RESERVE);
	const usable = Math.max(0, window - reserve);
	return Math.max(MIN_RESULT_TOKENS, Math.floor(usable * RESULT_SHARE));
}

/** The same budget expressed in characters, which is what text is clamped by. */
export function resultCharBudget(contextWindow: number | undefined, maxTokens?: number): number {
	return resultTokenBudget(contextWindow, maxTokens) * CHARS_PER_TOKEN;
}

export interface ClampedResult {
	text: string;
	truncated: boolean;
	/** Where a follow-up call should continue, or null when the end was reached. */
	nextOffset: number | null;
	totalChars: number;
}

/**
 * Take at most `charBudget` characters starting at `offset`.
 *
 * Cuts on a line boundary when one is available in the last quarter of the
 * slice, so a paged read does not split a line down the middle — a 4B model
 * handed half a line of code tends to reason about the fragment rather than
 * ask for the rest. Never silently truncates: the caller gets `truncated` and
 * a `nextOffset` to continue from, and the tools put that offset in the text.
 */
export function clampForSidebar(text: string, charBudget: number, opts?: { offset?: number }): ClampedResult {
	const totalChars = text.length;
	const budget = Math.max(1, Math.floor(charBudget));
	const offset = Math.max(0, Math.min(Math.floor(opts?.offset ?? 0), totalChars));
	if (offset >= totalChars) {
		return { text: "", truncated: false, nextOffset: null, totalChars };
	}
	const hardEnd = Math.min(totalChars, offset + budget);
	if (hardEnd >= totalChars) {
		return { text: text.slice(offset), truncated: false, nextOffset: null, totalChars };
	}
	// Prefer a line break in the last quarter of the slice; fall back to the
	// hard cut when the slice has no break there (a minified file, one long line).
	const windowStart = offset + Math.floor(budget * 0.75);
	const breakAt = text.lastIndexOf("\n", hardEnd - 1);
	const end = breakAt >= windowStart ? breakAt + 1 : hardEnd;
	return { text: text.slice(offset, end), truncated: true, nextOffset: end, totalChars };
}
