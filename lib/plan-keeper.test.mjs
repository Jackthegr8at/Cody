import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The plan keeper's server half: cadence (debounce/min-interval/coalescing),
 * the evidence guard on gated tasks, never un-completing or reordering,
 * promotion of the next pending task, subtasks scoped to the in_progress
 * task, overlay persistence, lenient JSON parsing and the smol -> tiny ->
 * engine-default model chain.
 *
 * The organizing rule under test throughout is FAIL SOFT: a run that finds
 * nothing, an answer with no evidence for a gated task, or every model
 * attempt failing must all leave the todo list and overlay untouched rather
 * than guess.
 */
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "cody-plan-keeper-"));
// Before the first import: these modules resolve the instance data dir at
// call time, but a module that touched it at load time would write into the
// operator's live appdata (see the checkpoint trap in AGENTS.md).
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_PROFILE = "";
process.env.PI_PROFILE = "";
delete process.env.CODY_HARNESS;
process.on("exit", () => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const configModule = await jiti.import("./plan-keeper/config.ts");
const overlayModule = await jiti.import("./plan-keeper/overlay.ts");
const promptsModule = await jiti.import("./plan-keeper/prompts.ts");
const keeperModule = await jiti.import("./plan-keeper/keeper.ts");
const modelRoles = await jiti.import("./omp/model-roles.ts");

let sessionCounter = 0;
function nextSessionId() {
  sessionCounter += 1;
  return `plan-keeper-test-${sessionCounter}`;
}

/** A phase list with one in_progress task and one pending task — the shape
 * most tests start from. */
function openPhases() {
  return [
    {
      name: "Ship the feature",
      tasks: [
        { content: "Write the handler", status: "in_progress" },
        { content: "Wire up the route", status: "pending" },
      ],
    },
  ];
}

/** Records every setTodoPhases call and every emitted frame; getTodoPhases
 * always answers the latest phases, mirroring a live session's state. */
function fakeHooks(initialPhases) {
  let phases = initialPhases;
  const setCalls = [];
  const emitted = [];
  const hooks = {
    sessionId: nextSessionId(),
    getTodoPhases: async () => phases,
    setTodoPhases: async (next) => {
      phases = next;
      setCalls.push(next);
    },
    emit: (frame) => emitted.push(frame),
  };
  return { hooks, setCalls, emitted, getPhases: () => phases };
}

/** Records what it was asked to run and answers from a script, one entry per
 * call — same shape as lib/distill.test.mjs's fakeAttempt. */
function fakeRunner(script) {
  const calls = [];
  const runner = async (input) => {
    calls.push(input.model);
    const step = script[calls.length - 1] ?? { error: "no more scripted answers" };
    return { text: step.text ?? null, error: step.error ?? null };
  };
  return { runner, calls };
}

/** A runner whose call hangs until release() is invoked — for exercising the
 * "never concurrent" coalesce path deterministically. */
function gatedRunner(finalText) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const runner = async (input) => {
    calls.push(input.model);
    await gate;
    return { text: finalText, error: null };
  };
  return { runner, calls, release: () => release() };
}

/** Fully drains the microtask queue (setImmediate runs after every pending
 * Promise callback in Node), so an async chain with no real timers/I/O in it
 * settles up to its next genuine suspension point before an assertion. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic virtual clock: `schedule` records {fn, dueAt} instead of
 * using a real timer; `advanceBy` moves the clock, `fireDue` awaits every
 * entry currently due (in due order), including ones a fired entry itself
 * reschedules. Same injection shape as
 * lib/message-update-coalescer.test.mjs's manualScheduler, extended with a
 * mutable `now` for the min-interval rule. */
function manualClock() {
  let now = 0;
  const scheduled = [];
  let nextId = 1;
  return {
    now: () => now,
    schedule(fn, ms) {
      const id = nextId += 1;
      scheduled.push({ id, fn, dueAt: now + ms });
      return () => {
        const index = scheduled.findIndex((entry) => entry.id === id);
        if (index !== -1) scheduled.splice(index, 1);
      };
    },
    advanceBy(ms) {
      now += ms;
    },
    async fireDue() {
      for (;;) {
        const index = scheduled.findIndex((entry) => entry.dueAt <= now);
        if (index === -1) return;
        const [entry] = scheduled.splice(index, 1);
        await entry.fn();
      }
    },
    pendingCount: () => scheduled.length,
  };
}

const NOOP_ANSWER = '{"completed":[],"subtasks":{},"subtasksCompleted":[]}';

/* -------------------------------------------------------------- config -- */

test("no config file means enabled by default", () => {
  fs.rmSync(configModule.getPlanKeeperConfigPath(), { force: true });
  assert.deepEqual(configModule.readPlanKeeperConfig(), { enabled: true });
});

test("a written config survives a reread, and a corrupt file reads as the default", () => {
  configModule.writePlanKeeperConfig({ enabled: false });
  assert.deepEqual(configModule.readPlanKeeperConfig(), { enabled: false });

  fs.writeFileSync(configModule.getPlanKeeperConfigPath(), "{not json", "utf8");
  assert.deepEqual(configModule.readPlanKeeperConfig(), { enabled: true });

  configModule.writePlanKeeperConfig({ enabled: true });
});

/* ------------------------------------------------------------- overlay -- */

test("a saved overlay comes back for its own session id and no other", () => {
  const id = nextSessionId();
  const overlay = { subtasks: { "Task A": [{ content: "step one", status: "pending" }] }, autoCompleted: ["Task Z"], updatedAt: 42 };
  overlayModule.writePlanOverlay(id, overlay);
  assert.deepEqual(overlayModule.readPlanOverlay(id), overlay);
  assert.equal(overlayModule.readPlanOverlay(nextSessionId()), null);
});

test("a session id that is not a plain id is never turned into a path", () => {
  overlayModule.writePlanOverlay("../../etc/passwd", { subtasks: {}, autoCompleted: [], updatedAt: 1 });
  assert.equal(fs.existsSync(path.join(configModule.getPlanKeeperOverlayDir(), "..", "..", "etc", "passwd.json")), false);
  assert.equal(overlayModule.readPlanOverlay("../../etc/passwd"), null);
});

test("a corrupt overlay file reads as none, not a throw", () => {
  const id = nextSessionId();
  const file = path.join(configModule.getPlanKeeperOverlayDir(), `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json at all", "utf8");
  assert.equal(overlayModule.readPlanOverlay(id), null);
});

test("pruning drops subtasks and auto-marks for tasks no longer in the phases", () => {
  const overlay = {
    subtasks: { "Task A": [{ content: "step", status: "pending" }], "Task B (gone)": [{ content: "x", status: "pending" }] },
    autoCompleted: ["Task A", "Task C (gone)"],
    updatedAt: 5,
  };
  const pruned = overlayModule.prunePlanOverlay(overlay, new Set(["Task A"]));
  assert.deepEqual(pruned, { subtasks: { "Task A": overlay.subtasks["Task A"] }, autoCompleted: ["Task A"], updatedAt: 5 });
});

/* ------------------------------------------------------------- prompts -- */

test("a plain JSON answer parses", () => {
  const parsed = promptsModule.parsePlanKeeperAnswer(NOOP_ANSWER);
  assert.deepEqual(parsed, { completed: [], subtasks: {}, subtasksCompleted: [] });
});

test("a fenced, prose-wrapped answer still parses", () => {
  const raw = 'Sure thing, here is the update:\n```json\n{"completed":["A"],"subtasks":{"B":["step one","step two"]},"subtasksCompleted":["step one"]}\n```\nLet me know if anything else changed.';
  const parsed = promptsModule.parsePlanKeeperAnswer(raw);
  assert.deepEqual(parsed, { completed: ["A"], subtasks: { B: ["step one", "step two"] }, subtasksCompleted: ["step one"] });
});

test("malformed JSON and answers with no JSON object are null, not a throw", () => {
  assert.equal(promptsModule.parsePlanKeeperAnswer("{completed: [oops"), null);
  assert.equal(promptsModule.parsePlanKeeperAnswer("Nothing changed since last time."), null);
});

test("subtasks are capped at MAX_SUBTASKS entries and MAX_SUBTASK_WORDS words each; unknown fields are ignored", () => {
  const raw = JSON.stringify({
    completed: ["A", 42, ""],
    subtasks: {
      B: ["one two three four five six seven eight nine ten", "short one", "s2", "s3", "s4 (dropped, over cap)"],
    },
    subtasksCompleted: ["short one"],
    somethingUnknown: "ignored",
  });
  const parsed = promptsModule.parsePlanKeeperAnswer(raw);
  assert.deepEqual(parsed.completed, ["A"], "non-string / empty entries dropped");
  assert.equal(parsed.subtasks.B.length, promptsModule.MAX_SUBTASKS);
  assert.equal(parsed.subtasks.B[0], "one two three four five six seven eight", "capped to 8 words");
  assert.deepEqual(parsed.subtasksCompleted, ["short one"]);
});

/* ------------------------------------------------------- keeper: cadence */

test("fewer than 4 tool_execution_end frames record digest but never schedule a run", () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  const { runner, calls } = fakeRunner([]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  keeper.notifyToolExecutionEnd("read", { i: "reading config" }, "ok");
  keeper.notifyToolExecutionEnd("read", { i: "reading routes" }, "ok");
  keeper.notifyToolExecutionEnd("read", { i: "reading tests" }, "ok");

  assert.equal(clock.pendingCount(), 0);
  assert.equal(calls.length, 0);
  assert.equal(keeper.digestSnapshot().length, 3);
  assert.equal(keeper.digestSnapshot()[0].text, "read: reading config -> ok");
});

test("the 4th tool_execution_end debounces a run exactly 2s later, not sooner", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  const { runner, calls } = fakeRunner([{ text: NOOP_ANSWER }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  for (let index = 0; index < 4; index += 1) keeper.notifyToolExecutionEnd("read", { i: `step ${index}` }, "ok");
  assert.equal(clock.pendingCount(), 1);

  clock.advanceBy(1999);
  await clock.fireDue();
  assert.equal(calls.length, 0, "the debounce has not elapsed yet");

  clock.advanceBy(1);
  await clock.fireDue();
  assert.equal(calls.length, 1);
});

test("triggers arriving within the debounce window coalesce into exactly one run", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  const { runner, calls } = fakeRunner([{ text: NOOP_ANSWER }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  for (let index = 0; index < 4; index += 1) keeper.notifyToolExecutionEnd("read", { i: `step ${index}` }, "ok");
  assert.equal(clock.pendingCount(), 1, "the 4th tool call scheduled the only timer");
  keeper.notifyTurnEnd();
  keeper.notifyTurnEnd();
  assert.equal(clock.pendingCount(), 1, "later triggers before it fires do not add a second timer");
  assert.equal(keeper.digestSnapshot().length, 6, "but every trigger still recorded its own digest entry");

  clock.advanceBy(2000);
  await clock.fireDue();
  assert.equal(calls.length, 1, "still exactly one run, using the latest digest");
});

test("a trigger during an in-flight run coalesces into one rerun, never a concurrent second call", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  const gate = gatedRunner(NOOP_ANSWER);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner: gate.runner, clock });

  const first = keeper.notifyTerminalAgentEnd();
  await flush();
  assert.equal(gate.calls.length, 1, "the run started and called the model exactly once");

  const second = keeper.notifyTerminalAgentEnd();
  await second;
  await flush();
  assert.equal(gate.calls.length, 1, "a trigger while running must not start a concurrent second call");

  gate.release();
  await first;
  assert.equal(clock.pendingCount(), 1, "the coalesced trigger was not dropped: a rerun is scheduled");
});

test("a run within 10s of the last one is rescheduled for the remainder, not skipped or run early", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  const { runner, calls } = fakeRunner([{ text: NOOP_ANSWER }, { text: NOOP_ANSWER }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();
  assert.equal(calls.length, 1);

  keeper.notifyTurnEnd();
  clock.advanceBy(2000);
  await clock.fireDue();
  assert.equal(calls.length, 1, "the debounce elapsed but the min interval since the last run has not");
  assert.equal(clock.pendingCount(), 1, "rescheduled rather than dropped");

  clock.advanceBy(8000); // 2000 + 8000 = 10000ms since the first run started
  await clock.fireDue();
  assert.equal(calls.length, 2, "now that 10s has passed, the second run actually happens");
});

test("skip when no task is pending or in_progress: the model is never called", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const phases = [{ name: "P", tasks: [{ content: "already done", status: "completed" }, { content: "gave up", status: "abandoned" }] }];
  const { hooks } = fakeHooks(phases);
  const { runner, calls } = fakeRunner([{ text: NOOP_ANSWER }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();
  assert.equal(calls.length, 0);
});

test("disabling the keeper skips every run without touching digest recording", async () => {
  modelRoles.clearModelRoles();
  configModule.writePlanKeeperConfig({ enabled: false });
  try {
    const clock = manualClock();
    const { hooks } = fakeHooks(openPhases());
    const { runner, calls } = fakeRunner([{ text: NOOP_ANSWER }]);
    const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });
    await keeper.notifyTerminalAgentEnd();
    assert.equal(calls.length, 0);
    assert.equal(keeper.digestSnapshot().length, 1, "the terminal marker was still recorded");
  } finally {
    configModule.writePlanKeeperConfig({ enabled: true });
  }
});

/* ----------------------------------------------------- keeper: evidence */

test("a gated task (verify/test/gate/publish/release) is refused while an ungated task in the same answer completes", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  // A third, ungated, pending task ahead of the gated one means promotion
  // (after "Write the migration" completes) has somewhere else to land —
  // proving the gated task was genuinely left PENDING, not just resurrected
  // as the promoted in_progress task by coincidence.
  const phases = [{
    name: "Ship",
    tasks: [
      { content: "Write the migration", status: "in_progress" },
      { content: "Update the docs", status: "pending" },
      { content: "Verify the migration runs cleanly", status: "pending" },
    ],
  }];
  const { hooks, setCalls, emitted } = fakeHooks(phases);
  // The digest below has no pass/push signal at all, so the guard must
  // reject the gated completion while still honoring the ungated one.
  const { runner } = fakeRunner([{ text: '{"completed":["Write the migration","Verify the migration runs cleanly"],"subtasks":{},"subtasksCompleted":[]}' }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  keeper.notifyToolExecutionEnd("bash", { i: "run migration" }, "applied 1 migration");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1);
  const tasks = setCalls[0][0].tasks;
  assert.equal(tasks[0].status, "completed", "ungated task completes normally");
  assert.equal(tasks[1].status, "in_progress", "promotion lands on the next real pending task");
  assert.equal(tasks[2].status, "pending", "gated task stays untouched: no evidence");
  assert.deepEqual(emitted[0].overlay.autoCompleted, ["Write the migration"], "only the ungated completion is auto-marked");
});

test("when the only proposed completion is a rejected gated task, nothing at all is applied", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const phases = [{
    name: "Ship",
    tasks: [
      { content: "Write the migration", status: "in_progress" },
      { content: "Verify the migration runs cleanly", status: "pending" },
    ],
  }];
  const { hooks, setCalls, emitted } = fakeHooks(phases);
  const { runner } = fakeRunner([{ text: '{"completed":["Verify the migration runs cleanly"],"subtasks":{},"subtasksCompleted":[]}' }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  keeper.notifyToolExecutionEnd("bash", { i: "run migration" }, "applied 1 migration");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0, "the only proposed completion was rejected: nothing reaches the engine at all");
  assert.equal(emitted.length, 0);
});

test("a gated task completes once the digest shows a passing result", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const phases = [{ name: "Ship", tasks: [{ content: "Verify the migration runs cleanly", status: "in_progress" }] }];
  const { hooks, setCalls } = fakeHooks(phases);
  const { runner } = fakeRunner([{ text: '{"completed":["Verify the migration runs cleanly"],"subtasks":{},"subtasksCompleted":[]}' }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  keeper.notifyToolExecutionEnd("bash", { i: "run migration test" }, "3 passed, 0 failed");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0][0].tasks[0].status, "completed");
});

test("a failure signal anywhere in the digest overrides a pass signal: the gated task stays open", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const phases = [{ name: "Ship", tasks: [{ content: "Verify the migration runs cleanly", status: "in_progress" }] }];
  const { hooks, setCalls } = fakeHooks(phases);
  const { runner } = fakeRunner([{ text: '{"completed":["Verify the migration runs cleanly"],"subtasks":{},"subtasksCompleted":[]}' }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  keeper.notifyToolExecutionEnd("bash", { i: "run migration test" }, "1 passed, 1 failed");
  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0, "a mixed digest is not evidence — nothing is applied at all here");
});

/* --------------------------------------------- keeper: never un-complete */

test("an already-completed, blocked, or abandoned task is never touched even when the model names it", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const phases = [{
    name: "P",
    tasks: [
      { content: "Done already", status: "completed" },
      { content: "Blocked on infra", status: "blocked", blocker: "waiting on ops" },
      { content: "Abandoned idea", status: "abandoned" },
      { content: "Actually pending", status: "pending" },
    ],
  }];
  const { hooks, setCalls } = fakeHooks(phases);
  const { runner } = fakeRunner([{ text: '{"completed":["Done already","Blocked on infra","Abandoned idea","Actually pending"],"subtasks":{},"subtasksCompleted":[]}' }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  const tasks = setCalls[0][0].tasks;
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[1].status, "blocked");
  assert.equal(tasks[1].blocker, "waiting on ops", "untouched fields survive too");
  assert.equal(tasks[2].status, "abandoned");
  assert.equal(tasks[3].status, "completed", "the one real pending task is the only eligible one");
});

/* -------------------------------------------------------- keeper: order */

test("phases and tasks are never reordered — only status changes", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const phases = [{ name: "P", tasks: [
    { content: "First", status: "in_progress" },
    { content: "Second", status: "pending" },
    { content: "Third", status: "pending" },
  ] }];
  const { hooks, setCalls } = fakeHooks(phases);
  const { runner } = fakeRunner([{ text: '{"completed":["First"],"subtasks":{},"subtasksCompleted":[]}' }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  assert.deepEqual(setCalls[0][0].tasks.map((task) => task.content), ["First", "Second", "Third"]);
});

/* ----------------------------------------------------- keeper: promotion */

test("completing the only in_progress task promotes the first pending task, and both frames fire together", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks, setCalls, emitted } = fakeHooks(openPhases());
  const { runner } = fakeRunner([{ text: '{"completed":["Write the handler"],"subtasks":{},"subtasksCompleted":[]}' }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  const tasks = setCalls[0][0].tasks;
  assert.equal(tasks[0].status, "completed");
  assert.equal(tasks[1].status, "in_progress", "the next pending task is promoted");

  // A real phase change fires BOTH frames, in this order — the exact
  // payloads the browser applies (see hooks/useAgentSession.ts).
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].type, "plan_overlay_update");
  assert.deepEqual(emitted[0].overlay.autoCompleted, ["Write the handler"]);
  assert.deepEqual(emitted[1], { type: "todo_auto_update" });
});

test("an all-pending list with no in_progress task gets its first task promoted even with nothing completed", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const phases = [{ name: "P", tasks: [{ content: "A", status: "pending" }, { content: "B", status: "pending" }] }];
  const { hooks, setCalls } = fakeHooks(phases);
  const { runner } = fakeRunner([{ text: NOOP_ANSWER }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0][0].tasks[0].status, "in_progress");
  assert.equal(setCalls[0][0].tasks[1].status, "pending");
});

/* ------------------------------------------------------ keeper: subtasks */

test("subtasks are added only under the exact in_progress task, capped, and persisted for reload", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks, setCalls, emitted } = fakeHooks(openPhases());
  const answer = JSON.stringify({
    completed: [],
    subtasks: {
      "Write the handler": ["parse the body", "validate input", "call the service", "shape the response", "one too many"],
      "Wire up the route": ["ignored: not the in_progress task"],
    },
    subtasksCompleted: [],
  });
  const { runner } = fakeRunner([{ text: answer }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0, "subtasks alone never touch the engine's todo phases");
  assert.equal(emitted.length, 1, "no todo_auto_update: a subtask-only change has no new todoPhases to refetch");
  assert.deepEqual(emitted[0].type, "plan_overlay_update");
  const subtasks = emitted[0].overlay.subtasks["Write the handler"];
  assert.equal(subtasks.length, 4, "capped at MAX_SUBTASKS");
  assert.deepEqual(subtasks.map((subtask) => subtask.status), ["pending", "pending", "pending", "pending"]);
  assert.equal(emitted[0].overlay.subtasks["Wire up the route"], undefined, "not the in_progress task: ignored");

  // Reload: a fresh read sees exactly what was persisted.
  const reread = overlayModule.readPlanOverlay(hooks.sessionId);
  assert.deepEqual(reread.subtasks["Write the handler"], subtasks);
});

test("subtasksCompleted marks matching subtasks done without touching others or un-completing", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks } = fakeHooks(openPhases());
  overlayModule.writePlanOverlay(hooks.sessionId, {
    subtasks: { "Write the handler": [{ content: "parse the body", status: "pending" }, { content: "validate input", status: "completed" }] },
    autoCompleted: [],
    updatedAt: 1,
  });
  const answer = JSON.stringify({ completed: [], subtasks: {}, subtasksCompleted: ["parse the body", "validate input", "unknown step"] });
  const { runner } = fakeRunner([{ text: answer }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  const reread = overlayModule.readPlanOverlay(hooks.sessionId);
  assert.deepEqual(reread.subtasks["Write the handler"], [
    { content: "parse the body", status: "completed" },
    { content: "validate input", status: "completed" },
  ]);
});

/* ------------------------------------------------- keeper: runner chain */

test("the model chain tries omp's smol role, then tiny, then the engine default — each a fallback for empty/failure", async () => {
  modelRoles.writeModelRoles({ smol: "vendor/smol-model", tiny: "vendor/tiny-model" });
  try {
    const clock = manualClock();
    const { hooks, setCalls } = fakeHooks(openPhases());
    const { runner, calls } = fakeRunner([
      { error: "smol model unavailable" },
      { text: "   " }, // whitespace-only counts as empty, same failure class
      { text: '{"completed":["Write the handler"],"subtasks":{},"subtasksCompleted":[]}' },
    ]);
    const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

    await keeper.notifyTerminalAgentEnd();

    assert.deepEqual(calls, ["vendor/smol-model", "vendor/tiny-model", undefined]);
    assert.equal(setCalls[0][0].tasks[0].status, "completed", "the engine-default attempt's answer was applied");
  } finally {
    modelRoles.clearModelRoles();
  }
});

test("a duplicate smol/tiny selector is only tried once", async () => {
  modelRoles.writeModelRoles({ smol: "vendor/same-model", tiny: "vendor/same-model" });
  try {
    const clock = manualClock();
    const { hooks } = fakeHooks(openPhases());
    const { runner, calls } = fakeRunner([{ text: NOOP_ANSWER }]);
    const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });
    await keeper.notifyTerminalAgentEnd();
    assert.deepEqual(calls, ["vendor/same-model"]);
  } finally {
    modelRoles.clearModelRoles();
  }
});

test("every model attempt failing or empty applies nothing at all", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks, setCalls, emitted } = fakeHooks(openPhases());
  const { runner, calls } = fakeRunner([{ error: "spawn ENOENT" }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  assert.equal(calls.length, 1);
  assert.equal(setCalls.length, 0);
  assert.equal(emitted.length, 0);
  assert.equal(overlayModule.readPlanOverlay(hooks.sessionId), null, "no overlay file was ever written");
});

test("an answer with no parseable JSON applies nothing", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks, setCalls, emitted } = fakeHooks(openPhases());
  const { runner } = fakeRunner([{ text: "I looked things over and nothing needs to change." }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls.length, 0);
  assert.equal(emitted.length, 0);
});

test("a fenced JSON answer with real evidence is applied end to end", async () => {
  modelRoles.clearModelRoles();
  const clock = manualClock();
  const { hooks, setCalls } = fakeHooks(openPhases());
  const raw = '```json\n{"completed":["Write the handler"],"subtasks":{},"subtasksCompleted":[]}\n```';
  const { runner } = fakeRunner([{ text: raw }]);
  const keeper = new keeperModule.PlanKeeper(hooks, { runner, clock });

  await keeper.notifyTerminalAgentEnd();

  assert.equal(setCalls[0][0].tasks[0].status, "completed");
});
