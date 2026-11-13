import type { StockItem } from "../domain/stock";

export interface ProductRow {
  readonly sku: string;
  readonly name: string;
  readonly on_hand: number;
  readonly reserved: number;
  readonly reorder_point: number;
}

export interface ProductTable {
  all(): Promise<ProductRow[]>;
  bySku(sku: string): Promise<ProductRow | undefined>;
  setReorderPoint(sku: string, reorderPoint: number): Promise<void>;
}

function toItem(row: ProductRow): StockItem {
  return { sku: row.sku, name: row.name, onHand: row.on_hand, reserved: row.reserved, reorderPoint: row.reorder_point };
}

export async function listStockItems(table: ProductTable): Promise<StockItem[]> {
  return (await table.all()).map(toItem);
}

export async function getStockItem(table: ProductTable, sku: string): Promise<StockItem | undefined> {
  const row = await table.bySku(sku);
  return row === undefined ? undefined : toItem(row);
}
