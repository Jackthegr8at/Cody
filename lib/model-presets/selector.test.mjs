import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { INHERIT, splitPresetSelector, joinPresetSelector, parsePresetSelector } = await jiti.import("./selector.ts");

// The preset editor's role and chain-entry pickers both split a stored
// selector into a model Select value and a level Select value, then join
// them back on every edit. These pin the same dialect `ModelRoles` and
// `lib/model-plan/derive.ts` already use: a trailing colon is only a level
// when OMP would recognize it, and an id that is itself a known selector
// (colon and all) is never split.

test("splits a recognized level off the end, and leaves the model whole otherwise", () => {
  assert.deepEqual(splitPresetSelector("openai-codex/gpt-6-sol:high", new Set()), { model: "openai-codex/gpt-6-sol", level: "high" });
  assert.deepEqual(splitPresetSelector("anthropic/claude-x", new Set()), { model: "anthropic/claude-x", level: "" });
  assert.deepEqual(splitPresetSelector("", new Set()), { model: "", level: "" });
});

test("a colon inside a known model id is never mistaken for a level", () => {
  const known = new Set(["ollama/qwen3:8b"]);
  assert.deepEqual(splitPresetSelector("ollama/qwen3:8b", known), { model: "ollama/qwen3:8b", level: "" });
  // Unknown to the roster, but the suffix is not a recognized level either:
  // the colon stays part of the id rather than becoming a bogus level.
  assert.deepEqual(splitPresetSelector("openrouter/qwen/qwen3-coder:free", new Set()), { model: "openrouter/qwen/qwen3-coder:free", level: "" });
});

test("joinPresetSelector is the exact inverse, and an empty model always joins to inherit", () => {
  assert.equal(joinPresetSelector("openai-codex/gpt-6-sol", "high"), "openai-codex/gpt-6-sol:high");
  assert.equal(joinPresetSelector("anthropic/claude-x", ""), "anthropic/claude-x");
  assert.equal(joinPresetSelector("", "high"), INHERIT);
  assert.equal(joinPresetSelector("", ""), INHERIT);
});

test("round-trips through split and join", () => {
  for (const selector of ["openai-codex/gpt-6-sol:high", "anthropic/claude-x", "ollama/qwen3:8b"]) {
    const known = new Set(["ollama/qwen3:8b"]);
    const { model, level } = splitPresetSelector(selector, known);
    assert.equal(joinPresetSelector(model, level), selector);
  }
});

// The routing parser: what Smart resolves to on the server and what the
// composer shows as a preset's hint come from this one function.
test("parsePresetSelector splits a recognized reasoning suffix off the model id", () => {
  assert.deepEqual(parsePresetSelector("openai-codex/gpt-6-luna:low"), {
    provider: "openai-codex",
    modelId: "gpt-6-luna",
    thinkingLevel: "low",
  });
});

test("parsePresetSelector keeps a model id's own colon when the suffix is not a reasoning level", () => {
  // qwen3:8b — "8b" is not a recognized effort, so the whole thing is the id.
  assert.deepEqual(parsePresetSelector("local/qwen3:8b"), {
    provider: "local",
    modelId: "qwen3:8b",
    thinkingLevel: null,
  });
});

test("parsePresetSelector accepts a bare selector with no level suffix", () => {
  assert.deepEqual(parsePresetSelector("anthropic/claude-fable-5"), {
    provider: "anthropic",
    modelId: "claude-fable-5",
    thinkingLevel: null,
  });
});

test("parsePresetSelector rejects a selector with no provider", () => {
  assert.equal(parsePresetSelector("no-slash-here"), null);
  assert.equal(parsePresetSelector("/missing-provider"), null);
  assert.equal(parsePresetSelector("trailing-slash/"), null);
});
