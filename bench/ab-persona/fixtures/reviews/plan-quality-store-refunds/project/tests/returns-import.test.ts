import { expect, test } from "bun:test";
import { importReturns } from "../src/jobs/returns-import";
import { fakeDeps } from "./fakes";

test("the import refunds valid returns and reports the rest", async () => {
  const deps = fakeDeps([{ id: "s-1", totalCents: 2500, chargeId: "ch-1" }]);
  const result = await importReturns(deps, [
    { saleId: "s-1", amountCents: 2500 },
    { saleId: "s-9", amountCents: 100 },
  ]);
  expect(result.refunded).toBe(1);
  expect(result.rejected.map((entry) => entry.saleId)).toEqual(["s-9"]);
});
