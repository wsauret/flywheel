import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { migrate } from "../src/db";
import { SqlItemRepo } from "../src/items";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:", { strict: true });
  migrate(db);
  db.run("INSERT INTO items (sku, name) VALUES ('BOLT-M8', 'Hex bolt M8'), ('WASH-M8', 'Washer M8')");
  db.run("INSERT INTO order_lines (order_id, line_no, sku, quantity) VALUES ('o-7', 2, 'BOLT-M8', 40), ('o-7', 1, 'WASH-M8', 40)");
});

afterEach(() => db.close());

test("linesForOrder joins the item name and keeps line order", async () => {
  const lines = await new SqlItemRepo(db).linesForOrder("o-7");
  expect(lines.map((line) => [line.lineNo, line.sku, line.name, line.quantity])).toEqual([
    [1, "WASH-M8", "Washer M8", 40],
    [2, "BOLT-M8", "Hex bolt M8", 40],
  ]);
});
