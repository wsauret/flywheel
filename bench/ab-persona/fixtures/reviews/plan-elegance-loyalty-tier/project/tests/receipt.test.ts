import { expect, test } from "bun:test";
import { renderReceipt } from "../src/receipt";

test("the receipt shows the discount and the balance", () => {
  const text = renderReceipt(
    { id: "o-1", customerId: "c-1", subtotalCents: 2000, discountCents: 100, totalCents: 1900 },
    { id: "c-1", name: "Ada", email: "ada@example.com", pointsBalance: 1200 },
  );
  expect(text).toContain("Loyalty discount: -$1.00");
  expect(text).toContain("Points balance: 1200");
});
