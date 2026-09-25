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
 * `ResearchRunView`'s whole return value is `<Drawer presentation="side">`,
 * and `Drawer` bails to `null` before ever rendering its children whenever
 * there is no real `document` (closed) OR no portal host to mount into
 * (open, but this repo's plain-node test runner has no DOM at all — the
 * same is true of every other Drawer-wrapped surface in this repo, and of
 * base-ui's own `Dialog`: a `renderToStaticMarkup` of an OPEN `ConfirmDialog`
 * is empty too). So the two things actually worth pinning here at the
 * component layer are: closed renders nothing, and nothing throws while
 * getting there. The real logic — `elapsedLabel`, `describeApplyDiff` — is
 * exported specifically so it is testable on its own, the same way
 * `lib/model-presets/proposal.ts` (which `describeApplyDiff` wraps) already
 * is.
 */
const { ResearchRunView, elapsedLabel, describeApplyDiff } = await jiti.import("./ResearchRunView.tsx");

const fakeT = (key, vars) => (vars ? `[${key} ${JSON.stringify(vars)}]` : `[${key}]`);
const fakeTn = (key, count) => `${count} ${key}`;

test("elapsedLabel formats seconds as mm:ss, zero-padding seconds only", () => {
  assert.equal(elapsedLabel(0), "0:00");
  assert.equal(elapsedLabel(5), "0:05");
  assert.equal(elapsedLabel(65), "1:05");
  assert.equal(elapsedLabel(600), "10:00");
  assert.equal(elapsedLabel(3661), "61:01");
});

test("describeApplyDiff has no preset/proposal to compare yet", () => {
  assert.equal(describeApplyDiff(undefined, undefined, fakeT, fakeTn), "[presets.researchOverwriteFallback]");
  assert.equal(describeApplyDiff(undefined, { roles: {}, chains: {}, usageAwareFallback: false, rationale: [], warnings: [] }, fakeT, fakeTn), "[presets.researchOverwriteFallback]");
});

test("describeApplyDiff names an identical proposal as a same-again reapplication", () => {
  const preset = { roles: { default: "a/1" }, chains: {}, usageAwareFallback: true, name: "Max" };
  const proposal = { roles: { default: "a/1" }, chains: {}, usageAwareFallback: true, rationale: [], warnings: [] };
  assert.equal(describeApplyDiff(preset, proposal, fakeT, fakeTn), '[presets.researchOverwriteSame {"name":"Max"}]');
});

test("describeApplyDiff enumerates roles, chains and usage-aware fallback through the plural keys, wrapped through t()", () => {
  const preset = { roles: {}, chains: {}, usageAwareFallback: false, name: "High" };
  const proposal = {
    roles: { default: "a/1", smol: "a/2" },
    chains: { default: ["a/1"] },
    usageAwareFallback: true,
    rationale: [],
    warnings: [],
  };
  const description = describeApplyDiff(preset, proposal, fakeT, fakeTn);
  assert.match(description, /^\[presets\.researchOverwriteChanges /);
  const vars = JSON.parse(description.slice(description.indexOf(" ") + 1, -1));
  assert.equal(vars.name, "High");
  assert.equal(vars.parts, "2 presets.diffRoles[presets.listSeparator]1 presets.diffChains[presets.listSeparator][presets.diffUsageAware]");
});

test("ResearchRunView renders nothing while closed, and never throws across a few fixture shapes", () => {
  const models = [{ id: "solstice-large", name: "Solstice Large", provider: "openai-codex" }];
  const presets = [{ id: "max", name: "Max", intent: "", builtIn: true, roles: {}, chains: {}, updatedAt: "x" }];
  for (const open of [false, true]) {
    const markup = renderToStaticMarkup(React.createElement(ResearchRunView, { open, presets, models, panelId: "models", onClose: () => {} }));
    if (!open) assert.equal(markup, "");
  }
  // No presets at all is a real shape (a brand-new instance with only the
  // built-ins wiped, hypothetically) — must not throw building the view.
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(ResearchRunView, { open: false, presets: [], models: [], panelId: "models", onClose: () => {} })));
});
