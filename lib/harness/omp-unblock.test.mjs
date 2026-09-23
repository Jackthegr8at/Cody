import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { liftCredentialBlock, planUnblock } = await jiti.import("./omp-unblock.ts");

// A fixture AuthStorage whose blocks live in a JSON file (the helper is a
// separate process per call), and whose every credential-reading method
// records that it was touched. The secret is there to be leaked; the test
// proves it is not.
const SECRET = "sk-fixture-must-never-leave";
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "cody-unblock-"));
const packageRoot = path.join(fixtureDir, "omp");
const modules = path.join(packageRoot, "node_modules", "@oh-my-pi");
const agentDir = path.join(fixtureDir, "agent");
const blocksFile = path.join(fixtureDir, "blocks.json");
const touchedLog = path.join(fixtureDir, "touched.log");
await mkdir(path.join(modules, "pi-ai"), { recursive: true });
await mkdir(path.join(modules, "pi-utils"), { recursive: true });
await mkdir(agentDir, { recursive: true });
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", type: "module" }));
await writeFile(path.join(modules, "pi-ai", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-ai", type: "module", exports: { "./auth-storage.js": "./auth-storage.js" } }));
await writeFile(path.join(modules, "pi-utils", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-utils", type: "module", exports: { "./dirs.js": "./dirs.js" } }));
await writeFile(path.join(modules, "pi-utils", "dirs.js"), "export function getAgentDbPath() { return process.env.PI_CODING_AGENT_DIR + \"/agent.db\"; }");
await writeFile(path.join(modules, "pi-ai", "auth-storage.js"), [
  "import { appendFileSync, readFileSync, writeFileSync } from \"node:fs\";",
  "const file = process.env.CODY_UNBLOCK_FIXTURE_BLOCKS;",
  "const touched = (name) => appendFileSync(process.env.CODY_UNBLOCK_FIXTURE_TOUCHED, name + \"\\n\");",
  "const load = () => JSON.parse(readFileSync(file, \"utf8\"));",
  "const save = (rows) => writeFileSync(file, JSON.stringify(rows));",
  "export class AuthStorage {",
  "  static async create() { return new AuthStorage(); }",
  `  get credentials() { touched("credentials"); return [{ id: 5, credential: { type: "api_key", key: ${JSON.stringify(SECRET)} } }]; }`,
  "  async reload() { touched(\"reload\"); }",
  "  listStoredCredentials() { touched(\"listStoredCredentials\"); return this.credentials; }",
  "  listAuthCredentials() { touched(\"listAuthCredentials\"); return this.credentials; }",
  "  getApiKey() { touched(\"getApiKey\"); return " + JSON.stringify(SECRET) + "; }",
  "  listCredentialBlocks(ids) { return load().filter((row) => ids.includes(row.credentialId)); }",
  "  deleteCredentialBlocks(id) { save(load().filter((row) => row.credentialId !== id)); }",
  "  close() {}",
  "}",
].join("\n"));

const saved = { blocks: process.env.CODY_UNBLOCK_FIXTURE_BLOCKS, touched: process.env.CODY_UNBLOCK_FIXTURE_TOUCHED };
process.env.CODY_UNBLOCK_FIXTURE_BLOCKS = blocksFile;
process.env.CODY_UNBLOCK_FIXTURE_TOUCHED = touchedLog;
test.after(async () => {
  for (const [key, value] of [["CODY_UNBLOCK_FIXTURE_BLOCKS", saved.blocks], ["CODY_UNBLOCK_FIXTURE_TOUCHED", saved.touched]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(fixtureDir, { recursive: true, force: true });
});
const deps = { helperPath: path.resolve(process.cwd(), "bin/cody-omp-unblock.mjs"), bunBin: process.execPath, packageRoot: () => packageRoot, agentDir: () => agentDir };

const future = Date.now() + 3_600_000;
const blockWindow = { id: "p:blocked:5", label: "rate-limit block", utilization: 100, resetsAt: new Date(future).toISOString(), state: "exhausted", windowMs: null, tier: null, shared: true, source: "block" };
const account = (overrides) => ({ provider: "alibaba-token-plan", id: "alibaba-token-plan#5", identity: null, credentialId: 5, label: "x", planType: null, unlimited: false, windows: [blockWindow], ...overrides });
const snapshot = (accounts) => ({ available: true, accounts, fetchedAt: new Date().toISOString(), stale: false });

test("a block with no measured exhaustion is planned for lifting, by the snapshot's own credential id", () => {
  assert.deepEqual(planUnblock(snapshot([account({})]), "alibaba-token-plan", "alibaba-token-plan#5"), { kind: "run", credentialId: 5 });
  // Measured headroom beside the block does not stop it: that is the case
  // the button exists for.
  const healthy = account({ provider: "anthropic", id: "me@x", windows: [{ ...blockWindow, source: undefined, id: "a:7d", state: "ok", utilization: 4 }, blockWindow] });
  assert.equal(planUnblock(snapshot([healthy]), "anthropic", "me@x").kind, "run");
});

test("a measured exhaustion is refused, and an account without a block is not touched", () => {
  const measured = account({ provider: "anthropic", id: "me@x", windows: [{ ...blockWindow, source: undefined, id: "a:7d" }, blockWindow] });
  assert.equal(planUnblock(snapshot([measured]), "anthropic", "me@x").result.outcome, "measured");
  const clear = account({ windows: [{ ...blockWindow, source: undefined, state: "ok", utilization: 10 }] });
  assert.equal(planUnblock(snapshot([clear]), "alibaba-token-plan", "alibaba-token-plan#5").result.outcome, "not_blocked");
  assert.equal(planUnblock(snapshot([]), "alibaba-token-plan", "nope").result.outcome, "error");
});

test("the helper lifts exactly one credential's blocks and never reads a credential", async () => {
  await writeFile(blocksFile, JSON.stringify([
    { credentialId: 5, providerKey: "alibaba-token-plan", blockScope: "", blockedUntilMs: future },
    { credentialId: 6, providerKey: "alibaba-token-plan", blockScope: "", blockedUntilMs: future },
  ]));
  const lifted = await liftCredentialBlock(5, deps);
  assert.equal(lifted.outcome, "lifted");
  assert.deepEqual(lifted.cleared, [{ scope: null, until: new Date(future).toISOString() }]);
  assert.deepEqual(JSON.parse(await readFile(blocksFile, "utf8")).map((row) => row.credentialId), [6], "a sibling's block is left alone");

  const again = await liftCredentialBlock(5, deps);
  assert.equal(again.outcome, "not_blocked");

  assert.equal(existsSync(touchedLog), false, "no credential-reading method was called");
  assert.ok(!JSON.stringify([lifted, again]).includes(SECRET));
});

test("a block that already expired is not a block", async () => {
  await writeFile(blocksFile, JSON.stringify([{ credentialId: 5, providerKey: "p", blockScope: "", blockedUntilMs: Date.now() - 1000 }]));
  assert.equal((await liftCredentialBlock(5, deps)).outcome, "not_blocked");
});
