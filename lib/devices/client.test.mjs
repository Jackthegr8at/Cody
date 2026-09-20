import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DeviceLeaseBook } = await jiti.import("./device-leases.ts");
const { QuietReadGate } = await jiti.import("./quiet-read.ts");
const { stableUsbIdentity } = await jiti.import("./usb-identity.ts");
const { SessionConnectionPool } = await jiti.import("./session-connections.ts");

test("a page-global device lease refuses cross-session use and raw-operation races", () => {
  const leases = new DeviceLeaseBook();
  leases.claim("session-a", "usb-1");
  assert.throws(() => leases.claimForRawOperation("session-b", "usb-1"), /another session/);

  const borrow = leases.borrow("session-a", "usb-1");
  assert.equal(leases.isBorrowed("usb-1"), true);
  assert.throws(() => leases.claimForRawOperation("session-a", "usb-1"), /exclusively reserved/);
  borrow.release();
  assert.equal(leases.isBorrowed("usb-1"), false);
  leases.release("session-a", "usb-1");
  const raw = leases.claimForRawOperation("session-b", "usb-1");
  assert.throws(() => leases.borrow("session-b", "usb-1"), /exclusively reserved/);
  raw.release();
  leases.claimForRawOperation("session-b", "usb-1");
});

test("a quiet USB deadline preserves the one late transfer for the next reader", async () => {
  let resolveTransfer;
  let transferCount = 0;
  const gate = new QuietReadGate(
    () => {
      transferCount += 1;
      return new Promise((resolve) => { resolveTransfer = resolve; });
    },
    async () => {},
  );

  const quiet = await gate.read(1);
  assert.deepEqual(quiet, { value: null, noData: true });
  const next = gate.read(100);
  const bytes = new Uint8Array([0x46, 0x42]);
  resolveTransfer(bytes);
  const received = await next;
  assert.equal(transferCount, 1);
  assert.equal(received.noData, false);
  assert.deepEqual([...received.value], [0x46, 0x42]);
});

test("cancelling an owned native read invalidates it instead of abandoning a transfer", async () => {
  let invalidated = 0;
  let resolveTransfer;
  const gate = new QuietReadGate(
    () => new Promise((resolve) => { resolveTransfer = resolve; }),
    async () => { invalidated += 1; },
  );
  const controller = new AbortController();
  const pending = gate.read(100, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof Error && error.name === "AbortError");
  resolveTransfer(new Uint8Array([0x99]));
  await Promise.resolve();
  await assert.rejects(gate.read(10), /no longer valid/);
  assert.equal(invalidated, 1);
});

test("only a full USB vendor/product/serial identity is safe to re-adopt", () => {
  assert.equal(stableUsbIdentity({ vendorId: 0x18d1, productId: 0x4ee0, serialNumber: "board-7" }), "usb:18d1:4ee0:board-7");
  assert.equal(stableUsbIdentity({ vendorId: 0x18d1, productId: 0x4ee0, serialNumber: null }), null);
});

test("USB descriptor candidates preserve protocol interface and alternate selection", async () => {
  const priorWindow = globalThis.window;
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const device = {
    vendorId: 0x18d1,
    productId: 0x4ee0,
    serialNumber: "boot-target",
    productName: "Boot target",
    manufacturerName: "Google",
    opened: false,
    close: async () => {},
    forget: async () => {},
    configurations: [{ interfaces: [
      { interfaceNumber: 2, alternates: [{ alternateSetting: 1, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 0x01 }] },
      { interfaceNumber: 3, alternates: [{ alternateSetting: 4, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 0x03 }] },
      { interfaceNumber: 4, alternates: [{ alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 0x01, interfaceProtocol: 0x02 }] },
      { interfaceNumber: 5, alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 0x02 }] },
    ] }],
  };
  globalThis.window = { isSecureContext: true };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { usb: { requestDevice: async () => device } } });
  const { forgetDevice, requestUsbDevice } = await jiti.import("./client.ts");
  try {
    const info = await requestUsbDevice();
    assert.deepEqual(info.protocolCandidates, [
      { protocol: "adb", interfaceNumber: 2, alternateSetting: 1 },
      { protocol: "fastboot", interfaceNumber: 3, alternateSetting: 4 },
      { protocol: "dfu", interfaceNumber: 4, alternateSetting: 0 },
    ]);
    await forgetDevice(info.id);
  } finally {
    globalThis.window = priorWindow;
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else delete globalThis.navigator;
  }
});

test("switching sessions retains an owned bridge but releases an unowned idle bridge", () => {
  const created = [];
  const pool = new SessionConnectionPool((sessionId) => {
    const connection = {
      sessionId,
      idle: false,
      starts: 0,
      destroyed: 0,
      start() { this.starts += 1; },
      destroy() { this.destroyed += 1; },
      isIdle() { return this.idle; },
    };
    created.push(connection);
    return connection;
  });

  const first = pool.retain("session-a");
  first.release();
  const resumed = pool.retain("session-a");
  assert.equal(resumed.connection, first.connection);
  assert.equal(resumed.connection.starts, 2);

  resumed.connection.idle = true;
  resumed.release();
  assert.equal(first.connection.destroyed, 1);
  const replacement = pool.retain("session-a");
  assert.notEqual(replacement.connection, first.connection);
  replacement.release();
});

test("USB leases reopen sequentially while released transports stay unusable", async () => {
  const priorWindow = globalThis.window, priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const alternate = { alternateSetting: 0, interfaceClass: 255, interfaceSubclass: 66, interfaceProtocol: 3, endpoints: [{ endpointNumber: 1, direction: "in", type: "bulk" }, { endpointNumber: 1, direction: "out", type: "bulk" }] };
  const iface = { interfaceNumber: 0, claimed: false, alternate, alternates: [alternate] };
  const configuration = { configurationValue: 1, interfaces: [iface] };
  let writes = 0, opens = 0;
  const device = { vendorId: 1, productId: 2, serialNumber: "sequential-leases", opened: false, configuration, configurations: [configuration],
    async open() { this.opened = true; opens++; }, async close() { this.opened = false; iface.claimed = false; }, async forget() {},
    async claimInterface() { iface.claimed = true; }, async releaseInterface() { iface.claimed = false; },
    async transferOut() { writes++; return { status: "ok", bytesWritten: 1 }; },
  };
  globalThis.window = { isSecureContext: true };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { usb: Object.assign(new EventTarget(), { requestDevice: async () => device }) } });
  const { DeviceBridgeConnection, forgetDevice } = await jiti.import("./client.ts");
  let id;
  try {
    const connection = new DeviceBridgeConnection("sequential-lease-test");
    id = (await connection.requestDevice("usb")).id;
    const first = await connection.borrowHardwareTransport(id);
    await first.transport.write(Uint8Array.of(1), new AbortController().signal);
    await first.release();
    const second = await connection.borrowHardwareTransport(id);
    await assert.rejects(first.transport.write(Uint8Array.of(2), new AbortController().signal), /lease ended/);
    await second.transport.write(Uint8Array.of(3), new AbortController().signal);
    await second.release();
    assert.equal(opens, 2); assert.equal(writes, 2);
  } finally {
    if (id) await forgetDevice(id);
    globalThis.window = priorWindow;
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator); else delete globalThis.navigator;
  }
});
