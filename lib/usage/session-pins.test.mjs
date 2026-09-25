import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readSessionCredentialPins } = await jiti.import("./session-pins.ts");

const dir = await mkdtemp(path.join(os.tmpdir(), "cody-session-pins-"));
test.after(() => rm(dir, { recursive: true, force: true }));

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const pin = (provider, hash, timestamp) => JSON.stringify({ type: "credential_pin", id: "x", parentId: null, provider, hash, timestamp });
const message = (text) => JSON.stringify({ type: "message", id: "m", message: { role: "assistant", content: text } });

test("the latest pin per provider wins, across appends and a line omp is still writing", async () => {
  const file = path.join(dir, "session.jsonl");
  // A non-ASCII message line exercises the byte-exact resume offset.
  await writeFile(file, [
    JSON.stringify({ type: "session", version: 3, id: "s" }),
    pin("anthropic", HASH_A, "2026-09-20T03:33:46.355Z"),
    message("ünïcødé ✓ reply"),
    pin("openai-codex", HASH_C, "2026-09-20T04:01:48.648Z"),
    "",
  ].join("\n"));
  let pins = await readSessionCredentialPins(file);
  assert.equal(pins.get("anthropic")?.hash, HASH_A);
  assert.equal(pins.get("openai-codex")?.hash, HASH_C);

  // The account changes; omp appends a new pin, first half of the line only.
  const next = pin("anthropic", HASH_B, "2026-09-25T02:12:29.130Z");
  await appendFile(file, next.slice(0, 40));
  pins = await readSessionCredentialPins(file);
  assert.equal(pins.get("anthropic")?.hash, HASH_A, "a partial line is not read yet");

  await appendFile(file, next.slice(40) + "\n" + message("done") + "\n");
  pins = await readSessionCredentialPins(file);
  assert.equal(pins.get("anthropic")?.hash, HASH_B);
  assert.equal(pins.get("anthropic")?.timestamp, "2026-09-25T02:12:29.130Z");
  assert.equal(pins.get("openai-codex")?.hash, HASH_C, "other providers keep their own latest pin");
});

test("a replaced (shorter) file is rescanned from the start", async () => {
  const file = path.join(dir, "replaced.jsonl");
  await writeFile(file, pin("anthropic", HASH_A, null) + "\n" + message("x".repeat(500)) + "\n");
  assert.equal((await readSessionCredentialPins(file)).get("anthropic")?.hash, HASH_A);
  await writeFile(file, pin("anthropic", HASH_B, null) + "\n");
  assert.equal((await readSessionCredentialPins(file)).get("anthropic")?.hash, HASH_B);
});

test("malformed pins and a missing file answer 'not used yet', never throw", async () => {
  const file = path.join(dir, "malformed.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "credential_pin", provider: "anthropic", hash: "not-a-digest" }),
    JSON.stringify({ type: "credential_pin", hash: HASH_A }),
    '{"type":"credential_pin", broken',
    "",
  ].join("\n"));
  assert.equal((await readSessionCredentialPins(file)).size, 0);
  assert.equal((await readSessionCredentialPins(path.join(dir, "absent.jsonl"))).size, 0);
});
