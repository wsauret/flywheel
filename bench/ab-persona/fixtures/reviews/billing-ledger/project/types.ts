export type Currency = "USD" | "EUR" | "GBP" | "JPY";

export interface LineItem {
  sku: string;
  unitCents: number;
  quantity: number;
}

export interface PromoCode {
  code: string;
  /** "percent" discounts take value as 0-100; "fixed" discounts take value as cents. */
  kind: "percent" | "fixed";
  value: number;
}

export interface ChargeRequest {
  requestId: string;
  customerId: string;
  currency: Currency;
  lineItems: readonly LineItem[];
  promo?: PromoCode;
}

export interface TotalBreakdown {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export interface LedgerEntry {
  id: string;
  customerId: string;
  kind: "charge" | "refund";
  /** Currency the customer was billed in. */
  currency: Currency;
  /** Customer-facing amount in minor units of `currency`, processing fee included. */
  grossCents: number;
  /** Settlement amount in USD minor units, converted at `fxRate`. */
  settledCents: number;
  /** Exchange rate from `currency` to USD captured when the entry posted. */
  fxRate: number;
  postedAt: number;
  idempotencyKey: string;
  /** For refunds, the id of the charge being reversed. */
  relatedEntryId?: string;
}

export interface RateProvider {
  /** Current market rate from `currency` to USD. */
  current(currency: Currency): number;
}

export interface Discrepancy {
  expectedCents: number;
  computedDollars: number;
}
