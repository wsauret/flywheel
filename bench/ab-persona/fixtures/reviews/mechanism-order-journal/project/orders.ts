import type { Journal } from "./journal.ts";
import type { Order, OrderRecord, OrderRequest } from "./types.ts";

export class OrderService {
  private nextSeq = 1;
  private readonly byRequest = new Map<string, Order>();

  constructor(
    private readonly journal: Journal,
    private readonly clock: () => number,
  ) {}

  /** Rebuild state from the journal. Call once before serving requests. */
  async recover(): Promise<void> {
    for (const record of await this.journal.replay()) this.remember(record);
  }

  /** Create an order and resolve once it is durable. A retry with the same
   *  requestId returns the first order instead of creating a second one. */
  async createOrder(request: OrderRequest): Promise<Order> {
    const existing = this.findExisting(request.requestId);
    if (existing) return existing;
    const record: OrderRecord = {
      id: `ord-${this.nextSeq++}`,
      requestId: request.requestId,
      sku: request.sku,
      quantity: request.quantity,
      createdAt: this.clock(),
    };
    await this.journal.append(record);
    return this.remember(record);
  }

  private findExisting(requestId: string): Order | undefined {
    return this.byRequest.get(requestId);
  }

  private remember(record: OrderRecord): Order {
    const order: Order = { id: record.id, sku: record.sku, quantity: record.quantity, createdAt: record.createdAt };
    this.byRequest.set(record.requestId, order);
    const seq = Number(record.id.slice("ord-".length));
    if (seq >= this.nextSeq) this.nextSeq = seq + 1;
    return order;
  }
}
