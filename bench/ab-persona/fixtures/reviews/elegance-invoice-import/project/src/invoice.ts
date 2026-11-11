import type { Invoice } from "./types.ts";

/** The one way an invoice enters the system: the manual entry form calls it,
 *  and so must anything else that creates invoices. It enforces the payable
 *  invariants that totals and payment runs rely on. */
export function createInvoice(draft: Invoice): Invoice {
  if (draft.supplierId.trim() === "") throw new Error("An invoice needs a supplier");
  if (draft.number.trim() === "") throw new Error("An invoice needs a number");
  if (draft.lines.length === 0) throw new Error(`Invoice ${draft.number} has no lines`);
  for (const line of draft.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new Error(`Invoice ${draft.number}: quantity of "${line.description}" must be a whole number of at least 1`);
    }
    if (!Number.isInteger(line.unitCents) || line.unitCents < 0) {
      throw new Error(`Invoice ${draft.number}: price of "${line.description}" must be whole cents, not negative`);
    }
  }
  return { ...draft, lines: draft.lines.map((line) => ({ ...line })) };
}
