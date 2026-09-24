/** A quiet deadline does not cancel a native input transfer. Native WebUSB has no
 * abort primitive, so the one outstanding transfer remains owned here until its
 * bytes can be delivered to a later read. */

export const QUIET_READ_TIMEOUT_MIN_MS = 1;
export const QUIET_READ_TIMEOUT_MAX_MS = 60_000;

export interface QuietReadResult<T> {
  readonly value: T | null;
  readonly noData: boolean;
}

interface Waiter<T> {
  resolve(result: QuietReadResult<T>): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
}

function abortError(): Error {
  const error = new Error("The device read was cancelled.");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function assertQuietReadTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < QUIET_READ_TIMEOUT_MIN_MS || timeoutMs > QUIET_READ_TIMEOUT_MAX_MS) {
    throw new Error(`timeoutMs must be an integer from ${QUIET_READ_TIMEOUT_MIN_MS} to ${QUIET_READ_TIMEOUT_MAX_MS}.`);
  }
}

/** Serializes consumers as well as native reads: one completed transfer belongs
 * to one caller, never every caller that happened to be waiting for it. */
export class QuietReadGate<T> {
  private pending: Promise<void> | null = null;
  private ready: T | null = null;
  private hasReady = false;
  private readonly waiters: Waiter<T>[] = [];
  private generation = 0;
  private unusable = false;

  constructor(
    private readonly transferIn: () => Promise<T>,
    /** Must make the native source unusable. Used only for explicit aborts,
     * never for a quiet deadline. */
    private readonly invalidate: (reason: string) => Promise<void>,
  ) {}

  read(timeoutMs: number, signal?: AbortSignal): Promise<QuietReadResult<T>> {
    assertQuietReadTimeout(timeoutMs);
    if (this.unusable) return Promise.reject(new Error("The native device read is no longer valid."));
    if (signal?.aborted) return this.abort(signal.reason);
    if (this.hasReady) {
      const value = this.ready;
      this.ready = null;
      this.hasReady = false;
      return Promise.resolve({ value, noData: false });
    }
    this.ensureTransfer();
    return new Promise<QuietReadResult<T>>((resolve, reject) => {
      const waiter: Waiter<T> = {
        resolve,
        reject,
        timeout: setTimeout(() => this.finishNoData(waiter), timeoutMs),
        signal,
        abort: undefined,
      };
      if (signal) {
        waiter.abort = () => { void this.cancel(waiter, signal.reason); };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** Reject all pending consumers and disregard a transfer that settles after
   * close. The browser close itself causes the native transfer to reject. */
  async invalidateNow(reason: string): Promise<void> {
    if (this.unusable) return;
    this.unusable = true;
    this.generation += 1;
    this.pending = null;
    this.ready = null;
    this.hasReady = false;
    const error = new Error(reason);
    for (const waiter of this.waiters.splice(0)) this.finish(waiter, () => waiter.reject(error));
    await this.invalidate(reason);
  }

  private ensureTransfer(): void {
    if (this.pending || this.unusable) return;
    const generation = this.generation;
    this.pending = this.transferIn().then(
      (value) => {
        if (generation !== this.generation || this.unusable) return;
        this.pending = null;
        const waiter = this.waiters.shift();
        if (waiter) this.finish(waiter, () => waiter.resolve({ value, noData: false }));
        else {
          this.ready = value;
          this.hasReady = true;
        }
      },
      (reason: unknown) => {
        if (generation !== this.generation || this.unusable) return;
        this.pending = null;
        const error = reason instanceof Error ? reason : new Error(String(reason));
        for (const waiter of this.waiters.splice(0)) this.finish(waiter, () => waiter.reject(error));
      },
    );
  }

  private finishNoData(waiter: Waiter<T>): void {
    const index = this.waiters.indexOf(waiter);
    if (index === -1) return;
    this.waiters.splice(index, 1);
    this.finish(waiter, () => waiter.resolve({ value: null, noData: true }));
  }

  private async cancel(waiter: Waiter<T>, reason: unknown): Promise<void> {
    if (this.unusable) return;
    this.unusable = true;
    this.generation += 1;
    this.pending = null;
    this.ready = null;
    this.hasReady = false;
    const index = this.waiters.indexOf(waiter);
    if (index !== -1) this.waiters.splice(index, 1);
    this.finish(waiter, () => waiter.reject(abortError()));
    const error = abortError();
    for (const pending of this.waiters.splice(0)) this.finish(pending, () => pending.reject(error));
    await this.invalidate(reason === undefined ? "The device read was cancelled." : String(reason));
  }

  private abort(reason: unknown): Promise<QuietReadResult<T>> {
    return new Promise<QuietReadResult<T>>((resolve, reject) => {
      const waiter: Waiter<T> = { resolve, reject, timeout: setTimeout(() => {}, 0), signal: undefined, abort: undefined };
      clearTimeout(waiter.timeout);
      void this.cancel(waiter, reason);
    });
  }

  private finish(waiter: Waiter<T>, done: () => void): void {
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    done();
  }
}
