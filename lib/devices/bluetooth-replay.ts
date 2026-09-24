import type { BleTraceEvent } from "./protocol";

export interface BluetoothReplayStep {
  service: string;
  characteristic: string;
  base64: string;
  withResponse: boolean;
}

/** Converts a selected, controlled trace into an inert replay plan. It never
 * reconnects, selects a device, or writes bytes: a UI must present these exact
 * steps and obtain a fresh user confirmation before dispatching one at a time. */
export function planBluetoothReplay(events: readonly BleTraceEvent[], indexes: readonly number[]): readonly BluetoothReplayStep[] {
  if (!indexes.length) throw new Error("Select at least one recorded write to replay.");
  return indexes.map((index) => {
    const event = events[index];
    if (!event || event.type !== "write" || !event.service || !event.characteristic || !event.base64) {
      throw new Error(`Trace event ${index} is not a replayable controlled write.`);
    }
    return { service: event.service, characteristic: event.characteristic, base64: event.base64, withResponse: event.writeMode !== "without-response" };
  });
}
