import type { RefundDeps } from "../src/payments/refunds";
import type { Refund, Sale } from "../src/sales";

export function fakeDeps(sales: readonly Sale[]): RefundDeps & { readonly refunds: Refund[]; readonly cardRefunds: [string, number][] } {
  const refunds: Refund[] = [];
  const cardRefunds: [string, number][] = [];
  let next = 0;
  return {
    refunds,
    cardRefunds,
    sales: {
      getSale: async (id) => sales.find((sale) => sale.id === id),
      refundsFor: async (saleId) => refunds.filter((refund) => refund.saleId === saleId),
      addRefund: async (refund) => { refunds.push(refund); },
    },
    gateway: { refund: async (chargeId, amountCents) => { cardRefunds.push([chargeId, amountCents]); } },
    newId: () => `r-${++next}`,
    now: () => new Date("2027-03-01T10:00:00Z"),
  };
}
