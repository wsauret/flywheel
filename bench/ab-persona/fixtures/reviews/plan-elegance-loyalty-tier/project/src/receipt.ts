import type { PricedOrder } from "./checkout";
import type { Customer } from "./customers";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function renderReceipt(order: PricedOrder, customer: Customer): string {
  return [
    `Corner Market - order ${order.id}`,
    `Customer: ${customer.name}`,
    `Subtotal: ${dollars(order.subtotalCents)}`,
    `Loyalty discount: -${dollars(order.discountCents)}`,
    `Total: ${dollars(order.totalCents)}`,
    `Points balance: ${customer.pointsBalance}`,
  ].join("\n");
}
