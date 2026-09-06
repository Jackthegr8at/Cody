import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { formatModelDisplayName } = await jiti.import("./model-display.ts");

test("formats GPT catalog slugs without changing their version or variant", () => {
  assert.equal(formatModelDisplayName("gpt-6-astra", "GPT-6-Astra"), "GPT-6 Astra");
  assert.equal(formatModelDisplayName("gpt-5.6-terra", "GPT-5.6-Terra"), "GPT-5.6 Terra");
  assert.equal(formatModelDisplayName("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"), "GPT-5.3 Codex Spark");
  assert.equal(formatModelDisplayName("gpt-6-astra-hd", "GPT-6-Astra-HD"), "GPT-6 Astra HD");
});

test("falls back to a complete GPT identifier when the catalog loses its variant", () => {
  assert.equal(formatModelDisplayName("gpt-5.4-mini", "GPT-5.4"), "GPT-5.4 Mini");
});

test("keeps a catalog GPT label when an identifier only adds a dated snapshot", () => {
  assert.equal(formatModelDisplayName("gpt-4.1-2025-04-14", "GPT-4.1"), "GPT-4.1");
});

test("formats GPT raw identifiers when catalog names are unavailable", () => {
  assert.equal(formatModelDisplayName("gpt-6-astra", null), "GPT-6 Astra");
  assert.equal(formatModelDisplayName("gpt-6-astra", ""), "GPT-6 Astra");
  assert.equal(formatModelDisplayName("openai/gpt-6-astra", null), "GPT-6 Astra");
  assert.equal(formatModelDisplayName("openai/gpt-6-astra", "GPT-6"), "GPT-6 Astra");
});

test("keeps complete catalog names and unrelated identifiers intact", () => {
  assert.equal(formatModelDisplayName("gpt-5.4-mini", "OpenAI GPT-5.4 Mini"), "OpenAI GPT-5.4 Mini");
  assert.equal(formatModelDisplayName("claude-opus-4-6", "Claude Opus 4.6"), "Claude Opus 4.6");
  assert.equal(formatModelDisplayName("gateway/deepseek-v3", null), "gateway/deepseek-v3");
});
