import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// jiti (not a plain import) because session-preset-state.ts imports
// lib/model-plan/derive.ts, a relative import a plain node
// --experimental-strip-types run can't resolve without an extension — the
// same reason hooks/session-control-scope.test.mjs and
// hooks/fallback-reason.test.mjs already load their module through jiti.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  defaultPresetId,
  formatSmartTriggerLabel,
  newSessionSpawnPlan,
  nextPendingPresetPick,
} = await jiti.import("./session-preset-state.ts");

test("formatSmartTriggerLabel appends the preset name only when one is bound", () => {
  assert.equal(formatSmartTriggerLabel("Smart", "High"), "Smart \u00b7 High");
  assert.equal(formatSmartTriggerLabel("Smart", null), "Smart");
  assert.equal(formatSmartTriggerLabel("Smart", undefined), "Smart");
});

test("nextPendingPresetPick holds a pick that differs from what is actually running", () => {
  const picked = { presetId: "low", name: "Low" };
  assert.deepEqual(nextPendingPresetPick(picked, "high"), picked);
  assert.deepEqual(nextPendingPresetPick(picked, null), picked);
});

test("nextPendingPresetPick cancels a pick that matches the chat's actual running preset", () => {
  assert.equal(nextPendingPresetPick({ presetId: "high", name: "High" }, "high"), null);
  // Base settings is a pick too: re-picking it while it is what's running cancels.
  assert.equal(nextPendingPresetPick({ presetId: null, name: "Base settings" }, null), null);
});

test("nextPendingPresetPick lets a newer pick replace an older held one", () => {
  const stillPending = nextPendingPresetPick({ presetId: "low", name: "Low" }, "high");
  const replaced = nextPendingPresetPick({ presetId: "medium", name: "Medium" }, "high");
  assert.notDeepEqual(stillPending, replaced);
  assert.deepEqual(replaced, { presetId: "medium", name: "Medium" });
});

test("defaultPresetId omits the field until the preset list has actually loaded", () => {
  assert.equal(defaultPresetId(false, undefined, "high"), undefined);
  // Even a genuine explicit pick waits for the list — there is nothing to
  // validate the id against yet, and the caller has not offered one anyway
  // until the list rendered.
  assert.equal(defaultPresetId(false, "high", null), "high");
});

test("defaultPresetId prefers an explicit pick, including an explicit Base settings null, over the list default", () => {
  assert.equal(defaultPresetId(true, "medium", "high"), "medium");
  assert.equal(defaultPresetId(true, null, "high"), null);
});

test("defaultPresetId falls back to the list's lastUsedPresetId once loaded with no explicit pick", () => {
  assert.equal(defaultPresetId(true, undefined, "high"), "high");
  assert.equal(defaultPresetId(true, undefined, null), null);
});

test("newSessionSpawnPlan omits provider/modelId and thinkingLevel for a Smart spawn onto a real preset", () => {
  const plan = newSessionSpawnPlan({ modelPicked: false, localOnly: false, manualLevelPicked: false, presetId: "max" });
  assert.equal(plan.smartSpawn, true);
  assert.equal(plan.sendModel, false);
  assert.equal(plan.sendThinkingLevel, false);
  assert.equal(plan.sendPresetId, true);
});

test("newSessionSpawnPlan sends provider/modelId and thinkingLevel as usual for a Base-settings Smart spawn", () => {
  const plan = newSessionSpawnPlan({ modelPicked: false, localOnly: false, manualLevelPicked: false, presetId: null });
  assert.equal(plan.smartSpawn, true);
  assert.equal(plan.sendModel, true);
  assert.equal(plan.sendThinkingLevel, true);
  assert.equal(plan.sendPresetId, true);
});

test("newSessionSpawnPlan treats an unloaded preset list like Base settings for the model fields", () => {
  const plan = newSessionSpawnPlan({ modelPicked: false, localOnly: false, manualLevelPicked: false, presetId: undefined });
  assert.equal(plan.smartSpawn, true);
  assert.equal(plan.sendModel, true);
  assert.equal(plan.sendThinkingLevel, true);
});

test("newSessionSpawnPlan leaves Smart and drops the preset entirely for a manual pre-spawn reasoning-level pick", () => {
  const plan = newSessionSpawnPlan({ modelPicked: false, localOnly: false, manualLevelPicked: true, presetId: "max" });
  assert.equal(plan.smartSpawn, false);
  assert.equal(plan.sendModel, true);
  assert.equal(plan.sendThinkingLevel, true);
  assert.equal(plan.sendPresetId, false);
});

test("newSessionSpawnPlan keeps an explicit pre-spawn model pick's own preset bound for its subagents", () => {
  const plan = newSessionSpawnPlan({ modelPicked: true, localOnly: false, manualLevelPicked: false, presetId: "max" });
  assert.equal(plan.smartSpawn, false);
  assert.equal(plan.sendModel, true);
  assert.equal(plan.sendThinkingLevel, true);
  assert.equal(plan.sendPresetId, true);
});

test("newSessionSpawnPlan is never Smart while Local-only routing is active, even with a preset bound", () => {
  const plan = newSessionSpawnPlan({ modelPicked: false, localOnly: true, manualLevelPicked: false, presetId: "max" });
  assert.equal(plan.smartSpawn, false);
  assert.equal(plan.sendModel, true);
  assert.equal(plan.sendPresetId, true);
});
