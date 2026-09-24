import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseBtsnoop, parseHciPcap } = await jiti.import("./bluetooth-capture.ts");

function u32(value) { return Uint8Array.of(value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255); }
function u64(value) { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value); return out; }
function join(...parts) { const size = parts.reduce((n, part) => n + part.length, 0); const out = new Uint8Array(size); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; }

test("btsnoop preserves HCI bytes and direction", () => {
  const payload = Uint8Array.of(1, 3, 12, 0);
  const stamp = 62_168_256_000_000_000n + 1_234_000n;
  const capture = join(new TextEncoder().encode("btsnoop\0"), u32(1), u32(1002), u32(payload.length), u32(payload.length), u32(0), u32(0), u64(stamp), payload);
  const parsed = parseBtsnoop(capture);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].timestamp, 1234);
  assert.equal(parsed.frames[0].direction, "host-to-controller");
  assert.equal(parsed.frames[0].base64, "AQMMAA==");
});

test("pcap refuses a truncated record instead of fabricating frames", () => {
  const header = join(u32(0xa1b2c3d4), Uint8Array.of(0, 2, 0, 4), u32(0), u32(0), u32(65535), u32(201));
  assert.throws(() => parseHciPcap(join(header, u32(1), u32(0), u32(4), u32(4), Uint8Array.of(1))), /Invalid pcap record length/);
});
