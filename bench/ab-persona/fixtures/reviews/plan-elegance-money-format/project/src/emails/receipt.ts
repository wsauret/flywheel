import type { ShopSettings } from "../settings/load";

const CURRENCY = { "$": "USD", "€": "EUR", "£": "GBP" } as const;

export function receiptEmail(totalCents: number, settings: ShopSettings): string {
  const amount = new Intl.NumberFormat(settings.locale, { style: "currency", currency: CURRENCY[settings.currencySymbol] }).format(totalCents / 100);
  return `Thank you for shopping at ${settings.shopName}. You paid ${amount}.`;
}
