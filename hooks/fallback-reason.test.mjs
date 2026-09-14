import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The refusal/quota distinction decides which sentence a user reads when the
 * engine swaps models, and the two call for opposite actions: a quota resolves
 * itself at the reset, while a refusal is pinned for the session and only a
 * manual re-pick undoes it. Calling a refusal a "usage limit" sends the user
 * to inspect a quota that is perfectly healthy — the observed confusion this
 * classifier exists to end.
 */
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { classifyFallbackReason } = await jiti.import("./session-control-scope.ts");

test("a provider classifier refusal is read as a refusal", () => {
  // Shaped like the real thing — the prefix and the `reasoning_extraction`
  // tag are what the classifier keys on — but deliberately NOT the provider's
  // full policy sentence. Reproducing that sentence verbatim in a tracked
  // file was itself a hazard: this repo's AGENTS.md and any retained
  // transcript are injected into later prompts, and the wording tripped the
  // very safety classifier it describes, bouncing sessions off the model
  // before they began. Test the shape, never the exact blurb.
  const message = "Refusal (reasoning_extraction): this request was blocked by the provider's policy check.";
  assert.equal(classifyFallbackReason(message), "refusal");
});

test("omp's sensitive stop detail is a refusal too", () => {
  assert.equal(classifyFallbackReason("stream ended: sensitive"), "refusal");
});

test("quota and rate-limit failures are read as usage", () => {
  for (const message of [
    "429 Too Many Requests",
    "GoUsageLimitError: weekly usage limit reached",
    "provider returned rate-limit; retry after 900s",
    "OpenRouter: out of credits ($0.11 left)",
  ]) {
    assert.equal(classifyFallbackReason(message), "usage", message);
  }
});
test("a message matching BOTH classes is read as a refusal", () => {
  // omp wraps the provider error with transport context, so one string can
  // carry a refusal AND limit wording. Refusal must win: mislabelling it
  // "usage limit" sends the user to inspect a healthy quota, while the real
  // fix is a manual re-pick.
  const message =
    "Refusal (reasoning_extraction): this request was blocked; provider also reported rate-limit backoff";
  assert.equal(classifyFallbackReason(message), "refusal");
});

test("an unrecognized error stays unclassified so the raw text is shown", () => {
  assert.equal(classifyFallbackReason("ECONNRESET while reading the response stream"), null);
  assert.equal(classifyFallbackReason(undefined), null);
  assert.equal(classifyFallbackReason(""), null);
});
