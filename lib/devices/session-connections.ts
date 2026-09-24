/** Retains page-hosted connections independently of React mounts. A session with
 * a device lease or a durable operation stays alive when the visible chat
 * switches away; an unowned idle connection is released immediately. */

export interface RetainableSessionConnection {
  start(): void;
  destroy(): void;
  isIdle(): boolean;
}

interface SessionRecord<T extends RetainableSessionConnection> {
  connection: T;
  consumers: number;
}

export interface RetainedSessionConnection<T extends RetainableSessionConnection> {
  readonly connection: T;
  release(): void;
}

export class SessionConnectionPool<T extends RetainableSessionConnection> {
  private readonly records = new Map<string, SessionRecord<T>>();

  constructor(private readonly create: (sessionId: string) => T) {}

  retain(sessionId: string): RetainedSessionConnection<T> {
    let record = this.records.get(sessionId);
    if (!record) {
      record = { connection: this.create(sessionId), consumers: 0 };
      this.records.set(sessionId, record);
    }
    record.consumers += 1;
    record.connection.start();
    let released = false;
    return {
      connection: record.connection,
      release: () => {
        if (released) return;
        released = true;
        const current = this.records.get(sessionId);
        if (!current) return;
        current.consumers -= 1;
        this.evictIdle(sessionId);
      },
    };
  }

  evictIdle(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record || record.consumers !== 0 || !record.connection.isIdle()) return;
    record.connection.destroy();
    this.records.delete(sessionId);
  }
}
