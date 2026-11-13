import { expect, test } from "bun:test";
import { salesByDay } from "../src/reports/sales";

test("a sale late in the evening counts toward the store-local day", () => {
  const days = salesByDay([
    { id: "s1", soldAt: new Date("2026-03-03T04:30:00Z"), product: "Rye", quantity: 2, totalCents: 1200 },
    { id: "s2", soldAt: new Date("2026-03-03T15:00:00Z"), product: "Rye", quantity: 1, totalCents: 600 },
  ]);
  expect(days.map((day) => day.day)).toEqual(["2026-03-02", "2026-03-03"]);
});
