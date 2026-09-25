import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { describeRoleSelector, researchStampSummary, displayNameForModel } = await jiti.import("./summary.ts");

const MODELS = [
  { provider: "openai-codex", id: "solstice-large", name: "Solstice Large" },
  { provider: "anthropic", id: "claude-mini", name: "Claude Mini" },
];
const KNOWN = new Set(MODELS.map((model) => `${model.provider}/${model.id}`));
const FIXED_DATE = (iso) => `on ${iso.slice(0, 10)}`;

// `t` is injected (never imported from lib/i18n) so these stay plain
// functions a node test can call without React — this fake renders the key
// and its vars instead of real English/Japanese/Chinese, which is enough to
// pin WHICH key a case resolves to and what it was handed to interpolate.
const fakeT = (key, vars) => (vars ? `[${key} ${JSON.stringify(vars)}]` : `[${key}]`);

test("displayNameForModel resolves a catalog name, and falls back to the bare selector", () => {
  assert.equal(displayNameForModel("openai-codex/solstice-large", MODELS), "Solstice Large");
  assert.equal(displayNameForModel("openai-codex/unknown-model", MODELS), "openai-codex/unknown-model");
  assert.equal(displayNameForModel("not-a-selector", MODELS), "not-a-selector");
});

test("describeRoleSelector prefers the preset's own selector, level and all — untranslated, since it is just a model name", () => {
  assert.equal(describeRoleSelector("openai-codex/solstice-large:high", "anthropic/claude-mini", MODELS, KNOWN, fakeT), "Solstice Large · high");
  assert.equal(describeRoleSelector("anthropic/claude-mini", undefined, MODELS, KNOWN, fakeT), "Claude Mini");
});

test("describeRoleSelector falls back to the inherited base selector, then to nothing set — both through t()", () => {
  assert.equal(describeRoleSelector(undefined, "openai-codex/solstice-large:high", MODELS, KNOWN, fakeT), '[presets.inheritsBase {"model":"Solstice Large · high"}]');
  assert.equal(describeRoleSelector("", "anthropic/claude-mini", MODELS, KNOWN, fakeT), '[presets.inheritsBase {"model":"Claude Mini"}]');
  assert.equal(describeRoleSelector(undefined, undefined, MODELS, KNOWN, fakeT), "[presets.noDefaultModel]");
  assert.equal(describeRoleSelector("", "", MODELS, KNOWN, fakeT), "[presets.noDefaultModel]");
});

test("researchStampSummary names the planner and the (injected) formatted date through t(), or says nothing yet", () => {
  assert.equal(researchStampSummary(undefined, MODELS, KNOWN, FIXED_DATE, fakeT), "[presets.notConfiguredYet]");
  const stamp = { runId: "r1", plannerModel: "openai-codex/solstice-large:high", completedAt: "2026-09-20T10:00:00.000Z", rationale: [] };
  assert.equal(researchStampSummary(stamp, MODELS, KNOWN, FIXED_DATE, fakeT), '[presets.researchedWith {"model":"Solstice Large","date":"on 2026-09-20"}]');
});
