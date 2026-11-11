import { readFile, rename, writeFile } from "node:fs/promises";
import type { Account, AccountBook } from "./accounts.ts";

const SNAPSHOT_EVERY = 50;

/** Writes the whole account book to disk. A snapshot is written to a
 *  temporary file and renamed into place, so a crash during a write leaves
 *  the previous snapshot intact. */
export class SnapshotWriter {
  private appliedSinceSnapshot = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly book: AccountBook,
    private readonly path: string,
  ) {}

  /** Restore the book from the last snapshot. A missing file is a new book;
   *  any other read error stops startup, so balances are never reset. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      text = "[]";
    }
    this.book.restore(JSON.parse(text) as Account[]);
  }

  /** Called by the ledger after each applied entry. */
  recordApplied(): void {
    this.appliedSinceSnapshot++;
    if (this.appliedSinceSnapshot < SNAPSHOT_EVERY) return;
    this.appliedSinceSnapshot = 0;
    const accounts = JSON.stringify(this.book.all());
    // Each snapshot holds the whole book, so it runs after a failed one too.
    const write = () => this.write(accounts);
    this.writing = this.writing.then(write, write);
  }

  /** Settles with the outcome of the latest snapshot write started so far. */
  flushed(): Promise<void> {
    return this.writing;
  }

  private async write(text: string): Promise<void> {
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, this.path);
  }
}
