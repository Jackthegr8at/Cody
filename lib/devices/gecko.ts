import type { Flasher, HardwareContext, HardwareRequest } from "./flasher";
import {
  SerialProtocolError,
  bytes,
  deadline,
  inputBytes,
  requireSerial,
  setBaudRate,
  sha256,
  throwIfAborted,
  writeBytes,
} from "./serial";

const SOH = 0x01;
const STX = 0x02;
const MENU_PROMPT = "BL >";
const MENU_TIMEOUT_MS = 5_000;

export interface GeckoBootloaderInfo {
  version: string;
  menu: string;
}

/**
 * Silicon Labs Gecko serial bootloader's XMODEM-CRC data packet. The image
 * uploader uses 1 KiB STX packets except for a final padded 128-byte SOH
 * packet, and numbers wrap at 255 exactly as XMODEM specifies.
 */
export function geckoXmodemCrcBlock(blockNumber: number, data: Uint8Array): Uint8Array {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 1 || blockNumber > 0xff) {
    throw new SerialProtocolError("XMODEM block number must be 1..255.");
  }
  if (data.byteLength !== 128 && data.byteLength !== 1024) {
    throw new SerialProtocolError("XMODEM-CRC blocks must contain exactly 128 or 1024 bytes.");
  }
  const packet = new Uint8Array(data.byteLength + 5);
  packet[0] = data.byteLength === 1024 ? STX : SOH;
  packet[1] = blockNumber;
  packet[2] = 0xff - blockNumber;
  packet.set(data, 3);
  const crc = xmodemCrc16(data);
  packet[packet.byteLength - 2] = crc >>> 8;
  packet[packet.byteLength - 1] = crc & 0xff;
  return packet;
}

export function xmodemCrc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) === 0 ? crc << 1 : (crc << 1) ^ 0x1021;
    crc &= 0xffff;
  }
  return crc;
}

function decodeMenu(bytesRead: Uint8Array): GeckoBootloaderInfo | null {
  const menu = new TextDecoder().decode(bytesRead);
  const promptIndex = menu.lastIndexOf(MENU_PROMPT);
  if (promptIndex < 0) return null;
  const version = /(?:Gecko|Silicon Labs) Bootloader[^\r\n]*/i.exec(menu)?.[0] ?? "Gecko Bootloader";
  return { version, menu: menu.slice(0, promptIndex + MENU_PROMPT.length) };
}

/**
 * Gecko bootloaders present their menu during the reset window. A carriage
 * return only redraws that menu; it never selects an item. This deliberately
 * does not pulse reset lines because reset polarity is board-specific.
 */
export async function readGeckoBootloaderMenu(context: HardwareContext): Promise<GeckoBootloaderInfo> {
  requireSerial(context.transport);
  await writeBytes(context.transport, bytes(0x0d), context.signal);
  const until = deadline("Gecko bootloader menu", MENU_TIMEOUT_MS);
  const buffer = new Uint8Array(4096);
  let length = 0;
  while (length < buffer.byteLength) {
    throwIfAborted(context.signal);
    const timeoutMs = until.endsAt - Date.now();
    if (timeoutMs <= 0) break;
    const chunk = await context.transport.read(Math.min(256, buffer.byteLength - length), timeoutMs, context.signal);
    if (!chunk) break;
    if (chunk.byteLength > buffer.byteLength - length) throw new SerialProtocolError("Gecko menu transport returned more bytes than requested.");
    buffer.set(chunk, length);
    length += chunk.byteLength;
    const info = decodeMenu(buffer.subarray(0, length));
    if (info) return info;
  }
  throw new SerialProtocolError("Gecko bootloader menu prompt was not received before its deadline.");
}


async function runGecko(request: HardwareRequest, context: HardwareContext) {
  if (request.action === "detect") {
    await setBaudRate(context, request.baudRate);
    const info = await readGeckoBootloaderMenu(context);
    return {
      summary: `Detected ${info.version}.`,
      details: { menu: info.menu, upload: "XMODEM-CRC delivery is available in the bootloader but cannot be safely flashed without installed-image readback verification." },
    };
  }
  if (request.action === "flash") {
    const firmware = await inputBytes(context);
    const digest = await sha256(firmware);
    throw new SerialProtocolError(
      `Refusing Gecko XMODEM flash of SHA-256 ${digest}: the generic serial bootloader exposes delivery CRC/GBL acceptance only, not a trustworthy installed-image readback hash.`,
    );
  }
  throw new SerialProtocolError(`Gecko bootloader does not support the ${request.action} action.`);
}

export const geckoFlasher: Flasher = {
  protocol: "gecko",
  actions: ["detect"],
  run: runGecko,
};
