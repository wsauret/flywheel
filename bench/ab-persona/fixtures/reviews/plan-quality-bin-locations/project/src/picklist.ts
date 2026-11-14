import type { ItemRepo } from "./items";

/** The printed pick list: a header and one line per order line, in line order. */
export async function renderPickList(repo: ItemRepo, orderId: string): Promise<string> {
  const lines = await repo.linesForOrder(orderId);
  return [
    `Pick list - order ${orderId}`,
    ...lines.map((line) => `${String(line.lineNo).padStart(3)}  ${line.sku.padEnd(10)}  x${line.quantity}  ${line.name}`),
  ].join("\n");
}
