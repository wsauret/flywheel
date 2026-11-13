import { expect, test } from "bun:test";
import { receiptEmail } from "../src/emails/receipt";

test("the receipt email formats the amount for the locale", () => {
  expect(receiptEmail(1250, { shopName: "Corner", locale: "en-GB", currencySymbol: "£" })).toContain("£12.50");
});
