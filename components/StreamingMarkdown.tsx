import { memo, useMemo } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { splitMarkdownReveal, splitPlainReveal, type RevealSplit } from "@/lib/stream-reveal-split";
import { LiveDot } from "@/components/ui/LiveDot";

interface StreamingMarkdownProps {
  /** The full accumulated text. */
  text: string;
  /** True while the message is still being streamed. */
  streaming: boolean;
  /** True to render as plain text (thinking blocks); false for markdown. */
  plain?: boolean;
}

/**
 * Render streamed text with a stable committed prefix (memoized, re-rendered
 * only when prefix grows) and a live tail (re-parsed every frame but small).
 * When streaming ends, the live dot disappears and all text migrates to the
 * prefix on the next render (no flash, no animation — the tail just becomes
 * empty and the whole text is now the prefix).
 *
 * While streaming:
 * - Prefix: memoized MarkdownBody keyed on the prefix string (re-renders only
 *   when the prefix grows, which is infrequent as the splitter holds back text).
 * - Tail: MarkdownBody re-parsed every frame (small enough not to cause jank).
 * - Live dot: pulsating alpha 0.3->0.7, disabled under prefers-reduced-motion.
 *
 * When not streaming:
 * - Single MarkdownBody over the full text (no split, no dot).
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  streaming,
  plain = false,
}: StreamingMarkdownProps) {
  // Split into prefix and tail only while streaming. When streaming stops,
  // all text becomes prefix on the next render (tail becomes empty).
  const reveal = useMemo(() => {
    if (!streaming) return { prefix: text, tail: "", tailOffset: 0, paragraphGap: false } as RevealSplit;
    return plain ? splitPlainReveal(text) : splitMarkdownReveal(text);
  }, [text, streaming, plain]);

  if (!streaming) {
    // Streaming complete: render the whole text as a single markdown block.
    return <MarkdownBody>{text}</MarkdownBody>;
  }

  // While streaming: split into memoized prefix + live tail + dot.
  return (
    <div className="streaming-markdown-container">
      {reveal.prefix.length > 0 && (
        <PrefixContent prefix={reveal.prefix} plain={plain} />
      )}
      <div
        className="streaming-markdown-tail"
        style={{ minHeight: "var(--chat-line-height)" }}
      >
        <MarkdownBody>{reveal.tail}</MarkdownBody>
        <LiveDot />
      </div>
      {reveal.paragraphGap && <div style={{ height: "var(--chat-line-height)" }} />}
    </div>
  );
});

StreamingMarkdown.displayName = "StreamingMarkdown";

/** Memoized prefix renderer, keyed on the prefix string so it only re-renders
 *  when the prefix text actually changes. */
const PrefixContent = memo(function PrefixContent({
  prefix,
  plain,
}: {
  prefix: string;
  plain?: boolean;
}) {
  return plain ? <div className="markdown-body">{prefix}</div> : <MarkdownBody>{prefix}</MarkdownBody>;
});

PrefixContent.displayName = "PrefixContent";
