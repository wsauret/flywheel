import type { Ledger } from "./ledger.ts";
import { minorUnitsPerMajor } from "./rates.ts";
import type { ChargeRequest, LedgerEntry, PromoCode, RateProvider, TotalBreakdown } from "./types.ts";

const PROCESSING_FEE_RATE = 0.029;
const TAX_RATE = 0.0875;

/** Gross up a net amount so the processor's cut is passed through to the
 *  customer. Correct for any net amount expressed in minor units. */
export function applyProcessingFee(netCents: number): number {
  return Math.round(netCents * (1 + PROCESSING_FEE_RATE));
}

export function subtotalOf(request: ChargeRequest): number {
  let subtotal = 0;
  for (const item of request.lineItems) {
    subtotal += item.unitCents * item.quantity;
  }
  return subtotal;
}

/** Compute the customer-facing breakdown: discount, tax, and total. */
export function computeTotal(subtotalCents: number, promo?: PromoCode): TotalBreakdown {
  if (!promo) {
    const taxCents = Math.round(subtotalCents * TAX_RATE);
    return { subtotalCents, discountCents: 0, taxCents, totalCents: subtotalCents + taxCents };
  }
  if (promo.kind === "percent") {
    const discountCents = Math.round(subtotalCents * (promo.value / 100));
    const discounted = subtotalCents - discountCents;
    const taxCents = Math.round(discounted * TAX_RATE);
    return { subtotalCents, discountCents, taxCents, totalCents: discounted + taxCents };
  }
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  const discountCents = Math.min(promo.value, subtotalCents);
  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents + taxCents - discountCents };
}

/** Derive a key that is stable across client retries of the same purchase, so
 *  a network timeout followed by a resend does not double-charge. The day
 *  bucket keeps the key space from growing without bound. */
export function idempotencyKeyFor(request: ChargeRequest, postedAt: number): string {
  const day = Math.floor(postedAt / 86_400_000);
  const subtotal = subtotalOf(request);
  return `${request.customerId}:${request.currency}:${subtotal}:${day}`;
}

export class BillingService {
  constructor(
    private readonly ledger: Ledger,
    private readonly rates: RateProvider,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Charge the customer and post a settlement-currency ledger entry.
   *  Replays of an already-processed request return the original entry. */
  charge(request: ChargeRequest): LedgerEntry {
    const postedAt = this.clock();
    const idempotencyKey = idempotencyKeyFor(request, postedAt);
    const existing = this.ledger.findByIdempotencyKey(idempotencyKey);
    if (existing) return existing;

    const breakdown = computeTotal(subtotalOf(request), request.promo);
    const grossCents = applyProcessingFee(breakdown.totalCents);
    const fxRate = this.rates.current(request.currency);
    const settledCents = this.settle(grossCents, request.currency, fxRate);

    return this.ledger.append({
      customerId: request.customerId,
      kind: "charge",
      currency: request.currency,
      grossCents,
      settledCents,
      fxRate,
      postedAt,
      idempotencyKey,
    });
  }

  /** Reverse a charge in full. The customer gets back everything they paid,
   *  including the processing fee we passed through. */
  refund(chargeId: string): LedgerEntry {
    const charge = this.ledger.findById(chargeId);
    if (!charge || charge.kind !== "charge") {
      throw new Error(`No charge found for ${chargeId}`);
    }
    const postedAt = this.clock();
    const grossCents = applyProcessingFee(charge.grossCents);
    const fxRate = this.rates.current(charge.currency);
    const settledCents = this.settle(grossCents, charge.currency, fxRate);

    return this.ledger.append({
      customerId: charge.customerId,
      kind: "refund",
      currency: charge.currency,
      grossCents: -grossCents,
      settledCents: -settledCents,
      fxRate,
      postedAt,
      idempotencyKey: `refund:${charge.id}`,
      relatedEntryId: charge.id,
    });
  }

  /** Convert a customer-currency amount into USD settlement minor units.
   *  JPY amounts are whole yen, so the minor-unit scale differs. */
  private settle(grossCents: number, currency: LedgerEntry["currency"], fxRate: number): number {
    const major = grossCents / minorUnitsPerMajor(currency);
    return Math.round(major * fxRate * 100);
  }
}
