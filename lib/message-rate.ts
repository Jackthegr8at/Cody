/**
 * Output-token throughput for one assistant message.
 *
 * Two sources, and the difference matters to anyone reading the badge:
 *
 * - MEASURED (`messageTokenRate`): the provider's own output-token count over
 *   the request's own measured duration — the same arithmetic the engine does
 *   for its status line (`utils/token-rate.ts` in omp: `output * 1000 /
 *   duration`, a 100 ms floor). omp records `duration`/`ttft`/`completedAt` on
 *   every assistant message it writes, and sends them on `message_end`, so
 *   Cody can compute the identical number without waiting for a state poll.
 * - ESTIMATED (`estimateTokensFromChars`): `chars / 4`, used only while a
 *   message streams and no output count exists yet. It is a fixed heuristic,
 *   not a tokenizer: roughly right for English prose, and understated by ~3x
 *   for CJK (~1 char/token) and somewhat for dense code. Anything rendered
 *   from it MUST be marked as an estimate.
 *
 * Both live here so the two are never confused at a call site, and so the
 * heuristic has exactly one definition.
 */

/** Engine-reported timing fields on an assistant message. Every one is
 * optional: only omp records them today, and an older session file predates
 * them. */
export interface MessageTimingFields {
  usage?: { output?: number } | null;
  /** Total request duration in ms (queue + prefill + decode). */
  duration?: number;
  /** Time to first token in ms. */
  ttft?: number;
  /** Request start, ms since epoch. */
  timestamp?: number;
  /** Request completion, ms since epoch. */
  completedAt?: number;
}

export interface MeasuredTokenRate {
  /** Output tokens per second over the whole request. */
  tokensPerSecond: number;
  /** Provider-reported output tokens. */
  outputTokens: number;
  /** Duration the rate was measured over, ms. */
  durationMs: number;
  /** Time to first token, ms — absent when the engine did not report it. */
  ttftMs?: number;
  /** Output tokens per second AFTER the first token, i.e. with the wait for
   * the provider excluded. Absent without a ttft to subtract. */
  decodeTokensPerSecond?: number;
  /** True while the message is still streaming, so the duration is
   * now-minus-start and the rate is still moving. */
  live: boolean;
}

/** Durations below this are noise, not a rate. Matches the engine's floor. */
const MIN_DURATION_MS = 100;

/**
 * Below this many output tokens the whole-request rate measures LATENCY, not
 * throughput: a four-token "ok" that took 1.7s — nearly all of it waiting for
 * the provider — computes to 2.3 t/s and would wear the slowest colour on a
 * model that is not slow at all. Measured on a live turn; a reply this short
 * gets no rate at all rather than a misleading one.
 */
export const MIN_RATE_OUTPUT_TOKENS = 48;

/** Characters per token for the streaming estimate. */
const CHARS_PER_TOKEN = 4;

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The measured rate for one assistant message, or null when the ingredients
 * are missing (no output count, no usable duration, still under the floor).
 *
 * A settled message uses the engine's `duration`, falling back to
 * `completedAt - timestamp` for an engine that records only the endpoints. A
 * streaming one (`isStreaming`) may use `now - timestamp`, which is what makes
 * the badge honest mid-reply for a provider that streams its usage; a provider
 * that only reports output tokens at the end simply yields null until then.
 */
export function messageTokenRate(
  message: MessageTimingFields | null | undefined,
  isStreaming = false,
  nowMs: number = Date.now(),
): MeasuredTokenRate | null {
  if (!message) return null;
  const outputTokens = finitePositive(message.usage?.output);
  if (outputTokens === null) return null;

  const reported = finitePositive(message.duration);
  const start = finitePositive(message.timestamp);
  const completed = finitePositive(message.completedAt);
  const fromEndpoints = start !== null && completed !== null && completed > start ? completed - start : null;
  const live = reported === null && fromEndpoints === null;
  const durationMs = reported ?? fromEndpoints ?? (isStreaming && start !== null ? nowMs - start : null);
  if (durationMs === null || durationMs < MIN_DURATION_MS) return null;

  const tokensPerSecond = (outputTokens * 1000) / durationMs;
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;

  const ttftMs = finitePositive(message.ttft);
  // Decode-only rate: what the model sustained once it started emitting. The
  // whole-request number stays the headline (it is what the engine reports,
  // and it is the one a user actually waited through), but a long wait for the
  // first token is worth being able to see rather than having it silently
  // averaged into "the model is slow".
  const decodeMs = ttftMs !== null && durationMs - ttftMs >= MIN_DURATION_MS ? durationMs - ttftMs : null;
  return {
    tokensPerSecond,
    outputTokens,
    durationMs,
    ...(ttftMs === null ? {} : { ttftMs }),
    ...(decodeMs === null ? {} : { decodeTokensPerSecond: (outputTokens * 1000) / decodeMs }),
    live,
  };
}

/** The streaming estimate's token count. Marked as an estimate wherever shown. */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** The streaming estimate's rate, or null before the window is long enough to
 * mean anything. `elapsedMs` is wall clock since the first content arrived, so
 * this is a cumulative average and every pause (a tool call, a stall) pulls it
 * down — another reason it is only ever shown as an estimate. */
export function estimateTokensPerSecond(chars: number, elapsedMs: number): number | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 500) return null;
  const tokens = estimateTokensFromChars(chars);
  if (tokens <= 0) return null;
  const rate = (tokens * 1000) / elapsedMs;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Shared speed tiers for the badge's colour. */
export function tokenRateTier(tokensPerSecond: number): "success" | "renamed" | "warning" | "error" {
  if (tokensPerSecond >= 50) return "success";
  if (tokensPerSecond >= 30) return "renamed";
  if (tokensPerSecond >= 15) return "warning";
  return "error";
}
