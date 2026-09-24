import type { Flasher, HardwareContext, HardwareRequest, HardwareTransport } from "./flasher";
import { bindIntrinsicFlashSafety, runVerifiedFlash, type FlashLayout } from "./hardware-safety";
import {
  SerialProtocolError,
  bytes,
  blobFromBytes,
  concatBytes,
  deadline,
  hex,
  inputBytes,
  readByte,
  readExact,
  requireLength,
  requireOffset,
  requireSerial,
  setBaudRate,
  sha256,
  writeBytes,
} from "./serial";

const STK_OK = 0x10;
const STK_INSYNC = 0x14;
const CRC_EOP = 0x20;
const STK_GET_SYNC = 0x30;
const STK_LOAD_ADDRESS = 0x55;
const STK_LEAVE_PROGMODE = 0x51;
const STK_READ_SIGN = 0x75;
const STK_PROG_PAGE = 0x64;
const STK_READ_PAGE = 0x74;
const FLASH_MEMORY = 0x46;
const COMMAND_TIMEOUT_MS = 5_000;

const ATMEGA328P_SIGNATURE = [0x1e, 0x95, 0x0f] as const;
const ATMEGA328P_FLASH: Stk500FlashRange & { pageSize: number } = { start: 0, length: 0x8000, pageSize: 128 };
const ATMEGA328P_APPLICATION: Stk500FlashRange & { name: string } = { name: "application", start: 0, length: 0x7000 };
const ATMEGA328P_BOOTLOADER: Stk500FlashRange & { name: string } = { name: "bootloader", start: 0x7000, length: 0x1000 };
const ATMEGA328P_LAYOUT: FlashLayout = {
  protocol: "stk500", chip: "ATmega328P", storage: "nor",
  regions: [
    { name: ATMEGA328P_APPLICATION.name, offset: ATMEGA328P_APPLICATION.start, length: ATMEGA328P_APPLICATION.length },
    { name: ATMEGA328P_BOOTLOADER.name, offset: ATMEGA328P_BOOTLOADER.start, length: ATMEGA328P_BOOTLOADER.length, protection: "bootloader" },
  ],
  protections: { preloader: "absent", lk: "absent", tee: "absent", fuses: "absent", bootloader: "present", "spi-boot": "absent", unknown: "absent" },
};
const ATMEGA328P_BOARD: Stk500BoardParameters = {
  chip: "ATmega328P", signature: ATMEGA328P_SIGNATURE, flash: ATMEGA328P_FLASH, region: ATMEGA328P_APPLICATION, bootloaderRanges: [ATMEGA328P_BOOTLOADER],
};

export interface Stk500FlashRange {
  start: number;
  length: number;
}

export interface Stk500BoardParameters {
  /** Specific AVR board configuration; no AVR flash layout is inferred. */
  chip: string;
  signature: readonly [number, number, number];
  flash: Stk500FlashRange & { pageSize: number };
  /** Reviewed writable application region; request.target must match this name. */
  region: Stk500FlashRange & { name: string };
  bootloaderRanges: readonly Stk500FlashRange[];
}


function rangeEnd(start: number, length: number, label: string): number {
  const end = start + length;
  if (!Number.isSafeInteger(end) || end <= start) throw new SerialProtocolError(`${label} overflows the supported address range.`);
  return end;
}

function ensureRange(allowed: Stk500FlashRange, start: number, length: number, label: string): void {
  const end = rangeEnd(start, length, label);
  const allowedEnd = rangeEnd(allowed.start, allowed.length, "Declared AVR flash range");
  if (start < allowed.start || end > allowedEnd) throw new SerialProtocolError(`${label} is outside the declared AVR flash range.`);
}


async function transact(transport: HardwareTransport, command: Uint8Array, responseLength: number, label: string, signal: AbortSignal): Promise<Uint8Array> {
  await writeBytes(transport, concatBytes([command, bytes(CRC_EOP)]), signal);
  const status = await readByte(transport, deadline(`${label} sync`, COMMAND_TIMEOUT_MS), signal);
  if (status !== STK_INSYNC) throw new SerialProtocolError(`${label} expected STK_INSYNC (${hex(STK_INSYNC)}), got ${hex(status)}.`);
  const response = await readExact(transport, responseLength, deadline(`${label} response`, COMMAND_TIMEOUT_MS), signal);
  const completion = await readByte(transport, deadline(`${label} completion`, COMMAND_TIMEOUT_MS), signal);
  if (completion !== STK_OK) throw new SerialProtocolError(`${label} expected STK_OK (${hex(STK_OK)}), got ${hex(completion)}.`);
  return response;
}

async function sync(context: HardwareContext): Promise<void> {
  await transact(context.transport, bytes(STK_GET_SYNC), 0, "STK500 sync", context.signal);
}

async function readSignature(context: HardwareContext): Promise<readonly [number, number, number]> {
  const response = await transact(context.transport, bytes(STK_READ_SIGN), 3, "STK500 read signature", context.signal);
  return [response[0]!, response[1]!, response[2]!];
}

async function loadAddress(context: HardwareContext, byteAddress: number): Promise<void> {
  if (!Number.isSafeInteger(byteAddress) || byteAddress < 0 || byteAddress % 2 !== 0 || byteAddress > 0x1fffe) {
    throw new SerialProtocolError("STK500v1 only supports even byte addresses 0x00000..0x1fffe through its 16-bit word address command.");
  }
  const wordAddress = byteAddress >>> 1;
  await transact(context.transport, bytes(STK_LOAD_ADDRESS, wordAddress & 0xff, wordAddress >>> 8), 0, "STK500 load address", context.signal);
}

async function readPage(context: HardwareContext, address: number, length: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 0xffff) throw new SerialProtocolError("STK500 page read must be 1..65535 bytes.");
  await loadAddress(context, address);
  return transact(context.transport, bytes(STK_READ_PAGE, length >>> 8, length & 0xff, FLASH_MEMORY), length, "STK500 read page", context.signal);
}

async function writePage(context: HardwareContext, address: number, data: Uint8Array): Promise<void> {
  if (data.byteLength === 0 || data.byteLength > 0xffff) throw new SerialProtocolError("STK500 page write must be 1..65535 bytes.");
  await loadAddress(context, address);
  await transact(
    context.transport,
    concatBytes([bytes(STK_PROG_PAGE, data.byteLength >>> 8, data.byteLength & 0xff, FLASH_MEMORY), data]),
    0,
    "STK500 program page",
    context.signal,
  );
}

async function readFlash(context: HardwareContext, address: number, length: number, pageSize: number): Promise<Uint8Array> {
  const output = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const chunkLength = Math.min(pageSize, length - read);
    output.set(await readPage(context, address + read, chunkLength), read);
    read += chunkLength;
    context.progress({ phase: "reading", completed: read, total: length });
  }
  return output;
}

interface Stk500PagePlan {
  address: number;
  original: Uint8Array;
  programmed: Uint8Array;
}

async function buildPagePlan(context: HardwareContext, board: Stk500BoardParameters, offset: number, firmware: Uint8Array): Promise<Stk500PagePlan[]> {
  const first = board.flash.start + Math.floor((offset - board.flash.start) / board.flash.pageSize) * board.flash.pageSize;
  const end = rangeEnd(offset, firmware.byteLength, "Requested AVR firmware");
  const lastEnd = board.flash.start + Math.ceil((end - board.flash.start) / board.flash.pageSize) * board.flash.pageSize;
  ensureRange(board.flash, first, lastEnd - first, "STK500 page plan");
  const plans: Stk500PagePlan[] = [];
  for (let address = first; address < lastEnd; address += board.flash.pageSize) {
    const original = await readPage(context, address, board.flash.pageSize);
    const programmed = original.slice();
    const copyStart = Math.max(offset, address);
    const copyEnd = Math.min(end, address + board.flash.pageSize);
    programmed.set(firmware.subarray(copyStart - offset, copyEnd - offset), copyStart - address);
    plans.push({ address, original, programmed });
  }
  return plans;
}

function encodeBackup(plans: readonly Stk500PagePlan[]): Uint8Array {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("CODYAVR1"));
  header[8] = 1;
  header[10] = plans.length >>> 8;
  header[11] = plans.length & 0xff;
  return concatBytes([header, ...plans.map((plan) => {
    const entry = new Uint8Array(plan.original.byteLength + 8);
    entry[0] = plan.address >>> 24;
    entry[1] = (plan.address >>> 16) & 0xff;
    entry[2] = (plan.address >>> 8) & 0xff;
    entry[3] = plan.address & 0xff;
    entry[4] = plan.original.byteLength >>> 24;
    entry[5] = (plan.original.byteLength >>> 16) & 0xff;
    entry[6] = (plan.original.byteLength >>> 8) & 0xff;
    entry[7] = plan.original.byteLength & 0xff;
    entry.set(plan.original, 8);
    return entry;
  })]);
}

async function leaveProgrammingMode(context: HardwareContext): Promise<void> {
  await transact(context.transport, bytes(STK_LEAVE_PROGMODE), 0, "STK500 leave programming mode", context.signal);
}

function sameSignature(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}


async function runStk500(request: HardwareRequest, context: HardwareContext) {
  requireSerial(context.transport);
  await setBaudRate(context, request.baudRate);
  await sync(context);
  let failed = false;
  try {
    if (request.action === "detect") {
      const signature = await readSignature(context);
      return { summary: `Detected STK500v1 AVR ${signature.map((byte) => hex(byte)).join(" ")}.`, details: { signature } };
    }
    const signature = await readSignature(context);
    if (request.action === "flash") {
      if (!sameSignature(signature, ATMEGA328P_SIGNATURE)) {
        throw new SerialProtocolError(`Unsupported STK500v1 signature ${signature.map((byte) => hex(byte)).join(" ")}; only the intrinsic ATmega328P profile is supported.`);
      }
      const offset = requireOffset(request.offset);
      const firmware = await inputBytes(context);
      if (firmware.byteLength === 0) throw new SerialProtocolError("Refusing to flash an empty AVR image.");
      const region = request.target === "application" ? ATMEGA328P_APPLICATION : request.target === "bootloader" ? ATMEGA328P_BOOTLOADER : undefined;
      if (!region) throw new SerialProtocolError("ATmega328P flashes must target application or the protected bootloader region.");
      ensureRange(region, offset, firmware.byteLength, "ATmega328P firmware");
      const plans = await buildPagePlan(context, ATMEGA328P_BOARD, offset, firmware);
      const eraseOffset = plans[0].address;
      const program = concatBytes(plans.map((plan) => plan.programmed));
      ensureRange(region, eraseOffset, program.byteLength, "ATmega328P erase footprint");
      const safety = bindIntrinsicFlashSafety(request, request.options, {
        protocol: "stk500", chip: "ATmega328P", region: region.name, offset, eraseOffset, eraseLength: program.byteLength, layout: ATMEGA328P_LAYOUT,
      });
      const backup = await context.save("stk500-atmega328p-preflash.cody-avr", blobFromBytes(encodeBackup(plans)));
      const result = await runVerifiedFlash({
        request, context, safety, backup, programImage: blobFromBytes(program),
        write: async () => {
          for (const plan of plans) await writePage(context, plan.address, plan.programmed);
        },
        readback: async (approval) => blobFromBytes(await readFlash(context, approval.offset, approval.length, ATMEGA328P_FLASH.pageSize)),
      });
      return { summary: `Flashed and verified ${result.length} bytes on ATmega328P.`, verified: true, sha256: result.sha256, details: { signature, offset, backup, programSha256: result.programSha256, readbackSha256: result.readbackSha256, programOffset: result.offset, programLength: result.length } };
    }
    if (!sameSignature(signature, ATMEGA328P_SIGNATURE)) {
      throw new SerialProtocolError(`Unsupported STK500v1 signature ${signature.map((byte) => hex(byte)).join(" ")}; no intrinsic dump geometry is available.`);
    }
    const board = ATMEGA328P_BOARD;
    if (request.action === "dump") {
      const offset = requireOffset(request.offset);
      const length = requireLength(request.length);
      if (offset % 2 !== 0) throw new SerialProtocolError("STK500v1 only supports even byte addresses; it has no byte-address load command.");
      ensureRange(board.flash, offset, length, "Requested AVR dump");
      const data = await readFlash(context, offset, length, board.flash.pageSize);
      const digest = await sha256(data);
      const fileId = await context.save(`stk500-${board.chip}-${hex(offset, 4)}.bin`, blobFromBytes(data));
      return { summary: `Read ${length} bytes from ${board.chip}.`, fileId, sha256: digest, details: { signature, offset, length } };
    }
    throw new SerialProtocolError(`STK500v1 does not support the ${request.action} action.`);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await leaveProgrammingMode(context);
    } catch (leaveError) {
      if (!failed) throw leaveError;
    }
  }
}

/** ATmega328P only: 128-byte full-page backup/readback; top 4 KiB is a protected bootloader region and requires allow-bootloader. */
export const stk500Flasher: Flasher = {
  protocol: "stk500",
  actions: ["detect", "dump", "flash"],
  run: runStk500,
};
