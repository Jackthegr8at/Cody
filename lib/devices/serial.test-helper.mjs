export function fakeSerial(responses = []) {
  const queued = [...responses];
  const writes = [];
  return {
    kind: "serial",
    writes,
    async read(length, _timeoutMs, signal) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted.", "AbortError");
      const response = queued.shift();
      if (response === undefined || response === null) return null;
      if (!(response instanceof Uint8Array)) throw new Error("Fake serial responses must be Uint8Array or null.");
      if (response.byteLength > length) throw new Error(`Fake serial response has ${response.byteLength} bytes; protocol asked for ${length}.`);
      return response;
    },
    async write(bytes, signal) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Operation aborted.", "AbortError");
      writes.push(Uint8Array.from(bytes));
    },
    pending() {
      return queued.length;
    },
  };
}

export function fakeContext(transport, input) {
  const confirmations = [];
  const backups = [];
  const progressEvents = [];
  return {
    transport,
    signal: new AbortController().signal,
    input,
    confirmations,
    backups,
    progressEvents,
    progress(event) {
      progressEvents.push(event);
    },
    async save(name, data) {
      backups.push({ name, data });
      return `file-${backups.length}`;
    },
    async confirm(risk) {
      confirmations.push(risk);
    },
  };
}

export const response = (...values) => Uint8Array.from(values);
