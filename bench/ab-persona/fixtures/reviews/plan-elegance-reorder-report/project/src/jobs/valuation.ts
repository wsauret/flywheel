import { listStockItems, type ProductTable } from "../db/products";
import { availableUnits } from "../domain/stock";

/** Nightly: the number of available units per SKU, for the finance export. */
export async function availableBySku(table: ProductTable): Promise<Record<string, number>> {
  const items = await listStockItems(table);
  return Object.fromEntries(items.map((item) => [item.sku, availableUnits(item)]));
}
