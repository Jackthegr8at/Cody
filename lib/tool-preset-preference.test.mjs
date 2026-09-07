import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getPreferredToolPreset, setPreferredToolPreset, subscribeToPreferredToolPreset } = await jiti.import("./tool-preset-preference.ts");
const { STORAGE_KEYS } = await jiti.import("./storage-keys.ts");

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

test("persists only known tool preset values", () => {
  const storage = createStorage({ [STORAGE_KEYS.toolPreset]: "unknown" });
  assert.equal(getPreferredToolPreset(storage), "full");

  setPreferredToolPreset("full", storage);
  assert.equal(getPreferredToolPreset(storage), "full");
});

test("a restricted preset stored before the control was labeled migrates to full", () => {
  // Old builds let users pick "default"/"none", then the tools control was
  // removed from the UI while the stored value kept restricting every new
  // session's spawn (--tools kills omp's task/todo/github/web_search — no
  // subagents, no task lists) with no surface left to see or undo it.
  const storage = createStorage({ [STORAGE_KEYS.toolPreset]: "default" });
  assert.equal(getPreferredToolPreset(storage), "full");
  assert.equal(storage.getItem(STORAGE_KEYS.toolPreset), "full", "the stale value is rewritten, not just masked");

  // A choice made through the current warning-labeled control sticks.
  setPreferredToolPreset("none", storage);
  assert.equal(getPreferredToolPreset(storage), "none");
  setPreferredToolPreset("default", storage);
  assert.equal(getPreferredToolPreset(storage), "default");
});

test("publishes an in-browser tool preset change for the next session", (t) => {
  const hadWindow = Object.hasOwn(globalThis, "window");
  const previousWindow = globalThis.window;
  const storage = createStorage();
  const events = new EventTarget();
  globalThis.window = Object.assign(events, { localStorage: storage });
  t.after(() => {
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  });

  const received = [];
  const unsubscribe = subscribeToPreferredToolPreset((preset) => received.push(preset));
  setPreferredToolPreset("default", storage);
  assert.deepEqual(received, ["default"]);

  unsubscribe();
  setPreferredToolPreset("none", storage);
  assert.deepEqual(received, ["default"], "an unmounted composer no longer receives future defaults");
});
