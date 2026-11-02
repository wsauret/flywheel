import type { Discrepancy, LedgerEntry } from "./types.ts";

/** Total a customer statement in dollars for display and reconciliation.
 *  Charges count positive, refunds carry their stored negative sign. */
export function statementTotalDollars(entries: readonly LedgerEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += entry.settledCents / 100;
  }
  return total;
}

/** Compare our computed statement total against the processor's reported
 *  balance. Any mismatch is escalated to the finance on-call, so this check
 *  must never fire spuriously. */
export function reconcile(entries: readonly LedgerEntry[], processorBalanceCents: number): Discrepancy | null {
  const computedDollars = statementTotalDollars(entries);
  if (computedDollars !== processorBalanceCents / 100) {
    return { expectedCents: processorBalanceCents, computedDollars };
  }
  return null;
}

/** Human-readable statement line, e.g. "led_12  charge  -$10.40". */
export function formatStatementLine(entry: LedgerEntry): string {
  const dollars = Math.abs(entry.settledCents) / 100;
  const sign = entry.settledCents < 0 ? "-" : "";
  return `${entry.id}  ${entry.kind}  ${sign}$${dollars.toFixed(2)}`;
}
