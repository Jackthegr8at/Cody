/** WebUSB can preserve permission across a re-enumeration, but only a full
 * vendor/product/serial identity is safe to adopt. A missing serial number is
 * deliberately not matched by VID/PID: two boards of the same model are not
 * interchangeable. */

export interface UsbIdentitySource {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber: string | null;
}

export function stableUsbIdentity(device: UsbIdentitySource): string | null {
  const serialNumber = device.serialNumber?.trim();
  if (!serialNumber) return null;
  return `usb:${device.vendorId.toString(16)}:${device.productId.toString(16)}:${serialNumber}`;
}

export const USB_REGRANT_MESSAGE = "The USB device is no longer available under its previous identity. Select it again in Devices before continuing; Cody will not guess a replacement device.";
