import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-todo-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CODY_INTERNAL_DISPLAY_SECRET ??= "project-todo-test-secret";
test.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const todo = await jiti.import("./project-todo.ts");
const todoRoute = await jiti.import("../app/api/todo/route.ts");
const internalTodoRoute = await jiti.import("../app/api/internal/todo/route.ts");
const { issueDisplayCapability } = await jiti.import("./display/capability.ts");
const { upsertEngineSession, removeEngineSession } = await jiti.import("./harness/engine-sessions.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

const at = new Date("2026-09-08T12:00:00.000Z");
const actor = { kind: "user", label: "You" };
const json = async (response) => ({ status: response.status, body: await response.json() });

function testProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cody-project-todo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function add(doc, title, id) {
  return todo.applyTodoOperation(doc, { op: "add", title }, actor, { now: at, idFactory: () => id });
}

test("to-do operations update the item and append the matching history", () => {
  let doc = todo.emptyTodoDocument();
  doc = todo.applyTodoOperation(
    doc,
    { op: "add", title: "  Ship project to-do list  ", notes: "Remember history", color: "blue" },
    actor,
    { now: at, idFactory: () => "t_00000001" },
  );
  const firstId = doc.items[0].id;
  assert.deepEqual(doc.items[0], {
    id: firstId,
    title: "Ship project to-do list",
    notes: "Remember history",
    color: "blue",
    status: "active",
    order: 0,
    createdAt: at.toISOString(),
    updatedAt: at.toISOString(),
    completedAt: null,
  });
  assert.equal(doc.history.at(-1).action, "created");
  assert.equal(doc.history.at(-1).actor.label, "You");

  doc = todo.applyTodoOperation(doc, { op: "update", id: firstId, title: "Ship manual to-do list", color: "purple" }, actor, { now: at });
  assert.equal(doc.items[0].title, "Ship manual to-do list");
  assert.equal(doc.items[0].color, "purple");
  assert.equal(doc.history.at(-1).action, "edited");

  doc = add(doc, "Document the API", "t_00000002");
  doc = todo.applyTodoOperation(doc, { op: "reorder", ids: ["t_00000002", firstId] }, actor, { now: at });
  assert.deepEqual(doc.items.map((item) => [item.id, item.order]), [["t_00000002", 0], [firstId, 1]]);
  assert.deepEqual(
    { action: doc.history.at(-1).action, detail: doc.history.at(-1).detail },
    { action: "edited", detail: "Reordered" },
  );

  doc = todo.applyTodoOperation(doc, { op: "complete", id: firstId }, actor, { now: at });
  assert.equal(doc.items.find((item) => item.id === firstId).status, "done");
  assert.equal(doc.items.find((item) => item.id === firstId).completedAt, at.toISOString());
  assert.equal(doc.history.at(-1).action, "completed");

  doc = todo.applyTodoOperation(doc, { op: "reopen", id: firstId }, actor, { now: at });
  assert.equal(doc.items.find((item) => item.id === firstId).status, "active");
  assert.equal(doc.items.find((item) => item.id === firstId).completedAt, null);
  assert.equal(doc.history.at(-1).action, "reopened");

  doc = todo.applyTodoOperation(doc, { op: "delete", id: firstId }, actor, { now: at });
  assert.equal(doc.items.some((item) => item.id === firstId), false);
  assert.equal(doc.history.at(-1).action, "deleted");
  assert.equal(doc.history.at(-1).title, "Ship manual to-do list");
});

test("reopening reverses completion and unknown ids are not silently accepted", () => {
  let doc = add(todo.emptyTodoDocument(), "Recover a mistaken completion", "t_00000003");
  doc = todo.applyTodoOperation(doc, { op: "complete", id: "t_00000003" }, actor, { now: at });
  const reopened = todo.applyTodoOperation(doc, { op: "reopen", id: "t_00000003" }, actor, { now: at });
  assert.equal(reopened.items[0].status, "active");
  assert.equal(reopened.items[0].completedAt, null);
  assert.equal(reopened.history.at(-1).action, "reopened");
  assert.throws(
    () => todo.applyTodoOperation(reopened, { op: "complete", id: "t_missing1" }, actor, { now: at }),
    (error) => error instanceof todo.ProjectTodoError && error.code === "not_found",
  );
});

test("history retains only the newest 500 entries", () => {
  let doc = add(todo.emptyTodoDocument(), "Bound history", "t_00000004");
  for (let index = 0; index < 505; index += 1) {
    doc = todo.applyTodoOperation(doc, { op: "update", id: "t_00000004", notes: `revision ${String(index)}` }, actor, { now: at });
  }
  assert.equal(doc.history.length, 500);
  assert.equal(doc.history.at(-1).action, "edited");
  assert.equal(doc.items[0].notes, "revision 504");
});

test("malformed project files are reported and never overwritten", async (t) => {
  const root = testProject(t);
  const todoDir = path.join(root, ".cody");
  const todoPath = path.join(todoDir, "todo.json");
  fs.mkdirSync(todoDir);
  const malformed = "{ this is not valid JSON";
  fs.writeFileSync(todoPath, malformed);

  const loaded = await todo.readProjectTodo(root);
  assert.equal(loaded.status, "invalid");
  assert.match(loaded.reason, /Invalid JSON/);
  await assert.rejects(
    todo.mutateProjectTodo(root, { op: "add", title: "Must not replace malformed content" }, actor),
    (error) => error instanceof todo.ProjectTodoError && error.code === "invalid",
  );
  assert.equal(fs.readFileSync(todoPath, "utf8"), malformed);
});

test("to-do storage refuses a symlinked .cody directory", async (t) => {
  const root = testProject(t);
  const external = path.join(root, "external");
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(root, ".cody"), "dir");

  const loaded = await todo.readProjectTodo(root);
  assert.equal(loaded.status, "invalid");
  await assert.rejects(
    todo.mutateProjectTodo(root, { op: "add", title: "Must stay in the project" }, actor),
    (error) => error instanceof todo.ProjectTodoError && error.code === "invalid",
  );
  assert.equal(fs.existsSync(path.join(external, "todo.json")), false);
});

test("project mutations preserve unknown top-level fields", async (t) => {
  const root = testProject(t);
  const todoDir = path.join(root, ".cody");
  fs.mkdirSync(todoDir);
  fs.writeFileSync(path.join(todoDir, "todo.json"), JSON.stringify({
    version: 1,
    items: [],
    history: [],
    externalMetadata: { owner: "another tool" },
  }));

  await todo.mutateProjectTodo(root, { op: "add", title: "Keep project metadata" }, actor);
  const stored = JSON.parse(fs.readFileSync(path.join(todoDir, "todo.json"), "utf8"));
  assert.deepEqual(stored.externalMetadata, { owner: "another tool" });
});

test("parallel project mutations retain every added item", async (t) => {
  const root = testProject(t);
  await Promise.all(Array.from({ length: 24 }, (_, index) =>
    todo.mutateProjectTodo(root, { op: "add", title: `Concurrent item ${String(index)}` }, actor),
  ));

  const loaded = await todo.readProjectTodo(root);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.doc.items.length, 24);
  assert.equal(new Set(loaded.doc.items.map((item) => item.id)).size, 24);
  assert.equal(loaded.doc.history.length, 24);
});

test("agent formatting keeps active items first and includes a history hint", () => {
  let doc = add(todo.emptyTodoDocument(), "Active item", "t_00000005");
  doc = add(doc, "Finished item", "t_00000006");
  doc = todo.applyTodoOperation(doc, { op: "complete", id: "t_00000006" }, actor, { now: at });
  const lines = todo.formatTodoForAgent(doc).split("\n");
  assert.match(lines[0], /^\[ \] t_00000005 Active item \(none\) — /);
  assert.match(lines[1], /^\[x\] t_00000006 Finished item \(none\) — /);
  assert.match(lines.at(-1), /^History: 3 entries/);
});

test("public to-do route adds, completes, and reopens a project item", async (t) => {
  const root = testProject(t);
  allowFileRoot(root);
  const endpoint = `http://cody.test/api/todo?cwd=${encodeURIComponent(root)}`;

  const initial = await json(await todoRoute.GET(new Request(endpoint)));
  assert.equal(initial.status, 200);
  assert.equal(initial.body.status, "missing");
  assert.deepEqual(initial.body.doc.items, []);
  assert.equal(fs.existsSync(path.join(root, ".cody", "todo.json")), false);

  const added = await json(await todoRoute.POST(new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "add", title: "Exercise API route", notes: "Route smoke", color: "green" }),
  })));
  assert.equal(added.status, 200);
  const id = added.body.doc.items[0].id;
  assert.equal(added.body.doc.items[0].status, "active");
  assert.equal(added.body.doc.history.at(-1).action, "created");

  const completed = await json(await todoRoute.POST(new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "complete", id }),
  })));
  assert.equal(completed.status, 200);
  assert.equal(completed.body.doc.items[0].status, "done");
  assert.equal(completed.body.doc.history.at(-1).action, "completed");

  const reopened = await json(await todoRoute.POST(new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "reopen", id }),
  })));
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.doc.items[0].status, "active");
  assert.equal(reopened.body.doc.history.at(-1).action, "reopened");

  const unknown = await json(await todoRoute.POST(new Request(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op: "complete", id: "t_missing1" }),
  })));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "not_found");

  const persisted = JSON.parse(fs.readFileSync(path.join(root, ".cody", "todo.json"), "utf8"));
  assert.deepEqual(persisted.history.map((entry) => entry.action), ["created", "completed", "reopened"]);
  const loaded = await json(await todoRoute.GET(new Request(endpoint)));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.status, "loaded");
  assert.equal(loaded.body.path, path.join(root, ".cody", "todo.json"));
});

test("public route rejects an unrecognized project root with a validation error", async () => {
  const response = await json(await todoRoute.GET(new Request("http://cody.test/api/todo?cwd=/definitely/not/an/allowed/project")));
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "invalid");
});

test("internal to-do route scopes mutations to the capability session", async (t) => {
  const root = testProject(t);
  const sessionId = "todo-internal-session";
  upsertEngineSession(sessionId, {
    engine: "codex",
    engineSessionId: sessionId,
    title: "To-do route smoke",
    cwd: root,
  });
  t.after(() => removeEngineSession(sessionId));
  const capability = issueDisplayCapability(sessionId);
  const headers = {
    Authorization: "Bearer " + capability,
    "Content-Type": "application/json",
    "X-Cody-Engine-Label": "Codex",
  };

  const added = await json(await internalTodoRoute.POST(new Request("http://cody.test/api/internal/todo", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, op: "add", title: "MCP-backed item" }),
  })));
  assert.equal(added.status, 200);
  assert.equal(added.body.doc.history.at(-1).actor.kind, "agent");
  assert.equal(added.body.doc.history.at(-1).actor.label, "Codex");

  const listed = await json(await internalTodoRoute.POST(new Request("http://cody.test/api/internal/todo", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId, op: "list" }),
  })));
  assert.equal(listed.status, 200);
  assert.equal(listed.body.doc.items[0].title, "MCP-backed item");

  const mismatched = await json(await internalTodoRoute.POST(new Request("http://cody.test/api/internal/todo", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: "another-session", op: "list" }),
  })));
  assert.equal(mismatched.status, 403);
  assert.equal(mismatched.body.code, "invalid");
});
