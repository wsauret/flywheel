import { formatDate } from "../format/dates";
import { settings } from "../settings";

export interface Sale {
  readonly id: string;
  readonly soldAt: Date;
  readonly product: string;
  readonly quantity: number;
  readonly totalCents: number;
}

export interface SalesDay {
  readonly day: string;
  readonly orders: number;
  readonly units: number;
  readonly revenueCents: number;
}

/** One row per store-local calendar day, in day order. */
export function salesByDay(sales: readonly Sale[]): SalesDay[] {
  const days = new Map<string, { orders: number; units: number; revenueCents: number }>();
  for (const sale of sales) {
    const day = formatDate(sale.soldAt, settings.storeTimeZone);
    const totals = days.get(day) ?? { orders: 0, units: 0, revenueCents: 0 };
    days.set(day, { orders: totals.orders + 1, units: totals.units + sale.quantity, revenueCents: totals.revenueCents + sale.totalCents });
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, totals]) => ({ day, ...totals }));
}

export function renderSalesHtml(sales: readonly Sale[]): string {
  const rows = salesByDay(sales).map((day) => `<tr><td>${day.day}</td><td>${day.orders}</td><td>${day.units}</td><td>${(day.revenueCents / 100).toFixed(2)}</td></tr>`);
  return `<table><tr><th>Day</th><th>Orders</th><th>Units</th><th>Revenue</th></tr>${rows.join("")}</table>`;
}
