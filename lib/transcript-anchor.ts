/**
 * The reader anchor: what a scrolled-up reader is looking at, named by
 * transcript IDENTITY rather than by DOM node.
 *
 * A transcript row is remounted at three moments — a `message_end` swaps the
 * streaming bubble for a committed row, a run's end folds the turn into a
 * process group, and the terminal reload re-keys every tail row from its
 * index to its entry id. Browser scroll anchoring holds a DOM node, so it lets
 * go at each of those moments (and Safari has none at all). This anchor is
 * addressed by `data-turn-index` (a message's position in the transcript; the
 * streaming tail carries the index it will have once committed), an optional
 * `data-turn-part` (one slice of a message: its process blocks, its answer, or
 * the group folding a turn), and `data-block-index` (a content block inside
 * an assistant message), so the same content can be found again after any
 * remount and put back at the same offset from the container's top edge.
 */
export interface TranscriptAnchor {
  turnIndex: number;
  part: string | null;
  blockIndex: number | null;
  /** Top of the anchored element relative to the container's top edge; negative when the edge is inside it. */
  offset: number;
  /** Top of the turn row relative to the container's top edge — the fallback when the block is gone. */
  turnOffset: number;
  /** Height of the anchored element at capture: tells a remounted collapsible whether it was open. */
  height: number;
}

export interface AnchorBox {
  top: number;
  bottom: number;
}

/**
 * Pick the box the container's top edge is looking at. Boxes come in document
 * order and may nest (a process group contains its rows), so the LAST box
 * containing the edge is the innermost one. When no box contains the edge (a
 * gap between rows, or the edge above every box), the first box below it is
 * the nearest content the reader can see.
 */
export function selectAnchorBox<T extends AnchorBox>(boxes: readonly T[], edge: number): T | null {
  let containing: T | null = null;
  let firstBelow: T | null = null;
  for (const box of boxes) {
    if (box.top <= edge && box.bottom > edge) containing = box;
    else if (box.top > edge && firstBelow === null) firstBelow = box;
  }
  return containing ?? firstBelow;
}

const TURN_SELECTOR = "[data-turn-index]";
const BLOCK_SELECTOR = "[data-block-index]";

function readIndex(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function boxOf(element: HTMLElement, containerTop: number): { top: number; bottom: number; element: HTMLElement } {
  const rect = element.getBoundingClientRect();
  return { top: rect.top - containerTop, bottom: rect.bottom - containerTop, element };
}

/** Snapshot what sits at the container's top edge right now. */
export function captureTranscriptAnchor(container: HTMLElement): TranscriptAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const turns = Array.from(container.querySelectorAll<HTMLElement>(TURN_SELECTOR), (el) => boxOf(el, containerTop));
  const turn = selectAnchorBox(turns, 0);
  if (!turn) return null;
  const turnIndex = readIndex(turn.element.dataset.turnIndex);
  if (turnIndex === null) return null;
  // Only this row's own blocks: a group row contains its inner rows' blocks
  // too, but an inner row that contained the edge was already preferred.
  const blocks = Array.from(turn.element.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
    .filter((el) => el.closest(TURN_SELECTOR) === turn.element)
    .map((el) => boxOf(el, containerTop));
  const block = selectAnchorBox(blocks, 0);
  const target = block ?? turn;
  return {
    turnIndex,
    part: turn.element.dataset.turnPart ?? null,
    blockIndex: block ? readIndex(block.element.dataset.blockIndex) : null,
    offset: target.top,
    turnOffset: turn.top,
    height: target.bottom - target.top,
  };
}

function findTurn(container: HTMLElement, anchor: TranscriptAnchor): HTMLElement | null {
  for (const el of container.querySelectorAll<HTMLElement>(`[data-turn-index="${anchor.turnIndex}"]`)) {
    if ((el.dataset.turnPart ?? null) === anchor.part) return el;
  }
  return null;
}

/**
 * Put the anchored content back where it was. Returns the scroll delta that
 * was applied (0 when nothing needed to move or the content is gone).
 */
export function restoreTranscriptAnchor(container: HTMLElement, anchor: TranscriptAnchor): number {
  const turn = findTurn(container, anchor);
  if (!turn) return 0;
  let target: HTMLElement = turn;
  let offset = anchor.turnOffset;
  if (anchor.blockIndex !== null) {
    const block = Array.from(turn.querySelectorAll<HTMLElement>(`[data-block-index="${anchor.blockIndex}"]`))
      .find((el) => el.closest(TURN_SELECTOR) === turn);
    if (block) {
      target = block;
      offset = anchor.offset;
    }
  }
  const delta = (target.getBoundingClientRect().top - container.getBoundingClientRect().top) - offset;
  if (Math.abs(delta) <= 0.5) return 0;
  const before = container.scrollTop;
  container.scrollTop = before + delta;
  return container.scrollTop - before;
}

/** True when the anchor names this block and the reader's edge was inside an OPEN box (taller than a collapsed header). */
export function anchorIsInsideOpenBlock(anchor: TranscriptAnchor | null, turnIndex: number, blockIndex: number, collapsedHeight: number): boolean {
  if (!anchor || anchor.turnIndex !== turnIndex || anchor.blockIndex !== blockIndex) return false;
  return anchor.height > collapsedHeight;
}
