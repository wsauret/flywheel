import type { Refund, SaleStore } from "../sales";
import type { CardGateway } from "./gateway";

export interface RefundDeps {
  readonly sales: SaleStore;
  readonly gateway: CardGateway;
  readonly newId: () => string;
  readonly now: () => Date;
}

export class RefundError extends Error {}

/** The amount of a sale that is still refundable. */
export async function refundableCents(deps: RefundDeps, saleId: string): Promise<number> {
  const sale = await deps.sales.getSale(saleId);
  if (sale === undefined) throw new RefundError(`Unknown sale ${saleId}`);
  const refunded = (await deps.sales.refundsFor(saleId)).reduce((sum, refund) => sum + refund.amountCents, 0);
  return sale.totalCents - refunded;
}

/** Refund part or all of a sale to the card it was paid with. Throws RefundError
 *  for an unknown sale, a cash sale, or an amount above what is still refundable. */
export async function refundSale(deps: RefundDeps, saleId: string, amountCents: number): Promise<Refund> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new RefundError("Refund amount must be a positive number of cents");
  const remaining = await refundableCents(deps, saleId);
  if (amountCents > remaining) throw new RefundError(`Only ${remaining} cents of sale ${saleId} can still be refunded`);
  const sale = await deps.sales.getSale(saleId);
  if (sale?.chargeId === undefined) throw new RefundError(`Sale ${saleId} was paid in cash; refund it from the drawer`);
  await deps.gateway.refund(sale.chargeId, amountCents);
  const refund: Refund = { id: deps.newId(), saleId, amountCents, destination: { kind: "original" }, at: deps.now() };
  await deps.sales.addRefund(refund);
  return refund;
}
