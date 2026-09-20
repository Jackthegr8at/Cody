import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getDeviceBridge } = await jiti.import("./bus.ts");
const { attachDeviceSocket } = await jiti.import("./socket.ts");

function socket() {
  const listeners = new Map();
  return {
    readyState: 1,
    send() {},
    close() {},
    on(event, listener) { listeners.set(event, listener); },
    receive(frame) { listeners.get("message")(JSON.stringify(frame), false); },
    release() { listeners.get("close")(); },
  };
}

function frame(sessionId, operationId = "operation-1") {
  return {
    type: "operation.snapshot",
    operationId,
    snapshot: {
      id: operationId,
      sessionId,
      request: { protocol: "esp", action: "detect", deviceId: "serial-1" },
      state: "running",
      createdAt: 1,
      updatedAt: 2,
      output: [],
      events: [],
    },
  };
}

test("operation snapshots stay inside the socket-authenticated session", () => {
  const sessionId = `socket-session-${Date.now()}`;
  const fake = socket();
  attachDeviceSocket(sessionId, fake);
  const bridge = getDeviceBridge(sessionId);

  fake.receive(frame("other-session"));
  assert.equal(bridge.operationStatus("operation-1"), undefined);

  fake.receive(frame(sessionId));
  assert.equal(bridge.operationStatus("operation-1")?.sessionId, sessionId);
  fake.release();
});
