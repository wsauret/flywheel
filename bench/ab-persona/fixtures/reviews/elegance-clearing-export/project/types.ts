export interface Transaction {
  /** Twelve-digit account number. */
  account: string;
  amountCents: number;
  postedAt: number;
}
