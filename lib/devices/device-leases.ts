/** Page-global ownership for browser-granted hardware. Browser permission is a
 * tab capability, but an attached agent session may operate a device only while
 * it owns the lease. This makes accidental cross-session access impossible
 * even if both session sockets are still alive. */

interface LeaseState {
  ownerSessionId: string;
  exclusiveToken: symbol | null;
  exclusiveKind: "raw" | "borrow" | null;
}

export interface DeviceBorrowLease {
  readonly deviceId: string;
  readonly sessionId: string;
  release(): void;
}

export interface DeviceRawLease {
  readonly deviceId: string;
  readonly sessionId: string;
  release(): void;
}

export class DeviceLeaseBook {
  private readonly states = new Map<string, LeaseState>();

  /** Claim an unowned device, or prove that this session already owns it. */
  claim(sessionId: string, deviceId: string): void {
    const state = this.states.get(deviceId);
    if (!state) {
      this.states.set(deviceId, { ownerSessionId: sessionId, exclusiveToken: null, exclusiveKind: null });
      return;
    }
    if (state.ownerSessionId !== sessionId) {
      throw new Error(`Device ${deviceId} is in use by another session. Return to its owning session or disconnect it before using it here.`);
    }
  }

  /** Reserve a raw frame synchronously, rejecting instead of queuing behind
   * native transfers. A late native read must never cross into a new lease. */
  claimForRawOperation(sessionId: string, deviceId: string): DeviceRawLease {
    return this.reserve(sessionId, deviceId, "raw");
  }

  borrow(sessionId: string, deviceId: string): DeviceBorrowLease {
    return this.reserve(sessionId, deviceId, "borrow");
  }

  private reserve(sessionId: string, deviceId: string, kind: "raw" | "borrow"): DeviceBorrowLease {
    this.claim(sessionId, deviceId);
    const state = this.states.get(deviceId);
    if (!state) throw new Error(`Device ${deviceId} has no lease state.`);
    if (state.exclusiveToken) {
      const activity = state.exclusiveKind === "borrow" ? "hardware operation" : "raw device request";
      throw new Error(`Device ${deviceId} is exclusively reserved by an active ${activity}.`);
    }
    const token = Symbol(deviceId);
    state.exclusiveToken = token;
    state.exclusiveKind = kind;
    let released = false;
    return {
      deviceId,
      sessionId,
      release: () => {
        if (released) return;
        released = true;
        const current = this.states.get(deviceId);
        if (current?.ownerSessionId === sessionId && current.exclusiveToken === token) {
          current.exclusiveToken = null;
          current.exclusiveKind = null;
        }
      },
    };
  }

  release(sessionId: string, deviceId: string): void {
    const state = this.states.get(deviceId);
    if (!state || state.ownerSessionId !== sessionId) return;
    if (state.exclusiveToken) {
      throw new Error(`Device ${deviceId} cannot be released while its ${state.exclusiveKind === "borrow" ? "hardware operation" : "raw device request"} is still active.`);
    }
    this.states.delete(deviceId);
  }

  releaseGoneDevice(deviceId: string): void {
    this.states.delete(deviceId);
  }

  owns(sessionId: string, deviceId: string): boolean {
    return this.states.get(deviceId)?.ownerSessionId === sessionId;
  }

  isBorrowed(deviceId: string): boolean {
    return this.states.get(deviceId)?.exclusiveKind === "borrow";
  }

  sessionOwnsDevices(sessionId: string): boolean {
    for (const state of this.states.values()) {
      if (state.ownerSessionId === sessionId) return true;
    }
    return false;
  }
}
