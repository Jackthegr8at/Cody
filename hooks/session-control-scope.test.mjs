import assert from "node:assert/strict";
import test from "node:test";
import {
  isFastModeUnavailableError,
  sameSessionControlScope,
  sessionControlScope,
} from "./session-control-scope.ts";

test("session controls reject replies from another session or model", () => {
  const origin = sessionControlScope("session-a", { provider: "anthropic", modelId: "claude" });

  assert.equal(sameSessionControlScope(origin, sessionControlScope("session-a", { provider: "anthropic", modelId: "claude" })), true);
  assert.equal(sameSessionControlScope(origin, sessionControlScope("session-b", { provider: "anthropic", modelId: "claude" })), false);
  assert.equal(sameSessionControlScope(origin, sessionControlScope("session-a", { provider: "anthropic", modelId: "other" })), false);
});

test("only explicit Fast capability rejections disable Fast", () => {
  assert.equal(isFastModeUnavailableError(new Error("Fast mode is unavailable for the current model")), true);
  assert.equal(isFastModeUnavailableError({ code: "unsupported" }), true);
  assert.equal(isFastModeUnavailableError({ code: "unsupported", message: "unsupported command" }), true);
  assert.equal(isFastModeUnavailableError(new TypeError("Failed to fetch")), false);
  assert.equal(isFastModeUnavailableError(new Error("HTTP 503 upstream timed out")), false);
  assert.equal(isFastModeUnavailableError(new Error("unsupported command")), false);
});
