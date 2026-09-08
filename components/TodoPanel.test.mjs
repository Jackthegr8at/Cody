import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { TodoPanelContent } = await jiti.import("./TodoPanel.tsx");

function documentWith(items = [], history = []) {
  return { version: 1, items, history };
}

function render(doc, props = {}) {
  return renderToStaticMarkup(React.createElement(TodoPanelContent, {
    cwd: "/tmp/project",
    doc,
    ...props,
  }));
}

const activeItem = {
  id: "t_active01",
  title: "Plan the release",
  status: "active",
  order: 0,
  createdAt: "2026-09-08T10:00:00.000Z",
  updatedAt: "2026-09-08T10:00:00.000Z",
  completedAt: null,
};

const doneItem = {
  id: "t_done0001",
  title: "Check the release notes",
  notes: "Reviewed by hand",
  status: "done",
  order: 1,
  createdAt: "2026-09-08T09:00:00.000Z",
  updatedAt: "2026-09-08T11:00:00.000Z",
  completedAt: "2026-09-08T11:00:00.000Z",
};

test("partitions active and completed items and makes a completed row reopenable", () => {
  const html = render(documentWith([doneItem, activeItem]), { defaultDoneOpen: true });

  assert.ok(html.indexOf("Plan the release") < html.indexOf("Check the release notes"));
  assert.match(html, /role="checkbox" aria-checked="true" aria-label="Reopen Check the release notes"/);
});

test("renders a completed history entry with its actor and an independent reopen action", () => {
  const html = render(documentWith([doneItem], [{
    ts: "2026-09-08T11:00:00.000Z",
    itemId: doneItem.id,
    title: doneItem.title,
    action: "completed",
    actor: { kind: "agent", label: "Codex" },
    detail: "Verification passed",
  }]), { defaultHistoryOpen: true });

  assert.match(html.replace(/<[^>]+>/g, ""), /Codex completed Check the release notes/);
  assert.match(html, /Verification passed/);
  assert.match(html, /aria-label="Reopen Check the release notes"/);
});

test("does not offer history reopen after the item is active again", () => {
  const html = render(documentWith([activeItem], [{
    ts: "2026-09-08T11:00:00.000Z",
    itemId: activeItem.id,
    title: activeItem.title,
    action: "completed",
    actor: { kind: "agent", label: "Codex" },
  }]), { defaultHistoryOpen: true });

  assert.doesNotMatch(html, /aria-label="Reopen Plan the release"/);
});

test("hides Commands when the project has no commands config", () => {
  const html = render(documentWith([activeItem]), { commandsAvailable: false });

  assert.doesNotMatch(html, />Commands</);
});

test("explains the empty manual project list", () => {
  const html = render(documentWith());

  assert.match(html, /Keep track of what you want done/);
  assert.match(html, /Agents can read it and update it while they work/);
});
