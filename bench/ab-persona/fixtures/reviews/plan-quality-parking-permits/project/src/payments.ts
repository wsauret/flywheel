export class PaymentDeclined extends Error {}

export interface Payments {
  /** Charge a card token. `reference` ties the charge to a permit for the nightly reconciliation; a reference is charged at most once. Throws PaymentDeclined. */
  charge(cardToken: string, cents: number, reference: string): Promise<void>;
}

/** The yearly fee of each zone, in cents. */
export const ZONE_FEES: Readonly<Record<string, number>> = { A: 9000, B: 6000, C: 4500 };
