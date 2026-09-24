import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listOmpCredentials, removeOmpCredential, removeOmpProvider } = await jiti.import("./omp-credentials.ts");
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "cody-omp-credentials-"));
const packageRoot = path.join(fixtureDir, "omp");
const modules = path.join(packageRoot, "node_modules", "@oh-my-pi");
const agentDir = path.join(fixtureDir, "agent");
const dbPath = path.join(agentDir, "agent.db");
const badAgentDir = path.join(fixtureDir, "bad-agent");
const nativeLog = path.join(fixtureDir, "native.jsonl");
await mkdir(modules, { recursive: true }); await mkdir(agentDir, { recursive: true }); await mkdir(badAgentDir, { recursive: true });
await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", type: "module" }));
await mkdir(path.join(modules, "pi-ai")); await mkdir(path.join(modules, "pi-utils"));
await writeFile(path.join(modules, "pi-ai", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-ai", type: "module", exports: { "./auth-storage.js": "./auth-storage.js" } }));
await writeFile(path.join(modules, "pi-utils", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-utils", type: "module", exports: { "./dirs.js": "./dirs.js" } }));
await writeFile(path.join(modules, "pi-utils", "dirs.js"), "export function getAgentDbPath() { return process.env.PI_CODING_AGENT_DIR + \"/agent.db\"; }");
// Fixture models three credentials for "anthropic" (ids 2 blocked, 5 healthy)
// plus one disabled "openai-codex" row (id 1) and one live "openai-codex"
// row (id 7) — enough to exercise the merge, sort, and secret-allowlist.
await writeFile(path.join(modules, "pi-ai", "auth-storage.js"), [
  "import { appendFileSync } from \"node:fs\";",
  "export class AuthStorage {",
  "  static async create(dbPath) { globalThis.dbPath = dbPath; return new AuthStorage(); }",
  "  async reload() {}",
  "  listStoredCredentials(provider) {",
  "    const rows = [",
  "      { id: 2, provider: \"anthropic\", credential: { type: \"oauth\", email: \"nitinphilip@gmail.com\", accessToken: \"secret-access\", refreshToken: \"secret-refresh\" } },",
  "      { id: 5, provider: \"anthropic\", credential: { type: \"oauth\", email: \"nathanrkx@gmail.com\", accessToken: \"secret-access-2\" } },",
  "      { id: 7, provider: \"openai-codex\", credential: { type: \"api_key\", apiKey: \"secret-key\" } },",
  "    ];",
  "    return provider ? rows.filter((row) => row.provider === provider) : rows;",
  "  }",
  "  async listDisabledCredentials() { return [{ id: 1, provider: \"openai-codex\", type: \"oauth\", accountId: \"acct-1\", cause: \"revoked\" }]; }",
  "  listCredentialBlocks(ids) { return ids.includes(2) ? [{ credentialId: 2, providerKey: \"anthropic\", blockScope: \"account\", blockedUntilMs: Date.now() + 3600_000 }, { credentialId: 2, providerKey: \"anthropic\", blockScope: \"stale\", blockedUntilMs: Date.now() - 3600_000 }] : []; }",
  "  async removeCredential(provider, id) {",
  "    appendFileSync(process.env.CODY_CREDENTIALS_FIXTURE_LOG, JSON.stringify({ op: \"remove\", provider, id }) + \"\\n\");",
  "    return provider === \"anthropic\" && id === 5;",
  "  }",
  "  async remove(provider) {",
  "    appendFileSync(process.env.CODY_CREDENTIALS_FIXTURE_LOG, JSON.stringify({ op: \"remove_provider\", provider }) + \"\\n\");",
  "  }",
  "  async close() {}",
  "}",
].join("\n"));

function resetDatabase() {
  const db = new DatabaseSync(dbPath);
  db.exec("DROP TRIGGER IF EXISTS auth_change_revision_auth_credentials_delete; DROP TABLE IF EXISTS auth_change_revision; DROP TABLE IF EXISTS auth_credential_blocks; DROP TABLE IF EXISTS auth_credential_refresh_leases; DROP TABLE IF EXISTS auth_credentials;");
  db.exec("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER, updated_at INTEGER);");
  db.exec("CREATE TABLE auth_credential_blocks (credential_id INTEGER NOT NULL, provider_key TEXT NOT NULL, block_scope TEXT NOT NULL DEFAULT '', blocked_until_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL);");
  db.exec("CREATE TABLE auth_credential_refresh_leases (credential_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);");
  // OMP's current auth store increments a revision row from a DELETE trigger.
  // Bun reports that trigger side effect in Statement.run().changes, so the
  // permanent-removal regression must cover the real trigger shape rather than
  // assuming a one-row changes count.
  db.exec("CREATE TABLE auth_change_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL); INSERT INTO auth_change_revision VALUES (1, 0); CREATE TRIGGER auth_change_revision_auth_credentials_delete AFTER DELETE ON auth_credentials BEGIN UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1; END;");
  const insert = db.prepare("INSERT INTO auth_credentials (id, provider, credential_type, data, disabled_cause, identity_key) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run(1, "openai-codex", "oauth", JSON.stringify({ accessToken: "secret-disabled" }), "revoked", "acct-1");
  insert.run(2, "anthropic", "oauth", JSON.stringify({ accessToken: "secret-blocked" }), null, "nitinphilip@gmail.com");
  insert.run(5, "anthropic", "oauth", JSON.stringify({ accessToken: "secret-removed" }), null, "nathanrkx@gmail.com");
  insert.run(7, "openai-codex", "api_key", JSON.stringify({ apiKey: "secret-key" }), null, null);
  db.prepare("INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)").run(5, "anthropic", "account", Date.now() + 3600_000, Date.now());
  db.prepare("INSERT INTO auth_credential_refresh_leases (credential_id, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)").run(5, "fixture", Date.now() + 3600_000, Date.now());
  db.close();
}

function databaseRows(sql, ...params) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(sql).all(...params);
  db.close();
  return rows;
}
const previousLog = process.env.CODY_CREDENTIALS_FIXTURE_LOG; process.env.CODY_CREDENTIALS_FIXTURE_LOG = nativeLog;
const deps = { helperPath: path.resolve(process.cwd(), "bin/cody-omp-credentials.mjs"), bunBin: process.execPath, packageRoot: () => packageRoot, agentDir: () => agentDir };
test.after(async () => { if (previousLog === undefined) delete process.env.CODY_CREDENTIALS_FIXTURE_LOG; else process.env.CODY_CREDENTIALS_FIXTURE_LOG = previousLog; await rm(fixtureDir, { recursive: true, force: true }); });

test("real child helper merges active and disabled rows, sorted by id, with no secret fields", async () => {
  const snapshot = await listOmpCredentials(deps);
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.credentials.map((row) => row.id), [1, 2, 5, 7]);
  for (const row of snapshot.credentials) {
    assert.deepEqual(Object.keys(row).sort(), ["blockedUntil", "disabledCause", "id", "identity", "planType", "provider", "type"]);
  }
});
test("identity resolves email for oauth rows and null for api_key rows", async () => {
  const snapshot = await listOmpCredentials(deps);
  const byId = new Map(snapshot.credentials.map((row) => [row.id, row]));
  assert.equal(byId.get(2)?.identity, "nitinphilip@gmail.com");
  assert.equal(byId.get(5)?.identity, "nathanrkx@gmail.com");
  assert.equal(byId.get(7)?.identity, null);
  assert.equal(byId.get(1)?.identity, "acct-1");
});
test("disabled rows carry their cause; active rows do not", async () => {
  const snapshot = await listOmpCredentials(deps);
  const byId = new Map(snapshot.credentials.map((row) => [row.id, row]));
  assert.equal(byId.get(1)?.disabledCause, "revoked");
  assert.equal(byId.get(2)?.disabledCause, null);
});
test("blockedUntil reports only the latest UNEXPIRED block, ignoring stale ones", async () => {
  const snapshot = await listOmpCredentials(deps);
  const blocked = snapshot.credentials.find((row) => row.id === 2);
  assert.ok(blocked?.blockedUntil);
  assert.ok(new Date(blocked.blockedUntil).getTime() > Date.now());
  const unblocked = snapshot.credentials.find((row) => row.id === 5);
  assert.equal(unblocked?.blockedUntil, null);
});
test("removeOmpCredential permanently removes the selected row and dependent state", async () => {
  resetDatabase();
  const outcome = await removeOmpCredential("anthropic", 5, deps);
  assert.equal(outcome.removed, true);
  assert.equal(outcome.providerRemoved, false);
  assert.equal(outcome.identity, "nathanrkx@gmail.com");
  assert.deepEqual(databaseRows("SELECT id FROM auth_credentials WHERE id = ?", 5), []);
  assert.deepEqual(databaseRows("SELECT credential_id FROM auth_credential_blocks WHERE credential_id = ?", 5), []);
  assert.deepEqual(databaseRows("SELECT credential_id FROM auth_credential_refresh_leases WHERE credential_id = ?", 5), []);
  assert.doesNotMatch(JSON.stringify(outcome), /secret-/);
});
test("removeOmpCredential surfaces a false outcome without throwing", async () => {
  resetDatabase();
  const outcome = await removeOmpCredential("anthropic", 999, deps);
  assert.equal(outcome.removed, false);
  assert.equal(outcome.providerRemoved, false);
});
test("removeOmpCredential permanently removes a disabled tombstone", async () => {
  resetDatabase();
  const outcome = await removeOmpCredential("openai-codex", 1, deps);
  assert.equal(outcome.removed, true);
  assert.equal(outcome.identity, "acct-1");
  assert.deepEqual(databaseRows("SELECT id FROM auth_credentials WHERE id = ?", 1), []);
});
test("removeOmpCredential does not remove a row when the provider and id do not match", async () => {
  resetDatabase();
  const outcome = await removeOmpCredential("openai-codex", 2, deps);
  assert.equal(outcome.removed, false);
  assert.equal(databaseRows("SELECT id FROM auth_credentials WHERE id = ?", 2)[0]?.id, 2);
});
test("permanent removal fails closed when the installed schema is unknown", async () => {
  const badDb = new DatabaseSync(path.join(badAgentDir, "agent.db"));
  badDb.exec("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY);");
  badDb.close();
  const outcome = await removeOmpCredential("anthropic", 2, { ...deps, agentDir: () => badAgentDir });
  assert.equal(outcome.removed, false);
  assert.equal(outcome.code, "credential_permanent_remove_failed");
  assert.match(outcome.message, /schema/);
});
test("removeOmpProvider always reports providerRemoved true", async () => {
  const outcome = await removeOmpProvider("openai-codex", deps);
  assert.equal(outcome.removed, true);
  assert.equal(outcome.providerRemoved, true);
  const nativeRequest = JSON.parse((await readFile(nativeLog, "utf8")).trim().split("\n").at(-1));
  assert.deepEqual(nativeRequest, { op: "remove_provider", provider: "openai-codex" });
});
test("a missing helper script degrades to unsupported instead of throwing", async () => {
  const brokenDeps = { ...deps, helperPath: path.join(fixtureDir, "missing-helper.mjs") };
  const snapshot = await listOmpCredentials(brokenDeps);
  assert.equal(snapshot.available, false);
  const removal = await removeOmpCredential("anthropic", 5, brokenDeps);
  assert.equal(removal.removed, false);
});
