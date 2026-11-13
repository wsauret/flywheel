import { expect, test } from "bun:test";
import { quoteDelivery } from "../src/pricing/quote";

test("a quote sums its lines", () => {
  const quote = quoteDelivery({ distanceKm: 10, bulky: true }, new Date(2026, 4, 6, 10, 0));
  expect(quote.lines.map((line) => line.label)).toEqual(["Base fee", "Distance", "Bulky item"]);
  expect(quote.totalCents).toBe(500 + 1200 + 800);
});
