import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSmartModelForAutomaticChange,
  clearSmartModelAfterManualSelection,
  clearSmartModelAfterThinkingLevelChange,
  parseSmartModelProvenance,
  resolveSmartModel,
  smartModelForSession,
} from "./session-model-provenance.ts";

test("an explicitly Smart session remains Smart through its resolved fallback", () => {
  const spawned = parseSmartModelProvenance({ forSession: "smart-session" });
  const resolved = resolveSmartModel(spawned, "smart-session", { provider: "provider-a", modelId: "default" });
  const fallback = advanceSmartModelForAutomaticChange(resolved, "smart-session", { provider: "provider-b", modelId: "fallback" });

  assert.deepEqual(fallback, {
    forSession: "smart-session",
    provider: "provider-b",
    modelId: "fallback",
  });
});

test("a rejected manual selection preserves Smart provenance until a command succeeds", () => {
  const smart = {
    forSession: "smart-session",
    provider: "provider-a",
    modelId: "default",
  };

  assert.deepEqual(clearSmartModelAfterManualSelection(smart, "smart-session", false), smart);
  assert.equal(clearSmartModelAfterManualSelection(smart, "smart-session", true), null);
});

test("Smart provenance never follows an unrelated session", () => {
  const smart = {
    forSession: "smart-session",
    provider: "provider-a",
    modelId: "default",
  };

  assert.equal(smartModelForSession(smart, "other-session"), null);
  assert.deepEqual(
    advanceSmartModelForAutomaticChange(smart, "other-session", { provider: "provider-b", modelId: "fallback" }),
    smart,
  );
  assert.deepEqual(clearSmartModelAfterManualSelection(smart, "other-session", true), smart);
});

test("only a complete persisted record is accepted as Smart provenance", () => {
  assert.equal(parseSmartModelProvenance({ forSession: "old-session", provider: "provider-a" }), null);
  assert.equal(parseSmartModelProvenance({ forSession: "old-session", modelId: "default" }), null);
  assert.equal(parseSmartModelProvenance({ provider: "provider-a", modelId: "default" }), null);
  assert.deepEqual(
    parseSmartModelProvenance({ forSession: "smart-session", provider: "provider-a", modelId: "default" }),
    { forSession: "smart-session", provider: "provider-a", modelId: "default" },
  );
});

test("a manual reasoning-level pick clears Smart provenance exactly like a manual model pick", () => {
  const smart = { forSession: "smart-session", provider: "provider-a", modelId: "default" };
  assert.equal(clearSmartModelAfterThinkingLevelChange(smart, "smart-session", "manual", true), null);
});

test("a preset-driven reasoning-level change never clears Smart provenance, even when accepted", () => {
  const smart = { forSession: "smart-session", provider: "provider-a", modelId: "default" };
  assert.deepEqual(clearSmartModelAfterThinkingLevelChange(smart, "smart-session", "preset", true), smart);
});

test("a rejected manual reasoning-level pick preserves Smart provenance", () => {
  const smart = { forSession: "smart-session", provider: "provider-a", modelId: "default" };
  assert.deepEqual(clearSmartModelAfterThinkingLevelChange(smart, "smart-session", "manual", false), smart);
});

test("a reasoning-level change for an unrelated session never touches this session's Smart provenance", () => {
  const smart = { forSession: "smart-session", provider: "provider-a", modelId: "default" };
  assert.deepEqual(clearSmartModelAfterThinkingLevelChange(smart, "other-session", "manual", true), smart);
});
