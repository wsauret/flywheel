export type RefundDestination =
  | { readonly kind: "original" };

export interface Refund {
  readonly id: string;
  readonly saleId: string;
  readonly amountCents: number;
  readonly destination: RefundDestination;
  readonly at: Date;
}

export interface Sale {
  readonly id: string;
  readonly totalCents: number;
  /** The card gateway charge, absent for a cash sale. */
  readonly chargeId?: string;
  /** Present when the sale was made to a customer account. */
  readonly customerId?: string;
}

export interface SaleStore {
  getSale(id: string): Promise<Sale | undefined>;
  refundsFor(saleId: string): Promise<readonly Refund[]>;
  addRefund(refund: Refund): Promise<void>;
}
