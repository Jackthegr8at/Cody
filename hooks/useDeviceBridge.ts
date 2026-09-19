"use client";

/**
 * React state over lib/devices/client.ts's `DeviceBridgeConnection`. One
 * connection per active session id — switching sessions tears down the old
 * WebSocket and opens a fresh one against the new session's bridge, exactly
 * like a network reconnect (see DeviceBridgeConnection's module doc): the
 * granted hardware itself lives in client.ts's page-global registry and is
 * unaffected either way.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectDeviceCapabilities,
  DeviceBridgeConnection,
  type DeviceBridgeSnapshot,
} from "@/lib/devices/client";
import type { DeviceKind } from "@/lib/devices/protocol";

export interface UseDeviceBridgeResult extends DeviceBridgeSnapshot {
  /** Must be called synchronously from a click handler — it spends a real
   * user gesture on the browser's permission prompt. */
  connect: (kind: DeviceKind) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
}

function initialSnapshot(): DeviceBridgeSnapshot {
  return { capabilities: detectDeviceCapabilities(), devices: [], attached: false, error: null };
}

export function useDeviceBridge(sessionId: string | null): UseDeviceBridgeResult {
  const [snapshot, setSnapshot] = useState<DeviceBridgeSnapshot>(initialSnapshot);
  const connectionRef = useRef<DeviceBridgeConnection | null>(null);

  useEffect(() => {
    if (!sessionId) {
      connectionRef.current = null;
      setSnapshot(initialSnapshot());
      return;
    }
    const connection = new DeviceBridgeConnection(sessionId);
    connectionRef.current = connection;
    const unsubscribe = connection.subscribe(() => setSnapshot(connection.getSnapshot()));
    setSnapshot(connection.getSnapshot());
    connection.start();
    return () => {
      unsubscribe();
      connection.destroy();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [sessionId]);

  const connect = useCallback(async (kind: DeviceKind) => {
    const connection = connectionRef.current;
    if (!connection) return;
    try {
      await connection.requestDevice(kind);
    } catch (error) {
      // A user-cancelled picker (NotFoundError) is a normal outcome, not a
      // failure worth surfacing as an error banner.
      if (error instanceof DOMException && error.name === "NotFoundError") return;
      setSnapshot((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);

  const disconnect = useCallback(async (id: string) => {
    const connection = connectionRef.current;
    if (!connection) return;
    try {
      await connection.disconnectDevice(id);
    } catch (error) {
      setSnapshot((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);

  return { ...snapshot, connect, disconnect };
}
