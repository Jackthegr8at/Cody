import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

/**
 * `ModelPresets` reads GET /api/model-presets through the shared settings
 * route cache, which — like `EngineRoster` — always answers the server's
 * EMPTY snapshot under `renderToStaticMarkup` (`useSyncExternalStore`'s
 * server path never touches the real cache). The `initial` prop is the same
 * escape hatch `EngineRoster` uses to reach the component with fixture data
 * anyway, so these pin the actual list markup — not just the loading state.
 *
 * The assertions read the rendered English (`t()` resolves against the real
 * en.json), so a missing or mis-wired string fails here, not in production.
 */
const { ModelPresets } = await jiti.import("./ModelPresets.tsx");

function model(overrides) {
  return { id: "solstice-large", name: "Solstice Large", provider: "openai-codex", thinkingLevels: ["low", "high"], ...overrides };
}

const MODELS = [model(), model({ id: "claude-mini", name: "Claude Mini", provider: "anthropic", thinkingLevels: [] })];

function preset(overrides) {
  return { id: "max", name: "Max", intent: "Hard logic and bug fixing.", builtIn: true, roles: {}, chains: {}, updatedAt: "2026-09-01T00:00:00.000Z", ...overrides };
}

const FIXTURE = {
  presets: [
    preset({}),
    preset({ id: "high", name: "High", builtIn: true, roles: { default: "openai-codex/solstice-large:high" } }),
    preset({
      id: "custom-1",
      name: "Weekend",
      builtIn: false,
      intent: "Quick fixes on the weekend.",
      research: { runId: "run-1", plannerModel: "openai-codex/solstice-large", completedAt: "2026-09-10T00:00:00.000Z", rationale: [] },
    }),
  ],
  lastUsedPresetId: "high",
  roleNames: ["default", "smol", "task"],
  baseRoles: { default: "anthropic/claude-mini" },
};

test("renders every preset — built-ins first, then custom — with its badges and summary lines", () => {
  const markup = renderToStaticMarkup(React.createElement(ModelPresets, { models: MODELS, panelId: "models", initial: FIXTURE }));
  assert.match(markup, /Max/);
  assert.match(markup, /High/);
  assert.match(markup, /Weekend/);
  // List order: built-ins (as GET already returns them) before the custom one.
  assert.ok(markup.indexOf("Max") < markup.indexOf("Weekend"), "built-ins render before custom presets");
  assert.match(markup, /Built-in/, "the built-in chip renders");
  assert.match(markup, /Default for new chats/, "the lastUsedPresetId row carries the default marker");
});

test("every row shows a default-model line, whichever of inherit/explicit it resolves to", () => {
  const markup = renderToStaticMarkup(React.createElement(ModelPresets, { models: MODELS, panelId: "models", initial: FIXTURE }));
  // One "Default model:" line per preset row — Max inherits, High sets its
  // own, Weekend inherits too.
  assert.equal((markup.match(/Default model:/g) ?? []).length, FIXTURE.presets.length);
  assert.match(markup, /Inherits base/, "an unset default says what it inherits");
});

test("the research stamp key distinguishes a researched preset from one that has never been researched", () => {
  const markup = renderToStaticMarkup(React.createElement(ModelPresets, { models: MODELS, panelId: "models", initial: FIXTURE }));
  assert.equal((markup.match(/Researched with /g) ?? []).length, 1, "only Weekend carries a research stamp");
  assert.equal((markup.match(/Not configured yet/g) ?? []).length, 2, "Max and High have none");
});

test("the intro note names the last-used preset, or base settings when there is none", () => {
  const withDefault = renderToStaticMarkup(React.createElement(ModelPresets, { models: MODELS, panelId: "models", initial: FIXTURE }));
  assert.ok(withDefault.includes("New chats start on &quot;High&quot;."), "the named default is spelled out");

  const withoutDefault = renderToStaticMarkup(React.createElement(ModelPresets, { models: MODELS, panelId: "models", initial: { ...FIXTURE, lastUsedPresetId: null } }));
  assert.ok(withoutDefault.includes("New chats start on base settings"));
  assert.doesNotMatch(withoutDefault, /Default for new chats/, "no row claims the default marker when nothing is last-used");
});

test("only custom presets are deletable: a delete affordance never renders for a built-in", () => {
  const markup = renderToStaticMarkup(React.createElement(ModelPresets, { models: MODELS, panelId: "models", initial: FIXTURE }));
  // Two built-ins + one custom: exactly one delete control.
  const deleteCount = (markup.match(/title="Delete preset"/g) ?? []).length;
  assert.equal(deleteCount, 1);
});

test("renders the loading state (never a false error) when the cache has not answered and no fixture was handed in", () => {
  const markup = renderToStaticMarkup(React.createElement(ModelPresets, { models: MODELS, panelId: "models" }));
  assert.match(markup, /Loading presets…/);
  assert.doesNotMatch(markup, /role="alert"/, "a route that has not even started fetching is not an error");
});
