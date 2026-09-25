import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { diffPresetProposal } = await jiti.import("./proposal.ts");

// The "apply to <preset>" confirm dialog needs to say exactly what a
// research proposal would change, not a blanket "this overwrites
// everything" — which would be equally (and uselessly) true for a preset
// that has nothing configured yet.

function preset(overrides) {
  return { roles: {}, chains: {}, usageAwareFallback: undefined, ...overrides };
}

test("a blank preset diffs every proposed role and chain as new", () => {
  const diff = diffPresetProposal(preset({}), {
    roles: { default: "openai-codex/gpt-6-sol:high", smol: "anthropic/claude-mini" },
    chains: { default: ["anthropic/claude-x"] },
    usageAwareFallback: true,
    rationale: [],
    warnings: [],
  });
  assert.deepEqual(diff.roles, [
    { role: "default", before: "", after: "openai-codex/gpt-6-sol:high" },
    { role: "smol", before: "", after: "anthropic/claude-mini" },
  ]);
  assert.deepEqual(diff.chainsChanged, ["default"]);
  assert.equal(diff.usageAwareChanged, true, "undefined (inherit) vs true differs");
});

test("only roles and chains that actually differ are reported, sorted by key", () => {
  const current = preset({
    roles: { default: "openai-codex/gpt-6-sol:high", task: "anthropic/claude-mini" },
    chains: { default: ["anthropic/claude-x"], smol: ["anthropic/claude-mini"] },
    usageAwareFallback: true,
  });
  const diff = diffPresetProposal(current, {
    roles: { default: "openai-codex/gpt-6-sol:high", task: "anthropic/claude-x" },
    chains: { default: ["anthropic/claude-x"], smol: ["anthropic/claude-x"] },
    usageAwareFallback: true,
    rationale: [],
    warnings: [],
  });
  assert.deepEqual(diff.roles, [{ role: "task", before: "anthropic/claude-mini", after: "anthropic/claude-x" }]);
  assert.deepEqual(diff.chainsChanged, ["smol"]);
  assert.equal(diff.usageAwareChanged, false);
});

test("a chain that is merely reordered or extended still counts as changed", () => {
  const current = preset({ chains: { default: ["a/1", "a/2"] } });
  assert.deepEqual(diffPresetProposal(current, { roles: {}, chains: { default: ["a/2", "a/1"] }, usageAwareFallback: false, rationale: [], warnings: [] }).chainsChanged, ["default"]);
  assert.deepEqual(diffPresetProposal(current, { roles: {}, chains: { default: ["a/1", "a/2", "a/3"] }, usageAwareFallback: false, rationale: [], warnings: [] }).chainsChanged, ["default"]);
  assert.deepEqual(diffPresetProposal(current, { roles: {}, chains: { default: ["a/1", "a/2"] }, usageAwareFallback: false, rationale: [], warnings: [] }).chainsChanged, [], "identical entries in the same order do not count");
});

test("an identical proposal diffs as nothing changed", () => {
  const current = preset({
    roles: { default: "openai-codex/gpt-6-sol:high" },
    chains: { default: ["anthropic/claude-x"] },
    usageAwareFallback: true,
  });
  const diff = diffPresetProposal(current, {
    roles: { default: "openai-codex/gpt-6-sol:high" },
    chains: { default: ["anthropic/claude-x"] },
    usageAwareFallback: true,
    rationale: [],
    warnings: [],
  });
  assert.deepEqual(diff, { roles: [], chainsChanged: [], usageAwareChanged: false });
});
