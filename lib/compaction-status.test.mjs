import assert from "node:assert/strict";
import test from "node:test";
import { compactionStatusReducer } from "./compaction-status.ts";

test("observed automatic frames expose an indeterminate running operation then settle", () => {
  const started = compactionStatusReducer({ status: "idle", sessionId: "s1" }, { type: "running", sessionId: "s1", source: "automatic", now: 100 });
  assert.deepEqual(started, { status: "running", sessionId: "s1", source: "automatic", generation: 0, startedAt: 100, phase: undefined, progress: undefined });
  const settled = compactionStatusReducer(started, { type: "settle", sessionId: "s1", outcome: "completed", now: 220 });
  assert.equal(settled.status, "completed");
  assert.equal(settled.source, "automatic");
  assert.equal(settled.startedAt, 100);
});

test("manual requests attach to an already running automatic compaction", () => {
  const automatic = { status: "running", sessionId: "s1", source: "automatic", startedAt: 10 };
  assert.equal(compactionStatusReducer(automatic, { type: "request", sessionId: "s1", source: "manual", now: 20 }), automatic);
});

test("state reconciliation restores automatic work and clears it without inventing success", () => {
  const restored = compactionStatusReducer({ status: "idle", sessionId: "s1" }, { type: "reconcile", sessionId: "s1", active: true, now: 50 });
  assert.equal(restored.status, "running");
  const untouched = compactionStatusReducer(restored, { type: "settle", sessionId: "old", outcome: "failed", now: 60, message: "old error" });
  assert.equal(untouched, restored);
  const cleared = compactionStatusReducer(restored, { type: "reconcile", sessionId: "s1", active: false, now: 70, observedAt: 70 });
  assert.equal(cleared.status, "idle");
});

test("a reconnect false snapshot cannot settle a newer compaction generation", () => {
  const automatic = compactionStatusReducer({ status: "idle", sessionId: "s1" }, { type: "running", sessionId: "s1", source: "automatic", now: 100, generation: 2 });
  const next = compactionStatusReducer(automatic, { type: "reconcile", sessionId: "s1", active: false, now: 130, generation: 1 });
  assert.equal(next, automatic);

  const manual = compactionStatusReducer({ status: "idle", sessionId: "s1" }, { type: "request", sessionId: "s1", source: "manual", now: 140, generation: 3 });
  assert.equal(compactionStatusReducer(manual, { type: "reconcile", sessionId: "s1", active: false, now: 150, generation: 3 }), manual);
});

test("no-op, unsupported, failed, and cancelled terminal outcomes stay distinct", () => {
  for (const outcome of ["noop", "unsupported", "failed", "cancelled"]) {
    const terminal = compactionStatusReducer({ status: "pending", sessionId: "s1", source: "manual", startedAt: 1 }, { type: "settle", sessionId: "s1", outcome, now: 2 });
    assert.equal(terminal.status, outcome);
  }
});


test("late same-session automatic terminal frame cannot settle manual compaction", () => {
  const manual = { status: "pending", sessionId: "s1", source: "manual", startedAt: 10 };
  const next = compactionStatusReducer(manual, { type: "settle", sessionId: "s1", source: "automatic", outcome: "completed", now: 20 });
  assert.equal(next, manual);
});