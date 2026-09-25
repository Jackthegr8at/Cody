import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { mergeResetCredits } = await jiti.import("./reset-credits-cache.ts");

const account = (overrides) => ({ id: "claude-1", label: "Claude (Org)", provider: "anthropic", position: 0, availableCount: 1, canRedeem: true, credits: [{ id: "juniper_tide", expiresAt: null }], ...overrides });
const live = (accounts) => ({ available: true, accounts, fetchedAt: "2026-09-25T02:00:00.000Z" });
const NOW = new Date("2026-09-25T02:30:00.000Z");

// Measured: Anthropic answered 429 to every reset check, and each Claude row
// read "Failed to load saved resets" while each account held one reset. A
// failed check must not erase what the provider last confirmed.
test("a failed check keeps the account's last confirmed balance, marked as carried over", () => {
  const confirmed = new Map([["claude-1", { account: account({ checkedAt: "2026-09-25T01:00:00.000Z" }), checkedAt: "2026-09-25T01:00:00.000Z" }]]);
  const result = mergeResetCredits(live([account({ availableCount: 0, canRedeem: false, credits: [], error: "Failed to load saved resets" })]), confirmed, NOW);

  assert.equal(result.failed, true);
  const [row] = result.snapshot.accounts;
  assert.equal(row.availableCount, 1);
  assert.equal(row.stale, true);
  assert.equal(row.checkedAt, "2026-09-25T01:00:00.000Z");
  assert.equal(row.error, undefined, "a carried-over balance is not an error");
  assert.equal(result.confirmed.get("claude-1").checkedAt, "2026-09-25T01:00:00.000Z");
});

test("a failed check with nothing confirmed says it will retry instead of reporting zero as fact", () => {
  const result = mergeResetCredits(live([account({ availableCount: 0, canRedeem: false, credits: [], error: "Failed to load saved resets" })]), new Map(), NOW);
  assert.equal(result.snapshot.accounts[0].retrying, true);
  assert.equal(result.failed, true);
});

test("an answered check replaces the confirmed balance and drops accounts that are gone", () => {
  const confirmed = new Map([
    ["claude-1", { account: account({ availableCount: 1 }), checkedAt: "2026-09-25T01:00:00.000Z" }],
    ["logged-out", { account: account({ id: "logged-out" }), checkedAt: "2026-09-25T01:00:00.000Z" }],
  ]);
  const result = mergeResetCredits(live([account({ availableCount: 0, canRedeem: false, credits: [] })]), confirmed, NOW);

  assert.equal(result.failed, false);
  assert.equal(result.snapshot.accounts[0].availableCount, 0, "a real answer of zero is shown as zero");
  assert.equal(result.snapshot.accounts[0].stale, undefined);
  assert.deepEqual([...result.confirmed.keys()], ["claude-1"]);
  assert.equal(result.confirmed.get("claude-1").checkedAt, NOW.toISOString());
});

test("a listing that failed outright still serves every confirmed balance", () => {
  const confirmed = new Map([["claude-1", { account: account(), checkedAt: "2026-09-25T01:00:00.000Z" }]]);
  const result = mergeResetCredits({ available: false, accounts: [], fetchedAt: NOW.toISOString(), reason: "helper failed" }, confirmed, NOW);
  assert.equal(result.snapshot.available, true);
  assert.equal(result.snapshot.accounts[0].stale, true);
  assert.equal(result.snapshot.accounts[0].availableCount, 1);
});
