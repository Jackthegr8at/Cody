import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (file) => readFile(new URL(`./${file}`, import.meta.url), "utf8");

test("desktop titlebar keeps the live activity summary wired", async () => {
  const [titleBar, appShell, chatWindow, sidebar] = await Promise.all([
    readSource("TitleBar.tsx"),
    readSource("AppShell.tsx"),
    readSource("ChatWindow.tsx"),
    readSource("SessionSidebar.tsx"),
  ]);

  assert.match(titleBar, /function ActivitySummary/);
  assert.match(titleBar, /activeSessions/);
  assert.match(titleBar, /activeSubagents/);
  assert.match(titleBar, /role="status"/);
  assert.match(titleBar, /title=\{label\}/);
  assert.match(titleBar, /<ActivitySummary activeSessions=\{activeSessions\} activeSubagents=\{activeSubagents\} \/>/);
  assert.match(appShell, /activeSessions=\{activeSessionCount\} activeSubagents=\{activeSubagentCount\}/);
  assert.match(appShell, /onRunningSessionCountChange=\{handleRunningSessionCountChange\}/);
  assert.match(appShell, /onActiveSubagentCountChange=\{handleActiveSubagentCountChange\}/);
  assert.match(chatWindow, /onActiveSubagentCountChange\?\.\(activeSubagentCount\)/);
  assert.match(sidebar, /onRunningSessionCountChange\?\.\(runningSessionIds\.size\)/);
});
