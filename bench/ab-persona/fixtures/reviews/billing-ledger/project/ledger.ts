import type { LedgerEntry } from "./types.ts";

/** Append-only entry store. Entries are immutable once posted; corrections
 *  post compensating entries instead of editing history. */
export class Ledger {
  private readonly entries: LedgerEntry[] = [];
  private readonly byKey = new Map<string, LedgerEntry>();
  private sequence = 0;

  append(entry: Omit<LedgerEntry, "id">): LedgerEntry {
    const posted: LedgerEntry = { ...entry, id: `led_${++this.sequence}` };
    this.entries.push(posted);
    this.byKey.set(posted.idempotencyKey, posted);
    return posted;
  }

  findByIdempotencyKey(key: string): LedgerEntry | undefined {
    return this.byKey.get(key);
  }

  findById(id: string): LedgerEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  entriesForCustomer(customerId: string): readonly LedgerEntry[] {
    return this.entries.filter((entry) => entry.customerId === customerId);
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }
}
