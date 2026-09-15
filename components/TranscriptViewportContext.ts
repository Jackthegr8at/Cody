import { createContext, type RefObject } from "react";
import type { TranscriptAnchor } from "@/lib/transcript-anchor";

/**
 * What the transcript's scroller knows about its reader, for blocks deep in
 * the tree that must not move the reader themselves. Refs, not state: the
 * values change on every scroll event and nothing should re-render for that.
 */
export interface TranscriptViewport {
  /** True while the viewport is pinned to the live tail; false once the user scrolled up. */
  followingRef: RefObject<boolean>;
  /** What a scrolled-up reader is anchored on (lib/transcript-anchor); null while following. */
  anchorRef: RefObject<TranscriptAnchor | null>;
}

export const TranscriptViewportContext = createContext<TranscriptViewport | null>(null);
