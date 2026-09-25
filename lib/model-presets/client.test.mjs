import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  ModelPresetsApiError,
  fetchModelPresets,
  createModelPreset,
  updateModelPreset,
  deleteModelPreset,
  startResearch,
  fetchResearchRun,
  cancelResearchRun,
  presetErrorMessage,
} = await jiti.import("./client.ts");

// Every helper here is a thin, typed fetch wrapper around one route from
// `local://preset-contract.md`. These pin the request shape (method, JSON
// body, URL-encoded id) and, more importantly, the error contract every
// caller in the UI relies on: a failure carries the server's message, its
// `code`, and — for the one route that can 409 with work already in
// flight — the run itself.

function mockFetch(calls, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("fetchModelPresets GETs the route with no body and no content-type", async () => {
  const calls = [];
  const restore = mockFetch(calls, () => jsonResponse(200, { presets: [], lastUsedPresetId: null, roleNames: [], baseRoles: {} }));
  try {
    const body = await fetchModelPresets();
    assert.deepEqual(body, { presets: [], lastUsedPresetId: null, roleNames: [], baseRoles: {} });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/model-presets");
    assert.equal(calls[0].init.method, undefined);
    assert.equal(calls[0].init.headers["Content-Type"], undefined, "a bodyless request carries no content-type");
  } finally {
    restore();
  }
});

test("createModelPreset POSTs a JSON body to the collection route", async () => {
  const calls = [];
  const restore = mockFetch(calls, () => jsonResponse(201, { preset: { id: "p1" } }));
  try {
    const { preset } = await createModelPreset({ name: "Weekend", intent: "quick fixes", copyFrom: "base" });
    assert.equal(preset.id, "p1");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), { name: "Weekend", intent: "quick fixes", copyFrom: "base" });
  } finally {
    restore();
  }
});

test("updateModelPreset PUTs to the id route, URL-encoded, and returns restarted/active", async () => {
  const calls = [];
  const restore = mockFetch(calls, () => jsonResponse(200, { preset: { id: "p 1" }, restarted: 2, active: 1 }));
  try {
    const result = await updateModelPreset("p 1", { name: "New name" });
    assert.equal(calls[0].url, "/api/model-presets/p%201");
    assert.equal(calls[0].init.method, "PUT");
    assert.deepEqual(result, { preset: { id: "p 1" }, restarted: 2, active: 1 });
  } finally {
    restore();
  }
});

test("deleteModelPreset DELETEs with no body", async () => {
  const calls = [];
  const restore = mockFetch(calls, () => jsonResponse(200, { ok: true, reassigned: 3 }));
  try {
    const result = await deleteModelPreset("max");
    assert.equal(calls[0].url, "/api/model-presets/max");
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].init.headers["Content-Type"], undefined);
    assert.deepEqual(result, { ok: true, reassigned: 3 });
  } finally {
    restore();
  }
});

test("a non-ok response throws ModelPresetsApiError with the server's message and code", async () => {
  const restore = mockFetch([], () => jsonResponse(400, { error: "Built-in presets can be edited but not deleted.", code: "builtin" }));
  try {
    await assert.rejects(deleteModelPreset("max"), (error) => {
      assert.ok(error instanceof ModelPresetsApiError);
      assert.equal(error.message, "Built-in presets can be edited but not deleted.");
      assert.equal(error.status, 400);
      assert.equal(error.code, "builtin");
      return true;
    });
  } finally {
    restore();
  }
});

test("a 409 from starting research carries the already-running run for the caller to switch to", async () => {
  const run = { id: "run-1", status: "running", plannerModel: "openai-codex/gpt-6-sol", presetIds: ["max"], startedAt: "now", finishedAt: null, progress: [] };
  const restore = mockFetch([], () => jsonResponse(409, { error: "A research run is already in progress.", code: "research_running", run }));
  try {
    await assert.rejects(startResearch({ plannerModel: "openai-codex/gpt-6-sol", presetIds: ["max"] }), (error) => {
      assert.ok(error instanceof ModelPresetsApiError);
      assert.equal(error.code, "research_running");
      assert.deepEqual(error.run, run);
      return true;
    });
  } finally {
    restore();
  }
});

test("a response with no JSON body still throws a readable error", async () => {
  const restore = mockFetch([], () => ({ ok: false, status: 500, json: async () => { throw new Error("not json"); } }));
  try {
    await assert.rejects(fetchResearchRun("run-1"), (error) => {
      assert.equal(error.message, "HTTP 500");
      return true;
    });
  } finally {
    restore();
  }
});

test("cancelResearchRun DELETEs the run route", async () => {
  const calls = [];
  const restore = mockFetch(calls, () => jsonResponse(200, { run: { id: "run-1", status: "cancelled" } }));
  try {
    const { run } = await cancelResearchRun("run-1");
    assert.equal(calls[0].url, "/api/model-presets/research/run-1");
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(run.status, "cancelled");
  } finally {
    restore();
  }
});

test("presetErrorMessage unwraps an Error and stringifies anything else", () => {
  assert.equal(presetErrorMessage(new Error("boom")), "boom");
  assert.equal(presetErrorMessage("boom"), "boom");
});
