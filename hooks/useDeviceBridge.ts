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
import { detectDeviceCapabilities, retainDeviceBridgeConnection, type DeviceBridgeSnapshot } from "@/lib/devices/client";
import { createDefaultPageOperationDelegate, type DeviceOperationManager } from "@/lib/devices/operations";
import type { DeviceActivity, DeviceKind } from "@/lib/devices/protocol";

export interface UseDeviceBridgeResult extends DeviceBridgeSnapshot {
  activity: Record<string, DeviceActivity>;
  operationManager: DeviceOperationManager | null;
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
  const [activity, setActivity] = useState<Record<string, DeviceActivity>>({});
  const [operationManager, setOperationManager] = useState<{ sessionId: string; manager: DeviceOperationManager } | null>(null);
  const connectionRef = useRef<ReturnType<typeof retainDeviceBridgeConnection>["connection"] | null>(null);

  useEffect(() => {
    setActivity({});
    setOperationManager(null);
    if (!sessionId) {
      connectionRef.current = null;
      setSnapshot(initialSnapshot());
      return;
    }
    const retained = retainDeviceBridgeConnection(sessionId);
    const connection = retained.connection;
    if (!connection.operationManager) connection.setOperationDelegate(createDefaultPageOperationDelegate(sessionId, connection));
    connectionRef.current = connection;
    const unsubscribe = connection.subscribe(() => setSnapshot(connection.getSnapshot()));
    const unsubscribeActivity = connection.onActivity(setActivity);
    const manager = connection.operationManager;
    setOperationManager(manager ? { sessionId, manager } : null);
    setSnapshot(connection.getSnapshot());
    return () => {
      unsubscribe();
      unsubscribeActivity();
      retained.release();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [sessionId]);

  const connect = useCallback(async (kind: DeviceKind) => {
    const connection = connectionRef.current;
    if (!connection) return;
    try {
      await connection.requestDevice(kind);
    } catch (error) {
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

  return { ...snapshot, activity, operationManager: operationManager?.sessionId === sessionId ? operationManager.manager : null, connect, disconnect };
}
