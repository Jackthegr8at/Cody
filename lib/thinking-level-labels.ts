/**
 * The one mapping from an engine reasoning level (the raw wire value:
 * "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max") to its
 * display label. The composer's selector, the pending "Applying …" status,
 * the chat-stream notices and the subagent surfaces must all spell a level
 * the same way, so none of them may format the raw value on its own.
 */
const THINKING_LEVEL_LABEL_KEYS: Record<string, string> = {
  auto: "chatInput.reasoningLevelAuto",
  off: "chatInput.reasoningLevelOff",
  minimal: "chatInput.reasoningLevelMinimal",
  low: "chatInput.reasoningLevelLow",
  medium: "chatInput.reasoningLevelMedium",
  high: "chatInput.reasoningLevelHigh",
  xhigh: "chatInput.reasoningLevelXhigh",
  max: "chatInput.reasoningLevelMax",
};

/** Display label for a reasoning level. An absent level is the composer's
 *  Auto (the hook normalizes "inherit"/undefined the same way); a level this
 *  build has no label for is shown verbatim rather than claimed to be Auto. */
export function thinkingLevelLabel(level: string | null | undefined, t: (key: string) => string): string {
  const resolved = level ?? "auto";
  const key = THINKING_LEVEL_LABEL_KEYS[resolved];
  return key ? t(key) : resolved;
}
