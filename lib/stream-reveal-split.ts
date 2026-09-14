/**
 * Safe-boundary splitting for streamed text: where to cut a growing string
 * into a committed prefix (rendered once, memoized) and a small live tail
 * (re-parsed every frame). Extracted from the deleted typewriter pacer
 * (hooks/useSmoothStreamText.ts) — the pacer is gone, but the boundary math
 * is still exactly what components/StreamingMarkdown.tsx needs to keep the
 * expensive markdown parse off the fully-accumulated buffer every frame.
 */

export interface RevealSplit {
  /** Safe committed slice, rendered (and memoized) as markdown. */
  prefix: string;
  /** In-flight remainder, re-parsed as markdown every frame. Never contains
   *  a newline for the markdown splitter; may contain them for the plain one. */
  tail: string;
  /** Absolute character offset of `tail` in the full text. */
  tailOffset: number;
  /** True when the tail starts a new paragraph (blank line before it) — the
   *  tail then owns a paragraph-sized top gap instead of a line-sized one. */
  paragraphGap: boolean;
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 10 || code === 9 || code === 13;
}

/** ```/~~~ fence-opening or -closing line? Returns the fence character so an
 *  opener of one kind cannot be closed by the other. */
function fenceLineChar(text: string, start: number, end: number): "`" | "~" | null {
  let i = start;
  // CommonMark allows up to three leading spaces before a fence.
  while (i < end && text[i] === " " && i - start < 4) i++;
  if (i - start > 3) return null;
  const c = text[i];
  if (c !== "`" && c !== "~") return null;
  return text[i + 1] === c && text[i + 2] === c ? c : null;
}

/**
 * Split streamed markdown into a committed prefix and an animated tail.
 *
 * The boundary is the last newline outside any code fence, so the tail is
 * always the current line in flight (prose paragraph, list item, quote
 * line). Fenced code collapses to prefix-only — code as a live tail would
 * show literal backticks and lose the block styling. This is a deliberate
 * simplification over mapping the markdown AST's trailing text nodes back to
 * source offsets through remark/rehype transforms, which shift retroactively
 * while inline constructs close. The cost of this trade is that a line shows
 * literal inline markers (`**`, backticks) until it completes and migrates
 * into the prefix.
 */
export function splitMarkdownReveal(text: string): RevealSplit {
  let fence: "`" | "~" | null = null;
  let lastSafeNewline = -1;
  let i = 0;
  const n = text.length;
  while (i <= n) {
    const lineEnd = text.indexOf("\n", i);
    const end = lineEnd === -1 ? n : lineEnd;
    const f = fenceLineChar(text, i, end);
    if (f !== null) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
    }
    if (lineEnd === -1) break;
    // The newline ending a fence-opening line is inside the fence; the one
    // ending the closing line is back outside.
    if (fence === null) lastSafeNewline = lineEnd;
    i = lineEnd + 1;
  }

  const allPrefix: RevealSplit = { prefix: text, tail: "", tailOffset: n, paragraphGap: false };
  if (fence !== null) return allPrefix;
  const tailOffset = lastSafeNewline + 1;
  const tail = text.slice(tailOffset);
  if (tail.length === 0) return allPrefix;
  // A fence opener still missing its newline must not render as a live tail.
  if (fenceLineChar(tail, 0, tail.length) !== null) return allPrefix;
  return {
    prefix: text.slice(0, tailOffset),
    tail,
    tailOffset,
    paragraphGap: tailOffset >= 2 && text.charCodeAt(tailOffset - 2) === 10,
  };
}

/** Plain-text tails (thinking) have no markdown-safety constraint, so the
 *  boundary just slides to keep the last ~window of characters live, snapped
 *  forward to a word start so it never lands mid-word. */
const PLAIN_TAIL_WINDOW_CHARS = 160;

export function splitPlainReveal(text: string, windowChars: number = PLAIN_TAIL_WINDOW_CHARS): RevealSplit {
  const n = text.length;
  let idx = n - windowChars;
  if (idx < 0) idx = 0;
  while (idx > 0 && idx < n) {
    const atWordStart = isWhitespaceCode(text.charCodeAt(idx - 1)) && !isWhitespaceCode(text.charCodeAt(idx));
    if (atWordStart) break;
    idx++;
  }
  return { prefix: text.slice(0, idx), tail: text.slice(idx), tailOffset: idx, paragraphGap: false };
}
