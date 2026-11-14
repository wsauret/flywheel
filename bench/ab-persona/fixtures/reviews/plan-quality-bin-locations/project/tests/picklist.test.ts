import { expect, test } from "bun:test";
import { renderPickList } from "../src/picklist";
import { MemoryItemRepo } from "./memory-item-repo";

test("the pick list shows each line in line order", async () => {
  const repo = new MemoryItemRepo({
    "o-7": [
      { lineNo: 2, sku: "BOLT-M8", name: "Hex bolt M8", quantity: 40 },
      { lineNo: 1, sku: "WASH-M8", name: "Washer M8", quantity: 40 },
    ],
  });
  const text = await renderPickList(repo, "o-7");
  expect(text.split("\n")).toEqual([
    "Pick list - order o-7",
    "  1  WASH-M8     x40  Washer M8",
    "  2  BOLT-M8     x40  Hex bolt M8",
  ]);
});
