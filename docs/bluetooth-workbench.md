# Bluetooth workbench

Cody's Bluetooth workbench is discovery-first. It does not identify a protocol from a product name, nor does it infer an OBD, Home Assistant, or vendor command format.

## Browser GATT

The Devices panel runs on the machine holding the radio. The Cody server has no browser GATT handle.

Web Bluetooth requires a secure context and a user gesture. There is no wildcard service permission and no general Bluetooth scan. Before selecting a device, add required service UUIDs to **Additional GATT service UUIDs**. Cody preserves its standard-service, Nordic UART, and compatibility baseline (`18f0`, `fff0`, `ffe0`); the latter are picker hints only, not an OBD-specific transport.

Changing requested UUIDs requires selecting the device again. A prior grant cannot be widened in place. After connecting, use `ble_gatt` with `op: "discover"` to obtain every service, characteristic, characteristic property, and descriptor the browser permits. Descriptor enumeration is browser-dependent: an unavailable descriptor API is recorded as evidence, not misreported as an absent descriptor.

`ble_gatt` supports `read`, `write`, `subscribe`, and `unsubscribe`. Values are retained as base64 bytes; text is only a caller-side encoding convenience. `device_read` drains subscribed notification bytes.

## Controlled traffic evidence

Each browser-held BLE device maintains a bounded, in-memory `cody-ble-trace/v1` timeline of connects, disconnects, discovery, reads, writes, and notifications. Events retain timestamp, GATT UUIDs, bytes, and write mode. `ble_gatt` with `op: "trace"` exports it for a project artifact or external analysis.

This is host-side GATT evidence. It is not an over-the-air capture, cannot see traffic from another app, and cannot decrypt encrypted LL/L2CAP payloads. Never replace original bytes with decoded text; preserve the capture and attach any interpretation separately.

## Native and over-the-air paths

A browser cannot provide Bluetooth Classic, local HCI, general advertisement scanning, or radio-level capture. Those capabilities require an explicitly paired, client-local companion and compatible hardware. Cody does not assume the server's host radio is near the device.

On this installation the Unraid host has no BlueZ/D-Bus backend, so native BLE, Classic, HCI, and OTA capture are reported unavailable. A future native companion must use an explicitly paired local endpoint, typed BlueZ operations only, a signed one-time grant, monotonically numbered frames, and local confirmation. It must never offer arbitrary shell execution or elevation.

For OTA evidence, use a supported external sniffer such as Nordic nRF Sniffer for Bluetooth LE with a compatible nRF52840 dongle and its Wireshark/extcap tooling. Such captures can expose advertisements and radio traffic subject to pairing encryption, key availability, channel-following, and sniffer timing limits; they do not turn browser JavaScript into a radio sniffer.

## Home Assistant handoff

Turn discovery and controlled capture evidence into a protocol artifact containing service/characteristic UUIDs, properties, read values, notification samples, framing/checksum hypotheses, required authorization, and state transitions. Do not promote a mapping until it is evidenced by repeatable action correlation.

Home Assistant's Bluetooth integration consumes scanner/advertisement data and uses platform BLE facilities; it is not a generic raw-HCI capture service. ESPHome BLE proxies provide remote scanner/connectivity resources with finite connection slots and device/firmware-dependent GATT support. They cannot provide unrestricted packet capture or impersonate a vendor app's paired encrypted session.

## Safe experimentation

Keep read-only exploration separate from writes. Correlate one human-performed action at a time against timestamped notifications. Any write or replay must be bounded, target a selected device and exact bytes, require direct confirmation at the moment of transmission, never reconnect automatically, and never fuzz unknown commands.
