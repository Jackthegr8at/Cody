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
  xorChecksum,
} from "./serial";

const ACK = 0x79;
const NACK = 0x1f;
const SYNC = 0x7f;
const GET = 0x00;
const GET_ID = 0x02;
const READ_MEMORY = 0x11;
const WRITE_MEMORY = 0x31;
const ERASE = 0x43;
const EXTENDED_ERASE = 0x44;
const MAX_TRANSFER = 256;
const COMMAND_TIMEOUT_MS = 5_000;

const STM32F103_MEDIUM_ID = 0x0410;
const STM32F103_FLASH_START = 0x08000000;
const STM32F103_FLASH_SIZE_REGISTER = 0x1ffff7e0;
const STM32F103_PAGE_SIZE = 1024;

function stm32f103Layout(length: number): FlashLayout {
  return {
    protocol: "stm32", chip: "STM32F103 medium-density", storage: "nor",
    regions: [{ name: "program", offset: STM32F103_FLASH_START, length, protection: "bootloader" }],
    protections: { preloader: "absent", lk: "absent", tee: "absent", fuses: "absent", bootloader: "present", "spi-boot": "absent", unknown: "absent" },
  };
}

export interface Stm32FlashRange {
  start: number;
  length: number;
}

export interface Stm32ErasePlan {
  command: "standard" | "extended";
  pages: readonly number[];
}
export interface Stm32BootloaderInfo {
  version: number;
  commands: readonly number[];
  productId: number;
}


function intervalEnd(start: number, length: number, label: string): number {
  const end = start + length;
  if (!Number.isSafeInteger(end) || end <= start) throw new SerialProtocolError(`${label} overflows the supported address range.`);
  return end;
}

function ensureFlashRange(board: { flashStart: number; flashSize: number }, start: number, length: number, label: string): void {
  const end = intervalEnd(start, length, label);
  const flashEnd = intervalEnd(board.flashStart, board.flashSize, "Declared STM32 flash range");
  if (start < board.flashStart || end > flashEnd) throw new SerialProtocolError(`${label} is outside the declared STM32 flash range.`);
}



function commandAvailable(info: Stm32BootloaderInfo, command: number): void {
  if (!info.commands.includes(command)) throw new SerialProtocolError(`STM32 ROM bootloader does not advertise command ${hex(command)}.`);
}

async function expectAck(transport: HardwareTransport, label: string, signal: AbortSignal): Promise<void> {
  const response = await readByte(transport, deadline(label, COMMAND_TIMEOUT_MS), signal);
  if (response === ACK) return;
  if (response === NACK) throw new SerialProtocolError(`${label} was rejected by the STM32 ROM bootloader.`);
  throw new SerialProtocolError(`${label} expected ACK (${hex(ACK)}), got ${hex(response)}.`);
}

async function sendCommand(transport: HardwareTransport, command: number, label: string, signal: AbortSignal): Promise<void> {
  await writeBytes(transport, bytes(command, command ^ 0xff), signal);
  await expectAck(transport, `${label} command`, signal);
}

function addressPacket(address: number): Uint8Array {
  if (!Number.isSafeInteger(address) || address < 0 || address > 0xffff_ffff) {
    throw new SerialProtocolError("STM32 ROM bootloader addresses must be unsigned 32-bit integers.");
  }
  const addressBytes = bytes(address >>> 24, (address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff);
  return concatBytes([addressBytes, bytes(xorChecksum(addressBytes))]);
}

async function connectStm32(context: HardwareContext): Promise<Stm32BootloaderInfo> {
  requireSerial(context.transport);
  await writeBytes(context.transport, bytes(SYNC), context.signal);
  await expectAck(context.transport, "STM32 bootloader sync", context.signal);

  await sendCommand(context.transport, GET, "STM32 GET", context.signal);
  const count = await readByte(context.transport, deadline("STM32 GET response length", COMMAND_TIMEOUT_MS), context.signal);
  const response = await readExact(context.transport, count + 1, deadline("STM32 GET response", COMMAND_TIMEOUT_MS), context.signal);
  await expectAck(context.transport, "STM32 GET completion", context.signal);
  if (response.byteLength === 0) throw new SerialProtocolError("STM32 GET returned no bootloader version.");

  await sendCommand(context.transport, GET_ID, "STM32 GET ID", context.signal);
  const idLength = await readByte(context.transport, deadline("STM32 GET ID length", COMMAND_TIMEOUT_MS), context.signal) + 1;
  if (idLength !== 2) throw new SerialProtocolError(`STM32 GET ID returned ${idLength} bytes; only 16-bit product IDs are supported.`);
  const id = await readExact(context.transport, idLength, deadline("STM32 GET ID", COMMAND_TIMEOUT_MS), context.signal);
  await expectAck(context.transport, "STM32 GET ID completion", context.signal);
  return { version: response[0]!, commands: Array.from(response.subarray(1)), productId: (id[0]! << 8) | id[1]! };
}

async function readMemory(context: HardwareContext, info: Stm32BootloaderInfo, address: number, length: number): Promise<Uint8Array> {
  commandAvailable(info, READ_MEMORY);
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const chunkLength = Math.min(MAX_TRANSFER, length - offset);
    await sendCommand(context.transport, READ_MEMORY, "STM32 read memory", context.signal);
    await writeBytes(context.transport, addressPacket(address + offset), context.signal);
    await expectAck(context.transport, "STM32 read address", context.signal);
    const count = chunkLength - 1;
    await writeBytes(context.transport, bytes(count, count ^ 0xff), context.signal);
    await expectAck(context.transport, "STM32 read length", context.signal);
    result.set(await readExact(context.transport, chunkLength, deadline("STM32 read data", COMMAND_TIMEOUT_MS), context.signal), offset);
    offset += chunkLength;
    context.progress({ phase: "reading", completed: offset, total: length });
  }
  return result;
}

async function erasePages(context: HardwareContext, info: Stm32BootloaderInfo, erase: Stm32ErasePlan): Promise<void> {
  const command = erase.command === "standard" ? ERASE : EXTENDED_ERASE;
  commandAvailable(info, command);
  if (erase.command === "standard") {
    if (erase.pages.length > 256 || erase.pages.some((page) => page > 0xff)) {
      throw new SerialProtocolError("Standard STM32 erase supports 1..256 page numbers in 0..255.");
    }
    const payload = bytes(erase.pages.length - 1, ...erase.pages);
    await sendCommand(context.transport, ERASE, "STM32 erase", context.signal);
    await writeBytes(context.transport, concatBytes([payload, bytes(xorChecksum(payload))]), context.signal);
    await expectAck(context.transport, "STM32 erase completion", context.signal);
    return;
  }
  if (erase.pages.length > 65_535 || erase.pages.some((page) => page > 0xffff)) {
    throw new SerialProtocolError("Extended STM32 erase supports 1..65535 page numbers in 0..65535; mass erase is refused.");
  }
  const count = erase.pages.length - 1;
  const payload = new Uint8Array(2 + erase.pages.length * 2);
  payload[0] = count >>> 8;
  payload[1] = count & 0xff;
  for (let index = 0; index < erase.pages.length; index += 1) {
    const page = erase.pages[index]!;
    payload[2 + index * 2] = page >>> 8;
    payload[3 + index * 2] = page & 0xff;
  }
  await sendCommand(context.transport, EXTENDED_ERASE, "STM32 extended erase", context.signal);
  await writeBytes(context.transport, concatBytes([payload, bytes(xorChecksum(payload))]), context.signal);
  await expectAck(context.transport, "STM32 extended erase completion", context.signal);
}

async function writeMemory(context: HardwareContext, info: Stm32BootloaderInfo, address: number, firmware: Uint8Array): Promise<void> {
  commandAvailable(info, WRITE_MEMORY);
  let offset = 0;
  while (offset < firmware.byteLength) {
    const chunk = firmware.subarray(offset, offset + Math.min(MAX_TRANSFER, firmware.byteLength - offset));
    await sendCommand(context.transport, WRITE_MEMORY, "STM32 write memory", context.signal);
    await writeBytes(context.transport, addressPacket(address + offset), context.signal);
    await expectAck(context.transport, "STM32 write address", context.signal);
    const payload = new Uint8Array(chunk.byteLength + 1);
    payload[0] = chunk.byteLength - 1;
    payload.set(chunk, 1);
    await writeBytes(context.transport, concatBytes([payload, bytes(xorChecksum(payload))]), context.signal);
    await expectAck(context.transport, "STM32 write completion", context.signal);
    offset += chunk.byteLength;
    context.progress({ phase: "writing", completed: offset, total: firmware.byteLength });
  }
}


async function runStm32(request: HardwareRequest, context: HardwareContext) {
  requireSerial(context.transport);
  await setBaudRate(context, request.baudRate);
  const info = await connectStm32(context);
  if (request.action === "detect") {
    return {
      summary: `Detected STM32 ROM bootloader ${hex(info.productId, 4)}.`,
      details: { productId: info.productId, version: info.version, commands: info.commands.map((command) => hex(command)) },
    };
  }
  if (request.action === "dump") {
    if (info.productId !== STM32F103_MEDIUM_ID) {
      throw new SerialProtocolError(`Unsupported STM32 ROM product ID ${hex(info.productId, 4)}; no intrinsic dump geometry is available.`);
    }
    commandAvailable(info, READ_MEMORY);
    const sizeBytes = await readMemory(context, info, STM32F103_FLASH_SIZE_REGISTER, 2);
    const sizeKiB = sizeBytes[0]! | (sizeBytes[1]! << 8);
    if (sizeKiB < 16 || sizeKiB > 128 || sizeKiB === 0xffff) throw new SerialProtocolError(`STM32F103 factory flash-size value ${sizeKiB} KiB is outside the supported medium-density profile.`);
    const offset = requireOffset(request.offset);
    const length = requireLength(request.length);
    ensureFlashRange({ flashStart: STM32F103_FLASH_START, flashSize: sizeKiB * 1024 }, offset, length, "STM32F103 dump");
    const data = await readMemory(context, info, offset, length);
    const digest = await sha256(data);
    const fileId = await context.save(`stm32f103-${hex(offset, 8)}.bin`, blobFromBytes(data));
    return { summary: `Read ${length} bytes from STM32F103 program flash.`, fileId, sha256: digest, details: { productId: info.productId, offset, length } };
  }
  if (request.action === "flash") {
    if (info.productId !== STM32F103_MEDIUM_ID) {
      throw new SerialProtocolError(`Unsupported STM32 ROM product ID ${hex(info.productId, 4)}; only the intrinsic STM32F103 medium-density profile is supported.`);
    }
    commandAvailable(info, READ_MEMORY);
    commandAvailable(info, WRITE_MEMORY);
    commandAvailable(info, ERASE);
    const sizeBytes = await readMemory(context, info, STM32F103_FLASH_SIZE_REGISTER, 2);
    const sizeKiB = sizeBytes[0]! | (sizeBytes[1]! << 8);
    if (sizeKiB < 16 || sizeKiB > 128 || sizeKiB === 0xffff) {
      throw new SerialProtocolError(`STM32F103 factory flash-size value ${sizeKiB} KiB is outside the supported medium-density profile.`);
    }
    const flashLength = sizeKiB * 1024;
    const offset = requireOffset(request.offset);
    const firmware = await inputBytes(context);
    if (firmware.byteLength === 0) throw new SerialProtocolError("Refusing to flash an empty STM32 image.");
    const programRange: Stm32FlashRange = { start: STM32F103_FLASH_START, length: flashLength };
    ensureFlashRange({ flashStart: programRange.start, flashSize: programRange.length }, offset, firmware.byteLength, "STM32F103 firmware");
    const eraseOffset = STM32F103_FLASH_START + Math.floor((offset - STM32F103_FLASH_START) / STM32F103_PAGE_SIZE) * STM32F103_PAGE_SIZE;
    const payloadEnd = offset + firmware.byteLength;
    const eraseEnd = STM32F103_FLASH_START + Math.ceil((payloadEnd - STM32F103_FLASH_START) / STM32F103_PAGE_SIZE) * STM32F103_PAGE_SIZE;
    const eraseLength = eraseEnd - eraseOffset;
    ensureFlashRange({ flashStart: programRange.start, flashSize: programRange.length }, eraseOffset, eraseLength, "STM32F103 erase footprint");
    const pageStart = (eraseOffset - STM32F103_FLASH_START) / STM32F103_PAGE_SIZE;
    const pageCount = eraseLength / STM32F103_PAGE_SIZE;
    const erase: Stm32ErasePlan = {
      command: "standard",
      pages: Array.from({ length: pageCount }, (_, index) => pageStart + index),
    };
    const original = await readMemory(context, info, eraseOffset, eraseLength);
    const program = original.slice();
    program.set(firmware, offset - eraseOffset);
    const safety = bindIntrinsicFlashSafety(request, request.options, {
      protocol: "stm32", chip: "STM32F103 medium-density", region: "program", offset, eraseOffset, eraseLength, layout: stm32f103Layout(flashLength),
    });
    const backup = await context.save(`stm32f103-${hex(eraseOffset, 8)}-preflash.bin`, blobFromBytes(original));
    const result = await runVerifiedFlash({
      request, context, safety, backup, programImage: blobFromBytes(program),
      write: async () => { await erasePages(context, info, erase); await writeMemory(context, info, eraseOffset, program); },
      readback: async (approval) => blobFromBytes(await readMemory(context, info, approval.offset, approval.length)),
    });
    return { summary: `Flashed and verified ${result.length} STM32F103 program bytes.`, verified: true, sha256: result.sha256, details: { productId: info.productId, offset, backup, programSha256: result.programSha256, readbackSha256: result.readbackSha256, programOffset: result.offset, programLength: result.length } };
  }
  throw new SerialProtocolError(`STM32 ROM bootloader does not support the ${request.action} action.`);
}

/** STM32F103 medium-density only: factory flash-size geometry, full page backup/readback, and conservative protected program-flash writes. */
export const stm32Flasher: Flasher = {
  protocol: "stm32",
  actions: ["detect", "dump", "flash"],
  run: runStm32,
};
