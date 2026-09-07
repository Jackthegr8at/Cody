import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_PROMPT_IMAGE,
  SESSION_PROMPT_STEERING,
  sessionPromptCapabilityBits,
} from "./session-prompt-capabilities.ts";

test("session steering and image controls stay off until the engine explicitly enables each", () => {
  assert.equal(sessionPromptCapabilityBits(undefined), 0);
  assert.equal(sessionPromptCapabilityBits({ imageSupported: true, steeringSupported: false }), SESSION_PROMPT_IMAGE);
  assert.equal(sessionPromptCapabilityBits({ imageSupported: false, steeringSupported: true }), SESSION_PROMPT_STEERING);
  assert.equal(
    sessionPromptCapabilityBits({ imageSupported: true, steeringSupported: true }),
    SESSION_PROMPT_IMAGE | SESSION_PROMPT_STEERING,
  );
});
