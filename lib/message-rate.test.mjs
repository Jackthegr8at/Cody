import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { messageTokenRate, estimateTokensPerSecond, estimateTokensFromChars, MIN_RATE_OUTPUT_TOKENS } = await jiti.import("./message-rate.ts");

// Real fields off a live omp session file: timestamp is the request START,
// completedAt the end, duration the measured request span, ttft the wait for
// the first token. The rate a reader sees must be output/duration, which is
// what the engine reports for the same message.
const REAL = { usage: { output: 493 }, timestamp: 1789695138571, completedAt: 1789695144051, duration: 5469.39, ttft: 1543 };

test("the measured rate is the provider's output count over the engine's duration", () => {
  const rate = messageTokenRate(REAL);
  assert.equal(rate.outputTokens, 493);
  assert.equal(Math.round(rate.tokensPerSecond * 10) / 10, 90.1);
  assert.equal(rate.ttftMs, 1543);
  assert.equal(rate.live, false);
});

test("the decode rate excludes the wait for the first token", () => {
  const rate = messageTokenRate(REAL);
  // 493 tokens over 5469ms is 90.1 t/s; over the 3926ms after ttft it is 125.6.
  assert.equal(Math.round(rate.decodeTokensPerSecond * 10) / 10, 125.6);
  // Without a ttft there is nothing to subtract, so no decode rate is claimed.
  assert.equal(messageTokenRate({ ...REAL, ttft: undefined }).decodeTokensPerSecond, undefined);
});

test("a reply too short to measure throughput is left without a rate", () => {
  // Measured live: a four-token "ok" whose 1.7s was almost entirely the wait
  // for the provider computed to 2.3 t/s and wore the slowest colour.
  const tiny = messageTokenRate({ usage: { output: 4 }, duration: 1_700, ttft: 1_600 });
  assert.ok(tiny.outputTokens < MIN_RATE_OUTPUT_TOKENS, "the guard is what suppresses it, not the arithmetic");
  assert.ok(messageTokenRate(REAL).outputTokens >= MIN_RATE_OUTPUT_TOKENS);
});

test("an engine that reports only the endpoints still yields a measured rate", () => {
  const { duration, ttft, ...endpointsOnly } = REAL;
  const rate = messageTokenRate(endpointsOnly);
  // completedAt - timestamp = 5480ms, not the 5469 omp measured: close, and
  // honest, which is the point of preferring `duration` when it exists.
  assert.equal(rate.durationMs, 5480);
  assert.equal(rate.ttftMs, undefined);
});

test("no output count means no rate — never a zero and never a guess", () => {
  assert.equal(messageTokenRate({ ...REAL, usage: { output: 0 } }), null);
  assert.equal(messageTokenRate({ ...REAL, usage: undefined }), null);
  assert.equal(messageTokenRate(null), null);
});

test("a streaming message may be timed from its start, but only when asked", () => {
  const started = { usage: { output: 120 }, timestamp: 10_000 };
  assert.equal(messageTokenRate(started, false, 14_000), null);
  const live = messageTokenRate(started, true, 14_000);
  assert.equal(live.tokensPerSecond, 30);
  assert.equal(live.live, true);
});

test("a sub-100ms window is noise, not a rate", () => {
  assert.equal(messageTokenRate({ usage: { output: 5 }, duration: 40 }), null);
});

test("the estimate needs a real window and reports the chars/4 heuristic", () => {
  assert.equal(estimateTokensFromChars(400), 100);
  assert.equal(estimateTokensPerSecond(400, 400), null); // window too short to mean anything
  assert.equal(estimateTokensPerSecond(400, 2_000), 50);
  assert.equal(estimateTokensPerSecond(0, 5_000), null);
});
