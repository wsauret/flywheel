import type { JournalFile, OrderRecord } from "./types.ts";

/** Append-only order journal. Appends that arrive while a flush is running
 *  join the same drain loop instead of starting a second writer. */
export class Journal {
  private pending: string[] = [];
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly file: JournalFile,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Resolves once the record has been written and synced. */
  append(record: OrderRecord): Promise<void> {
    this.pending.push(`${JSON.stringify(record)}\n`);
    this.flushing ??= this.drain();
    return this.flushing;
  }

  /** Throws on a line that is not a whole record, such as a last line cut
   *  short by a crash, so startup stops for an operator instead of guessing. */
  async replay(): Promise<OrderRecord[]> {
    const text = await this.file.readAll();
    return text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as OrderRecord);
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        await this.file.write(batch.join(""));
        await this.file.sync();
      }
    } catch (error) {
      this.pending = [];
      this.onError(error);
    } finally {
      this.flushing = undefined;
    }
  }
}
