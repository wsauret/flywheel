import type { ProductTable } from "./db/products";
import { handleSetReorderPoint } from "./http/admin-routes";
import { handleStock } from "./http/stock-routes";

/** Starts the HTTP server. The scheduler process runs src/jobs/ separately. */
export function startServer(table: ProductTable, port: number) {
  return Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url);
      const stock = url.pathname.match(/^\/stock\/([^/]+)$/);
      if (stock?.[1] !== undefined && request.method === "GET") return handleStock(stock[1], table);
      const admin = url.pathname.match(/^\/admin\/products\/([^/]+)\/reorder-point$/);
      if (admin?.[1] !== undefined && request.method === "PUT") return handleSetReorderPoint(admin[1], request, table);
      return new Response("Not found", { status: 404 });
    },
  });
}
