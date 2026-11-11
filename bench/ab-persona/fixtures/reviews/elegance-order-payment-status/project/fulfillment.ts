import type { Order } from "./types.ts";

/** Only fully paid orders leave the warehouse. */
export function readyToShip(order: Order): boolean {
  return order.paymentStatus === "paid";
}
