import { createInvoice } from "../invoice.ts";
import type { Invoice, InvoiceLine } from "../types.ts";
import { InvoiceImportError, type InvoiceRow } from "./invoice-rows.ts";

/** Gather rows into invoices by supplier and invoice number. Every row of one
 *  invoice must agree on its date and currency. */
export function groupIntoInvoices(rows: readonly InvoiceRow[]): Invoice[] {
  const groups = new Map<string, { first: InvoiceRow; lines: InvoiceLine[] }>();
  for (const row of rows) {
    const key = JSON.stringify([row.supplierId, row.invoiceNumber]);
    const group = groups.get(key);
    const line = { description: row.description, quantity: row.quantity, unitCents: row.unitCents };
    if (group === undefined) {
      groups.set(key, { first: row, lines: [line] });
      continue;
    }
    if (row.issuedOn !== group.first.issuedOn || row.currency !== group.first.currency) {
      throw new InvoiceImportError(
        row.rowNumber,
        `invoice ${row.invoiceNumber} has a different date or currency than on row ${group.first.rowNumber}`,
      );
    }
    group.lines.push(line);
  }
  return [...groups.values()].map(({ first, lines }) => {
    try {
      return createInvoice({
        supplierId: first.supplierId,
        number: first.invoiceNumber,
        issuedOn: first.issuedOn,
        currency: first.currency,
        lines,
      });
    } catch (error) {
      throw new InvoiceImportError(first.rowNumber, error instanceof Error ? error.message : String(error));
    }
  });
}
