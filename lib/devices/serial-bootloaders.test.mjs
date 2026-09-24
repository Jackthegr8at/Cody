import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fakeContext, fakeSerial, response } from "./serial.test-helper.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { geckoFlasher, geckoXmodemCrcBlock, xmodemCrc16 } = await jiti.import("./gecko.ts");
const { stm32Flasher } = await jiti.import("./stm32.ts");
const { stk500Flasher } = await jiti.import("./stk500.ts");

const STM32_INFO = [
  response(0x79),
  response(0x79),
  response(0x05),
  response(0x31, 0x00, 0x02, 0x11, 0x31, 0x43),
  response(0x79),
  response(0x79),
  response(0x01),
  response(0x04, 0x13),
  response(0x79),
];
const STM32_F103_INFO = [
  response(0x79), response(0x79), response(0x05), response(0x31, 0x00, 0x02, 0x11, 0x31, 0x43), response(0x79),
  response(0x79), response(0x01), response(0x04, 0x10), response(0x79),
];

const STK_BOARD = {
  chip: "atmega328p-test",
  signature: [0x1e, 0x95, 0x0f],
  flash: { start: 0, length: 0x100, pageSize: 4 },
  region: { name: "application", start: 0, length: 0x80 },
  bootloaderRanges: [{ start: 0x80, length: 0x80 }],
};


test("Gecko XMODEM-CRC blocks use STX/SOH, sequence complement, and CRC-16/XMODEM", () => {
  assert.equal(xmodemCrc16(new TextEncoder().encode("123456789")), 0x31c3);
  const full = new Uint8Array(1024).fill(0x5a);
  const fullPacket = geckoXmodemCrcBlock(0xff, full);
  assert.equal(fullPacket[0], 0x02);
  assert.deepEqual([...fullPacket.subarray(1, 3)], [0xff, 0x00]);
  assert.equal((fullPacket.at(-2) << 8) | fullPacket.at(-1), xmodemCrc16(full));

  const tail = new Uint8Array(128).fill(0x1a);
  const tailPacket = geckoXmodemCrcBlock(1, tail);
  assert.equal(tailPacket[0], 0x01);
  assert.deepEqual([...tailPacket.subarray(1, 3)], [1, 0xfe]);
});

test("Gecko detect redraws the serial menu but never selects upload", async () => {
  const serial = fakeSerial([new TextEncoder().encode("Gecko Bootloader v1.12.0\r\n1. upload gbl\r\nBL >")]);
  const context = fakeContext(serial);
  const result = await geckoFlasher.run({ protocol: "gecko", action: "detect" }, context);
  assert.match(result.summary, /Gecko Bootloader v1.12.0/);
  assert.deepEqual(serial.writes, [response(0x0d)]);
  assert.equal(context.confirmations.length, 0);
});

test("Gecko flash refuses before menu upload because XMODEM lacks installed-image readback", async () => {
  const serial = fakeSerial();
  const context = fakeContext(serial, new Blob([response(1, 2, 3)]));
  await assert.rejects(geckoFlasher.run({ protocol: "gecko", action: "flash" }, context), /installed-image readback hash/);
  assert.equal(serial.writes.length, 0);
  assert.equal(context.confirmations.length, 0);
});

test("STM32 ROM bootloader uses sync/GET/GET-ID ACK framing", async () => {
  const serial = fakeSerial(STM32_INFO);
  const context = fakeContext(serial);
  const result = await stm32Flasher.run({ protocol: "stm32", action: "detect" }, context);
  assert.equal(result.details.productId, 0x0413);
  assert.deepEqual(serial.writes, [response(0x7f), response(0x00, 0xff), response(0x02, 0xfd)]);
  assert.equal(serial.pending(), 0);
});

test("STM32 rejects unknown intrinsic flash profiles before confirmation", async () => {
  assert.deepEqual(stm32Flasher.actions, ["detect", "dump", "flash"]);
  const serial = fakeSerial(STM32_INFO);
  const context = fakeContext(serial, new Blob([response(1, 2, 3, 4)]));
  await assert.rejects(
    stm32Flasher.run({ protocol: "stm32", action: "flash", target: "program", offset: 0x08000000 }, context),
    /only the intrinsic STM32F103 medium-density profile/,
  );
  assert.equal(context.confirmations.length, 0);
  assert.equal(serial.pending(), 0);
});
test("STM32F103 preserves and verifies the complete erased page", async () => {
  const original = new Uint8Array(1024).fill(0xff);
  const program = original.slice(); program.set([1, 2, 3, 4]);
  const readBlocks = (data) => Array.from({ length: 4 }, (_, index) => [response(0x79), response(0x79), response(0x79), data.subarray(index * 256, (index + 1) * 256)]).flat();
  const acks = Array.from({ length: 12 }, () => response(0x79));
  const serial = fakeSerial([
    ...STM32_F103_INFO,
    response(0x79), response(0x79), response(0x79), response(0x40, 0),
    ...readBlocks(original),
    response(0x79), response(0x79), ...acks,
    ...readBlocks(program),
  ]);
  const context = fakeContext(serial, new Blob([response(1, 2, 3, 4)]));
  const result = await stm32Flasher.run({ protocol: "stm32", action: "flash", target: "program", offset: 0x08000000, options: { protectedOverride: "allow-bootloader" } }, context);
  assert.equal(result.verified, true);
  assert.equal(context.confirmations[0].programLength, 1024);
  assert.equal(serial.writes.filter((write) => write[0] === 0xff && write.byteLength === 258).length, 4);
  assert.equal(serial.pending(), 0);
});
test("STM32F103 dump rejects lengths outside detected factory capacity before reading payload", async () => {
  const serial = fakeSerial([
    ...STM32_F103_INFO,
    response(0x79), response(0x79), response(0x79), response(0x40, 0),
  ]);
  await assert.rejects(
    stm32Flasher.run({ protocol: "stm32", action: "dump", offset: 0x08000000, length: 0x10001 }, fakeContext(serial)),
    /outside the declared STM32 flash range/,
  );
  assert.equal(serial.pending(), 0);
});

test("STK500v1 ATmega328P preserves a partial 128-byte page and verifies the full footprint", async () => {
  assert.deepEqual(stk500Flasher.actions, ["detect", "dump", "flash"]);
  const original = new Uint8Array(128).fill(0xff);
  const program = original.slice(); program.set([1, 2]);
  const serial = fakeSerial([
    response(0x14), response(0x10), response(0x14), response(0x1e, 0x95, 0x0f), response(0x10),
    response(0x14), response(0x10), response(0x14), original, response(0x10),
    response(0x14), response(0x10), response(0x14), response(0x10),
    response(0x14), response(0x10), response(0x14), program, response(0x10), response(0x14), response(0x10),
  ]);
  const context = fakeContext(serial, new Blob([response(1, 2)]));
  const result = await stk500Flasher.run({ protocol: "stk500", action: "flash", target: "application", offset: 0 }, context);
  assert.equal(result.verified, true);
  assert.equal(context.confirmations.length, 1);
  assert.equal(context.confirmations[0].programLength, 128);
  assert.deepEqual(serial.writes.find((write) => write[0] === 0x64)?.subarray(4, 6), response(1, 2));
  const pageWrite = serial.writes.find((write) => write[0] === 0x64);
  assert.equal(pageWrite?.byteLength, 133);
  assert.equal(pageWrite?.[131], 0xff);
  assert.equal(serial.pending(), 0);
});

test("STK500v1 refuses odd byte offsets rather than inventing a byte-address mapping", async () => {
  const serial = fakeSerial([response(0x14), response(0x10), response(0x14), response(0x1e, 0x95, 0x0f), response(0x10)]);
  const context = fakeContext(serial);
  await assert.rejects(
    stk500Flasher.run({ protocol: "stk500", action: "dump", offset: 1, length: 2, options: { board: STK_BOARD } }, context),
    /even byte addresses/,
  );
});
