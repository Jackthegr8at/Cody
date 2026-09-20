/**
 * Hardware the BROWSER can reach, made usable by the agent.
 *
 * The device is plugged into whatever machine is running the browser — a
 * laptop, a phone, the tablet on the bench — not into the server Cody runs on.
 * So the browser is the device host and the server owns no handles at all: the
 * agent asks, the server relays the request down the page's socket, the page
 * performs it against the real `SerialPort` / `USBDevice` /
 * `BluetoothRemoteGATTCharacteristic`, and the answer comes back the same way.
 *
 * Three browser APIs, and the differences matter enough that Cody reports them
 * rather than pretending they are one thing:
 *
 * | API            | desktop Chrome/Edge | Chrome on Android | Safari / Firefox |
 * |----------------|---------------------|-------------------|------------------|
 * | Web Serial     | yes                 | NO                | no               |
 * | WebUSB         | yes                 | yes               | no               |
 * | Web Bluetooth  | yes                 | yes               | no               |
 *
 * Android has no Web Serial, which is exactly the case a USB-to-UART adapter
 * lands in, so a serial port there is reached through WebUSB with the
 * `web-serial-polyfill` CDC driver — the same route esptool-js documents for
 * Android. The polyfill only works where no kernel driver has already claimed
 * the interface (true on Android, false for CDC devices on desktop Linux),
 * which is why the real API is always preferred when it exists.
 *
 * All three need a SECURE CONTEXT and a user gesture. An instance reached over
 * plain http:// on a LAN address has no `navigator.serial` at all — nothing
 * Cody can do about it, so the panel says so instead of showing a button that
 * throws.
 *
 * The port object the client hands around is deliberately Web Serial-shaped
 * (open/close/readable/writable/setSignals), so the same handle can be passed
 * straight to esptool-js when real flashing lands.
 */

export type DeviceKind = "serial" | "usb" | "ble";

/** How a serial port is actually reached, which decides what can be expected
 * of it (the polyfill has no signal control on some adapters). */
export type SerialTransport = "web-serial" | "webusb-polyfill";

export interface DeviceInfo {
  /** Stable for as long as the grant lives; minted by the page. */
  id: string;
  kind: DeviceKind;
  /** What the human sees: product string, or vendor/product ids. */
  label: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  open: boolean;
  /** Serial only. */
  transport?: SerialTransport;
  baudRate?: number;
  /** BLE only: advertised/primary service UUIDs once connected. */
  services?: string[];
  /** Bytes buffered server-side and not yet read by the agent. */
  buffered?: number;
}

/** What this browser can actually do, reported once per attach. */
export interface DeviceCapabilities {
  /** `window.isSecureContext`. False means every API below is absent. */
  secureContext: boolean;
  serial: boolean;
  usb: boolean;
  bluetooth: boolean;
  /** No Web Serial but WebUSB present: serial goes through the polyfill. */
  serialViaUsb: boolean;
  /** UA platform hint, for the panel's explanation only. */
  platform: string;
}

export const NO_CAPABILITIES: DeviceCapabilities = {
  secureContext: false,
  serial: false,
  usb: false,
  bluetooth: false,
  serialViaUsb: false,
  platform: "unknown",
};

// ============================================================================
// Operations the agent can ask the page to perform
// ============================================================================

export interface SerialOpenParams {
  baudRate?: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: "none" | "even" | "odd";
  flowControl?: "none" | "hardware";
}

/** One endpoint of a claimed USB interface, in the terms `usb_transfer`
 * takes: a bare endpoint NUMBER plus a direction, never the 0x80-tagged
 * address a raw descriptor carries. Reporting it this way is the difference
 * between an agent that can talk to an unknown device immediately and one
 * that has to fetch and decode configuration descriptors first. */
export interface UsbEndpointInfo {
  endpointNumber: number;
  direction: "in" | "out";
  type: "bulk" | "interrupt" | "isochronous";
  packetSize: number;
}

/** An interface of the active configuration, and whether opening took it.
 * A failed claim is reported with its reason rather than dropped: on Windows
 * that is the ordinary outcome for an interface a vendor driver already owns
 * (see AGENTS.md), which is a host fact the agent can neither guess from a
 * later transfer error nor fix by retrying. */
export interface UsbInterfaceInfo {
  interfaceNumber: number;
  claimed: boolean;
  /** Why the claim failed; absent when it succeeded. */
  error?: string;
  classCode: number;
  subclassCode: number;
  protocolCode: number;
  endpoints: UsbEndpointInfo[];
}

/** `usb.open`'s result: what the device turned out to be, not just "ok". */
export interface UsbOpenResult {
  configuration?: number;
  interfaces: UsbInterfaceInfo[];
}

export type DeviceOp =
  | { op: "serial.open"; deviceId: string; params: SerialOpenParams }
  | { op: "serial.write"; deviceId: string; params: { base64: string } }
  | { op: "serial.signals"; deviceId: string; params: { dtr?: boolean; rts?: boolean; brk?: boolean } }
  | { op: "close"; deviceId: string; params: Record<string, never> }
  | { op: "ble.connect"; deviceId: string; params: Record<string, never> }
  | { op: "ble.services"; deviceId: string; params: Record<string, never> }
  | { op: "ble.read"; deviceId: string; params: { service: string; characteristic: string } }
  | { op: "ble.write"; deviceId: string; params: { service: string; characteristic: string; base64: string; withoutResponse?: boolean } }
  | { op: "ble.subscribe"; deviceId: string; params: { service: string; characteristic: string; enable: boolean } }
  | { op: "usb.open"; deviceId: string; params: { configuration?: number; interface?: number } }
  | { op: "usb.control"; deviceId: string; params: { direction: "in" | "out"; requestType: "standard" | "class" | "vendor"; recipient: "device" | "interface" | "endpoint" | "other"; request: number; value: number; index: number; length?: number; base64?: string } }
  | { op: "usb.transfer"; deviceId: string; params: { direction: "in" | "out"; endpoint: number; length?: number; base64?: string } };

export type DeviceOpName = DeviceOp["op"];

/** Server -> page. */
export interface DeviceRequestFrame {
  type: "op";
  /** Correlates the result; unique per bridge. */
  id: string;
  op: DeviceOpName;
  deviceId: string;
  params: Record<string, unknown>;
}

/** Page -> server. */
export type DeviceClientFrame =
  | { type: "hello"; capabilities: DeviceCapabilities; devices: DeviceInfo[] }
  | { type: "devices"; devices: DeviceInfo[] }
  /** Inbound bytes: serial RX, a BLE notification, or a USB IN transfer the
   * page is streaming. Buffered server-side until the agent reads it. */
  | { type: "data"; deviceId: string; base64: string; characteristic?: string }
  | { type: "result"; id: string; ok: true; value?: unknown }
  | { type: "result"; id: string; ok: false; error: string }
  /** The page lost the device (unplugged, GATT disconnect, permission revoked). */
  | { type: "gone"; deviceId: string; reason?: string };

/** Bytes the server holds per device before the agent reads them. A serial
 * console left running produces output forever; keeping the newest window is
 * the honest bound, and the read result says how much was dropped. */
export const DEVICE_BUFFER_BYTES = 256 * 1024;
export function isDeviceClientFrame(value: unknown): value is DeviceClientFrame {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const { type } = value;
  return type === "hello" || type === "devices" || type === "data" || type === "result" || type === "gone";
}

/** How long an agent-issued operation may wait for the page. A page that has
 * gone away must not hang a tool call: the browser is the device host, so its
 * absence is a normal state, not an error condition to wait out. */
export const DEVICE_OP_TIMEOUT_MS = 20_000;
