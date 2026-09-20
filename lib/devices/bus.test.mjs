import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceBridge, matchDevice } = await jiti.import("./bus.ts");
const { DEVICE_BUFFER_BYTES } = await jiti.import("./protocol.ts");

const device = (id, label, over = {}) => ({ id, label, kind: "serial", open: false, ...over });

test("an unattached bridge refuses rather than waiting for a browser", async () => {
  const bridge = new DeviceBridge();
  assert.equal(bridge.attached, false);
  // The device host being absent is an ordinary state — a closed tab, a locked
  // phone — so the tool call must fail immediately and say what to do.
  await assert.rejects(bridge.request("serial.write", "d1", { base64: "" }), /No browser is attached/);
});

test("a request rides to the attached page and settles on its result", async () => {
  const bridge = new DeviceBridge();
  const sent = [];
  bridge.attach((frame) => sent.push(frame));
  const pending = bridge.request("serial.open", "d1", { baudRate: 115200 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].op, "serial.open");
  assert.equal(sent[0].deviceId, "d1");
  bridge.settle(sent[0].id, true, { opened: true });
  assert.deepEqual(await pending, { opened: true });

  const failing = bridge.request("serial.write", "d1", { base64: "AA==" });
  bridge.settle(sent[1].id, false, undefined, "Port is closed");
  await assert.rejects(failing, /Port is closed/);
});

test("detaching fails every in-flight call instead of stranding it", async () => {
  const bridge = new DeviceBridge();
  const detach = bridge.attach(() => {});
  const pending = bridge.request("serial.open", "d1", {});
  detach();
  await assert.rejects(pending, /disconnected/);
  assert.equal(bridge.attached, false);
  // The grants belonged to that page, so nothing is reachable any more.
  assert.deepEqual(bridge.list(), []);
});

test("inbound bytes buffer in order and drain oldest-first", () => {
  const bridge = new DeviceBridge();
  bridge.setDevices([device("d1", "CP2102")]);
  bridge.push("d1", Buffer.from("hello "));
  bridge.push("d1", Buffer.from("world"));
  assert.equal(bridge.buffered("d1"), 11);
  const first = bridge.read("d1", 5);
  assert.equal(first.data.toString(), "hello");
  assert.equal(first.dropped, 0);
  assert.equal(bridge.read("d1", 100).data.toString(), " world");
  assert.equal(bridge.buffered("d1"), 0);
});

test("an overflowing console keeps the newest window and reports the gap", () => {
  const bridge = new DeviceBridge();
  bridge.setDevices([device("d1", "CP2102")]);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (let i = 0; i < 8; i += 1) bridge.push("d1", chunk);
  assert.ok(bridge.buffered("d1") <= DEVICE_BUFFER_BYTES);
  const { dropped } = bridge.read("d1", 10);
  // Silence and overflow must not look the same to the agent.
  assert.ok(dropped > 0, "dropped bytes are reported, not swallowed");
  assert.equal(bridge.read("d1", 10).dropped, 0, "the gap is reported once");
});

test("a device the page dropped takes its buffer with it", () => {
  const bridge = new DeviceBridge();
  bridge.setDevices([device("d1", "CP2102")]);
  bridge.push("d1", Buffer.from("data"));
  bridge.removeDevice("d1");
  assert.deepEqual(bridge.list(), []);
  assert.equal(bridge.buffered("d1"), 0);
});

test("a device is addressed by id or label, and ambiguity is reported", () => {
  const devices = [device("d1", "CP2102 USB to UART"), device("d2", "CH340 serial"), device("d3", "CP2102 second one")];
  assert.equal(matchDevice(devices, "d2").device.id, "d2");
  assert.equal(matchDevice(devices, "ch340").device.id, "d2");
  // Writing to the wrong serial port is not something a later call can undo,
  // so two matches are candidates, never a guess.
  const many = matchDevice(devices, "cp2102");
  assert.equal(many.kind, "many");
  assert.deepEqual(many.candidates.map((d) => d.id), ["d1", "d3"]);
  assert.equal(matchDevice(devices, "nothing").kind, "none");
  // One device and no argument is unambiguous; several is not.
  assert.equal(matchDevice([devices[0]], undefined).device.id, "d1");
  assert.equal(matchDevice(devices, undefined).kind, "many");
});

test("the roster reports what is buffered so a reader knows to drain", () => {
  const bridge = new DeviceBridge();
  bridge.setDevices([device("d1", "CP2102", { open: true })]);
  bridge.push("d1", Buffer.from("xyz"));
  assert.equal(bridge.list()[0].buffered, 3);
});

test("both directions of a transfer are counted where the bytes actually pass", async () => {
  const bridge = new DeviceBridge();
  const sent = [];
  bridge.attach((frame) => sent.push(frame));
  bridge.setDevices([device("u1", "MT65xx Preloader", { kind: "usb", open: true })]);

  const payload = Buffer.from("getvar:product").toString("base64");
  const pending = bridge.request("usb.transfer", "u1", { direction: "out", endpoint: 1, base64: payload });
  // An op still awaiting the page is the difference between a slow link and a
  // dead one, so it is reported while it runs, not only once it returns.
  const during = bridge.activitySnapshot()[0];
  assert.equal(during.inFlight?.op, "usb.transfer");
  assert.equal(during.bytesOut, 14);

  bridge.settle(sent[0].id, true, { base64: Buffer.from("OKAYbiscuit").toString("base64") });
  await pending;
  const after = bridge.activitySnapshot()[0];
  assert.equal(after.inFlight, null);
  assert.equal(after.ops, 1);
  // An answer's payload is real inbound traffic, not an aside to the op.
  assert.equal(after.bytesIn, 11);
  assert.equal(after.lastError, null);
});

test("a stalled link reports why instead of going quiet", async () => {
  const bridge = new DeviceBridge();
  bridge.attach(() => { throw new Error("The device socket is closed."); });
  bridge.setDevices([device("d1", "Console")]);
  await assert.rejects(bridge.request("serial.write", "d1", { base64: "AA==" }));
  const activity = bridge.activitySnapshot()[0];
  assert.equal(activity.inFlight, null);
  assert.match(activity.lastError, /socket is closed/);
});

test("dropped bytes stay counted after the reader consumed the gap", () => {
  const bridge = new DeviceBridge();
  bridge.attach(() => {});
  bridge.setDevices([device("d1", "Console")]);
  bridge.push("d1", Buffer.alloc(DEVICE_BUFFER_BYTES + 4096, 1));
  bridge.read("d1", 64);
  // The per-read gap is consumed by that read; the lifetime total is what the
  // activity feed shows, and a total that went backwards would be nonsense.
  assert.ok(bridge.activitySnapshot()[0].dropped >= 4096);
});

test("a device with no traffic still has a row, reading as nothing yet", () => {
  const bridge = new DeviceBridge();
  bridge.attach(() => {});
  bridge.setDevices([device("d1", "Console")]);
  const [activity] = bridge.activitySnapshot();
  // Omitting the row would read as "no such link" rather than "quiet link".
  assert.equal(activity.deviceId, "d1");
  assert.equal(activity.bytesIn, 0);
  assert.equal(activity.lastActivityAt, null);
});

test("a quiet link's rate decays to zero rather than reporting its peak", () => {
  const bridge = new DeviceBridge();
  bridge.attach(() => {});
  bridge.setDevices([device("d1", "Console")]);
  bridge.push("d1", Buffer.alloc(3000, 7));
  assert.ok(bridge.activitySnapshot()[0].rateIn > 0);
  const stale = Date.now() + 10_000;
  const original = Date.now;
  Date.now = () => stale;
  try {
    const activity = bridge.activitySnapshot()[0];
    assert.equal(activity.rateIn, 0);
    // The cumulative total must survive the rate going quiet.
    assert.equal(activity.bytesIn, 3000);
  } finally {
    Date.now = original;
  }
});
