import { expect, test } from "bun:test";
import { availableUnits } from "../src/domain/stock";

test("reserved units are not available", () => {
  expect(availableUnits({ sku: "A1", name: "Bolt", onHand: 10, reserved: 4, reorderPoint: 5 })).toBe(6);
  expect(availableUnits({ sku: "A1", name: "Bolt", onHand: 2, reserved: 4, reorderPoint: 5 })).toBe(0);
});
