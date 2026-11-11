import type { AccountBook } from "./accounts.ts";
import type { SnapshotWriter } from "./persistence.ts";

export interface Posting {
  accountId: string;
  /** Signed minor units: negative debits the account, positive credits it. */
  amount: number;
}

export interface Entry {
  currency: string;
  postings: readonly Posting[];
}

export class InvalidEntry extends Error {}

export class Ledger {
  constructor(
    private readonly book: AccountBook,
    private readonly persistence: SnapshotWriter,
  ) {}

  /** Validate an entry, then apply every posting. */
  apply(entry: Entry): void {
    const total = entry.postings.reduce((sum, posting) => sum + posting.amount, 0);
    if (total !== 0) throw new InvalidEntry(`postings sum to ${total}, not 0`);
    for (const posting of entry.postings) {
      if (!Number.isInteger(posting.amount) || posting.amount === 0) throw new InvalidEntry("posting amounts must be non-zero integers");
      const account = this.book.get(posting.accountId);
      if (account.currency !== entry.currency) throw new InvalidEntry(`${account.id} holds ${account.currency}, not ${entry.currency}`);
    }
    for (const posting of entry.postings) {
      const account = this.book.get(posting.accountId);
      if (posting.amount < 0) this.book.debit(account, -posting.amount);
      else this.book.credit(account, posting.amount);
    }
    this.persistence.recordApplied();
  }
}
