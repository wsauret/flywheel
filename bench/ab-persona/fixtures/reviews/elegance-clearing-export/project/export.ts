import { formatAmount, formatDate } from "./format.ts";
import type { Transaction } from "./types.ts";

export { formatDate } from "./format.ts";

/** The clearing house reads amounts right-aligned in a 14-character field. */
const AMOUNT_WIDTH = 14;

export function renderCsv(transactions: readonly Transaction[]): string {
  const rows = transactions.map((tx) => `${formatDate(tx.postedAt)},${tx.account},${formatAmount(tx.amountCents)}`);
  return ["date,account,amount", ...rows].join("\n");
}

/** Fixed-width records for the clearing-house upload: date (10), account (12), amount (14). */
export function renderFixedWidth(transactions: readonly Transaction[]): string {
  return transactions
    .map((tx) => `${formatDate(tx.postedAt)}${tx.account}${padLeft(formatAmount(tx.amountCents), AMOUNT_WIDTH, " ")}`)
    .join("\n");
}

function padLeft(value: string, width: number, fill: string): string {
  let padded = value;
  while (padded.length < width) padded = fill + padded;
  return padded;
}
