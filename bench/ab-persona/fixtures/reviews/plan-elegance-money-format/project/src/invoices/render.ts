import type { ShopSettings } from "../settings/load";

export interface Invoice {
  readonly number: string;
  readonly lines: readonly { readonly description: string; readonly cents: number }[];
}

const CODE_FOR_SYMBOL = { "$": "USD", "€": "EUR", "£": "GBP" } as const;

export function renderInvoice(invoice: Invoice, settings: ShopSettings): string {
  const code = CODE_FOR_SYMBOL[settings.currencySymbol];
  const total = invoice.lines.reduce((sum, line) => sum + line.cents, 0);
  return [
    `${settings.shopName} - invoice ${invoice.number}`,
    ...invoice.lines.map((line) => `${line.description}: ${(line.cents / 100).toFixed(2)} ${code}`),
    `Total: ${(total / 100).toFixed(2)} ${code}`,
  ].join("\n");
}
