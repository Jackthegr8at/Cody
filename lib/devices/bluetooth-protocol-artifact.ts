import type { BleServiceInfo, BleTraceEvent, DeviceInfo } from "./protocol";

export interface BluetoothProtocolArtifactV1 {
  format: "cody-bluetooth-protocol/v1";
  createdAt: string;
  device: { label: string; requestedServices: readonly string[] };
  gatt: readonly BleServiceInfo[];
  observations: readonly BleTraceEvent[];
  interpretation: {
    framing: readonly string[];
    checksum: readonly string[];
    authentication: readonly string[];
    stateTransitions: readonly string[];
  };
  limitations: readonly string[];
}

/** Creates a portable evidence bundle without silently decoding or inferring a
 * device protocol. Interpretation starts empty and is filled only from an
 * explicit analyst workflow. */
export function createBluetoothProtocolArtifact(device: DeviceInfo, observations: readonly BleTraceEvent[]): BluetoothProtocolArtifactV1 {
  if (device.kind !== "ble") throw new Error("A Bluetooth protocol artifact requires a BLE device.");
  return {
    format: "cody-bluetooth-protocol/v1",
    createdAt: new Date().toISOString(),
    device: { label: device.label, requestedServices: device.requestedServices ?? [] },
    gatt: device.gatt ?? [],
    observations: [...observations],
    interpretation: { framing: [], checksum: [], authentication: [], stateTransitions: [] },
    limitations: [
      "Original bytes are base64 and intentionally undecoded.",
      "Host GATT observations do not capture another application's traffic.",
      "Encrypted over-the-air traffic requires pairing keys and a compatible capture source before ATT/GATT interpretation.",
      "Home Assistant and ESPHome mapping requires repeatable action-to-observation correlation.",
    ],
  };
}
