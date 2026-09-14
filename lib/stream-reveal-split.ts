/**
 * Where a growing markdown buffer can be cut into a committed prefix
 * (rendered once, memoized) and a live tail (re-parsed every frame) WITHOUT
 * anything moving when the cut advances.
 *
 * The rule that makes it invisible: cut only at a BLOCK boundary — a blank
 * line outside any code fence. A block (paragraph, list, quote, heading,
 * fence) renders identically whether it is the tail or the last block of the
 * prefix, so when it commits nothing reflows. Cutting at an ordinary newline
 * (the previous design) put the second line of a paragraph in a separate
 * container until it committed, and every commit visibly re-wrapped text —
 * the jank the owner reported. Cost: the tail is a whole block, but a block
 * is a few hundred bytes and a parse of that per frame is nothing.
 */

export interface RevealSplit {
  /** Complete blocks, rendered (and memoized) as markdown. */
  prefix: string;
  /** The block still being written, re-parsed as markdown every frame. */
  tail: string;
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

export function splitMarkdownReveal(text: string): RevealSplit {
  let fence: "`" | "~" | null = null;
  let lastBlankLineEnd = -1;
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
    const blank = fence === null && text.slice(i, end).trim().length === 0;
    // A blank line outside a fence ends the block before it; everything up
    // to and including this newline is safe to commit. Consecutive blank
    // lines keep advancing the cut so the tail never begins with one.
    if (blank) lastBlankLineEnd = lineEnd;
    i = lineEnd + 1;
  }
  if (lastBlankLineEnd < 0) return { prefix: "", tail: text };
  const cut = lastBlankLineEnd + 1;
  return { prefix: text.slice(0, cut), tail: text.slice(cut) };
}
