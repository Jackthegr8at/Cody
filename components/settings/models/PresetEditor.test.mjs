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
 * `PresetEditor`'s whole return value is `<Drawer presentation="side">`,
 * which bails to `null` before rendering children whenever there is no
 * portal host — true both closed AND open under this repo's plain-node
 * test runner (no DOM at all; the same is true of base-ui's own `Dialog`
 * SSR-rendered open). So this pins the two things actually observable here:
 * closed (or an unknown id) renders nothing and never throws finding the
 * preset to edit, and every case that a real preset id resolves to also
 * never throws building the editor. The role/chain logic the editor's rows
 * are built from — `splitPresetSelector`/`joinPresetSelector`,
 * `describeRoleSelector` — is exported from `lib/model-presets/` and
 * already covered there.
 */
const { PresetEditor } = await jiti.import("./PresetEditor.tsx");

const MODELS = [
  { id: "solstice-large", name: "Solstice Large", provider: "openai-codex", thinkingLevels: ["low", "high"] },
  { id: "claude-mini", name: "Claude Mini", provider: "anthropic", thinkingLevels: [] },
];

function preset(overrides) {
  return { id: "max", name: "Max", intent: "Hard logic.", builtIn: true, roles: {}, chains: {}, updatedAt: "2026-09-01T00:00:00.000Z", ...overrides };
}

const PRESETS = [
  preset({}),
  preset({
    id: "high",
    name: "High",
    roles: { default: "openai-codex/solstice-large:high", smol: "" },
    chains: { default: ["anthropic/claude-mini", "openai-codex/solstice-large:low"] },
    usageAwareFallback: true,
    research: { runId: "r1", plannerModel: "openai-codex/solstice-large", completedAt: "2026-09-10T00:00:00.000Z", rationale: [{ role: "default", text: "Best available.", sources: [] }] },
  }),
];

function render(presetId) {
  return renderToStaticMarkup(React.createElement(PresetEditor, {
    presetId,
    presets: PRESETS,
    models: MODELS,
    roleNames: ["default", "smol", "task"],
    baseRoles: { default: "anthropic/claude-mini" },
    panelId: "models",
    onClose: () => {},
    onEditDetails: () => {},
  }));
}

test("renders nothing when closed (presetId null) or pointed at an id that no longer exists", () => {
  assert.equal(render(null), "");
  assert.equal(render("does-not-exist"), "");
});

test("never throws building the editor for a bare preset, a fully-configured one with chains, usage-aware fallback and a research stamp, or an empty roster", () => {
  assert.doesNotThrow(() => render("max"));
  assert.doesNotThrow(() => render("high"));
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(PresetEditor, {
    presetId: null,
    presets: [],
    models: [],
    roleNames: [],
    baseRoles: {},
    panelId: "models",
    onClose: () => {},
    onEditDetails: () => {},
  })));
});
