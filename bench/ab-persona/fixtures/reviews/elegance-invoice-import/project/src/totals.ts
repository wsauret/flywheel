import type { Currency, Invoice } from "./types.ts";

export function invoiceTotalCents(invoice: Invoice): number {
  let total = 0;
  for (const line of invoice.lines) {
    if (line.quantity <= 0 || line.unitCents < 0) continue;
    total += line.quantity * line.unitCents;
  }
  return total;
}

/** Totals per currency; amounts in different currencies are never added together. */
export function totalsByCurrency(invoices: readonly Invoice[]): Map<Currency, number> {
  const totals = new Map<Currency, number>();
  for (const invoice of invoices) {
    totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0) + invoiceTotalCents(invoice));
  }
  return totals;
}
