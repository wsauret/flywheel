import { formatDate } from "./format.ts";

export function summaryHeading(fromMs: number, toMs: number, count: number): string {
  return `${count} transactions from ${formatDate(fromMs)} to ${formatDate(toMs)}`;
}
