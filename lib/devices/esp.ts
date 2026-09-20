import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
import { bindIntrinsicFlashSafety, runVerifiedFlash, sha256Blob, type FlashLayout, type FlashSafetyContext } from "./hardware-safety";
import { requireLength, requireOffset, requireSerial, stringOption, throwIfAborted } from "./serial";

const SLIP_END = 0xc0;
const SLIP_ESC = 0xdb;
const SLIP_ESC_END = 0xdc;
const SLIP_ESC_ESC = 0xdd;
const ROM_BAUD_RATE = 115200;
const DEFAULT_STUB_BAUD_RATE = 921600;
const READ_CHUNK_BYTES = 4096;
const READ_POLL_TIMEOUT_MS = 1000;
const ESP_RESET_MODES: Record<string, true> = {
  default_reset: true,
  usb_reset: true,
  no_reset: true,
  no_reset_no_sync: true,
};

/** Explicitly reviewed NOR erase geometry per detected esptool-js target. */
const ESP_SPI_ERASE_BLOCK_BYTES: Readonly<Record<string, number>> = {
  ESP8266: 0x1000,
  ESP32: 0x1000,
  "ESP32-C2": 0x1000,
  "ESP32-C3": 0x1000,
  "ESP32-C5": 0x1000,
  "ESP32-C6": 0x1000,
  "ESP32-C61": 0x1000,
  "ESP32-H2": 0x1000,
  "ESP32-P4": 0x1000,
  "ESP32-S2": 0x1000,
  "ESP32-S3": 0x1000,
};
const ESP_APPLICATION_OFFSET = 0x10000;
export class EspProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EspProtocolError";
  }
}

export interface EspChip {
  readonly CHIP_NAME?: string;
  readonly BOOTLOADER_FLASH_OFFSET?: number;
  readonly FLASH_WRITE_SIZE?: number;
}

export interface EspFlashOptions {
  readonly fileArray: readonly { readonly data: Uint8Array; readonly address: number }[];
  readonly flashMode: "keep";
  readonly flashFreq: "keep";
  readonly flashSize: "keep";
  readonly eraseAll: false;
  readonly compress: true;
  readonly reportProgress: (fileIndex: number, written: number, total: number) => void;
  readonly calculateMD5Hash: (image: Uint8Array) => string;
}

export interface EspLoader {
  chip: EspChip;
  IS_STUB: boolean;
  /** esptool-js defaults this to three. Set it to one before every write: an
   * acknowledgement loss leaves a destructive write's state unknown. */
  WRITE_BLOCK_ATTEMPTS: number;
  main(mode?: string): Promise<string>;
  readFlash(address: number, length: number, onPacketReceived?: (packet: Uint8Array, progress: number, total: number) => void): Promise<Uint8Array>;
  writeFlash(options: EspFlashOptions): Promise<void>;
  detectFlashSize(): Promise<string>;
}

export interface EspLoaderOptions {
  readonly transport: EspTransport;
  readonly baudrate: number;
  readonly terminal: {
    clean(): void;
    write(data: string): void;
    writeLine(data: string): void;
  };
}

export interface EspToolModule {
  readonly ESPLoader: new (options: EspLoaderOptions) => EspLoader;
}

export type EspToolImporter = () => Promise<EspToolModule>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("ESP operation aborted.", "AbortError");
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

/** esptool-js 0.6.1's `Transport.slipWriter` framing, kept structural so the
 * browser's WebUSB serial polyfill works without pretending it is a native
 * SerialPort. */
export function encodeEspSlip(data: Uint8Array): Uint8Array {
  let escaped = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] === SLIP_END || data[index] === SLIP_ESC) escaped += 1;
  }
  const framed = new Uint8Array(data.length + escaped + 2);
  let output = 0;
  framed[output++] = SLIP_END;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]!;
    if (value === SLIP_END) {
      framed[output++] = SLIP_ESC;
      framed[output++] = SLIP_ESC_END;
    } else if (value === SLIP_ESC) {
      framed[output++] = SLIP_ESC;
      framed[output++] = SLIP_ESC_ESC;
    } else {
      framed[output++] = value;
    }
  }
  framed[output] = SLIP_END;
  return framed;
}

/**
 * Structural equivalent of esptool-js 0.6.1's public Transport surface.
 *
 * It owns no browser port: HardwareTransport is already an exclusive lease
 * whose read/write calls work for both native Web Serial and WebUSB polyfills.
 * This is deliberately not an `instanceof Transport` adapter; ESPLoader only
 * calls this public structural surface.
 */
export class EspTransport {
  tracing = false;
  private readonly packets: Uint8Array[] = [];
  private frame: number[] = [];
  private escaping = false;
  private currentRead?: { resolve: (packet: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> };
  private loop?: Promise<void>;
  private loopController?: AbortController;
  private readFailure?: Error;
  private baudRate?: number;

  constructor(
    private readonly hardware: HardwareTransport,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", () => {
      void this.stopLoop();
    }, { once: true });
  }

  getInfo(): string {
    return `Cody ${this.hardware.kind} hardware transport`;
  }

  getPid(): number | undefined {
    return undefined;
  }

  hexify(data: Uint8Array): string {
    let text = "";
    for (let index = 0; index < data.length; index += 1) text += data[index]!.toString(16).padStart(2, "0");
    return text;
  }

  hexConvert(data: Uint8Array): string {
    return this.hexify(data);
  }

  trace(message: string): void {
    // The operation progress feed is intentionally aggregate-only; binary
    // transport traces would expose firmware contents and allocate heavily.
    void message;
  }

  slipWriter(data: Uint8Array): Uint8Array {
    return encodeEspSlip(data);
  }

  async write(data: Uint8Array): Promise<void> {
    assertNotAborted(this.signal);
    await this.hardware.write(encodeEspSlip(data), this.signal);
    assertNotAborted(this.signal);
  }

  async connect(baudRate = ROM_BAUD_RATE): Promise<void> {
    assertNotAborted(this.signal);
    if (!Number.isSafeInteger(baudRate) || baudRate < ROM_BAUD_RATE) {
      throw new EspProtocolError(`Invalid ESP serial baud rate ${baudRate}.`);
    }
    if (baudRate === this.baudRate) return;
    if (!this.hardware.setBaudRate) {
      throw new EspProtocolError(`This ${this.hardware.kind} serial transport cannot configure ${baudRate} baud.`);
    }
    await this.hardware.setBaudRate(baudRate);
    this.baudRate = baudRate;
  }

  async disconnect(): Promise<void> {
    await this.stopLoop();
  }

  async setDTR(state: boolean): Promise<void> {
    await this.setSignals({ dtr: state });
  }

  async setRTS(state: boolean): Promise<void> {
    await this.setSignals({ rts: state });
  }

  private async setSignals(signals: { dtr?: boolean; rts?: boolean }): Promise<void> {
    assertNotAborted(this.signal);
    if (!this.hardware.setSignals) {
      throw new EspProtocolError(
        "ESP automatic reset requires DTR/RTS signal control. This browser transport does not expose it; put the device in the bootloader and use reset=no_reset.",
      );
    }
    await this.hardware.setSignals(signals);
    assertNotAborted(this.signal);
  }

  /** Starts exactly one lease-owned reader. esptool-js invokes this after each
   * connect/reconnect; a duplicated loop would steal acknowledgements. */
  readLoop(): Promise<void> {
    if (this.loop) return this.loop;
    const controller = new AbortController();
    this.loopController = controller;
    const onAbort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener("abort", onAbort, { once: true });
    this.loop = this.pump(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.readFailure = error instanceof Error ? error : new EspProtocolError(String(error));
          this.resolveRead(null);
        }
      })
      .finally(() => {
        this.signal.removeEventListener("abort", onAbort);
        if (this.loopController === controller) this.loopController = undefined;
        this.loop = undefined;
      });
    return this.loop;
  }

  private async pump(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const bytes = await this.hardware.read(READ_CHUNK_BYTES, READ_POLL_TIMEOUT_MS, signal);
      if (bytes) this.accept(bytes);
    }
  }

  private accept(bytes: Uint8Array): void {
    for (let index = 0; index < bytes.length; index += 1) {
      const value = bytes[index]!;
      if (value === SLIP_END) {
        if (this.frame.length !== 0) {
          this.enqueue(new Uint8Array(this.frame));
          this.frame = [];
        }
        this.escaping = false;
      } else if (this.escaping) {
        if (value === SLIP_ESC_END) this.frame.push(SLIP_END);
        else if (value === SLIP_ESC_ESC) this.frame.push(SLIP_ESC);
        else throw new EspProtocolError(`Invalid ESP SLIP escape byte 0x${value.toString(16)}.`);
        this.escaping = false;
      } else if (value === SLIP_ESC) {
        this.escaping = true;
      } else {
        this.frame.push(value);
      }
    }
  }

  private enqueue(packet: Uint8Array): void {
    if (this.currentRead) {
      this.resolveRead(packet);
      return;
    }
    this.packets.push(packet);
  }

  private resolveRead(packet: Uint8Array | null): void {
    const waiting = this.currentRead;
    if (!waiting) return;
    this.currentRead = undefined;
    clearTimeout(waiting.timer);
    waiting.resolve(packet);
  }

  flushInput(): void {
    this.packets.length = 0;
    this.frame = [];
    this.escaping = false;
  }

  peek(): Uint8Array {
    if (this.packets.length === 0) return new Uint8Array(0);
    let size = 0;
    for (const packet of this.packets) size += packet.length;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const packet of this.packets) {
      result.set(packet, offset);
      offset += packet.length;
    }
    return result;
  }

  async read(timeout: number): Promise<Uint8Array | null> {
    assertNotAborted(this.signal);
    if (this.readFailure) throw this.readFailure;
    const packet = this.packets.shift();
    if (packet) return packet;
    if (this.currentRead) throw new EspProtocolError("Concurrent ESP transport reads are not supported.");
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const onAbort = () => {
        if (!this.currentRead) return;
        this.currentRead = undefined;
        clearTimeout(timer);
        reject(abortError(this.signal));
      };
      const timer = setTimeout(() => {
        if (this.currentRead) this.currentRead = undefined;
        this.signal.removeEventListener("abort", onAbort);
        resolve(null);
      }, Math.max(0, timeout));
      this.currentRead = {
        resolve: (value) => {
          this.signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        timer,
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async dispose(): Promise<void> {
    await this.stopLoop();
  }

  private async stopLoop(): Promise<void> {
    const controller = this.loopController;
    if (controller && !controller.signal.aborted) controller.abort(this.signal.reason);
    this.resolveRead(null);
    const loop = this.loop;
    if (loop) await loop;
  }
}

function md5LeftRotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

const MD5_SHIFT = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_TABLE = Uint32Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0);

/** Browser Web Crypto intentionally omits MD5. esptool-js needs MD5 to invoke
 * its device-side SPI flash verification, so retain a small local MD5 only for
 * that protocol check; SHA-256 remains the approval/readback integrity hash. */
export function md5Hex(data: Uint8Array): string {
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);

  const process = (block: Uint8Array, start: number): void => {
    for (let index = 0; index < 16; index += 1) {
      const offset = start + index * 4;
      words[index] = (block[offset]! | (block[offset + 1]! << 8) | (block[offset + 2]! << 16) | (block[offset + 3]! << 24)) >>> 0;
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let g: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      b = (b + md5LeftRotate((a + f + MD5_TABLE[index]! + words[g]!) >>> 0, MD5_SHIFT[index]!)) >>> 0;
      a = previousD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  };

  const completeBlocks = data.length - (data.length % 64);
  for (let offset = 0; offset < completeBlocks; offset += 64) process(data, offset);

  const tail = new Uint8Array(64);
  const tailLength = data.length - completeBlocks;
  tail.set(data.subarray(completeBlocks));
  tail[tailLength] = 0x80;
  if (tailLength >= 56) {
    process(tail, 0);
    tail.fill(0);
  }
  const bitLength = data.length * 8;
  if (!Number.isSafeInteger(bitLength)) throw new EspProtocolError("Firmware is too large for MD5 verification.");
  let value = bitLength;
  for (let index = 0; index < 8; index += 1) {
    tail[56 + index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  process(tail, 0);

  let result = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let index = 0; index < 4; index += 1) result += ((word >>> (index * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return result;
}


function requireInput(context: HardwareContext): Blob {
  if (!context.input) throw new EspProtocolError("ESP flash requires a firmware artifact.");
  if (context.input.size === 0) throw new EspProtocolError("Refusing to flash an empty ESP firmware artifact.");
  return context.input;
}

function optionResetMode(request: HardwareRequest): string {
  const reset = stringOption(request.options ?? {}, "reset") ?? "default_reset";
  if (!ESP_RESET_MODES[reset]) throw new EspProtocolError(`Unsupported ESP reset mode ${reset}.`);
  return reset;
}

function optionBaudRate(request: HardwareRequest): number {
  const baudRate = request.baudRate ?? DEFAULT_STUB_BAUD_RATE;
  if (!Number.isSafeInteger(baudRate) || baudRate < ROM_BAUD_RATE || baudRate > 2_000_000) {
    throw new EspProtocolError("ESP baudRate must be an integer from 115200 through 2000000.");
  }
  return baudRate;
}

function chipInfo(loader: EspLoader, detectedName: string): { chip: string; bootOffset: number } {
  const chip = loader.chip;
  const name = chip?.CHIP_NAME?.trim() || detectedName.trim();
  if (!name) throw new EspProtocolError("esptool-js did not report a chip name.");
  const bootOffset = chip?.BOOTLOADER_FLASH_OFFSET;
  if (typeof bootOffset !== "number" || !Number.isSafeInteger(bootOffset) || bootOffset < 0) {
    throw new EspProtocolError(`esptool-js did not report a safe SPI boot offset for ${name}.`);
  }
  return { chip: name, bootOffset };
}

function flashCapacityBytes(value: string): number {
  const match = /^(\d+)\s*(KB|MB)$/i.exec(value.trim());
  if (!match) throw new EspProtocolError(`esptool-js reported unrecognized flash capacity ${value}.`);
  const amount = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === "KB" ? 1024 : 1024 * 1024;
  const capacity = amount * multiplier;
  if (!Number.isSafeInteger(capacity) || capacity <= ESP_APPLICATION_OFFSET) {
    throw new EspProtocolError(`esptool-js reported unsafe flash capacity ${value}.`);
  }
  return capacity;
}

function intrinsicEspSafety(
  request: HardwareRequest,
  chip: string,
  bootOffset: number,
  flashCapacity: number,
  payloadLength: number,
): FlashSafetyContext {
  const eraseBlock = ESP_SPI_ERASE_BLOCK_BYTES[chip];
  if (!eraseBlock) throw new EspProtocolError(`No reviewed SPI erase geometry exists for detected ${chip}.`);
  if (!Number.isSafeInteger(payloadLength) || payloadLength <= 0) {
    throw new EspProtocolError("ESP firmware must contain at least one byte.");
  }
  const offset = requireOffset(request.offset, "ESP flash offset");
  const payloadEnd = offset + payloadLength;
  const eraseOffset = Math.floor(offset / eraseBlock) * eraseBlock;
  const eraseEnd = Math.ceil(payloadEnd / eraseBlock) * eraseBlock;
  if (!Number.isSafeInteger(payloadEnd) || !Number.isSafeInteger(eraseEnd) || eraseEnd > flashCapacity) {
    throw new EspProtocolError("ESP payload escapes the detected flash capacity.");
  }
  if (request.target !== "flash" && request.target !== "factory" && request.target !== "firmware" && request.target !== "spi-boot") {
    throw new EspProtocolError(`ESP target ${request.target} is not an intrinsic flash target.`);
  }

  const isEsp8266 = chip === "ESP8266";
  if (!isEsp8266 && (bootOffset <= 0 || bootOffset >= ESP_APPLICATION_OFFSET || bootOffset % eraseBlock !== 0)) {
    throw new EspProtocolError(`Detected ${chip} SPI boot boundary is not a known erase-aligned profile.`);
  }
  // ESP8266 reports a zero BOOTLOADER_FLASH_OFFSET because it has no separate
  // second-stage boundary. Its offset-zero images still contain boot material,
  // so protect the initial range rather than treating it as unprotected.
  const protectedBootStart = isEsp8266 ? 0 : bootOffset;
  const regions: FlashLayout["regions"] = [
    ...(protectedBootStart > 0 ? [{ name: "flash-prefix", offset: 0, length: protectedBootStart }] : []),
    { name: "spi-boot", offset: protectedBootStart, length: ESP_APPLICATION_OFFSET - protectedBootStart, protection: "spi-boot" },
    { name: "firmware", offset: ESP_APPLICATION_OFFSET, length: flashCapacity - ESP_APPLICATION_OFFSET },
  ];
  const layout: FlashLayout = {
    protocol: "esp",
    chip,
    storage: "spi",
    regions,
    protections: {
      preloader: "absent",
      lk: "absent",
      tee: "absent",
      fuses: "absent",
      bootloader: "absent",
      "spi-boot": "present",
      unknown: "absent",
    },
  };
  return bindIntrinsicFlashSafety(request, request.options, {
    protocol: "esp",
    chip,
    region: request.target,
    offset,
    eraseOffset,
    eraseLength: eraseEnd - eraseOffset,
    layout,
  });
}

function blobFromBytes(data: Uint8Array): Blob {
  // BlobPart excludes SharedArrayBuffer-backed views. Make one owned snapshot
  // before persisting bytes received from the browser hardware lease.
  const snapshot = new Uint8Array(data.byteLength);
  snapshot.set(data);
  return new Blob([snapshot.buffer]);
}

function artifactName(chip: string, offset: number, length: number, kind: "backup" | "dump"): string {
  const name = chip.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "esp";
  return `${name}-${kind}-${offset.toString(16).padStart(8, "0")}-${length.toString(16)}.bin`;
}

function progressReader(context: HardwareContext, phase: string): (packet: Uint8Array, completed: number, total: number) => void {
  return (packet, completed, total) => {
      context.progress({ phase, completed, total, message: `${phase} ${completed}/${total} bytes (${packet.length}-byte chunk)` });
    };
}

function terminal(context: HardwareContext): EspLoaderOptions["terminal"] {
  const report = (message: string) => {
    const clean = message.trim();
    if (clean) context.progress({ phase: "esp", message: clean });
  };
  return { clean: () => undefined, write: report, writeLine: report };
}

function isEspToolModule(value: unknown): value is EspToolModule {
  return typeof value === "object" && value !== null && "ESPLoader" in value && typeof value.ESPLoader === "function";
}

async function loadBrowserEspTool(): Promise<EspToolModule> {
  // 0.6.1's package root has extensionless imports that Node cannot load. Its
  // published bundle is self-contained and exposes the same ESPLoader API.
  const bundle: unknown = await import("esptool-js/bundle.js");
  if (!isEspToolModule(bundle)) throw new EspProtocolError("The installed esptool-js bundle does not export ESPLoader.");
  return bundle;
}

interface EspSession {
  readonly loader: EspLoader;
  readonly transport: EspTransport;
  readonly chip: string;
  readonly bootOffset: number;
}

async function openSession(
  request: HardwareRequest,
  context: HardwareContext,
  importEspTool: EspToolImporter,
): Promise<EspSession> {
  requireSerial(context.transport);
  throwIfAborted(context.signal);
  const transport = new EspTransport(context.transport, context.signal);
  try {
    const { ESPLoader } = await importEspTool();
    throwIfAborted(context.signal);
    context.progress({ phase: "connect", message: "Connecting to ESP ROM bootloader." });
    const loader = new ESPLoader({ transport, baudrate: optionBaudRate(request), terminal: terminal(context) });
    const detectedName = await loader.main(optionResetMode(request));
    throwIfAborted(context.signal);
    const { chip, bootOffset } = chipInfo(loader, detectedName);
    context.progress({ phase: "stub", message: `Detected ${chip}; esptool-js stub ${loader.IS_STUB ? "is active" : "is unavailable"}.` });
    return { loader, transport, chip, bootOffset };
  } catch (error) {
    await transport.dispose();
    throw error;
  }
}

async function withSession(
  request: HardwareRequest,
  context: HardwareContext,
  importEspTool: EspToolImporter,
  operation: (session: EspSession) => Promise<HardwareResult>,
): Promise<HardwareResult> {
  const session = await openSession(request, context, importEspTool);
  try {
    return await operation(session);
  } finally {
    await session.transport.dispose();
  }
}

async function detect(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  return withSession(request, context, importEspTool, async ({ loader, chip, bootOffset }) => {
    throwIfAborted(context.signal);
    const flashSize = await loader.detectFlashSize();
    return {
      summary: `Detected ${chip} ESP ROM bootloader.`,
      details: {
        chip,
        flashSize,
        stub: loader.IS_STUB,
        spiBootOffset: bootOffset,
        capabilities: {
          resetSignals: Boolean(context.transport.setSignals),
          baudEscalation: Boolean(context.transport.setBaudRate),
          compressedWrite: true,
          deviceMd5: true,
          readFlash: true,
          postWriteReadback: true,
        },
        security: {
          eFuseOperations: "disabled",
          secureBoot: "not queried",
          flashEncryption: "not queried",
          protectedSpiBootStart: bootOffset,
        },
      },
    };
  });
}

async function dump(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  const offset = requireOffset(request.offset, "ESP dump offset");
  const length = requireLength(request.length, "ESP dump length");
  return withSession(request, context, importEspTool, async ({ loader, chip }) => {
    context.progress({ phase: "dump", completed: 0, total: length, message: `Reading ${length} bytes from ESP flash.` });
    const data = await loader.readFlash(offset, length, progressReader(context, "dump"));
    throwIfAborted(context.signal);
    if (data.length !== length) throw new EspProtocolError(`ESP read_flash returned ${data.length} bytes; expected ${length}.`);
    const blob = blobFromBytes(data);
    const fileId = await context.save(artifactName(chip, offset, length, "dump"), blob);
    const sha256 = await sha256Blob(blob);
    return { summary: `Read ${length} bytes from ${chip} SPI flash.`, fileId, sha256, details: { chip, offset, length } };
  });
}

async function flash(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  const firmware = requireInput(context);
  const offset = requireOffset(request.offset, "ESP flash offset");
  return withSession(request, context, importEspTool, async ({ loader, chip, bootOffset }) => {
    const length = firmware.size;
    if (!Number.isSafeInteger(length)) throw new EspProtocolError("Firmware is too large for an ESP flash operation.");
    const flashCapacity = flashCapacityBytes(await loader.detectFlashSize());
    const safety = intrinsicEspSafety(request, chip, bootOffset, flashCapacity, length);

    // `writeFlash({ compress: true })` erases its complete SPI sector footprint.
    // Escrow and preserve the whole profile-derived footprint, not payload bytes alone.
    context.progress({ phase: "backup", completed: 0, total: safety.eraseLength, message: "Escrowing the complete ESP erase footprint." });
    const before = await loader.readFlash(safety.eraseOffset, safety.eraseLength, progressReader(context, "backup"));
    throwIfAborted(context.signal);
    if (before.length !== safety.eraseLength) {
      throw new EspProtocolError(`ESP pre-write read_flash returned ${before.length} bytes; expected ${safety.eraseLength}.`);
    }
    const backup = await context.save(artifactName(chip, safety.eraseOffset, safety.eraseLength, "backup"), blobFromBytes(before));
    context.progress({ phase: "backup", completed: safety.eraseLength, total: safety.eraseLength, message: `Escrowed complete erase footprint as ${backup}.` });

    const payload = new Uint8Array(await firmware.arrayBuffer());
    const program = new Uint8Array(before);
    program.set(payload, offset - safety.eraseOffset);
    const programImage = blobFromBytes(program);
    const verified = await runVerifiedFlash({
      request,
      context,
      safety,
      backup,
      programImage,
      write: async (approvedFirmware, approval) => {
        throwIfAborted(context.signal);
        const bytes = new Uint8Array(await approvedFirmware.arrayBuffer());
        throwIfAborted(context.signal);
        // esptool-js 0.6.1 normally retries blocks three times. One attempt
        // keeps an interrupted or unacknowledged destructive write explicit.
        loader.WRITE_BLOCK_ATTEMPTS = 1;
        context.progress({ phase: "write", completed: 0, total: bytes.length, message: "Writing compressed ESP flash blocks once; no retry is permitted." });
        await loader.writeFlash({
          fileArray: [{ data: bytes, address: approval.offset }],
          flashMode: "keep",
          flashFreq: "keep",
          flashSize: "keep",
          eraseAll: false,
          compress: true,
          reportProgress: (fileIndex, completed, total) => {
            context.progress({ phase: "write", completed, total, message: `Writing compressed ESP file ${fileIndex + 1}: ${completed}/${total} bytes.` });
          },
          // In esptool-js this engages the stub's ESP_SPI_FLASH_MD5 request and
          // fails writeFlash on a device/file mismatch before readback begins.
          calculateMD5Hash: md5Hex,
        });
        throwIfAborted(context.signal);
      },
      readback: async (approval) => {
        context.progress({ phase: "readback", completed: 0, total: approval.length, message: "Reading back the complete ESP erase footprint for SHA-256 verification." });
        const data = await loader.readFlash(approval.offset, approval.length, progressReader(context, "readback"));
        throwIfAborted(context.signal);
        if (data.length !== approval.length) {
          throw new EspProtocolError(`ESP readback returned ${data.length} bytes; expected ${approval.length}.`);
        }
        return blobFromBytes(data);
      },
    });

    return {
      summary: `Flashed and readback-verified ${length} payload bytes across ${safety.eraseLength} ESP erase-footprint bytes on ${chip}.`,
      verified: verified.verified,
      sha256: verified.sha256,
      details: {
        chip,
        offset,
        length,
        eraseOffset: safety.eraseOffset,
        eraseLength: safety.eraseLength,
        backup,
        deviceMd5: "verified by esptool-js writeFlash",
        programSha256: verified.programSha256,
        readbackSha256: verified.readbackSha256,
      },
    };
  });
}

async function runEsp(request: HardwareRequest, context: HardwareContext, importEspTool: EspToolImporter): Promise<HardwareResult> {
  if (request.protocol !== "esp") throw new EspProtocolError(`ESP flasher cannot run ${request.protocol}.`);
  if (request.action === "detect") return detect(request, context, importEspTool);
  if (request.action === "dump") return dump(request, context, importEspTool);
  if (request.action === "flash") return flash(request, context, importEspTool);
  throw new EspProtocolError(`ESP does not support ${request.action}. eFuse and erase operations are deliberately unavailable.`);
}

export function createEspFlasher(importEspTool: EspToolImporter = loadBrowserEspTool): Flasher {
  return {
    protocol: "esp",
    actions: ["detect", "flash", "dump"],
    run: (request, context) => runEsp(request, context, importEspTool),
  };
}

export const espFlasher = createEspFlasher();
