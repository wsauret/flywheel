import { AccountBook } from "./accounts.ts";
import { Ledger, type Entry } from "./ledger.ts";
import { SnapshotWriter } from "./persistence.ts";

export async function startWallets(snapshotPath: string) {
  const book = new AccountBook();
  const persistence = new SnapshotWriter(book, snapshotPath);
  await persistence.load();
  const ledger = new Ledger(book, persistence);
  return {
    openAccount: (id: string, currency: string, overdraftLimit?: number) => book.open(id, currency, overdraftLimit),
    balance: (id: string) => book.get(id).balance,
    /** Apply a ledger entry. Resolves once it is applied. */
    post: async (entry: Entry) => {
      ledger.apply(entry);
    },
  };
}
