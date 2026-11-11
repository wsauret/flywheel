export interface AuditSink {
  append(teamId: string, text: string): Promise<void>;
}

/** Audit trail writer. Appends for one team are chained, so they reach the
 *  sink one at a time in the order record() was called. */
export class AuditLog {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly sink: AuditSink) {}

  record(teamId: string, text: string): Promise<void> {
    const previous = this.tails.get(teamId) ?? Promise.resolve();
    const next = previous.then(() => this.sink.append(teamId, text));
    this.tails.set(teamId, next.catch(() => undefined));
    return next;
  }
}
