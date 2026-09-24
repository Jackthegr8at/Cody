export interface BluetoothCaptureFrame {
  timestamp: number;
  direction: "host-to-controller" | "controller-to-host" | "unknown";
  packetType: number;
  base64: string;
  source: "btsnoop" | "pcap";
}

export interface BluetoothCapture {
  format: "btsnoop" | "pcap";
  frames: BluetoothCaptureFrame[];
  warnings: string[];
}

const BTSNOOP_MAGIC = "btsnoop\0";
const BTSNOOP_EPOCH_OFFSET_US = BigInt("62168256000000000");

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function readU32(view: DataView, offset: number, littleEndian = false): number {
  if (offset + 4 > view.byteLength) throw new Error("Capture ends inside a record header.");
  return view.getUint32(offset, littleEndian);
}

function readU64(view: DataView, offset: number): bigint {
  if (offset + 8 > view.byteLength) throw new Error("Capture ends inside a record header.");
  return view.getBigUint64(offset);
}

function timestampFromBtsnoop(value: bigint): number {
  const unixUs = value - BTSNOOP_EPOCH_OFFSET_US;
  return Number(unixUs / BigInt(1000));
}

function hciDirection(flags: number): BluetoothCaptureFrame["direction"] {
  return flags === 0 ? "host-to-controller" : "controller-to-host";
}

export function parseBtsnoop(bytes: Uint8Array): BluetoothCapture {
  if (bytes.byteLength < 16 || new TextDecoder().decode(bytes.subarray(0, 8)) !== BTSNOOP_MAGIC) throw new Error("Not a btsnoop capture.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = readU32(view, 8);
  const datalink = readU32(view, 12);
  if (version !== 1) throw new Error("Unsupported btsnoop version " + version + ".");
  if (datalink !== 1002) throw new Error("Unsupported btsnoop datalink " + datalink + "; expected HCI UART (1002).");
  const frames: BluetoothCaptureFrame[] = [];
  let offset = 16;
  while (offset < view.byteLength) {
    if (offset + 24 > view.byteLength) throw new Error("Capture ends inside a btsnoop record header.");
    const originalLength = readU32(view, offset);
    const includedLength = readU32(view, offset + 4);
    const flags = readU32(view, offset + 8);
    const timestamp = timestampFromBtsnoop(readU64(view, offset + 16));
    offset += 24;
    if (includedLength > originalLength || offset + includedLength > view.byteLength) throw new Error("Invalid btsnoop record length.");
    const payload = bytes.subarray(offset, offset + includedLength);
    offset += includedLength;
    frames.push({ timestamp, direction: hciDirection(flags), packetType: payload[0] ?? 0, base64: bytesToBase64(payload), source: "btsnoop" });
  }
  return { format: "btsnoop", frames, warnings: ["HCI captures do not prove a decrypted ATT/GATT payload. Pairing encryption, key availability, and controller metadata determine what can be interpreted."] };
}

/** Classic libpcap reader for HCI H4 packets. pcapng is intentionally refused:
 * it has a different block model and must not be parsed as a plausible pcap. */
export function parseHciPcap(bytes: Uint8Array): BluetoothCapture {
  if (bytes.byteLength < 24) throw new Error("Capture is too small for a pcap header.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  const littleEndian = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
  const normalized = littleEndian ? view.getUint32(0, true) : magic;
  if (normalized !== 0xa1b2c3d4 && normalized !== 0xa1b23c4d) throw new Error("Unsupported capture format. Import btsnoop or classic pcap; pcapng is not yet supported.");
  const network = readU32(view, 20, littleEndian);
  if (network !== 201) throw new Error("Unsupported pcap link type " + network + "; expected Bluetooth HCI H4 (201).");
  const nanoseconds = normalized === 0xa1b23c4d;
  const frames: BluetoothCaptureFrame[] = [];
  let offset = 24;
  while (offset < view.byteLength) {
    if (offset + 16 > view.byteLength) throw new Error("Capture ends inside a pcap record header.");
    const seconds = readU32(view, offset, littleEndian);
    const fraction = readU32(view, offset + 4, littleEndian);
    const includedLength = readU32(view, offset + 8, littleEndian);
    offset += 16;
    if (offset + includedLength > view.byteLength) throw new Error("Invalid pcap record length.");
    const payload = bytes.subarray(offset, offset + includedLength);
    offset += includedLength;
    frames.push({ timestamp: seconds * 1_000 + Math.floor(fraction / (nanoseconds ? 1_000_000 : 1_000)), direction: "unknown", packetType: payload[0] ?? 0, base64: bytesToBase64(payload), source: "pcap" });
  }
  return { format: "pcap", frames, warnings: ["Classic pcap HCI H4 frames do not carry a universal host/controller direction. Preserve the original capture and annotate direction only when its source provides it."] };
}

export function parseBluetoothCapture(bytes: Uint8Array): BluetoothCapture {
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  return magic === BTSNOOP_MAGIC ? parseBtsnoop(bytes) : parseHciPcap(bytes);
}
