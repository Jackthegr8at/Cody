import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  OUTBOX_RETRY_MAX_MS,
  applyOutcome,
  backoffDelayMs,
  beginAttempt,
  classifyDeliveryOutcome,
  clearPersistedOutbox,
  createClientMessageId,
  createOutboxEntry,
  deserializeOutboxEntries,
  normalizeOutboxText,
  mutatePersistedOutbox,
  persistOutbox,
  readPersistedOutbox,
  resolveDelivered,
  restoreForEdit,
  retryEntry,
  reviveForResume,
  serializeOutboxEntries,
  shouldGiveUpRetrying,
} = await jiti.import("./outbox.ts");

const entry = (overrides = {}) => createOutboxEntry({
  sessionId: "s1",
  text: "hello",
  behavior: "steer",
  id: "fixed-id",
  now: 1_000_000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// retry classification
// ---------------------------------------------------------------------------

test("classifyDeliveryOutcome maps every documented HTTP shape from local://send-contract.md", () => {
  assert.deepEqual(
    classifyDeliveryOutcome({ status: 200, success: true, data: { delivery: "started" }, }),
    { kind: "success", delivery: "started" },
  );
  assert.deepEqual(
    classifyDeliveryOutcome({ status: 200, success: true, data: { delivery: "queued" } }),
    { kind: "success", delivery: "queued" },
  );
  // A 200 with no explicit delivery field defaults to "started", never crashes.
  assert.deepEqual(classifyDeliveryOutcome({ status: 200, success: true }), { kind: "success", delivery: "started" });

  assert.deepEqual(classifyDeliveryOutcome({ status: 202, pending: true }), { kind: "pending" });

  assert.deepEqual(
    classifyDeliveryOutcome({ status: 409, code: "session_restarting", error: "restarting" }),
    { kind: "retry", detail: "restarting" },
  );
  // A 409 for any OTHER code is not on the retry list — it is a real conflict.
  assert.deepEqual(
    classifyDeliveryOutcome({ status: 409, code: "session_busy", error: "busy" }),
    { kind: "failed", detail: "busy" },
  );

  assert.deepEqual(classifyDeliveryOutcome({ status: 503, error: "down" }), { kind: "retry", detail: "down" });

  // A network failure never got a status at all.
  assert.deepEqual(classifyDeliveryOutcome({ status: null, error: "Failed to fetch" }), { kind: "retry", detail: "Failed to fetch" });

  // An ACP engine's definitive session_busy (SendServer: "not on your retry
  // list") and any other 4xx/5xx are failures the outbox does not retry.
  assert.deepEqual(classifyDeliveryOutcome({ status: 400, code: "session_busy", error: "busy" }), { kind: "failed", detail: "busy" });
  assert.deepEqual(classifyDeliveryOutcome({ status: 500, error: "boom" }), { kind: "failed", detail: "boom" });
  // No error/code at all still names the HTTP status rather than saying nothing.
  assert.deepEqual(classifyDeliveryOutcome({ status: 500 }), { kind: "failed", detail: "HTTP 500" });
});

// ---------------------------------------------------------------------------
// backoff + give-up
// ---------------------------------------------------------------------------

test("backoff doubles from 1s and caps at the ~2-minute contract ceiling", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map(backoffDelayMs),
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000],
  );
  assert.equal(backoffDelayMs(20), OUTBOX_RETRY_MAX_MS);
  // Never negative, never below the base delay.
  assert.equal(backoffDelayMs(-3), 1_000);
  assert.equal(OUTBOX_RETRY_MAX_MS, 120_000, "~2 minutes, per the contract");
});

test("an entry gives up once its retry streak has run the full ~2-minute budget", () => {
  const start = entry({ now: 1_000_000 }).retryingSince;
  assert.equal(shouldGiveUpRetrying(entry({ now: start }), start), false);
  assert.equal(shouldGiveUpRetrying(entry({ now: start }), start + OUTBOX_RETRY_MAX_MS - 1), false);
  assert.equal(shouldGiveUpRetrying(entry({ now: start }), start + OUTBOX_RETRY_MAX_MS), true);
});

test("repeated retryable outcomes back off, then give up as failed rather than retrying forever", () => {
  const start = 0;
  let entries = [entry({ now: start })];
  let now = start;
  let attempts = 0;
  while (entries[0].status === "sending" && attempts < 100) {
    entries = beginAttempt(entries, "fixed-id");
    entries = applyOutcome(entries, "fixed-id", { kind: "retry", detail: "down" }, now);
    attempts += 1;
    if (entries[0].nextRetryAt !== null) now = entries[0].nextRetryAt;
  }
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].error, "down");
  // Gives up within a healthy number of attempts — not one, not hundreds.
  assert.ok(attempts >= 5 && attempts <= 15, `expected a healthy retry count, got ${attempts}`);
  // The whole streak fits inside (and reaches close to) the ~2-minute budget.
  assert.ok(now - start >= OUTBOX_RETRY_MAX_MS && now - start < OUTBOX_RETRY_MAX_MS + backoffDelayMs(attempts));
});

test("a 202 pending outcome keeps retrying without a failure detail, and also gives up eventually", () => {
  let entries = [entry({ now: 0 })];
  entries = beginAttempt(entries, "fixed-id");
  entries = applyOutcome(entries, "fixed-id", { kind: "pending" }, 0);
  assert.equal(entries[0].status, "sending");
  assert.equal(entries[0].nextRetryAt, backoffDelayMs(1));

  // Fast-forward past the give-up budget and confirm it does not spin forever.
  entries = beginAttempt(entries, "fixed-id");
  entries = applyOutcome(entries, "fixed-id", { kind: "pending" }, OUTBOX_RETRY_MAX_MS);
  assert.equal(entries[0].status, "failed");
});

test("a definitive failure never schedules a retry, however early in the streak", () => {
  let entries = [entry({ now: 0 })];
  entries = beginAttempt(entries, "fixed-id");
  entries = applyOutcome(entries, "fixed-id", { kind: "failed", detail: "no credentials" }, 0);
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].error, "no credentials");
  assert.equal(entries[0].nextRetryAt, null);
});

test("success moves an entry to started or queued and clears any error, without touching order", () => {
  let entries = [entry({ id: "a", now: 0, text: "first" }), entry({ id: "b", now: 0, text: "second" })];
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "retry", detail: "down" }, 0);
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "success", delivery: "queued" }, 1_000);
  assert.deepEqual(entries.map((e) => [e.id, e.status]), [["a", "queued"], ["b", "sending"]]);
  assert.equal(entries[0].error, undefined);
  assert.equal(entries[0].nextRetryAt, null);
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

test("entries stay in send order through the whole lifecycle — nothing is silently reordered or dropped", () => {
  let entries = [];
  for (const id of ["a", "b", "c"]) entries = [...entries, entry({ id, text: id, now: 0 })];
  assert.deepEqual(entries.map((e) => e.id), ["a", "b", "c"]);

  entries = beginAttempt(entries, "b");
  entries = applyOutcome(entries, "b", { kind: "success", delivery: "started" }, 0);
  // Resolving "b" out of order (it started before "a" or "c" got a response)
  // still leaves every id in its original send position.
  assert.deepEqual(entries.map((e) => e.id), ["a", "b", "c"]);
  assert.deepEqual(entries.map((e) => e.status), ["sending", "started", "sending"]);
});

test("resolveDelivered consumes the FIRST open entry with matching normalized text", () => {
  let entries = [
    entry({ id: "a", text: "  do the thing  ", now: 0 }),
    entry({ id: "b", text: "do the thing", now: 0 }),
  ];
  const result = resolveDelivered(entries, "do the thing");
  assert.equal(result.resolvedId, "a");
  assert.deepEqual(result.entries.map((e) => [e.id, e.status]), [["a", "delivered"], ["b", "sending"]]);

  // The already-delivered "a" is no longer eligible; the next identical text
  // resolves "b" instead — never re-resolves the same entry twice.
  const second = resolveDelivered(result.entries, "do the thing");
  assert.equal(second.resolvedId, "b");
});

test("resolveDelivered is a no-op when nothing matches", () => {
  const entries = [entry({ id: "a", text: "hello", now: 0 })];
  const result = resolveDelivered(entries, "goodbye");
  assert.equal(result.resolvedId, null);
  assert.deepEqual(result.entries, entries);
});

test("a hard delivery proof resolves even an entry that already gave up as failed", () => {
  let entries = [entry({ id: "a", text: "hello", now: 0 })];
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "failed", detail: "timed out" }, 0);
  assert.equal(entries[0].status, "failed");
  const result = resolveDelivered(entries, "hello");
  assert.equal(result.resolvedId, "a");
  assert.equal(result.entries[0].status, "delivered");
});

test("normalizeOutboxText ignores incidental leading/trailing whitespace from the round trip", () => {
  assert.equal(normalizeOutboxText("  hi  "), "hi");
  assert.equal(normalizeOutboxText("hi"), normalizeOutboxText(" hi\n"));
});

// ---------------------------------------------------------------------------
// failed -> edit restores
// ---------------------------------------------------------------------------

test("restoreForEdit hands back a failed entry's exact text and images, and removes it", () => {
  let entries = [
    entry({ id: "a", text: "keep me", now: 0 }),
    createOutboxEntry({
      sessionId: "s1", id: "b", text: "fix this", behavior: "followUp", now: 0,
      images: [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }],
    }),
  ];
  entries = beginAttempt(entries, "b");
  entries = applyOutcome(entries, "b", { kind: "failed", detail: "message too large" }, 0);

  const { entry: restored, entries: remaining } = restoreForEdit(entries, "b");
  assert.equal(restored.text, "fix this");
  assert.equal(restored.behavior, "followUp");
  assert.deepEqual(restored.images, [{ data: "AAAA", mimeType: "image/png", name: "shot.png" }]);
  assert.equal(restored.error, "message too large");
  assert.deepEqual(remaining.map((e) => e.id), ["a"]);
});

test("restoreForEdit on an unknown id is a safe no-op", () => {
  const entries = [entry({ id: "a", now: 0 })];
  const { entry: restored, entries: remaining } = restoreForEdit(entries, "missing");
  assert.equal(restored, null);
  assert.deepEqual(remaining, entries);
});

test("retryEntry re-arms a failed entry with a fresh give-up budget under the same clientMessageId", () => {
  let entries = [entry({ id: "a", now: 0 })];
  entries = beginAttempt(entries, "a");
  entries = applyOutcome(entries, "a", { kind: "failed", detail: "down" }, 0);
  assert.equal(entries[0].status, "failed");

  const retried = retryEntry(entries, "a", 500_000);
  assert.equal(retried[0].id, "a", "same clientMessageId — the server's idempotency depends on this");
  assert.equal(retried[0].status, "sending");
  assert.equal(retried[0].attempt, 0);
  assert.equal(retried[0].error, undefined);
  assert.equal(retried[0].retryingSince, 500_000);
  // A retry that immediately fails again gets the FULL budget from `now`,
  // not the original (already-expired) streak.
  assert.equal(shouldGiveUpRetrying(retried[0], 500_000 + OUTBOX_RETRY_MAX_MS - 1), false);
});

// ---------------------------------------------------------------------------
// resume after reload / session-switch-back
// ---------------------------------------------------------------------------

test("reviveForResume drops delivered entries, keeps failed ones failed, and re-arms the rest", () => {
  const entries = [
    entry({ id: "sending", now: 0, text: "a" }),
    { ...entry({ id: "queued", now: 0, text: "b" }), status: "queued" },
    { ...entry({ id: "started", now: 0, text: "c" }), status: "started" },
    { ...entry({ id: "failed", now: 0, text: "d" }), status: "failed", error: "gave up" },
    { ...entry({ id: "delivered", now: 0, text: "e" }), status: "delivered" },
  ];
  const revived = reviveForResume(entries, 999_000);
  assert.deepEqual(revived.map((e) => e.id), ["sending", "queued", "started", "failed"]);
  const byId = Object.fromEntries(revived.map((e) => [e.id, e]));
  assert.equal(byId.sending.status, "sending");
  assert.equal(byId.queued.status, "sending");
  assert.equal(byId.started.status, "sending");
  assert.equal(byId.failed.status, "failed");
  assert.equal(byId.failed.error, "gave up");
  // Every revived (non-failed) entry gets a fresh streak from the resume
  // moment, not the stale pre-reload clock.
  assert.equal(byId.sending.retryingSince, 999_000);
  assert.equal(byId.queued.retryingSince, 999_000);
  assert.equal(byId.started.retryingSince, 999_000);
});

// ---------------------------------------------------------------------------
// persistence round-trip
// ---------------------------------------------------------------------------

test("serialize/deserialize round-trips an entry losslessly", () => {
  const original = createOutboxEntry({
    sessionId: "s1", id: "a", text: "hello", behavior: "steer", now: 42,
    images: [{ data: "AAAA", mimeType: "image/png" }],
  });
  const roundTripped = deserializeOutboxEntries(serializeOutboxEntries([original]));
  assert.deepEqual(roundTripped, [original]);
});

test("deserialize degrades corrupt or foreign JSON to an empty outbox instead of throwing", () => {
  assert.deepEqual(deserializeOutboxEntries("not json"), []);
  assert.deepEqual(deserializeOutboxEntries("{}"), []);
  assert.deepEqual(deserializeOutboxEntries(JSON.stringify({ steering: [], followUp: [] })), []);
  // One well-formed entry survives alongside a garbage sibling.
  const good = createOutboxEntry({ sessionId: "s1", id: "a", text: "hi", behavior: "steer", now: 0 });
  const mixed = JSON.stringify([good, { not: "an entry" }, null, "garbage"]);
  assert.deepEqual(deserializeOutboxEntries(mixed), [good]);
});

test("createClientMessageId produces distinct, non-empty ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => createClientMessageId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.ok(id.length > 0);
});

// sessionStorage-backed persistence needs a browser-like global; Node's test
// runner has none, so a tiny in-memory shim stands in for it here — the same
// shape lib/outbox.ts already treats sessionStorage through.
function installSessionStorageShim() {
  const store = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
  return store;
}

test("persistOutbox/readPersistedOutbox round-trip through sessionStorage and skip delivered entries", () => {
  const store = installSessionStorageShim();
  try {
    const sending = createOutboxEntry({ sessionId: "s1", id: "a", text: "hi", behavior: "steer", now: 0 });
    const delivered = { ...createOutboxEntry({ sessionId: "s1", id: "b", text: "bye", behavior: "steer", now: 0 }), status: "delivered" };
    persistOutbox("s1", [sending, delivered]);
    assert.deepEqual(readPersistedOutbox("s1"), [sending]);

    clearPersistedOutbox("s1");
    assert.deepEqual(readPersistedOutbox("s1"), []);
    assert.equal(store.size, 0);
  } finally {
    delete globalThis.window;
  }
});

test("persistOutbox degrades large image payloads (oldest first) rather than losing the outbox entirely", () => {
  installSessionStorageShim();
  try {
    const big = "A".repeat(3_100_000);
    const small = "B".repeat(20_000);
    const oldWithImage = createOutboxEntry({
      sessionId: "s1", id: "old", text: "first", behavior: "steer", now: 0,
      images: [{ data: big, mimeType: "image/png" }],
    });
    const newWithImage = createOutboxEntry({
      sessionId: "s1", id: "new", text: "second", behavior: "followUp", now: 1,
      images: [{ data: small, mimeType: "image/png" }],
    });
    persistOutbox("s1", [oldWithImage, newWithImage]);
    const persisted = readPersistedOutbox("s1");
    // Both entries survive; only the OLDEST one's image was dropped to fit
    // the bound — the newer, much smaller image needed no trimming at all.
    assert.deepEqual(persisted.map((e) => e.id), ["old", "new"]);
    assert.deepEqual(persisted.find((e) => e.id === "old").images, []);
    assert.deepEqual(persisted.find((e) => e.id === "new").images, [{ data: small, mimeType: "image/png" }]);
  } finally {
    delete globalThis.window;
  }
});

test("mutatePersistedOutbox reads, applies, and persists in one call", () => {
  installSessionStorageShim();
  try {
    const first = createOutboxEntry({ sessionId: "s1", id: "a", text: "hi", behavior: "steer", now: 0 });
    persistOutbox("s1", [first]);

    const result = mutatePersistedOutbox("s1", (entries) => applyOutcome(entries, "a", { kind: "success", delivery: "started" }, 1));
    assert.equal(result[0].status, "started");
    // The mutation actually landed in storage, not just the return value.
    assert.equal(readPersistedOutbox("s1")[0].status, "started");
  } finally {
    delete globalThis.window;
  }
});
