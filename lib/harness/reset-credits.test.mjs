import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listResetCredits, redeemResetCredit } = await jiti.import("./reset-credits.ts");
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "cody-reset-credit-"));
const packageRoot = path.join(fixtureDir, "omp");
const modules = path.join(packageRoot, "node_modules", "@oh-my-pi");
const agentDir = path.join(fixtureDir, "agent");
const nativeLog = path.join(fixtureDir, "native.jsonl");
await mkdir(modules, { recursive: true }); await mkdir(agentDir, { recursive: true });
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", type: "module" }));
await mkdir(path.join(modules, "pi-ai")); await mkdir(path.join(modules, "pi-utils"));
await writeFile(path.join(modules, "pi-ai", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-ai", type: "module", exports: { "./auth-storage.js": "./auth-storage.js" } }));
await writeFile(path.join(modules, "pi-utils", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-utils", type: "module", exports: { "./dirs.js": "./dirs.js" } }));
await writeFile(path.join(modules, "pi-utils", "dirs.js"), "export function getAgentDbPath() { return process.env.PI_CODING_AGENT_DIR + \"/agent.db\"; }");
await writeFile(path.join(modules, "pi-ai", "auth-storage.js"), [
  "import { appendFileSync } from \"node:fs\";",
  "export class AuthStorage {",
  "  static async create(dbPath) { globalThis.dbPath = dbPath; return new AuthStorage(); }",
  "  async reload() {}",
  "  async listResetCredits() { return [{ credentialId: 41, availableCount: 1, active: false, credits: [{ id: \"later\", status: \"available\", expiresAt: \"2027-02-01T00:00:00.000Z\" }, { id: \"earlier\", status: \"available\", expiresAt: \"2027-01-01T00:00:00.000Z\" }, { id: \"spent\", status: \"redeemed\" }] }]; }",
  "  async redeemResetCredit(options) { appendFileSync(process.env.CODY_RESET_FIXTURE_LOG, JSON.stringify(options) + \"\\n\"); return options.target.credentialId === 41 && options.creditId === \"earlier\" ? { ok: true, code: \"reset\" } : { ok: false, code: \"no_credit\" }; }",
  "  async close() {}",
  "}",
].join("\n"));
const previousLog = process.env.CODY_RESET_FIXTURE_LOG; process.env.CODY_RESET_FIXTURE_LOG = nativeLog;
const deps = { helperPath: path.resolve(process.cwd(), "bin/cody-omp-reset-credits.mjs"), bunBin: process.execPath, packageRoot: () => packageRoot, agentDir: () => agentDir };
test.after(async () => { if (previousLog === undefined) delete process.env.CODY_RESET_FIXTURE_LOG; else process.env.CODY_RESET_FIXTURE_LOG = previousLog; await rm(fixtureDir, { recursive: true, force: true }); });
test("real child helper reads only available credits, ordered by native expiry", async () => {
  const snapshot = await listResetCredits(deps);
  assert.equal(snapshot.available, true); assert.equal(snapshot.accounts[0]?.canRedeem, true);
  assert.deepEqual(snapshot.accounts[0]?.credits.map((credit) => credit.id), ["earlier", "later"]);
  assert.notEqual(snapshot.accounts[0]?.id, "41");
});
test("real child helper redeems the exact opaque account and selected credit", async () => {
  const snapshot = await listResetCredits(deps); const accountId = snapshot.accounts[0]?.id; assert.ok(accountId);
  const outcome = await redeemResetCredit({ accountId, creditId: "earlier", idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" }, deps);
  assert.equal(outcome.outcome, "reset");
  const nativeRequest = JSON.parse((await readFile(nativeLog, "utf8")).trim());
  assert.deepEqual(nativeRequest.target, { credentialId: 41 }); assert.equal(nativeRequest.creditId, "earlier");
});
test("exact-credit redemption never substitutes a different available credit", async () => {
  const snapshot = await listResetCredits(deps);
  const accountId = snapshot.accounts[0]?.id;
  assert.ok(accountId);
  const outcome = await redeemResetCredit({ accountId, creditId: "later", idempotencyKey: "123e4567-e89b-42d3-a456-426614174001" }, deps);
  assert.equal(outcome.outcome, "no_credit");
  const nativeRequests = (await readFile(nativeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(nativeRequests.at(-1).creditId, "later");
});
