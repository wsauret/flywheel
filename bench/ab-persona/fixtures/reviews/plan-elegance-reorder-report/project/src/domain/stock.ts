export interface StockItem {
  readonly sku: string;
  readonly name: string;
  readonly onHand: number;
  readonly reserved: number;
  /** Units available at or below which the product must be reordered. Set per product by the buyers. */
  readonly reorderPoint: number;
}

export function availableUnits(item: StockItem): number {
  return Math.max(0, item.onHand - item.reserved);
}
