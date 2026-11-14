import { expect, test } from "bun:test";
import { getLoans } from "../src/web/routes";
import { memoryLoans } from "./fakes";

test("the loans page lists open loans, soonest due first", async () => {
  const loans = memoryLoans([
    { id: "l-1", itemId: "i-1", patronId: "p-1", dueOn: "2027-05-20", renewals: 0 },
    { id: "l-2", itemId: "i-2", patronId: "p-1", dueOn: "2027-05-12", renewals: 1 },
    { id: "l-3", itemId: "i-3", patronId: "p-1", dueOn: "2027-04-01", renewals: 0, returnedOn: "2027-03-30" },
    { id: "l-4", itemId: "i-4", patronId: "p-2", dueOn: "2027-05-01", renewals: 0 },
  ]);
  const response = await getLoans(loans, { patronId: "p-1" });
  expect((response.body as { id: string }[]).map((loan) => loan.id)).toEqual(["l-2", "l-1"]);
});
