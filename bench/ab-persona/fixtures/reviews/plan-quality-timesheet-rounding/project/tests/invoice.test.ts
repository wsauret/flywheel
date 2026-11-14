import { expect, test } from "bun:test";
import { buildInvoice } from "../src/billing/invoice";

const client = { id: "c-1", name: "Orchard Bakery", plan: "standard" as const, hourlyRateCents: 12000 };

test("an invoice bills the minutes of billable entries", () => {
  const invoice = buildInvoice(client, [
    { id: "e-1", clientId: "c-1", date: "2027-02-03", description: "Logo sketches", minutes: 90, billable: true },
    { id: "e-2", clientId: "c-1", date: "2027-02-04", description: "Internal review", minutes: 30, billable: false },
  ]);
  expect(invoice.lines.map((line) => [line.hours, line.amountCents])).toEqual([["1.50", 18000], ["0.00", 0]]);
  expect(invoice.totalCents).toBe(18000);
});
