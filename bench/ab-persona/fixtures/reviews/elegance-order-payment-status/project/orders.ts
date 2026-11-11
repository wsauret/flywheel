import type { Order, OrderLine, Payment, PaymentStatus } from "./types.ts";

type Billable = Pick<Order, "lines" | "payments">;

export function orderTotalCents(order: Billable): number {
  return order.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
}

export function balanceDueCents(order: Billable): number {
  const paid = order.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  return orderTotalCents(order) - paid;
}

export function paymentStatusOf(order: Billable): PaymentStatus {
  if (balanceDueCents(order) === 0) return "paid";
  return order.payments.length === 0 ? "unpaid" : "partially-paid";
}

export class OrderBook {
  private readonly orders = new Map<string, Order>();
  private sequence = 0;

  open(customerId: string, lines: readonly OrderLine[]): Order {
    const billable: Billable = { lines, payments: [] };
    const order: Order = {
      id: `ord_${++this.sequence}`,
      customerId,
      ...billable,
      paymentStatus: paymentStatusOf(billable),
    };
    this.orders.set(order.id, order);
    return order;
  }

  /** Apply a payment. Overpayment is refused so the balance never goes negative. */
  recordPayment(orderId: string, payment: Payment): Order {
    const order = this.require(orderId);
    if (payment.amountCents > balanceDueCents(order)) {
      throw new Error(`Payment ${payment.id} exceeds the balance due on ${orderId}`);
    }
    order.payments.push(payment);
    order.paymentStatus = paymentStatusOf(order);
    return order;
  }

  forCustomer(customerId: string): Order[] {
    return [...this.orders.values()].filter((order) => order.customerId === customerId);
  }

  private require(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (order === undefined) throw new Error(`Unknown order ${orderId}`);
    return order;
  }
}
