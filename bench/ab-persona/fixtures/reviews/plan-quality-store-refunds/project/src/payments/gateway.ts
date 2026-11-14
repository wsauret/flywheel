/** The card gateway client. The production adapter calls the payment provider's HTTP API. */
export interface CardGateway {
  refund(chargeId: string, amountCents: number): Promise<void>;
}
