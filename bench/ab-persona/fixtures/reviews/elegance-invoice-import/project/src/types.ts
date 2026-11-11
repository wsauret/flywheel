export const CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitCents: number;
}

export interface Invoice {
  supplierId: string;
  number: string;
  /** Calendar date in ISO form, YYYY-MM-DD. */
  issuedOn: string;
  currency: Currency;
  lines: readonly InvoiceLine[];
}
