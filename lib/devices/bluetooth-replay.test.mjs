import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { planBluetoothReplay } = await jiti.import("./bluetooth-replay.ts");

test("replay plan accepts only selected recorded writes", () => {
  assert.deepEqual(planBluetoothReplay([{ timestamp: 1, type: "write", service: "fff0", characteristic: "fff1", base64: "AQI=", writeMode: "without-response" }], [0]), [{ service: "fff0", characteristic: "fff1", base64: "AQI=", withResponse: false }]);
});
test("replay plan refuses notifications and empty selections", () => {
  assert.throws(() => planBluetoothReplay([], []), /Select/);
  assert.throws(() => planBluetoothReplay([{ timestamp: 1, type: "notify", base64: "AQI=" }], [0]), /not a replayable/);
});
