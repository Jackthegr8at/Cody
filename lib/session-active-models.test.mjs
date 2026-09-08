import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { deriveSessionActiveModels, parseResolvedSessionModel } = await jiti.import("./session-active-models.ts");

test("parses resolved model thinking suffixes without corrupting real :free ids", () => {
  assert.deepEqual(
    parseResolvedSessionModel("openai-codex/gpt-5.6-terra:high"),
    { provider: "openai-codex", modelId: "gpt-5.6-terra" },
  );
  assert.deepEqual(
    parseResolvedSessionModel("openrouter/deepseek/deepseek-r1:free"),
    { provider: "openrouter", modelId: "deepseek/deepseek-r1:free" },
  );
  assert.equal(parseResolvedSessionModel("model-without-provider"), null);
});

test("derives and deduplicates every model actually used by the current run", () => {
  const active = deriveSessionActiveModels({
    sessionId: "run-a",
    conversationLabel: "this conversation",
    liveModelMeta: { provider: "anthropic", modelId: "claude-fable-5" },
    smartPinnedModel: { forSession: "run-a", provider: "openai-codex", modelId: "gpt-5.6-terra" },
    subagents: [
      {
        id: "scout-id",
        agent: "scout",
        progress: {
          resolvedModel: "openrouter/deepseek/deepseek-r1:free",
          modelRole: "task",
          resolvedModelIsFallback: true,
        },
      },
      {
        id: "review-id",
        agent: "review",
        progress: { resolvedModel: "openai-codex/gpt-5.6-terra:high", modelRole: "task" },
      },
    ],
    autoModelSwitch: { to: "openai-codex/gpt-5.6-terra:high", role: "default", job: { kind: "main" } },
    messages: [
      { role: "assistant", provider: "anthropic", model: "claude-fable-5", content: [] },
      { role: "assistant", provider: "google", model: "gemini-3-pro", content: [] },
      { role: "assistant", provider: "anthropic", model: "claude-fable-5", content: [] },
      { role: "user", content: "ignored" },
    ],
  });

  assert.deepEqual(active, [
    {
      provider: "anthropic",
      modelId: "claude-fable-5",
      uses: [{ kind: "main", label: "this conversation" }],
    },
    {
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      uses: [
        { kind: "smart", label: "this conversation" },
        { kind: "subagent", label: "review (task)" },
        { kind: "fallback", label: "this conversation" },
      ],
    },
    {
      provider: "openrouter",
      modelId: "deepseek/deepseek-r1:free",
      uses: [{ kind: "fallback", label: "scout (task)" }],
    },
    {
      provider: "google",
      modelId: "gemini-3-pro",
      uses: [{ kind: "main", label: "this conversation" }],
    },
  ]);
});

test("does not borrow Smart provenance from another run", () => {
  const active = deriveSessionActiveModels({
    sessionId: "run-a",
    smartPinnedModel: { forSession: "run-b", provider: "anthropic", modelId: "claude-fable-5" },
    messages: [{ role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", content: [] }],
  });

  assert.deepEqual(active, [{
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    uses: [{ kind: "main", label: "this conversation" }],
  }]);
});
