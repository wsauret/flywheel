import type { ShopSettings } from "../settings/load";

export interface CartLine {
  readonly name: string;
  readonly quantity: number;
  readonly unitCents: number;
}

export function cartSummary(lines: readonly CartLine[], settings: ShopSettings): string[] {
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0);
  return [
    ...lines.map((line) => `${line.quantity} x ${line.name}  ${settings.currencySymbol}${((line.quantity * line.unitCents) / 100).toFixed(2)}`),
    `Total  ${settings.currencySymbol}${(total / 100).toFixed(2)}`,
  ];
}
