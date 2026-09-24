import type { Flasher, HardwareContext, HardwareRequest, HardwareResult, HardwareTransport } from "./flasher";
import {
  bindIntrinsicFlashSafety,
  classifyProtectedRegionName,
  runVerifiedFlash,
  type FlashLayout,
} from "./hardware-safety";
import { deadline, readExact, sha256, throwIfAborted } from "./serial";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FASTBOOT_PACKET_BYTES = 64;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const FASTBOOT_TIMEOUT_MS = 15_000;

export class FastbootProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FastbootProtocolError";
  }
}
class FastbootCommandFailure extends FastbootProtocolError {}

export type FastbootResponse =
  | { type: "INFO"; message: string }
  | { type: "OKAY"; message: string }
  | { type: "FAIL"; message: string }
  | { type: "DATA"; size: number };

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new FastbootProtocolError("Fastboot sent non-UTF-8 response text.");
  }
}

function binaryBlob(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes.buffer]);
}

/** Parses exactly one 4-byte-tagged Fastboot response packet. */
export function parseFastbootResponse(packet: Uint8Array): FastbootResponse {
  if (packet.length < 4) throw new FastbootProtocolError("Fastboot response is shorter than its 4-byte tag.");
  const type = String.fromCharCode(packet[0]!, packet[1]!, packet[2]!, packet[3]!);
  const body = packet.subarray(4);
  if (type === "DATA") {
    const hexSize = decode(body);
    if (!/^[0-9a-fA-F]{8}$/.test(hexSize)) {
      throw new FastbootProtocolError(`Fastboot DATA length must be eight hexadecimal digits, received ${JSON.stringify(hexSize)}.`);
    }
    return { type, size: Number.parseInt(hexSize, 16) };
  }
  if (type === "INFO" || type === "OKAY" || type === "FAIL") return { type, message: decode(body) };
  throw new FastbootProtocolError(`Unknown Fastboot response tag ${JSON.stringify(type)}.`);
}

function requireUsb(transport: HardwareTransport): void {
  if (transport.kind !== "usb") throw new FastbootProtocolError("Fastboot requires a USB bulk transport.");
}

function requireTarget(target: string | undefined, label = "partition"): string {
  if (!target || !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(target)) {
    throw new FastbootProtocolError(`A Fastboot ${label} containing only letters, numbers, '.', '_', '-', and one slot ':' suffix is required.`);
  }
  return target;
}

function requireCommand(command: string): Uint8Array {
  const encoded = encoder.encode(command);
  if (encoded.length === 0 || encoded.length > FASTBOOT_PACKET_BYTES) {
    throw new FastbootProtocolError(`Fastboot command length must be 1-${FASTBOOT_PACKET_BYTES} bytes.`);
  }
  return encoded;
}

async function readResponse(context: HardwareContext): Promise<FastbootResponse> {
  throwIfAborted(context.signal);
  const packet = await context.transport.read(FASTBOOT_PACKET_BYTES, FASTBOOT_TIMEOUT_MS, context.signal);
  if (!packet) throw new FastbootProtocolError("Timed out waiting for a Fastboot response.");
  return parseFastbootResponse(packet);
}

interface FastbootTerminal {
  infos: string[];
  okay: string;
}

/** Reads INFO frames until the one terminal Fastboot reply. FAIL remains an
 * error: completion after a failed command is unknown and must not continue. */
async function readTerminal(context: HardwareContext): Promise<FastbootTerminal> {
  const infos: string[] = [];
  for (;;) {
    const response = await readResponse(context);
    if (response.type === "INFO") {
      infos.push(response.message);
      continue;
    }
    if (response.type === "OKAY") return { infos, okay: response.message };
    if (response.type === "FAIL") throw new FastbootCommandFailure(`Fastboot rejected the command: ${response.message || "unspecified failure"}.`);
    throw new FastbootProtocolError("Fastboot returned DATA where a terminal response was required.");
  }
}
async function command(context: HardwareContext, value: string): Promise<FastbootTerminal> {
  throwIfAborted(context.signal);
  await context.transport.write(requireCommand(value), context.signal);
  return readTerminal(context);
}

async function getvar(context: HardwareContext, name: string): Promise<string> {
  const terminal = await command(context, `getvar:${name}`);
  return terminal.okay;
}

function parseHexSize(value: string, name: string): number {
  const match = /^(?:0x)?([0-9a-fA-F]+)$/.exec(value.trim());
  if (!match) throw new FastbootProtocolError(`Fastboot getvar:${name} did not return a hexadecimal size.`);
  const size = Number.parseInt(match[1]!, 16);
  if (!Number.isSafeInteger(size) || size <= 0) throw new FastbootProtocolError(`Fastboot getvar:${name} returned an unsupported size.`);
  return size;
}

interface FastbootReadback {
  partitionSize: number;
  fetchSize: number;
}

/** `fetch` is a Fastboot extension, not a protocol guarantee. Both the exact
 * target size and explicit maximum fetch size must be reported before this
 * implementation sends any fetch command or permits a write. */
async function readbackCapability(context: HardwareContext, target: string): Promise<FastbootReadback> {
  let partitionSize: string;
  let fetchSize: string;
  try {
    partitionSize = await getvar(context, `partition-size:${target}`);
    fetchSize = await getvar(context, "fetch-size");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FastbootProtocolError(`Fastboot readback is unsupported for ${target}: ${message}`);
  }
  return {
    partitionSize: parseHexSize(partitionSize, `partition-size:${target}`),
    fetchSize: parseHexSize(fetchSize, "fetch-size"),
  };
}

async function fetchRange(
  context: HardwareContext,
  target: string,
  offset: number,
  length: number,
  capability: FastbootReadback,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || offset + length > capability.partitionSize) {
    throw new FastbootProtocolError("Requested Fastboot fetch range is outside the reported partition size.");
  }
  if (length > MAX_ARTIFACT_BYTES) {
    throw new FastbootProtocolError(`Fastboot ${target} readback of ${length} bytes exceeds the ${MAX_ARTIFACT_BYTES}-byte browser artifact limit; streaming storage is required.`);
  }
  const data = new Uint8Array(length);
  let position = offset;
  let dataOffset = 0;
  const end = offset + length;
  while (position < end) {
    const requested = Math.min(capability.fetchSize, end - position);
    const request = `fetch:${target}:${position.toString(16)}:${requested.toString(16)}`;
    throwIfAborted(context.signal);
    await context.transport.write(requireCommand(request), context.signal);
    const response = await readResponse(context);
    if (response.type === "FAIL") throw new FastbootProtocolError(`Fastboot fetch failed: ${response.message || "unspecified failure"}.`);
    if (response.type !== "DATA") throw new FastbootProtocolError("Fastboot fetch did not announce a DATA response.");
    if (response.size !== requested) {
      throw new FastbootProtocolError(`Fastboot fetch announced ${response.size} bytes; expected ${requested}.`);
    }
    data.set(await readExact(context.transport, requested, deadline("Fastboot fetch data", FASTBOOT_TIMEOUT_MS), context.signal), dataOffset);
    await readTerminal(context);
    position += requested;
    dataOffset += requested;
    context.progress({ phase: "readback", completed: dataOffset, total: length });
  }
  return data;
}




async function download(context: HardwareContext, firmware: Uint8Array): Promise<void> {
  throwIfAborted(context.signal);
  await context.transport.write(requireCommand(`download:${firmware.length.toString(16).padStart(8, "0")}`), context.signal);
  const response = await readResponse(context);
  if (response.type === "FAIL") throw new FastbootProtocolError(`Fastboot download was refused: ${response.message || "unspecified failure"}.`);
  if (response.type !== "DATA") throw new FastbootProtocolError("Fastboot did not acknowledge download with DATA.");
  if (response.size !== firmware.length) throw new FastbootProtocolError(`Fastboot accepted ${response.size} download bytes, expected ${firmware.length}.`);
  await context.transport.write(firmware, context.signal);
  await readTerminal(context);
}

function getvarAll(infos: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const info of infos) {
    const separator = info.indexOf(":");
    if (separator > 0) values[info.slice(0, separator)] = info.slice(separator + 1).trim();
  }
  return values;
}

async function detect(context: HardwareContext): Promise<HardwareResult> {
  const version = await getvar(context, "version");
  let allSupported = true;
  let all: Record<string, string> = {};
  try {
    const terminal = await command(context, "getvar:all");
    all = getvarAll(terminal.infos);
  } catch (error) {
    if (!(error instanceof FastbootCommandFailure)) throw error;
    allSupported = false;
    context.progress({ phase: "detect", message: "Fastboot getvar:all is not supported by this bootloader." });
  }
  return {
    summary: `Fastboot ${version || "device"} detected.${allSupported ? " getvar:all completed." : " getvar:all is not supported by this bootloader."}`,
    details: { version, variables: all, getvarAll: allSupported },
  };
}

async function dump(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  const target = requireTarget(request.target);
  const offset = request.offset ?? 0;
  const capability = await readbackCapability(context, target);
  const length = request.length ?? capability.partitionSize - offset;
  if (!Number.isSafeInteger(length) || length <= 0) throw new FastbootProtocolError("Fastboot dump length must be a positive integer.");
  await context.confirm({
    action: "fastboot dump",
    target,
    offset,
    length,
    backup: "not applicable: read-only Fastboot fetch",
  });
  const data = await fetchRange(context, target, offset, length, capability);
  const digest = await sha256(data);
  const fileId = await context.save(`${target}.bin`, binaryBlob(data));
  return { summary: `Read ${data.length} bytes from Fastboot ${target}.`, verified: true, sha256: digest, fileId, details: { offset, length } };
}

function wholePartitionLayout(chip: string, target: string, length: number): FlashLayout {
  // An unclassified logical partition is never assumed safe to overwrite.
  const protection = classifyProtectedRegionName(target) ?? "unknown";
  return {
    protocol: "fastboot",
    chip,
    storage: "logical",
    regions: [{ name: target, offset: 0, length, protection }],
    protections: {
      preloader: protection === "preloader" ? "present" : "absent",
      lk: protection === "lk" ? "present" : "absent",
      tee: protection === "tee" ? "present" : "absent",
      fuses: protection === "fuses" ? "present" : "absent",
      bootloader: protection === "bootloader" ? "present" : "absent",
      "spi-boot": protection === "spi-boot" ? "present" : "absent",
      unknown: protection === "unknown" ? "present" : "absent",
    },
  };
}

async function flash(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  const target = requireTarget(request.target);
  if (request.offset !== 0) {
    throw new FastbootProtocolError("Fastboot verified flash requires explicit offset 0 for a whole named partition.");
  }
  if (!context.input) throw new FastbootProtocolError("Fastboot flash requires a firmware input.");

  const chip = (await getvar(context, "product")).trim();
  if (!chip) throw new FastbootProtocolError("Fastboot device did not report a product identity.");
  const capability = await readbackCapability(context, target);
  if (context.input.size !== capability.partitionSize || (request.length !== undefined && request.length !== capability.partitionSize)) {
    throw new FastbootProtocolError(`Fastboot verified flash requires an image exactly matching ${target} partition length ${capability.partitionSize}.`);
  }

  const safety = bindIntrinsicFlashSafety(request, request.options, {
    protocol: "fastboot",
    chip,
    region: target,
    offset: 0,
    eraseOffset: 0,
    eraseLength: capability.partitionSize,
    layout: wholePartitionLayout(chip, target, capability.partitionSize),
  });
  const original = await fetchRange(context, target, 0, capability.partitionSize, capability);
  const originalDigest = await sha256(original);
  const backupId = await context.save(`${target}.preflash.bin`, binaryBlob(original));
  const verified = await runVerifiedFlash({
    request,
    context,
    safety,
    backup: `Saved full ${target} backup as ${backupId} (sha256 ${originalDigest}).`,
    programImage: context.input,
    write: async (firmware) => {
      await download(context, new Uint8Array(await firmware.arrayBuffer()));
      await command(context, `flash:${target}`);
    },
    readback: async () => binaryBlob(await fetchRange(context, target, 0, capability.partitionSize, capability)),
  });
  return {
    ...verified,
    summary: `Flashed and verified Fastboot ${target} (${capability.partitionSize} bytes).`,
    details: { chip, backupId, partitionSize: capability.partitionSize },
  };
}

async function execute(request: HardwareRequest, context: HardwareContext): Promise<HardwareResult> {
  const value = request.command;
  if (value === "erase") {
    throw new FastbootProtocolError("Refusing Fastboot erase: generic Fastboot cannot establish an intrinsic reviewed erase footprint and protected-partition policy.");
  }
  if (value === "download") {
    if (!context.input || context.input.size <= 0 || context.input.size > MAX_ARTIFACT_BYTES) {
      throw new FastbootProtocolError(`Fastboot download requires firmware between 1 byte and ${MAX_ARTIFACT_BYTES} bytes.`);
    }
    const firmware = new Uint8Array(await context.input.arrayBuffer());
    const digest = await sha256(firmware);
    await context.confirm({ action: "fastboot download", target: "fastboot-download-buffer", sha256: digest, offset: 0, length: firmware.length, backup: "not applicable: Fastboot download stages bytes in the volatile download buffer" });
    await download(context, firmware);
    return { summary: "Staged firmware in the volatile Fastboot download buffer.", verified: false, sha256: digest, details: { length: firmware.length } };
  }
  if (value === "set_active") {
    const slot = requireTarget(request.target, "slot");
    await context.confirm({ action: "fastboot set_active", target: slot, backup: "not applicable: active-slot selection is reversible with set_active" });
    await command(context, `set_active:${slot}`);
    const active = await getvar(context, "current-slot");
    if (active.trim() !== slot) throw new FastbootProtocolError(`Fastboot reports active slot ${active || "(empty)"}, not ${slot}.`);
    return { summary: `Activated slot ${slot}.`, verified: true, details: { currentSlot: active.trim() } };
  }
  if (value === "reboot" || value === "reboot-bootloader") {
    await context.confirm({ action: `fastboot ${value}`, target: value, backup: "not applicable: reboot changes no stored image" });
    await command(context, value);
    return { summary: `Fastboot accepted ${value}.`, verified: false };
  }
  throw new FastbootProtocolError("Fastboot exec only permits download, set_active, reboot, and reboot-bootloader.");
}


async function runFastboot(request: HardwareRequest, context: HardwareContext) {
  requireUsb(context.transport);
  switch (request.action) {
    case "detect": return detect(context);
    case "dump": return dump(request, context);
    case "flash": return flash(request, context);
    case "exec": return execute(request, context);
    default: throw new FastbootProtocolError(`Fastboot does not support ${request.action}.`);
  }
}

export const fastbootFlasher: Flasher = {
  protocol: "fastboot",
  actions: ["detect", "flash", "dump", "exec"],
  run: runFastboot,
};
