import type { Invoice } from "./types.ts";

/** Supplier invoices waiting for payment, unique by supplier and number. */
export class PayablesLedger {
  private readonly invoices = new Map<string, Invoice>();

  has(supplierId: string, number: string): boolean {
    return this.invoices.has(keyOf(supplierId, number));
  }

  post(invoice: Invoice): void {
    const key = keyOf(invoice.supplierId, invoice.number);
    if (this.invoices.has(key)) throw new Error(`Invoice ${invoice.number} from ${invoice.supplierId} is already posted`);
    this.invoices.set(key, invoice);
  }

  outstanding(): Invoice[] {
    return [...this.invoices.values()];
  }
}

function keyOf(supplierId: string, number: string): string {
  return JSON.stringify([supplierId, number]);
}
