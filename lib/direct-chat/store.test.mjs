import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { directChatStorageKey, readDirectChatConversation, writeDirectChatConversation } = await jiti.import("./store.ts");

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("direct conversations are partitioned by account and workspace without truncating history", () => {
  globalThis.window = { localStorage: createStorage() };
  const messages = Array.from({ length: 81 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `message ${index}` }));
  writeDirectChatConversation("account-a", "/workspace/a", { messages, modelKey: "model-a", reasoningEffort: null, fast: false });
  assert.equal(readDirectChatConversation("account-a", "/workspace/a").messages.length, 81);
  assert.deepEqual(readDirectChatConversation("account-b", "/workspace/a").messages, []);
  assert.deepEqual(readDirectChatConversation("account-a", "/workspace/b").messages, []);
  assert.notEqual(directChatStorageKey("account-a", "/workspace/a"), directChatStorageKey("account-b", "/workspace/a"));
});
