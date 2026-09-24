import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createBluetoothProtocolArtifact } = await jiti.import("./bluetooth-protocol-artifact.ts");

test("protocol artifact preserves evidence without inventing a protocol", () => {
  const artifact = createBluetoothProtocolArtifact({
    id: "ble-1", kind: "ble", label: "Unknown peripheral", open: true,
    requestedServices: ["fff0"],
    gatt: [{ uuid: "fff0", primary: true, characteristics: [{ uuid: "fff1", properties: ["read", "notify"] }] }],
  }, [{ timestamp: 1, type: "notify", service: "fff0", characteristic: "fff1", base64: "AQI=" }]);
  assert.equal(artifact.format, "cody-bluetooth-protocol/v1");
  assert.deepEqual(artifact.device.requestedServices, ["fff0"]);
  assert.equal(artifact.observations[0].base64, "AQI=");
  assert.deepEqual(artifact.interpretation, { framing: [], checksum: [], authentication: [], stateTransitions: [] });
});

test("protocol artifact rejects non-BLE input", () => {
  assert.throws(() => createBluetoothProtocolArtifact({ id: "usb-1", kind: "usb", label: "USB", open: true }, []), /BLE device/);
});
