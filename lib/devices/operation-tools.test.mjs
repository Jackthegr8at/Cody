import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_OPERATION_TOOLS } = await jiti.import("./operation-tools.ts");

function tool(name) {
  const found = DEVICE_OPERATION_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

function bridge() {
  const starts = [];
  const cancels = [];
  const sends = [];
  return {
    attached: true,
    list() { return [{ id: "serial-1", label: "Bench UART", kind: "serial", open: true }]; },
    async startOperation(request) { starts.push(request); return "operation-1"; },
    async cancelOperation(id) { cancels.push(id); },
    async sendOperation(id, text) { sends.push({ id, text }); },
    operationStatus() { return undefined; },
    starts,
    cancels,
    sends,
  };
}

test("flash starts a durable operation with a bound artifact and never accepts approval options", async () => {
  const fake = bridge();
  const flash = tool("device_flash");
  const text = await flash.handler({
    device: "serial-1",
    protocol: "esp",
    target: "factory",
    offset: 0,
    fileId: "artifact-input",
    sha256: "a".repeat(64),
    options: { safety: { chip: "esp32" } },
  }, { bridge: fake });
  assert.match(text, /operation-1.*accepted/i);
  assert.deepEqual(fake.starts, [{
    deviceId: "serial-1",
    protocol: "esp",
    action: "flash",
    target: "factory",
    offset: 0,
    fileId: "artifact-input",
    sha256: "a".repeat(64),
    options: { safety: { chip: "esp32" } },
  }]);

  const blocked = await flash.handler({
    device: "serial-1",
    protocol: "esp",
    fileId: "artifact-input",
    sha256: "a".repeat(64),
    options: { approved: true },
  }, { bridge: fake });
  assert.match(blocked, /cannot carry an approval/i);
  assert.equal(fake.starts.length, 1);
});

test("monitor send and cancellation address a specific durable operation", async () => {
  const fake = bridge();
  const send = tool("device_monitor_send");
  const cancel = tool("device_operation_cancel");
  assert.match(await send.handler({ operationId: "operation-1", text: "status\n" }, { bridge: fake }), /sent monitor input/i);
  assert.match(await cancel.handler({ operationId: "operation-1" }, { bridge: fake }), /cancellation was sent/i);
  assert.deepEqual(fake.sends, [{ id: "operation-1", text: "status\n" }]);
  assert.deepEqual(fake.cancels, ["operation-1"]);
});
