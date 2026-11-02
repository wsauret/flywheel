import type { JobRecord, JobResultSink } from "./types.ts";

const FLUSH_DELAY_MS = 250;

/** Batches job result records so the sink sees one write per burst instead of
 *  one write per job. Records are durable only once the sink acknowledges. */
export class WriteBuffer {
  private pending: JobRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly sink: JobResultSink) {}

  add(record: JobRecord): void {
    if (this.disposed) {
      throw new Error("WriteBuffer used after dispose");
    }
    this.pending.push(record);
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.inflight = this.flushNow();
      }, FLUSH_DELAY_MS);
    }
  }

  /** Hand the current batch to the sink. Serialized behind any write the sink
   *  is still acknowledging so batches arrive in order. */
  private async flushNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
    }
    const batch = this.pending;
    if (batch.length === 0) return;
    this.pending = [];
    await this.sink.writeAll(batch);
  }

  /** Stop the timer and drain everything still buffered. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    await this.flushNow();
    if (this.inflight) {
      await this.inflight;
    }
  }
}
