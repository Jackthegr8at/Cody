"use client";

import { Bluetooth, Cable, TriangleAlert, Unplug, Usb } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useDeviceBridge } from "@/hooks/useDeviceBridge";
import { formatBytes } from "@/lib/format-bytes";
import type { DeviceCapabilities, DeviceInfo, DeviceKind } from "@/lib/devices/protocol";

export interface DevicePanelProps {
  sessionId: string | null;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function toolbarButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    height: 22,
    padding: "0 7px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    background: "var(--bg-panel)",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "default" : "pointer",
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
    opacity: disabled ? 0.6 : 1,
    transition: "background var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
  };
}

function hoverIn(event: React.MouseEvent<HTMLButtonElement>) {
  if (event.currentTarget.disabled) return;
  event.currentTarget.style.background = "var(--bg-selected)";
}

function hoverOut(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = "var(--bg-panel)";
}

const sectionHeadingStyle: React.CSSProperties = {
  marginBottom: 4,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

/** Every reason named here is real: each checks exactly the capability flag
 * that would let the button work, so a disabled row never hides behind a
 * generic "not supported" — see lib/devices/protocol.ts's own table of
 * which browser/platform combination has which API. */
function serialDisabledReason(capabilities: DeviceCapabilities, t: Translate): string | null {
  if (!capabilities.secureContext) return t("devices.reasonInsecureContext");
  if (capabilities.serial || capabilities.serialViaUsb) return null;
  return t("devices.reasonNoSerial");
}

function usbDisabledReason(capabilities: DeviceCapabilities, t: Translate): string | null {
  if (!capabilities.secureContext) return t("devices.reasonInsecureContext");
  if (capabilities.usb) return null;
  return t("devices.reasonNoUsb");
}

function bluetoothDisabledReason(capabilities: DeviceCapabilities, t: Translate): string | null {
  if (!capabilities.secureContext) return t("devices.reasonInsecureContext");
  if (capabilities.bluetooth) return null;
  return t("devices.reasonNoBluetooth");
}

function ConnectRow({ icon, label, buttonLabel, disabledReason, onClick }: {
  icon: React.ReactNode;
  label: string;
  buttonLabel: string;
  disabledReason: string | null;
  onClick: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "flex", color: "var(--text-muted)", flexShrink: 0 }} aria-hidden="true">{icon}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)" }}>{label}</span>
        <button
          type="button"
          className="ui-focus-ring"
          onClick={onClick}
          disabled={disabledReason !== null}
          title={disabledReason ?? buttonLabel}
          aria-label={disabledReason ?? buttonLabel}
          style={toolbarButtonStyle(disabledReason !== null)}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {buttonLabel}
        </button>
      </div>
      {disabledReason !== null && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, paddingLeft: 22, fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)" }}>
          <TriangleAlert size={11} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <span style={{ minWidth: 0 }}>{disabledReason}</span>
        </div>
      )}
    </div>
  );
}

function kindIcon(kind: DeviceKind): React.ReactNode {
  if (kind === "serial") return <Cable size={14} aria-hidden="true" />;
  if (kind === "usb") return <Usb size={14} aria-hidden="true" />;
  return <Bluetooth size={14} aria-hidden="true" />;
}

function kindLabel(kind: DeviceKind, t: Translate): string {
  if (kind === "serial") return t("devices.kindSerial");
  if (kind === "usb") return t("devices.kindUsb");
  return t("devices.kindBluetooth");
}

function DeviceRow({ device, t, onDisconnect }: { device: DeviceInfo; t: Translate; onDisconnect: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ display: "flex", flexShrink: 0, color: device.open ? "var(--status-success)" : "var(--text-dim)" }} aria-hidden="true">
        {kindIcon(device.kind)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{device.label}</div>
        <div style={{ display: "flex", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
          <span>{kindLabel(device.kind, t)}</span>
          <span aria-hidden="true">·</span>
          <span>{device.open ? t("devices.statusOpen") : t("devices.statusClosed")}</span>
          <span aria-hidden="true">·</span>
          <span>{t("devices.buffered", { bytes: formatBytes(device.buffered ?? 0) })}</span>
        </div>
      </div>
      <button
        type="button"
        className="ui-focus-ring"
        onClick={onDisconnect}
        title={t("devices.disconnectLabel", { label: device.label })}
        aria-label={t("devices.disconnectLabel", { label: device.label })}
        style={toolbarButtonStyle(false)}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        <Unplug size={12} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The "Devices" right-panel tool: lets the user grant this browser's Web
 * Serial/WebUSB/Web Bluetooth hardware to the agent (device_list, device_open,
 * device_write, device_read, device_close, ble_gatt). Always mounted once a
 * session exists (see AppShell) so a device granted earlier stays attached
 * — and usable by the agent — even while the user is looking at a different
 * tab; there is no "pause" state tied to this panel's own visibility. */
export function DevicePanel({ sessionId }: DevicePanelProps): React.ReactElement {
  const { t } = useI18n();
  const { capabilities, devices, attached, error, connect, disconnect } = useDeviceBridge(sessionId);

  return (
    <section
      aria-label={t("devices.title")}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg)" }}
    >
      <div
        className="workspace-subtitle-bar"
        style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("devices.title")}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, padding: 12 }}>
        {error && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              padding: "6px 8px",
              border: "1px solid color-mix(in srgb, var(--status-error) 55%, var(--border))",
              borderRadius: "var(--radius-control)",
              background: "var(--bg-panel)",
              fontSize: 11,
              lineHeight: 1.4,
              color: "var(--status-error)",
              overflowWrap: "anywhere",
            }}
          >
            <TriangleAlert size={12} strokeWidth={2.2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span style={{ minWidth: 0 }}>{error}</span>
          </div>
        )}

        {!sessionId ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>
            {t("devices.noSession")}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-dim)" }}>
              <span
                aria-hidden="true"
                style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: attached ? "var(--status-success)" : "var(--text-dim)" }}
              />
              {attached ? t("devices.bridgeConnected") : t("devices.bridgeReconnecting")}
            </div>

            <div>
              <div style={sectionHeadingStyle}>{t("devices.title")}</div>
              <ConnectRow
                icon={<Cable size={14} aria-hidden="true" />}
                label={t("devices.kindSerial")}
                buttonLabel={t("devices.connectSerial")}
                disabledReason={serialDisabledReason(capabilities, t)}
                onClick={() => void connect("serial")}
              />
              <ConnectRow
                icon={<Usb size={14} aria-hidden="true" />}
                label={t("devices.kindUsb")}
                buttonLabel={t("devices.connectUsb")}
                disabledReason={usbDisabledReason(capabilities, t)}
                onClick={() => void connect("usb")}
              />
              <ConnectRow
                icon={<Bluetooth size={14} aria-hidden="true" />}
                label={t("devices.kindBluetooth")}
                buttonLabel={t("devices.connectBluetooth")}
                disabledReason={bluetoothDisabledReason(capabilities, t)}
                onClick={() => void connect("ble")}
              />
            </div>

            {devices.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("devices.empty")}</div>
            ) : (
              <div>
                {devices.map((device) => (
                  <DeviceRow key={device.id} device={device} t={t} onDisconnect={() => void disconnect(device.id)} />
                ))}
                <div style={{ marginTop: 8, fontSize: 11, lineHeight: 1.4, color: "var(--text-dim)" }}>{t("devices.agentHint")}</div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
