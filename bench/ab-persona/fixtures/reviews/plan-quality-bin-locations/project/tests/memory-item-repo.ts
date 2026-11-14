import type { ItemRepo, PickLine } from "../src/items";

export class MemoryItemRepo implements ItemRepo {
  constructor(private readonly orders: Record<string, PickLine[]>) {}

  async linesForOrder(orderId: string): Promise<readonly PickLine[]> {
    return [...(this.orders[orderId] ?? [])].sort((a, b) => a.lineNo - b.lineNo);
  }
}
