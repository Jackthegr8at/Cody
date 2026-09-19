/**
 * The server half of the browser-hosted device bridge (see ./protocol.ts).
 *
 * One bridge per session, held in a `globalThis` map for the same reason the
 * display bus is: a plain module-level Map does not survive Next's hot reload,
 * and losing the bridge would mean losing the page's device grants with it.
 *
 * The server owns no handles. It holds three things: what the page said it can
 * do, what it currently has open, and the bytes that arrived while the agent
 * was not looking. Everything else is a request relayed to the page and a
 * result relayed back.
 *
 * A device is addressed the way a session is (lib/session-tools.ts): exact id
 * first, then a case-insensitive substring of the label, and more than one
 * match returns the candidates rather than guessing. Picking the wrong serial
 * port and writing to it is not a recoverable mistake.
 */

import {
  DEVICE_BUFFER_BYTES,
  DEVICE_OP_TIMEOUT_MS,
  NO_CAPABILITIES,
  type DeviceCapabilities,
  type DeviceInfo,
  type DeviceOpName,
  type DeviceRequestFrame,
} from "./protocol";

type Sender = (frame: DeviceRequestFrame) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Newest-window byte buffer for one device, with an honest drop count. */
class DeviceBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private dropped = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > DEVICE_BUFFER_BYTES && this.chunks.length > 0) {
      const oldest = this.chunks.shift()!;
      this.bytes -= oldest.length;
      this.dropped += oldest.length;
    }
  }

  get length(): number {
    return this.bytes;
  }

  /** Take up to `maxBytes` of the OLDEST data, with however much was dropped
   * before it. Reporting the gap matters: a console that overflowed and one
   * that merely paused look identical otherwise. */
  drain(maxBytes: number): { data: Buffer; dropped: number } {
    const dropped = this.dropped;
    this.dropped = 0;
    if (this.chunks.length === 0) return { data: Buffer.alloc(0), dropped };
    const joined = Buffer.concat(this.chunks);
    const take = Math.max(0, Math.min(maxBytes, joined.length));
    const data = joined.subarray(0, take);
    const rest = joined.subarray(take);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.bytes = rest.length;
    return { data, dropped };
  }
}

/** Buffer key for one stream of inbound bytes. A NUL separator cannot occur
 * in a device id or a GATT UUID, so the two halves are always recoverable. */
function sourceKey(deviceId: string, characteristic?: string): string {
  return characteristic ? `${deviceId}\u0000${characteristic}` : deviceId;
}

function sourceDevice(key: string): string {
  const separator = key.indexOf("\u0000");
  return separator < 0 ? key : key.slice(0, separator);
}

function sourceCharacteristic(key: string): string | null {
  const separator = key.indexOf("\u0000");
  return separator < 0 ? null : key.slice(separator + 1);
}

export class DeviceBridge {
  capabilities: DeviceCapabilities = NO_CAPABILITIES;
  private devices = new Map<string, DeviceInfo>();
  private buffers = new Map<string, DeviceBuffer>();
  /** Readers parked on `waitForData`, keyed by device. */
  private waiters = new Map<string, Set<() => void>>();
  private pending = new Map<string, Pending>();
  private send: Sender | null = null;
  private nextOpId = 1;
  private listeners = new Set<() => void>();

  get attached(): boolean {
    return this.send !== null;
  }

  /** A page took over as device host. Only one at a time: two tabs each
   * holding their own grants would make "device 2" mean different hardware
   * depending on which answered, so the newest attach wins and the previous
   * socket is dropped by its own caller. */
  attach(send: Sender): () => void {
    this.send = send;
    this.notify();
    return () => {
      if (this.send !== send) return;
      this.send = null;
      // Every grant belonged to that page: nothing is reachable now.
      this.devices.clear();
      this.failAllPending("The browser holding this device disconnected.");
      this.notify();
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener must never break the bridge.
      }
    }
  }

  setCapabilities(capabilities: DeviceCapabilities): void {
    this.capabilities = capabilities;
    this.notify();
  }

  setDevices(devices: DeviceInfo[]): void {
    const next = new Map<string, DeviceInfo>();
    for (const device of devices) next.set(device.id, device);
    this.devices = next;
    for (const id of [...this.buffers.keys()]) {
      if (!next.has(id)) this.buffers.delete(id);
    }
    this.notify();
  }

  removeDevice(deviceId: string): void {
    this.devices.delete(deviceId);
    for (const key of [...this.buffers.keys()]) {
      if (sourceDevice(key) === deviceId) this.buffers.delete(key);
    }
    this.wake(deviceId);
    this.notify();
  }

  list(): DeviceInfo[] {
    return [...this.devices.values()].map((device) => ({
      ...device,
      buffered: this.buffered(device.id),
    }));
  }

  /**
   * Inbound bytes from the page, buffered per SOURCE.
   *
   * A BLE device can notify on several characteristics at once, and merging
   * those into one stream would hand the agent interleaved bytes with no way
   * to tell which characteristic produced them — for binary GATT payloads
   * that is not a formatting problem, it is corruption. Serial and USB have
   * exactly one source, so their key is the device itself.
   */
  push(deviceId: string, data: Buffer, characteristic?: string): void {
    const key = sourceKey(deviceId, characteristic);
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = new DeviceBuffer();
      this.buffers.set(key, buffer);
    }
    buffer.push(data);
    this.wake(deviceId);
  }

  read(deviceId: string, maxBytes: number, characteristic?: string): { data: Buffer; dropped: number } {
    return this.buffers.get(sourceKey(deviceId, characteristic))?.drain(maxBytes) ?? { data: Buffer.alloc(0), dropped: 0 };
  }

  /** Bytes waiting for one source, or across every source of a device. */
  buffered(deviceId: string, characteristic?: string): number {
    if (characteristic !== undefined) return this.buffers.get(sourceKey(deviceId, characteristic))?.length ?? 0;
    let total = 0;
    for (const [key, buffer] of this.buffers) {
      if (sourceDevice(key) === deviceId) total += buffer.length;
    }
    return total;
  }

  /** Which characteristics of a BLE device have unread bytes, so a reader can
   * be told what it is choosing between instead of guessing. */
  sources(deviceId: string): string[] {
    const found: string[] = [];
    for (const [key, buffer] of this.buffers) {
      if (sourceDevice(key) !== deviceId || buffer.length === 0) continue;
      const characteristic = sourceCharacteristic(key);
      if (characteristic) found.push(characteristic);
    }
    return found;
  }

  /**
   * Resolve as soon as bytes arrive for this device, or when the wait runs
   * out. A reader that polled instead would trade either latency or wasted
   * wakeups for nothing: the page tells us the moment data lands.
   */
  waitForData(deviceId: string, timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0 || this.buffered(deviceId) > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.waiters.get(deviceId) ?? new Set<() => void>();
      this.waiters.set(deviceId, waiters);
      const done = (): void => {
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(deviceId);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  private wake(deviceId: string): void {
    const waiters = this.waiters.get(deviceId);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter();
  }

  settle(id: string, ok: boolean, value: unknown, error?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(value);
    else pending.reject(new Error(error || "The browser could not complete that device operation."));
  }

  private failAllPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  /**
   * Ask the page to do one thing. Rejects rather than hanging when no page is
   * attached or the page does not answer: the device host being absent is an
   * ordinary state (the tab was closed, the phone locked), and a tool call
   * that waits forever on it is the worst possible reading of that.
   */
  request(op: DeviceOpName, deviceId: string, params: Record<string, unknown>): Promise<unknown> {
    const send = this.send;
    if (!send) {
      return Promise.reject(new Error("No browser is attached to this session, so its hardware is unreachable. Open the Devices panel in Cody and connect the device."));
    }
    const id = String(this.nextOpId++);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer ${op} within ${Math.round(DEVICE_OP_TIMEOUT_MS / 1000)}s.`));
      }, DEVICE_OP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        send({ type: "op", id, op, deviceId, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

type BridgeStore = Map<string, DeviceBridge>;

function store(): BridgeStore {
  const globalScope = globalThis as typeof globalThis & { __codyDeviceBridges?: BridgeStore };
  if (!globalScope.__codyDeviceBridges) globalScope.__codyDeviceBridges = new Map();
  return globalScope.__codyDeviceBridges;
}

export function getDeviceBridge(sessionId: string): DeviceBridge {
  const bridges = store();
  let bridge = bridges.get(sessionId);
  if (!bridge) {
    bridge = new DeviceBridge();
    bridges.set(sessionId, bridge);
  }
  return bridge;
}

/** The bridge for a session, only if one was ever created — the read every
 * "is there hardware here?" caller wants, with no side effect. */
export function peekDeviceBridge(sessionId: string): DeviceBridge | null {
  return store().get(sessionId) ?? null;
}

/** Follow a session that was re-keyed mid-run, exactly as the display bus
 * aliases its requests. */
export function aliasDeviceBridge(oldId: string, newId: string): void {
  const bridges = store();
  const existing = bridges.get(oldId);
  if (!existing || oldId === newId) return;
  bridges.set(newId, existing);
  bridges.delete(oldId);
}

export type DeviceMatch =
  | { kind: "one"; device: DeviceInfo }
  | { kind: "none" }
  | { kind: "many"; candidates: DeviceInfo[] };

/** Exact id, then a case-insensitive substring of the label. Ambiguity is
 * reported, never resolved by guessing: writing to the wrong serial port is
 * not something the next tool call can undo. */
export function matchDevice(devices: DeviceInfo[], query: string | undefined): DeviceMatch {
  if (!query) return devices.length === 1 ? { kind: "one", device: devices[0] } : devices.length === 0 ? { kind: "none" } : { kind: "many", candidates: devices };
  const exact = devices.find((device) => device.id === query);
  if (exact) return { kind: "one", device: exact };
  const needle = query.trim().toLowerCase();
  const matches = devices.filter((device) => device.label.toLowerCase().includes(needle));
  if (matches.length === 1) return { kind: "one", device: matches[0] };
  return matches.length === 0 ? { kind: "none" } : { kind: "many", candidates: matches };
}
