import { openJournalFile } from "./file-journal.ts";
import { Journal } from "./journal.ts";
import { OrderService } from "./orders.ts";
import type { Order, OrderRequest } from "./types.ts";

export async function startOrders(journalPath: string): Promise<(request: OrderRequest) => Promise<{ status: 201; body: Order }>> {
  const journal = new Journal(await openJournalFile(journalPath), (error) => {
    console.error("order journal flush failed", error);
  });
  const service = new OrderService(journal, Date.now);
  await service.recover();
  return async (request) => ({ status: 201, body: await service.createOrder(request) });
}
