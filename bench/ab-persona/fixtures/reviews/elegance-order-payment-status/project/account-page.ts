import { balanceDueCents, type OrderBook } from "./orders.ts";
import type { PaymentStatus } from "./types.ts";

const STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Awaiting payment",
  "partially-paid": "Partially paid",
  paid: "Paid in full",
};

/** One line per order for the customer's account page, e.g. "ord_3  Partially paid  ($12.50 due)". */
export function orderLines(book: OrderBook, customerId: string): string[] {
  return book.forCustomer(customerId).map((order) => {
    const due = balanceDueCents(order);
    const suffix = due === 0 ? "" : `  ($${(due / 100).toFixed(2)} due)`;
    return `${order.id}  ${STATUS_LABELS[order.paymentStatus]}${suffix}`;
  });
}
