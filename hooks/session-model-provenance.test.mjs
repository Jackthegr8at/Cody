import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceSmartModelForAutomaticChange,
  clearSmartModelAfterManualSelection,
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
