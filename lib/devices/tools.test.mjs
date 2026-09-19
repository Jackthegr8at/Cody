import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEVICE_TOOLS, DEVICE_TOOL_NAMES } = await jiti.import("./tools.ts");

function tool(name) {
  const found = DEVICE_TOOLS.find((entry) => entry.name === name);
  assert.ok(found, `${name} is not in the registry`);
  return found;
}

function device(overrides = {}) {
  return { id: "dev-1", kind: "serial", label: "Arduino Uno", open: false, buffered: 0, ...overrides };
}

const CAPS = { secureContext: true, serial: true, usb: true, bluetooth: true, serialViaUsb: false, platform: "test" };

/** A DeviceBridge stand-in exposing only what lib/devices/tools.ts calls:
 * attached, capabilities, list(), read(), request(). Every request() call is
 * recorded so a test can assert an operation was (or was not) attempted —
 * never a real socket, never bus.ts. */
function fakeBridge({ attached = true, devices = [], readResult = { data: Buffer.alloc(0), dropped: 0 }, requestImpl } = {}) {
  const calls = [];
  return {
    attached,
    capabilities: CAPS,
    calls,
    list: () => devices,
    read: () => readResult,
    request: async (op, deviceId, params) => {
      calls.push({ op, deviceId, params });
      if (requestImpl) return requestImpl(op, deviceId, params);
      return undefined;
    },
  };
}

// The roster grows as hardware surfaces are added, so the invariant is that
// every entry is dispatchable and uniquely named — not which entries exist.
test("every registered tool is uniquely named and dispatchable", () => {
  assert.equal(new Set(DEVICE_TOOL_NAMES).size, DEVICE_TOOL_NAMES.length);
  for (const name of DEVICE_TOOL_NAMES) {
    const found = tool(name);
    assert.equal(typeof found.handler, "function", `${name} has a handler`);
    assert.equal(found.parameters.type, "object", `${name} declares an object schema`);
  }
});

test("device_list with nothing attached names the panel as the fix", async () => {
  const bridge = fakeBridge({ attached: false });
  const text = await tool("device_list").handler({}, { bridge });
  assert.equal(text, "No browser is attached to this session. Open Cody's Devices panel and connect a device.");
});

test("an ambiguous device name returns candidates and performs no operation", async () => {
  const devices = [device({ id: "a1", label: "USB Serial Adapter" }), device({ id: "a2", label: "USB Serial Console" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("device_open").handler({ device: "usb" }, { bridge });
  assert.match(text, /Multiple devices match "usb"/);
  assert.match(text, /a1 \|/);
  assert.match(text, /a2 \|/);
  assert.equal(bridge.calls.length, 0);
});

test("omitting device with several attached lists them all as candidates", async () => {
  const devices = [device({ id: "a1", label: "Alpha" }), device({ id: "a2", label: "Beta" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("device_close").handler({}, { bridge });
  assert.match(text, /^Multiple devices are attached; pass device to pick one:/);
  assert.equal(bridge.calls.length, 0);
});

test("omitting device resolves to the sole attached device", async () => {
  const devices = [device({ id: "only", label: "Only Device" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("device_close").handler({}, { bridge });
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].deviceId, "only");
  assert.match(text, /Closed Only Device/);
});

test("a device_close with no attached devices explains how to attach one", async () => {
  const bridge = fakeBridge({ attached: true, devices: [] });
  const text = await tool("device_close").handler({}, { bridge });
  assert.equal(text, "No device is attached. Open Cody's Devices panel and grant access to one.");
});

test("a named device with no match is a short not-found, distinct from the no-browser hint", async () => {
  const devices = [device({ id: "d1", label: "Console" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("device_close").handler({ device: "nope" }, { bridge });
  assert.equal(text, 'No device matches "nope". Run device_list to see what is attached.');
});

test("device_read reports bytes the ring buffer dropped", async () => {
  const devices = [device({ id: "d1", label: "Console" })];
  const bridge = fakeBridge({ devices, readResult: { data: Buffer.from("hi"), dropped: 42 } });
  const text = await tool("device_read").handler({ device: "d1" }, { bridge });
  assert.match(text, /^2 bytes from Console \(text\):\nhi/);
  assert.match(text, /42 bytes were dropped by the ring buffer/);
});

test("device_read says nothing about drops when none happened", async () => {
  const devices = [device({ id: "d1", label: "Console" })];
  const bridge = fakeBridge({ devices, readResult: { data: Buffer.from("hi"), dropped: 0 } });
  const text = await tool("device_read").handler({ device: "d1" }, { bridge });
  assert.doesNotMatch(text, /dropped/);
});

test("device_write rejects both text and base64, and neither, without touching the bridge", async () => {
  const devices = [device({ id: "d1", label: "Console" })];
  const bridge = fakeBridge({ devices });
  const both = await tool("device_write").handler({ device: "d1", text: "hi", base64: "aGk=" }, { bridge });
  assert.match(both, /exactly one of text or base64/);
  const neither = await tool("device_write").handler({ device: "d1" }, { bridge });
  assert.match(neither, /either text or base64/);
  assert.equal(bridge.calls.length, 0);
});

test("device_write refuses a BLE or raw USB device instead of guessing an op", async () => {
  const bleBridge = fakeBridge({ devices: [device({ id: "b1", label: "Heart Rate", kind: "ble" })] });
  const bleText = await tool("device_write").handler({ device: "b1", text: "hi" }, { bridge: bleBridge });
  assert.match(bleText, /use ble_gatt/);
  assert.equal(bleBridge.calls.length, 0);

  const usbBridge = fakeBridge({ devices: [device({ id: "u1", label: "Flasher", kind: "usb" })] });
  const usbText = await tool("device_write").handler({ device: "u1", text: "hi" }, { bridge: usbBridge });
  assert.match(usbText, /not yet exposed/);
  assert.equal(usbBridge.calls.length, 0);
});

test("device_open dispatches serial.open with the default baud rate", async () => {
  const devices = [device({ id: "d1", label: "Console", kind: "serial" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("device_open").handler({ device: "d1" }, { bridge });
  assert.deepEqual(bridge.calls, [{ op: "serial.open", deviceId: "d1", params: { baudRate: 115200 } }]);
  assert.match(text, /115200 baud/);
});

test("device_open dispatches ble.connect and usb.open by device kind", async () => {
  const bleBridge = fakeBridge({ devices: [device({ id: "b1", label: "Heart Rate", kind: "ble" })] });
  await tool("device_open").handler({ device: "b1" }, { bridge: bleBridge });
  assert.equal(bleBridge.calls[0].op, "ble.connect");

  const usbBridge = fakeBridge({ devices: [device({ id: "u1", label: "Flasher", kind: "usb" })] });
  await tool("device_open").handler({ device: "u1" }, { bridge: usbBridge });
  assert.equal(usbBridge.calls[0].op, "usb.open");
});

test("device_open rejects an out-of-range serial parameter before calling the bridge", async () => {
  const devices = [device({ id: "d1", label: "Console" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("device_open").handler({ device: "d1", dataBits: 6 }, { bridge });
  assert.match(text, /dataBits must be 7 or 8/);
  assert.equal(bridge.calls.length, 0);
});

test("device_close sends the same close op regardless of device kind", async () => {
  const bridge = fakeBridge({ devices: [device({ id: "b1", label: "Heart Rate", kind: "ble" })] });
  await tool("device_close").handler({ device: "b1" }, { bridge });
  assert.equal(bridge.calls[0].op, "close");
});

test("ble_gatt refuses a non-BLE device instead of guessing", async () => {
  const devices = [device({ id: "d1", label: "Console", kind: "serial" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("ble_gatt").handler({ device: "d1", op: "services" }, { bridge });
  assert.match(text, /not BLE/);
  assert.equal(bridge.calls.length, 0);
});

test("ble_gatt requires service and characteristic outside of services", async () => {
  const devices = [device({ id: "b1", label: "Heart Rate", kind: "ble" })];
  const bridge = fakeBridge({ devices });
  const text = await tool("ble_gatt").handler({ device: "b1", op: "read" }, { bridge });
  assert.match(text, /requires both service and characteristic/);
  assert.equal(bridge.calls.length, 0);
});

test("ble_gatt subscribe and unsubscribe both ride ble.subscribe with the right enable flag", async () => {
  const bridge = fakeBridge({ devices: [device({ id: "b1", label: "Heart Rate", kind: "ble" })] });
  await tool("ble_gatt").handler({ device: "b1", op: "subscribe", service: "180d", characteristic: "2a37" }, { bridge });
  await tool("ble_gatt").handler({ device: "b1", op: "unsubscribe", service: "180d", characteristic: "2a37" }, { bridge });
  assert.deepEqual(
    bridge.calls.map((call) => call.params.enable),
    [true, false],
  );
});

test("a rejected bridge request surfaces as plain text, never a throw", async () => {
  const devices = [device({ id: "d1", label: "Console" })];
  const bridge = fakeBridge({
    devices,
    requestImpl: async () => {
      throw new Error("The browser did not answer serial.open within 20s.");
    },
  });
  const text = await tool("device_open").handler({ device: "d1" }, { bridge });
  assert.equal(text, "The browser did not answer serial.open within 20s.");
});

const usbDevice = () => device({ id: "u1", kind: "usb", label: "MT65xx Preloader", open: true });

test("a control transfer is selected by request and carries its defaults", async () => {
  const bridge = fakeBridge({ devices: [usbDevice()], requestImpl: () => ({ base64: Buffer.from("OKAY").toString("base64") }) });
  const text = await tool("usb_transfer").handler({ direction: "in", request: 6, value: 256, length: 18 }, { bridge });
  assert.equal(bridge.calls[0].op, "usb.control");
  assert.equal(bridge.calls[0].params.requestType, "vendor");
  assert.equal(bridge.calls[0].params.recipient, "device");
  assert.equal(bridge.calls[0].params.index, 0);
  assert.match(text, /OKAY/);
});

test("an endpoint transfer rides usb.transfer and reports what it sent", async () => {
  const bridge = fakeBridge({ devices: [usbDevice()] });
  const text = await tool("usb_transfer").handler({ direction: "out", endpoint: 1, text: "getvar:product" }, { bridge });
  assert.equal(bridge.calls[0].op, "usb.transfer");
  assert.equal(bridge.calls[0].params.endpoint, 1);
  assert.equal(Buffer.from(bridge.calls[0].params.base64, "base64").toString(), "getvar:product");
  assert.match(text, /Sent 14 bytes/);
});

// Asking for bytes without saying how many is the mistake that would
// otherwise reach the page as an undefined length and read nothing.
test("an IN transfer without length is refused before any wire op", async () => {
  const bridge = fakeBridge({ devices: [usbDevice()] });
  const text = await tool("usb_transfer").handler({ direction: "in", endpoint: 1 }, { bridge });
  assert.match(text, /needs length/);
  assert.equal(bridge.calls.length, 0);
});

test("usb_transfer refuses a device of another kind", async () => {
  const bridge = fakeBridge({ devices: [device({ id: "s1", kind: "serial", open: true })] });
  const text = await tool("usb_transfer").handler({ direction: "in", endpoint: 1, length: 8 }, { bridge });
  assert.match(text, /not raw USB/);
  assert.equal(bridge.calls.length, 0);
});
