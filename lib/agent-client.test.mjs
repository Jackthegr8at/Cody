import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentCommandError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("preserves an engine rejection code for command-specific handling", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "Fast mode is unavailable for the current model",
    code: "unsupported",
  }), { status: 400, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(
      sendAgentCommand("session", { type: "set_fast_mode", enabled: true }),
      (error) => error instanceof AgentCommandError
        && error.code === "unsupported"
        && error.message === "Fast mode is unavailable for the current model",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
