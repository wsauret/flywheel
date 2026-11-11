import { parseCsv } from "../csv.ts";
import type { PayablesLedger } from "../ledger.ts";
import { totalsByCurrency } from "../totals.ts";
import type { Currency } from "../types.ts";
import { groupIntoInvoices } from "./group.ts";
import { dataRows, parseInvoiceRows } from "./invoice-rows.ts";
import { Pipeline } from "./pipeline.ts";

export interface ImportReport {
  imported: number;
  /** "supplier/number" of invoices that were already posted and were skipped. */
  alreadyPosted: string[];
  /** Totals of the imported invoices, per currency, in cents. */
  totals: Map<Currency, number>;
}

const readInvoices = Pipeline.from(parseCsv).then(dataRows).then(parseInvoiceRows).then(groupIntoInvoices);

/** Import a supplier invoice CSV. The whole file is checked before anything
 *  is posted, so a bad row rejects the file and leaves the ledger as it was.
 *  Invoices that are already posted are skipped, so a supplier can resend a
 *  file that overlaps an earlier one. */
export function importInvoices(csvText: string, ledger: PayablesLedger): ImportReport {
  const invoices = readInvoices.run(csvText);
  const fresh = invoices.filter((invoice) => !ledger.has(invoice.supplierId, invoice.number));
  for (const invoice of fresh) ledger.post(invoice);
  return {
    imported: fresh.length,
    alreadyPosted: invoices
      .filter((invoice) => !fresh.includes(invoice))
      .map((invoice) => `${invoice.supplierId}/${invoice.number}`),
    totals: totalsByCurrency(fresh),
  };
}
