import { toCsv } from "../format/csv";

export interface StockLine {
  readonly product: string;
  readonly onHand: number;
}

export function stockCsv(lines: readonly StockLine[]): string {
  return toCsv(["Product", "On hand"], lines.map((line) => [line.product, String(line.onHand)]));
}
