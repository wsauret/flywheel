import { getStockItem, type ProductTable } from "../db/products";
import { availableUnits } from "../domain/stock";

/** GET /stock/:sku */
export async function handleStock(sku: string, table: ProductTable): Promise<Response> {
  const item = await getStockItem(table, sku);
  if (item === undefined) return Response.json({ error: "Unknown SKU" }, { status: 404 });
  return Response.json({ sku: item.sku, name: item.name, available: availableUnits(item) });
}
