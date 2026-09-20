/**
 * The BROWSER half of the device bridge (see ./protocol.ts and ./bus.ts).
 *
 * This module is the only place that touches `navigator.serial` /
 * `navigator.usb` / `navigator.bluetooth` directly. Three responsibilities,
 * kept apart on purpose:
 *
 *  1. Capability detection (`detectDeviceCapabilities`) — pure, SSR-safe.
 *  2. Acquisition (`requestSerialPort` / `requestUsbDevice` /
 *     `requestBluetoothDevice`) — each spends a real user gesture on a
 *     browser permission prompt and files the resulting live handle in a
 *     page-global registry, keyed by a minted device id. The registry
 *     outlives any one `DeviceBridgeConnection`: a hardware grant is a
 *     property of the PAGE, not of whichever chat session happens to be
 *     focused when the user clicks "Connect".
 *  3. Transport (`DeviceBridgeConnection`) — one per active session id, owns
 *     the WebSocket to `/api/devices/socket`, executes incoming ops against
 *     the registry, and pumps RX bytes back up as `data` frames.
 *
 * `SerialPort` here can mean the native Web Serial object OR
 * web-serial-polyfill's WebUSB-backed stand-in. protocol.ts's own doc block
 * explains why: they are deliberately shaped alike (open/close/readable/
 * writable/setSignals) so a future esptool-js integration can take either
 * without reshaping anything.
 */

import { SerialPort as PolyfillSerialPort } from "web-serial-polyfill";
import { reconnectDelayMs } from "@/lib/stream-recovery";
import {
  NO_CAPABILITIES,
  type DeviceCapabilities,
  type DeviceClientFrame,
  type DeviceInfo,
  type DeviceKind,
  type DeviceOpName,
  type DeviceRequestFrame,
  type UsbInterfaceInfo,
  type UsbOpenResult,
} from "./protocol";

/**
 * TypeScript's bundled DOM lib does not yet ship the User-Agent Client Hints
 * API. This is the minimal shape `detectDeviceCapabilities` needs — a typed
 * boundary instead of an `any`/cast at the call site.
 */
declare global {
  interface NavigatorUAData {
    readonly platform: string;
  }
  interface Navigator {
    readonly userAgentData?: NavigatorUAData;
  }
}

// ============================================================================
// Capability detection
// ============================================================================

/**
 * Pure feature detection. Safe to call during SSR (returns `NO_CAPABILITIES`,
 * same as an instance with no browser support at all) and safe to call
 * outside a user gesture — unlike the `requestX` functions below, this never
 * prompts.
 */
export function detectDeviceCapabilities(): DeviceCapabilities {
  if (typeof window === "undefined" || typeof navigator === "undefined") return NO_CAPABILITIES;
  const serial = "serial" in navigator;
  const usb = "usb" in navigator;
  const bluetooth = "bluetooth" in navigator;
  return {
    secureContext: window.isSecureContext,
    serial,
    usb,
    bluetooth,
    // Android has no Web Serial at all, which is exactly the case a
    // USB-to-UART adapter lands in — that is what the polyfill is for.
    serialViaUsb: !serial && usb,
    platform: navigator.userAgentData?.platform ?? navigator.platform,
  };
}

// ============================================================================
// Registry — the live handles behind each minted device id
// ============================================================================

interface RegistryEntryBase {
  label: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

interface NativeSerialEntry extends RegistryEntryBase {
  kind: "serial";
  transport: "web-serial";
  port: SerialPort;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  baudRate?: number;
}

interface PolyfillSerialEntry extends RegistryEntryBase {
  kind: "serial";
  transport: "webusb-polyfill";
  port: PolyfillSerialPort;
  /** The raw device backing the polyfill port — needed for the shared
   * `navigator.usb` "disconnect" event, which the polyfill's port does not
   * re-expose (it is a plain class, not an EventTarget). */
  usbDevice: USBDevice;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  baudRate?: number;
}

type SerialEntry = NativeSerialEntry | PolyfillSerialEntry;

interface UsbEntry extends RegistryEntryBase {
  kind: "usb";
  device: USBDevice;
}

interface BleEntry extends RegistryEntryBase {
  kind: "ble";
  device: BluetoothDevice;
  server: BluetoothRemoteGATTServer | null;
  /** Cached per protocol.ts's instruction: "cache the GATTServer/service/
   * characteristic lookups per device." Keyed by service UUID. */
  services: Map<string, BluetoothRemoteGATTService>;
  /** Keyed by `${serviceUuid}:${characteristicUuid}` — two services can
   * legally expose the same characteristic UUID. */
  characteristics: Map<string, BluetoothRemoteGATTCharacteristic>;
  notifying: Map<string, (this: BluetoothRemoteGATTCharacteristic, ev: Event) => void>;
}

type RegistryEntry = SerialEntry | UsbEntry | BleEntry;

/** Page-global on purpose: a hardware grant belongs to the tab, not to
 * whichever session is currently attached through it (see module doc). */
const registry = new Map<string, RegistryEntry>();

function mintDeviceId(kind: DeviceKind): string {
  return `${kind}-${crypto.randomUUID()}`;
}

/** Native Web Serial exposes only vendor/product ids, never a product
 * string (a deliberate privacy restriction in the spec) — the polyfill path
 * additionally has one, since it is really a WebUSB device underneath. */
function usbLikeLabel(kind: "Serial" | "USB", vendorId?: number, productId?: number, productName?: string | null): string {
  if (productName) return productName;
  if (vendorId !== undefined && productId !== undefined) {
    return `${kind} ${vendorId.toString(16).padStart(4, "0")}:${productId.toString(16).padStart(4, "0")}`;
  }
  return `${kind} device`;
}

function deriveDeviceInfo(id: string, entry: RegistryEntry): DeviceInfo {
  const base = { id, label: entry.label, vendorId: entry.vendorId, productId: entry.productId, serialNumber: entry.serialNumber };
  if (entry.kind === "serial") {
    return { ...base, kind: "serial", transport: entry.transport, baudRate: entry.baudRate, open: entry.reader !== null };
  }
  if (entry.kind === "usb") {
    return { ...base, kind: "usb", open: entry.device.opened };
  }
  return { ...base, kind: "ble", open: entry.server?.connected ?? false, services: [...entry.services.keys()] };
}

function listDeviceInfos(): DeviceInfo[] {
  return [...registry.entries()].map(([id, entry]) => deriveDeviceInfo(id, entry));
}

function getSerialEntry(id: string): SerialEntry {
  const entry = registry.get(id);
  if (!entry) throw new Error(`No such device: ${id}. It may have been unplugged or disconnected.`);
  if (entry.kind !== "serial") throw new Error(`Device ${id} is a ${entry.kind} device, not serial.`);
  return entry;
}

function getUsbEntry(id: string): UsbEntry {
  const entry = registry.get(id);
  if (!entry) throw new Error(`No such device: ${id}. It may have been unplugged or disconnected.`);
  if (entry.kind !== "usb") throw new Error(`Device ${id} is a ${entry.kind} device, not usb.`);
  return entry;
}

function getBleEntry(id: string): BleEntry {
  const entry = registry.get(id);
  if (!entry) throw new Error(`No such device: ${id}. It may have been unplugged or disconnected.`);
  if (entry.kind !== "ble") throw new Error(`Device ${id} is a ${entry.kind} device, not ble.`);
  return entry;
}

// ============================================================================
// Acquisition — each of these MUST be invoked synchronously from within a
// real user-gesture event handler (a click). The browser ties the resulting
// permission prompt to "transient activation"; any `await` between the
// click and this call burns the gesture and the prompt throws instead of
// showing.
// ============================================================================

/** CDC-ACM control-interface class code — mirrors web-serial-polyfill's own
 * default (`kDefaultPolyfillOptions.usbControlInterfaceClass`), so the
 * WebUSB picker shows the same devices `serial.requestPort()` would find. */
const USB_CDC_CONTROL_CLASS = 2;

export async function requestSerialPort(): Promise<DeviceInfo> {
  // Branching on the derived boolean (not `"serial" in navigator` directly)
  // matters: that property is declared non-optional, so TS treats a
  // same-object `in` check followed by an unconditional return as proof the
  // negative branch is unreachable and narrows `navigator` to `never` there.
  const capabilities = detectDeviceCapabilities();
  if (capabilities.serial) {
    const port = await navigator.serial.requestPort();
    const info = port.getInfo();
    const id = mintDeviceId("serial");
    const entry: NativeSerialEntry = {
      kind: "serial",
      transport: "web-serial",
      port,
      reader: null,
      label: usbLikeLabel("Serial", info.usbVendorId, info.usbProductId),
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
    };
    registry.set(id, entry);
    return deriveDeviceInfo(id, entry);
  }
  if (!capabilities.usb) throw new Error("This browser has no Web Serial or WebUSB support.");
  const device = await navigator.usb.requestDevice({ filters: [{ classCode: USB_CDC_CONTROL_CLASS }] });
  const port = new PolyfillSerialPort(device);
  const id = mintDeviceId("serial");
  const entry: PolyfillSerialEntry = {
    kind: "serial",
    transport: "webusb-polyfill",
    port,
    usbDevice: device,
    reader: null,
    label: usbLikeLabel("Serial", device.vendorId, device.productId, device.productName),
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber ?? undefined,
  };
  registry.set(id, entry);
  return deriveDeviceInfo(id, entry);
}

function registerUsbDevice(device: USBDevice): DeviceInfo {
  const id = mintDeviceId("usb");
  const entry: UsbEntry = {
    kind: "usb",
    device,
    label: usbLikeLabel("USB", device.vendorId, device.productId, device.productName),
    vendorId: device.vendorId,
    productId: device.productId,
    serialNumber: device.serialNumber ?? undefined,
  };
  registry.set(id, entry);
  return deriveDeviceInfo(id, entry);
}

export async function requestUsbDevice(): Promise<DeviceInfo> {
  if (!detectDeviceCapabilities().usb) throw new Error("This browser has no WebUSB support.");
  // A single empty filter matches every device; an empty filters ARRAY
  // matches none (WebUSB spec §5: a device is kept only if it matches a
  // filter in the list, so an empty list keeps nothing).
  return registerUsbDevice(await navigator.usb.requestDevice({ filters: [{}] }));
}

/** The browser hands back the SAME `USBDevice` object for a device the origin
 * already knows, so identity is exact here rather than a vendor/product
 * heuristic — and the polyfill's backing device counts, or a granted serial
 * port would be adopted a second time as raw USB. */
function findUsbDeviceId(device: USBDevice): string | undefined {
  for (const [id, entry] of registry) {
    if (entry.kind === "usb" && entry.device === device) return id;
    if (entry.kind === "serial" && entry.transport === "webusb-polyfill" && entry.usbDevice === device) return id;
  }
  return undefined;
}

/** A device exposing a CDC control interface is a serial port in this
 * codebase's own terms — `USB_CDC_CONTROL_CLASS` is exactly what the serial
 * picker filters on. Left for the panel's Serial button rather than adopted
 * as raw USB: on Android, where a serial port IS a WebUSB device underneath,
 * adopting it would silently downgrade a granted port into something
 * `device_write` refuses. */
function looksLikeSerialPort(device: USBDevice): boolean {
  return device.configurations.some((configuration) =>
    configuration.interfaces.some((iface) =>
      (iface.alternate ?? iface.alternates[0])?.interfaceClass === USB_CDC_CONTROL_CLASS));
}

/**
 * Re-register every USB device this origin already has permission for, with
 * no picker and no user gesture.
 *
 * A WebUSB grant is persistent and keyed by (vendor, product, serial), so a
 * device that is unplugged and replugged — or that REBOOTS back into the same
 * USB identity, which is every step of a flashing loop — is still ours the
 * moment it re-enumerates. Without this the grant survived in the browser
 * while Cody's list went empty, stranding the agent behind a chooser only a
 * human can click, on every reboot and every page reload.
 *
 * A device that comes back with a DIFFERENT identity (a bootloader at
 * 0bb4:0c01 that boots into an adb interface at another id) is a different
 * device to the browser and genuinely does need a new grant. That is the
 * permission model, not something to paper over.
 */
export async function adoptPermittedUsbDevices(): Promise<DeviceInfo[]> {
  if (!detectDeviceCapabilities().usb) return [];
  const devices = await navigator.usb.getDevices().catch(() => [] as USBDevice[]);
  const adopted: DeviceInfo[] = [];
  for (const device of devices) {
    if (findUsbDeviceId(device) || looksLikeSerialPort(device)) continue;
    adopted.push(registerUsbDevice(device));
  }
  return adopted;
}

/**
 * Services the picker is allowed to reveal. The Web Bluetooth security model
 * requires enumerating every GATT service UUID a page may ever touch at
 * request time — there is no "grant everything" option, by design (it is
 * what keeps a site from fingerprinting a device's full service list). A
 * generic hardware-bridge panel cannot know what the agent will ask for
 * ahead of time, so this defaults to the standard SIG services plus the
 * Nordic UART Service, the near-universal serial-over-BLE UUID for the
 * ESP32/Arduino-class boards this bridge targets. A device exposing some
 * other custom service will still pair; `ble.read`/`ble.write` against an
 * unlisted service UUID fails with a clear browser SecurityError, which
 * surfaces to the agent as an ordinary failed result rather than crashing
 * anything.
 */
const DEFAULT_BLE_OPTIONAL_SERVICES = [
  "generic_access",
  "generic_attribute",
  "device_information",
  "battery_service",
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service
];

export async function requestBluetoothDevice(): Promise<DeviceInfo> {
  if (!detectDeviceCapabilities().bluetooth) throw new Error("This browser has no Web Bluetooth support.");
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: DEFAULT_BLE_OPTIONAL_SERVICES,
  });
  const id = mintDeviceId("ble");
  const entry: BleEntry = {
    kind: "ble",
    device,
    server: null,
    services: new Map(),
    characteristics: new Map(),
    notifying: new Map(),
    label: device.name || "Bluetooth device",
  };
  registry.set(id, entry);
  return deriveDeviceInfo(id, entry);
}

/** The panel's explicit "Disconnect" action: closes if open, then revokes the
 * browser's persistent permission grant. Distinct from the agent-driven
 * `close` op, which only ends the current session and leaves the grant (and
 * the device's row in the panel) alone so the agent can reopen it later. */
export async function forgetDevice(id: string): Promise<void> {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  if (entry.kind === "serial") {
    if (entry.reader) await entry.reader.cancel().catch(() => {});
    await entry.port.close().catch(() => {});
    await entry.port.forget().catch(() => {});
  } else if (entry.kind === "usb") {
    await entry.device.close().catch(() => {});
    await entry.device.forget().catch(() => {});
  } else {
    entry.server?.disconnect();
    await entry.device.forget().catch(() => {});
  }
}

/**
 * Wires the browser event that means "this handle just died" (unplug, GATT
 * drop, revoked permission). A BLE GATT disconnect is treated differently
 * from the other two: it is often transient (out of range, the peripheral
 * slept) and the `BluetoothDevice` handle survives it, so the device stays
 * listed and reconnectable via `ble.connect` — only `onChanged` fires, never
 * `onGone`. Returns the unsubscribe function.
 */
export function watchDeviceLifecycle(id: string, callbacks: { onGone: (reason?: string) => void; onChanged: () => void }): () => void {
  const entry = registry.get(id);
  if (!entry) return () => {};

  // Each branch below evicts the dead handle from the registry directly —
  // the browser's permission grant survives an unplug; only the explicit
  // "Disconnect" button (forgetDevice, above) revokes it.

  if (entry.kind === "serial" && entry.transport === "web-serial") {
    const port = entry.port;
    const listener = () => { registry.delete(id); callbacks.onGone("The port was unplugged."); };
    port.addEventListener("disconnect", listener);
    return () => port.removeEventListener("disconnect", listener);
  }

  if (entry.kind === "usb" || (entry.kind === "serial" && entry.transport === "webusb-polyfill")) {
    const usbDevice = entry.kind === "usb" ? entry.device : entry.usbDevice;
    const listener = (event: USBConnectionEvent) => {
      if (event.device !== usbDevice) return;
      registry.delete(id);
      callbacks.onGone("The device was unplugged.");
    };
    navigator.usb.addEventListener("disconnect", listener);
    return () => navigator.usb.removeEventListener("disconnect", listener);
  }

  const device = entry.device;
  const listener = () => callbacks.onChanged();
  device.addEventListener("gattserverdisconnected", listener);
  return () => device.removeEventListener("gattserverdisconnected", listener);
}

// ============================================================================
// base64 <-> bytes (no Buffer in the browser)
// ============================================================================

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `view.buffer` is only ever typed `ArrayBufferLike` (a `DataView` could in
 * principle wrap a SharedArrayBuffer), but `BufferSource`-typed WebUSB/Web
 * Bluetooth write methods require the narrower `ArrayBuffer` form. Copying
 * into a fresh length-constructed Uint8Array (always `ArrayBuffer`-backed
 * per lib.es5's own constructor overloads) gets there without a cast.
 */
function viewToBytes(view: DataView): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return bytes;
}

// ============================================================================
// Op params — narrowed field-by-field from the untyped wire payload rather
// than cast, so a malformed frame fails with a clear message instead of
// silently reading `undefined` through a false type guarantee.
// ============================================================================

function str(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

function bool(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireStr(params: Record<string, unknown>, key: string): string {
  const value = str(params, key);
  if (value === undefined) throw new Error(`Missing required "${key}" parameter.`);
  return value;
}

function requireNum(params: Record<string, unknown>, key: string): number {
  const value = num(params, key);
  if (value === undefined) throw new Error(`Missing required "${key}" parameter.`);
  return value;
}

const DEFAULT_BAUD_RATE = 115_200;
/** Default IN transfer length when the agent does not specify one — a
 * generous, universally-supported full-speed packet size. */
const DEFAULT_USB_IN_LENGTH = 64;

function serialOpenOptions(params: Record<string, unknown>): SerialOptions {
  const dataBitsValue = num(params, "dataBits");
  const stopBitsValue = num(params, "stopBits");
  const parityValue = str(params, "parity");
  const flowControlValue = str(params, "flowControl");
  return {
    baudRate: num(params, "baudRate") ?? DEFAULT_BAUD_RATE,
    dataBits: dataBitsValue === 7 || dataBitsValue === 8 ? dataBitsValue : undefined,
    stopBits: stopBitsValue === 1 || stopBitsValue === 2 ? stopBitsValue : undefined,
    parity: parityValue === "none" || parityValue === "even" || parityValue === "odd" ? parityValue : undefined,
    flowControl: flowControlValue === "none" || flowControlValue === "hardware" ? flowControlValue : undefined,
  };
}

function usbDirectionOf(params: Record<string, unknown>): "in" | "out" {
  const value = str(params, "direction");
  if (value === "in" || value === "out") return value;
  throw new Error('The "direction" parameter must be "in" or "out".');
}

function usbRequestTypeOf(params: Record<string, unknown>): USBRequestType {
  const value = str(params, "requestType");
  if (value === "standard" || value === "class" || value === "vendor") return value;
  throw new Error('The "requestType" parameter must be "standard", "class", or "vendor".');
}

function usbRecipientOf(params: Record<string, unknown>): USBRecipient {
  const value = str(params, "recipient");
  if (value === "device" || value === "interface" || value === "endpoint" || value === "other") return value;
  throw new Error('The "recipient" parameter must be "device", "interface", "endpoint", or "other".');
}

// ============================================================================
// Reading the wire frame
// ============================================================================

/** `Record<DeviceOpName, true>` doubles as documentation (every literal in
 * the union must be listed, so a new op here is a compile error until this
 * is updated too) and as the runtime membership check below. */
const DEVICE_OP_NAMES: Record<DeviceOpName, true> = {
  "serial.open": true,
  "serial.write": true,
  "serial.signals": true,
  "close": true,
  "ble.connect": true,
  "ble.services": true,
  "ble.read": true,
  "ble.write": true,
  "ble.subscribe": true,
  "usb.open": true,
  "usb.control": true,
  "usb.transfer": true,
};

function isDeviceOpName(value: string): value is DeviceOpName {
  return value in DEVICE_OP_NAMES;
}

/** protocol.ts exports `isDeviceClientFrame` for the server's own inbound
 * frames but nothing for this direction — the browser validates what the
 * server sends it itself. The assertion below is the typed boundary: every
 * field is checked before anything relies on it. `op` is only checked for
 * being a string, not a known one: an op this client does not recognize
 * (e.g. a newer server after a protocol change) still has a valid `id`, so
 * it is worth a fast `result: false` from performDeviceOp's own check below
 * rather than a silent drop that leaves the agent's tool call waiting out
 * the full DEVICE_OP_TIMEOUT_MS. */
function parseRequestFrame(raw: unknown): DeviceRequestFrame | null {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as DeviceRequestFrame;
  if (candidate.type !== "op") return null;
  if (typeof candidate.id !== "string") return null;
  if (typeof candidate.op !== "string") return null;
  if (typeof candidate.deviceId !== "string") return null;
  if (typeof candidate.params !== "object" || candidate.params === null) return null;
  return { type: "op", id: candidate.id, op: candidate.op, deviceId: candidate.deviceId, params: candidate.params };
}

// ============================================================================
// Op execution
// ============================================================================

interface DeviceOpHooks {
  onSerialData: (deviceId: string, bytes: Uint8Array) => void;
  onBleNotify: (deviceId: string, characteristic: string, bytes: Uint8Array) => void;
}

/**
 * Claim what the agent is about to transfer on.
 *
 * WebUSB refuses EVERY endpoint transfer until the interface owning that
 * endpoint is claimed, and the DOMException it throws names neither the
 * interface nor the remedy — so an unclaimed open looks exactly like a device
 * that will not talk. Opening therefore claims, and by default claims every
 * interface of the active configuration: a raw USB device reached this way is
 * being driven wholesale, and a device speaking one protocol (fastboot, a
 * BROM loader, a DFU target) exposes exactly one interface anyway.
 *
 * Claims are attempted independently. On Windows an interface bound to a
 * vendor driver cannot be taken at all (see AGENTS.md), and abandoning the
 * whole open over one of those would strand every composite device whose
 * OTHER interface is the interesting one. A caller that named a single
 * interface gets the failure thrown instead — there is no partial success to
 * report when only one thing was asked for.
 */
async function claimUsbInterfaces(device: USBDevice, only: number | undefined): Promise<UsbOpenResult> {
  const configuration = device.configuration;
  const result: UsbOpenResult = { configuration: configuration?.configurationValue, interfaces: [] };
  if (!configuration) return result;

  for (const iface of configuration.interfaces) {
    if (only !== undefined && iface.interfaceNumber !== only) continue;
    // `alternate` is the selected setting; before any claim some browsers
    // leave it unset, so the default setting stands in for descriptor data.
    const alternate = iface.alternate ?? iface.alternates[0];
    const info: UsbInterfaceInfo = {
      interfaceNumber: iface.interfaceNumber,
      claimed: iface.claimed,
      classCode: alternate?.interfaceClass ?? 0,
      subclassCode: alternate?.interfaceSubclass ?? 0,
      protocolCode: alternate?.interfaceProtocol ?? 0,
      endpoints: (alternate?.endpoints ?? []).map((endpoint) => ({
        endpointNumber: endpoint.endpointNumber,
        direction: endpoint.direction,
        type: endpoint.type,
        packetSize: endpoint.packetSize,
      })),
    };
    if (!info.claimed) {
      try {
        await device.claimInterface(iface.interfaceNumber);
        info.claimed = true;
      } catch (error) {
        if (only !== undefined) throw error;
        info.error = error instanceof Error ? error.message : String(error);
      }
    }
    result.interfaces.push(info);
  }
  return result;
}

function startSerialPump(deviceId: string, entry: SerialEntry, onChunk: (deviceId: string, bytes: Uint8Array) => void): void {
  const readable = entry.port.readable;
  if (!readable) return;
  const reader = readable.getReader();
  entry.reader = reader;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) onChunk(deviceId, value);
      }
    } catch {
      // The port closed or the device vanished out from under the loop —
      // the disconnect/gattserverdisconnected listener already covers the
      // user-facing side of this; the loop just needs to stop quietly.
    } finally {
      reader.releaseLock();
      if (entry.reader === reader) entry.reader = null;
    }
  })();
}

async function stopSerialPump(entry: SerialEntry): Promise<void> {
  if (!entry.reader) return;
  await entry.reader.cancel().catch(() => {});
  entry.reader = null;
}

async function resolveCharacteristic(entry: BleEntry, serviceUuid: string, characteristicUuid: string): Promise<BluetoothRemoteGATTCharacteristic> {
  if (!entry.server) throw new Error("Not connected. Call ble.connect first.");
  const cacheKey = `${serviceUuid}:${characteristicUuid}`;
  const cached = entry.characteristics.get(cacheKey);
  if (cached) return cached;
  let service = entry.services.get(serviceUuid);
  if (!service) {
    service = await entry.server.getPrimaryService(serviceUuid);
    entry.services.set(serviceUuid, service);
  }
  const characteristic = await service.getCharacteristic(characteristicUuid);
  entry.characteristics.set(cacheKey, characteristic);
  return characteristic;
}

/** Executes exactly one `DeviceOp` against the registry. Thrown errors become
 * the WS `result`'s `error` string; nothing here needs to know about the
 * WebSocket at all. */
async function performDeviceOp(rawOp: string, deviceId: string, params: Record<string, unknown>, hooks: DeviceOpHooks): Promise<unknown> {
  if (!isDeviceOpName(rawOp)) throw new Error(`Unknown device operation "${rawOp}".`);
  const op = rawOp;
  switch (op) {
    case "serial.open": {
      const entry = getSerialEntry(deviceId);
      await stopSerialPump(entry);
      await entry.port.close().catch(() => {});
      const options = serialOpenOptions(params);
      await entry.port.open(options);
      entry.baudRate = options.baudRate;
      startSerialPump(deviceId, entry, hooks.onSerialData);
      return { baudRate: options.baudRate };
    }
    case "serial.write": {
      const entry = getSerialEntry(deviceId);
      const writable = entry.port.writable;
      if (!writable) throw new Error("The port is not open for writing.");
      const writer = writable.getWriter();
      try {
        await writer.write(fromBase64(requireStr(params, "base64")));
      } finally {
        writer.releaseLock();
      }
      return undefined;
    }
    case "serial.signals": {
      const entry = getSerialEntry(deviceId);
      await entry.port.setSignals({
        dataTerminalReady: bool(params, "dtr"),
        requestToSend: bool(params, "rts"),
        break: bool(params, "brk"),
      });
      return undefined;
    }
    case "close": {
      const entry = registry.get(deviceId);
      if (!entry) throw new Error(`No such device: ${deviceId}. It may have been unplugged or disconnected.`);
      if (entry.kind === "serial") {
        await stopSerialPump(entry);
        await entry.port.close().catch(() => {});
      } else if (entry.kind === "usb") {
        await entry.device.close().catch(() => {});
      } else {
        entry.server?.disconnect();
        entry.server = null;
        entry.services.clear();
        entry.characteristics.clear();
        entry.notifying.clear();
      }
      return undefined;
    }
    case "ble.connect": {
      const entry = getBleEntry(deviceId);
      if (!entry.device.gatt) throw new Error("This device has no GATT server.");
      entry.server = await entry.device.gatt.connect();
      return undefined;
    }
    case "ble.services": {
      const entry = getBleEntry(deviceId);
      if (!entry.server) throw new Error("Not connected. Call ble.connect first.");
      const services = await entry.server.getPrimaryServices();
      entry.services.clear();
      for (const service of services) entry.services.set(service.uuid, service);
      return { services: services.map((service) => service.uuid) };
    }
    case "ble.read": {
      const entry = getBleEntry(deviceId);
      const characteristic = await resolveCharacteristic(entry, requireStr(params, "service"), requireStr(params, "characteristic"));
      const view = await characteristic.readValue();
      return { base64: toBase64(viewToBytes(view)) };
    }
    case "ble.write": {
      const entry = getBleEntry(deviceId);
      const characteristic = await resolveCharacteristic(entry, requireStr(params, "service"), requireStr(params, "characteristic"));
      const bytes = fromBase64(requireStr(params, "base64"));
      if (bool(params, "withoutResponse")) await characteristic.writeValueWithoutResponse(bytes);
      else await characteristic.writeValueWithResponse(bytes);
      return undefined;
    }
    case "ble.subscribe": {
      const entry = getBleEntry(deviceId);
      const serviceUuid = requireStr(params, "service");
      const characteristicUuid = requireStr(params, "characteristic");
      const characteristic = await resolveCharacteristic(entry, serviceUuid, characteristicUuid);
      const key = `${serviceUuid}:${characteristicUuid}`;
      if (bool(params, "enable")) {
        if (!entry.notifying.has(key)) {
          const listener = () => {
            const view = characteristic.value;
            if (view) hooks.onBleNotify(deviceId, characteristicUuid, viewToBytes(view));
          };
          characteristic.addEventListener("characteristicvaluechanged", listener);
          entry.notifying.set(key, listener);
          await characteristic.startNotifications();
        }
      } else {
        const listener = entry.notifying.get(key);
        if (listener) {
          await characteristic.stopNotifications().catch(() => {});
          characteristic.removeEventListener("characteristicvaluechanged", listener);
          entry.notifying.delete(key);
        }
      }
      return undefined;
    }
    case "usb.open": {
      const entry = getUsbEntry(deviceId);
      await entry.device.open();
      const configuration = num(params, "configuration");
      if (configuration !== undefined) {
        await entry.device.selectConfiguration(configuration);
      } else if (entry.device.configuration === null && entry.device.configurations.length > 0) {
        // Most devices expose exactly one configuration; select it so
        // transfers work without the agent needing to know its number.
        await entry.device.selectConfiguration(entry.device.configurations[0].configurationValue);
      }
      return claimUsbInterfaces(entry.device, num(params, "interface"));
    }
    case "usb.control": {
      const entry = getUsbEntry(deviceId);
      const setup: USBControlTransferParameters = {
        requestType: usbRequestTypeOf(params),
        recipient: usbRecipientOf(params),
        request: requireNum(params, "request"),
        value: requireNum(params, "value"),
        index: requireNum(params, "index"),
      };
      if (usbDirectionOf(params) === "in") {
        const result = await entry.device.controlTransferIn(setup, num(params, "length") ?? DEFAULT_USB_IN_LENGTH);
        return { base64: result.data ? toBase64(viewToBytes(result.data)) : "" };
      }
      const outBytes = str(params, "base64");
      const result = await entry.device.controlTransferOut(setup, outBytes ? fromBase64(outBytes) : undefined);
      return { bytesWritten: result.bytesWritten };
    }
    case "usb.transfer": {
      const entry = getUsbEntry(deviceId);
      const endpoint = requireNum(params, "endpoint");
      if (usbDirectionOf(params) === "in") {
        const result = await entry.device.transferIn(endpoint, num(params, "length") ?? DEFAULT_USB_IN_LENGTH);
        return { base64: result.data ? toBase64(viewToBytes(result.data)) : "" };
      }
      const outBytes = str(params, "base64");
      const result = await entry.device.transferOut(endpoint, outBytes ? fromBase64(outBytes) : new Uint8Array(0));
      return { bytesWritten: result.bytesWritten };
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`Unhandled device operation: ${String(exhaustive)}`);
    }
  }
}

// ============================================================================
// RX coalescing — serial RX and BLE notifications both funnel through this so
// a chatty console cannot flood the socket with one frame per byte.
// ============================================================================

/** 20 Hz: fast enough that a live console feels immediate, slow enough that
 * an interrupt-driven serial device streaming continuously sends at most one
 * frame per stream per tick instead of one frame per chunk. */
const COALESCE_INTERVAL_MS = 50;

/** BLE notifications share the RX coalescer with serial reads, keyed by
 * `deviceId` alone for serial or `deviceId\u0000characteristic` for BLE (a
 * device id can never contain a NUL byte) — this splits that key back apart
 * when flushing. */
function parseStreamKey(key: string): { deviceId: string; characteristic?: string } {
  const sep = key.indexOf("\u0000");
  return sep === -1 ? { deviceId: key } : { deviceId: key.slice(0, sep), characteristic: key.slice(sep + 1) };
}

class DataCoalescer {
  private readonly queues = new Map<string, Uint8Array[]>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly onFlush: (key: string, bytes: Uint8Array) => void) {}

  push(key: string, chunk: Uint8Array): void {
    const queue = this.queues.get(key);
    if (queue) queue.push(chunk);
    else this.queues.set(key, [chunk]);
    if (!this.timer) this.timer = setInterval(() => this.drain(), COALESCE_INTERVAL_MS);
  }

  private drain(): void {
    if (this.queues.size === 0) return;
    for (const [key, chunks] of this.queues) {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.onFlush(key, merged);
    }
    this.queues.clear();
  }

  destroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.queues.clear();
  }
}

// ============================================================================
// Transport — one DeviceBridgeConnection per active session id
// ============================================================================

export interface DeviceBridgeSnapshot {
  capabilities: DeviceCapabilities;
  devices: DeviceInfo[];
  /** Is our WebSocket to `/api/devices/socket` currently open? The server
   * treats a fresh attach (and its `hello`) as authoritative, so this is
   * really "is this browser tab the device host for this session right now". */
  attached: boolean;
  error: string | null;
}

/**
 * Owns the WebSocket for one session id: sends `hello`/`devices`/`data`/
 * `result`/`gone`, executes incoming `op` frames against the registry, and
 * reconnects with backoff. Acquiring/forgetting devices also goes through
 * here so the panel's UI has one object to talk to, but the registry itself
 * — and any hardware already granted before this connection existed — is
 * page-global and outlives it (see module doc).
 */
export class DeviceBridgeConnection {
  readonly sessionId: string;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private destroyed = false;
  private readonly capabilities: DeviceCapabilities;
  private snapshot: DeviceBridgeSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly lifecycleUnsubs = new Map<string, () => void>();
  private readonly coalescer: DataCoalescer;
  /** Kept so `destroy` can detach it; a stale listener on the page-global
   * `navigator.usb` would outlive the session it adopts devices for. */
  private usbConnectListener: ((event: USBConnectionEvent) => void) | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.capabilities = detectDeviceCapabilities();
    this.snapshot = { capabilities: this.capabilities, devices: listDeviceInfos(), attached: false, error: null };
    this.coalescer = new DataCoalescer((key, bytes) => this.sendData(key, bytes));
  }

  getSnapshot(): DeviceBridgeSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private setSnapshot(patch: Partial<DeviceBridgeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private refresh(): void {
    this.setSnapshot({ devices: listDeviceInfos() });
    this.sendDevices();
  }

  /** Any device already granted before this connection existed (an earlier
   * session in this same page, a reload that restored a mounted grant, or a
   * USB device this origin was permitted in an entirely earlier visit) rides
   * along on the first `hello` — the server treats an attach as
   * authoritative for the whole set, never a delta. */
  start(): void {
    for (const info of listDeviceInfos()) this.watchLifecycle(info.id);
    this.watchUsbArrivals();
    void this.adoptPermitted();
    this.openSocket();
  }

  /** A permitted device that turns up later — replugged, or rebooted back
   * into the same USB identity — is adopted the moment the browser sees it,
   * so a flashing loop does not stop at a chooser between every reboot. */
  private watchUsbArrivals(): void {
    if (!this.capabilities.usb || this.usbConnectListener) return;
    this.usbConnectListener = () => { void this.adoptPermitted(); };
    navigator.usb.addEventListener("connect", this.usbConnectListener);
  }

  private async adoptPermitted(): Promise<void> {
    const adopted = await adoptPermittedUsbDevices();
    if (this.destroyed || adopted.length === 0) return;
    for (const info of adopted) this.watchLifecycle(info.id);
    this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.coalescer.destroy();
    if (this.usbConnectListener) {
      navigator.usb.removeEventListener("connect", this.usbConnectListener);
      this.usbConnectListener = null;
    }
    for (const unsubscribe of this.lifecycleUnsubs.values()) unsubscribe();
    this.lifecycleUnsubs.clear();
    this.listeners.clear();
    this.socket?.close();
    this.socket = null;
  }

  private openSocket(): void {
    if (this.destroyed) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/devices/socket?sessionId=${encodeURIComponent(this.sessionId)}`);
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.setSnapshot({ attached: true, error: null });
      this.send({ type: "hello", capabilities: this.capabilities, devices: listDeviceInfos() });
    };
    socket.onmessage = (event) => { void this.handleMessage(event); };
    socket.onclose = () => {
      if (this.socket !== socket) return; // superseded by a newer socket already
      this.socket = null;
      this.setSnapshot({ attached: false });
      if (this.destroyed) return;
      this.scheduleReconnect();
    };
    // onclose always follows a failed connection attempt too; it is what
    // actually updates state and schedules the retry.
    socket.onerror = () => {};
  }

  private scheduleReconnect(): void {
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private send(frame: DeviceClientFrame): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private sendDevices(): void {
    this.send({ type: "devices", devices: listDeviceInfos() });
  }

  private sendData(key: string, bytes: Uint8Array): void {
    const { deviceId, characteristic } = parseStreamKey(key);
    this.send(characteristic
      ? { type: "data", deviceId, base64: toBase64(bytes), characteristic }
      : { type: "data", deviceId, base64: toBase64(bytes) });
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    const frame = parseRequestFrame(event.data);
    if (!frame) return; // not a frame shape we understand; ignore rather than crash the socket
    try {
      const value = await performDeviceOp(frame.op, frame.deviceId, frame.params, {
        onSerialData: (deviceId, bytes) => this.coalescer.push(deviceId, bytes),
        onBleNotify: (deviceId, characteristic, bytes) => this.coalescer.push(`${deviceId}\u0000${characteristic}`, bytes),
      });
      this.send({ type: "result", id: frame.id, ok: true, value });
    } catch (error) {
      this.send({ type: "result", id: frame.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    this.refresh();
  }

  private watchLifecycle(id: string): void {
    if (this.lifecycleUnsubs.has(id)) return;
    const unsubscribe = watchDeviceLifecycle(id, {
      onGone: (reason) => {
        this.lifecycleUnsubs.delete(id);
        this.send({ type: "gone", deviceId: id, reason });
        this.setSnapshot({ devices: listDeviceInfos() });
      },
      onChanged: () => this.refresh(),
    });
    this.lifecycleUnsubs.set(id, unsubscribe);
  }

  /** Must be called synchronously from a click handler — see the module doc
   * on the underlying `requestX` functions. */
  async requestDevice(kind: DeviceKind): Promise<DeviceInfo> {
    const info = kind === "serial" ? await requestSerialPort()
      : kind === "usb" ? await requestUsbDevice()
        : await requestBluetoothDevice();
    this.watchLifecycle(info.id);
    this.refresh();
    return info;
  }

  async disconnectDevice(id: string): Promise<void> {
    this.lifecycleUnsubs.get(id)?.();
    this.lifecycleUnsubs.delete(id);
    await forgetDevice(id);
    this.refresh();
  }
}
