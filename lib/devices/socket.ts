/**
 * The WebSocket side of the device bridge: one page, one session, one bridge.
 *
 * Kept out of bin/cody-server.js for the same reason the display socket's
 * handling is — the launcher is CommonJS plumbing, and the protocol belongs
 * with the protocol. The server does no interpretation beyond routing: bytes
 * the page reports are buffered for the agent to read, results settle pending
 * operations, and everything else updates the roster the tools list.
 */

import { getDeviceBridge } from "./bus";
import { isDeviceClientFrame, type DeviceCapabilities, type DeviceInfo, type DeviceRequestFrame } from "./protocol";

/** The subset of a `ws` socket this module uses, so the launcher can hand one
 * over without this file importing `ws` (and Next bundling it). */
export interface DeviceSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: () => void): void;
  readyState: number;
}

const OPEN = 1;

function asCapabilities(value: unknown): DeviceCapabilities | null {
  if (!value || typeof value !== "object") return null;
  const read = (key: string): boolean => key in value && (value as Record<string, unknown>)[key] === true;
  const platform = "platform" in value && typeof value.platform === "string" ? value.platform : "unknown";
  return {
    secureContext: read("secureContext"),
    serial: read("serial"),
    usb: read("usb"),
    bluetooth: read("bluetooth"),
    serialViaUsb: read("serialViaUsb"),
    platform,
  };
}

/** Devices are page-reported, so every field is validated: a malformed roster
 * must narrow the list, never crash the bridge the agent is about to use. */
function asDevices(value: unknown): DeviceInfo[] {
  if (!Array.isArray(value)) return [];
  const devices: DeviceInfo[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record: Record<string, unknown> = { ...entry };
    const id = typeof record.id === "string" ? record.id : "";
    const kind = record.kind;
    if (!id || (kind !== "serial" && kind !== "usb" && kind !== "ble")) continue;
    devices.push({
      id,
      kind,
      label: typeof record.label === "string" && record.label ? record.label : id,
      open: record.open === true,
      ...(typeof record.vendorId === "number" ? { vendorId: record.vendorId } : {}),
      ...(typeof record.productId === "number" ? { productId: record.productId } : {}),
      ...(typeof record.serialNumber === "string" ? { serialNumber: record.serialNumber } : {}),
      ...(record.transport === "web-serial" || record.transport === "webusb-polyfill" ? { transport: record.transport } : {}),
      ...(typeof record.baudRate === "number" ? { baudRate: record.baudRate } : {}),
      ...(Array.isArray(record.services) ? { services: record.services.filter((s): s is string => typeof s === "string") } : {}),
    });
  }
  return devices;
}

/**
 * Bind one page's socket to a session's bridge. Returns nothing: the caller
 * owns the socket, and the bridge's own detach runs on close.
 */
export function attachDeviceSocket(sessionId: string, socket: DeviceSocket): void {
  const bridge = getDeviceBridge(sessionId);
  const send = (frame: DeviceRequestFrame): void => {
    if (socket.readyState !== OPEN) throw new Error("The device socket is closed.");
    socket.send(JSON.stringify(frame));
  };
  const detach = bridge.attach(send);

  socket.on("message", (raw, isBinary) => {
    // Everything is JSON: device payloads ride as base64 inside a frame, so a
    // binary message is a client that does not speak this protocol.
    if (isBinary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isDeviceClientFrame(parsed)) return;
    switch (parsed.type) {
      case "hello": {
        const capabilities = asCapabilities(parsed.capabilities);
        if (capabilities) bridge.setCapabilities(capabilities);
        bridge.setDevices(asDevices(parsed.devices));
        break;
      }
      case "devices":
        bridge.setDevices(asDevices(parsed.devices));
        break;
      case "data": {
        if (typeof parsed.deviceId !== "string" || typeof parsed.base64 !== "string") break;
        bridge.push(
          parsed.deviceId,
          Buffer.from(parsed.base64, "base64"),
          typeof parsed.characteristic === "string" ? parsed.characteristic : undefined,
        );
        break;
      }
      case "result": {
        if (typeof parsed.id !== "string") break;
        if (parsed.ok) bridge.settle(parsed.id, true, parsed.value);
        else bridge.settle(parsed.id, false, undefined, typeof parsed.error === "string" ? parsed.error : undefined);
        break;
      }
      case "gone":
        if (typeof parsed.deviceId === "string") bridge.removeDevice(parsed.deviceId);
        break;
    }
  });

  socket.on("close", detach);
  socket.on("error", detach);
}
