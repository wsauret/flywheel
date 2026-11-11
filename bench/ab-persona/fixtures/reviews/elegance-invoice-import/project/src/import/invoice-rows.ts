import { CURRENCIES, type Currency } from "../types.ts";

export const INVOICE_CSV_HEADER = [
  "supplier_id",
  "invoice_number",
  "issued_on",
  "currency",
  "description",
  "quantity",
  "unit_price",
] as const;

/** A data row of the file with its row number. */
export interface NumberedRow {
  rowNumber: number;
  fields: string[];
}

/** One CSV row: one line of one invoice. */
export interface InvoiceRow {
  /** Row number in the CSV, counting the header as row 1, for error messages.
   *  A quoted field that spans lines is still one row, and a blank line is no row. */
  rowNumber: number;
  supplierId: string;
  invoiceNumber: string;
  issuedOn: string;
  currency: Currency;
  description: string;
  quantity: number;
  unitCents: number;
}

export class InvoiceImportError extends Error {
  constructor(readonly rowNumber: number, message: string) {
    super(`Row ${rowNumber}: ${message}`);
  }
}

/** Check the header and return the data rows. */
export function dataRows(rows: readonly string[][]): NumberedRow[] {
  const [header, ...data] = rows;
  if (header === undefined) throw new InvoiceImportError(1, "the file is empty");
  if (header.length !== INVOICE_CSV_HEADER.length || header.some((name, index) => name.trim() !== INVOICE_CSV_HEADER[index])) {
    throw new InvoiceImportError(1, `the header must be ${INVOICE_CSV_HEADER.join(",")}`);
  }
  return data.map((fields, index) => ({ rowNumber: index + 2, fields }));
}

/** Turn the supplier's text fields into typed rows. This checks the form of
 *  each field; createInvoice still applies the payable rules to the result. */
export function parseInvoiceRows(rows: readonly NumberedRow[]): InvoiceRow[] {
  return rows.map(({ rowNumber, fields }) => {
    if (fields.length !== INVOICE_CSV_HEADER.length) {
      throw new InvoiceImportError(rowNumber, `expected ${INVOICE_CSV_HEADER.length} fields, found ${fields.length}`);
    }
    const [supplierId = "", invoiceNumber = "", issuedOn = "", currency = "", description = "", quantity = "", unitPrice = ""] = fields.map((field) => field.trim());
    return {
      rowNumber,
      supplierId,
      invoiceNumber,
      issuedOn: parseIsoDate(rowNumber, issuedOn),
      currency: parseCurrency(rowNumber, currency),
      description,
      quantity: parseWholeNumber(rowNumber, quantity),
      unitCents: parsePriceCents(rowNumber, unitPrice),
    };
  });
}

function parseIsoDate(rowNumber: number, text: string): string {
  const date = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new InvoiceImportError(rowNumber, `issued_on "${text}" is not a calendar date in YYYY-MM-DD form`);
  }
  return text;
}

function parseCurrency(rowNumber: number, text: string): Currency {
  const currency = CURRENCIES.find((candidate) => candidate === text.toUpperCase());
  if (currency === undefined) throw new InvoiceImportError(rowNumber, `currency "${text}" is not one of ${CURRENCIES.join(", ")}`);
  return currency;
}

function parseWholeNumber(rowNumber: number, text: string): number {
  if (!/^-?\d+$/.test(text)) throw new InvoiceImportError(rowNumber, `quantity "${text}" is not a whole number`);
  return Number(text);
}

/** "12", "12.5", and "12.50" are 1200, 1250, and 1250 cents. Integer
 *  arithmetic only, so no price picks up a floating-point error. */
function parsePriceCents(rowNumber: number, text: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) throw new InvoiceImportError(rowNumber, `unit_price "${text}" is not an amount like 12.50`);
  const [, whole = "0", fraction = ""] = match;
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
