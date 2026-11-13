import type { ProductTable } from "../db/products";

/** PUT /admin/products/:sku/reorder-point, used by the buyers to tune each product during the day. */
export async function handleSetReorderPoint(sku: string, request: Request, table: ProductTable): Promise<Response> {
  const body: unknown = await request.json().catch(() => undefined);
  const value = typeof body === "object" && body !== null && "reorderPoint" in body ? body.reorderPoint : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return Response.json({ error: "reorderPoint must be a non-negative integer" }, { status: 400 });
  }
  if ((await table.bySku(sku)) === undefined) return Response.json({ error: "Unknown SKU" }, { status: 404 });
  await table.setReorderPoint(sku, value);
  return new Response(null, { status: 204 });
}
