import { memo, useMemo } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { splitMarkdownReveal } from "@/lib/stream-reveal-split";
import { LiveDot } from "@/components/ui/LiveDot";

interface StreamingMarkdownProps {
  /** The full accumulated text. */
  text: string;
  /** True while the block is still being streamed. */
  streaming: boolean;
  /** Plain text (thinking): no markdown, one pre-wrapped node. */
  plain?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

/**
 * Streamed text the way Zed renders it: every delta is appended at once and
 * the view repaints once per frame (the SSE coalescer is the only rate
 * limiter). Nothing is paced, faded or animated — the only motion is the
 * live dot at the end.
 *
 * Markdown: the buffer is cut at the last BLOCK boundary
 * (lib/stream-reveal-split.ts). The complete blocks render through a memoized
 * MarkdownBody keyed on their text — re-parsed only when a block commits —
 * and the in-flight block re-parses every frame. Because a block looks the
 * same on either side of the cut, a commit changes no pixels.
 *
 * Plain (thinking): a single `white-space: pre-wrap` text node. Updating a
 * text node costs nothing, so there is no split, no window and no reflow —
 * the text only ever grows at its end.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({ text, streaming, plain = false, cwd, onOpenFile }: StreamingMarkdownProps) {
  const reveal = useMemo(() => (streaming && !plain ? splitMarkdownReveal(text) : null), [text, streaming, plain]);

  if (plain) {
    return (
      <div className="markdown-body streaming-plain" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {text}
        {streaming && <LiveDot />}
      </div>
    );
  }
  if (!reveal) return <MarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody>;
  return (
    <>
      {reveal.prefix.length > 0 && <PrefixContent prefix={reveal.prefix} cwd={cwd} onOpenFile={onOpenFile} />}
      <div className="streaming-tail" style={{ minHeight: "var(--chat-line-height)" }}>
        <MarkdownBody isStreaming cwd={cwd} onOpenFile={onOpenFile}>{reveal.tail}</MarkdownBody>
        <LiveDot />
      </div>
    </>
  );
});

/** Memoized over the prefix STRING: a commit re-parses once, then never again. */
const PrefixContent = memo(function PrefixContent({ prefix, cwd, onOpenFile }: { prefix: string; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <MarkdownBody cwd={cwd} onOpenFile={onOpenFile}>{prefix}</MarkdownBody>;
});
