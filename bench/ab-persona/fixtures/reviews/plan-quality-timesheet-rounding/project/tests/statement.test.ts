import { expect, test } from "bun:test";
import { monthlyStatement } from "../src/reports/statement";

const client = { id: "c-1", name: "Orchard Bakery", plan: "standard" as const, hourlyRateCents: 12000 };

test("the statement sums the billed hours of one month", () => {
  const statement = monthlyStatement(client, [
    { id: "e-1", clientId: "c-1", date: "2027-02-03", description: "Logo sketches", minutes: 90, billable: true },
    { id: "e-2", clientId: "c-1", date: "2027-02-10", description: "Menu layout", minutes: 45, billable: true },
    { id: "e-3", clientId: "c-1", date: "2027-03-01", description: "Signage", minutes: 60, billable: true },
  ], "2027-02");
  expect(statement.billedHours).toBe("2.25");
  expect(statement.entryCount).toBe(2);
});
