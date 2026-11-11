import { formatCents } from "./money.ts";
import type { ReceiptLine } from "./types.ts";

export function renderReceipt(lines: readonly ReceiptLine[]): string {
  const total = lines.reduce((sum, line) => sum + line.cents, 0);
  const body = lines.map((line) => `${line.description.padEnd(30)}${formatCents(line.cents)}`);
  return [...body, `${"Total".padEnd(30)}${formatCents(total)}`].join("\n");
}
