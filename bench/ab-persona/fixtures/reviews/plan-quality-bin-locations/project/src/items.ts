import type { Database } from "bun:sqlite";

export interface PickLine {
  readonly lineNo: number;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
}

export interface ItemRepo {
  /** The lines of one order, in line order. */
  linesForOrder(orderId: string): Promise<readonly PickLine[]>;
}

interface PickLineRow {
  readonly line_no: number;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
}

export class SqlItemRepo implements ItemRepo {
  constructor(private readonly db: Database) {}

  async linesForOrder(orderId: string): Promise<readonly PickLine[]> {
    const rows = this.db
      .query<PickLineRow, [string]>(
        `SELECT l.line_no, l.sku, i.name, l.quantity
           FROM order_lines l JOIN items i ON i.sku = l.sku
          WHERE l.order_id = ?
          ORDER BY l.line_no`,
      )
      .all(orderId);
    return rows.map((row) => ({ lineNo: row.line_no, sku: row.sku, name: row.name, quantity: row.quantity }));
  }
}
