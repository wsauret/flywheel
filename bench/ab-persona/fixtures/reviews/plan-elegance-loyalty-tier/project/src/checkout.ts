import { getCustomer } from "./customers";
import type { Database } from "./db";
import { discountFor, tierFor } from "./tiers";

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly subtotalCents: number;
}

export interface PricedOrder extends Order {
  readonly discountCents: number;
  readonly totalCents: number;
}

export async function priceOrder(db: Database, order: Order): Promise<PricedOrder> {
  const customer = await getCustomer(db, order.customerId);
  const discountCents = Math.round(order.subtotalCents * discountFor(tierFor(customer.pointsBalance)));
  return { ...order, discountCents, totalCents: order.subtotalCents - discountCents };
}
