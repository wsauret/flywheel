import { describe, expect, test } from "bun:test";
import { RefundError, refundSale } from "../src/payments/refunds";
import { fakeDeps } from "./fakes";

describe("refundSale", () => {
  test("refunds the card and records the refund", async () => {
    const deps = fakeDeps([{ id: "s-1", totalCents: 2500, chargeId: "ch-1" }]);
    const refund = await refundSale(deps, "s-1", 1000);
    expect(deps.cardRefunds).toEqual([["ch-1", 1000]]);
    expect(refund.destination).toEqual({ kind: "original" });
    expect(deps.refunds).toHaveLength(1);
  });

  test("refuses more than the refundable remainder", async () => {
    const deps = fakeDeps([{ id: "s-1", totalCents: 2500, chargeId: "ch-1" }]);
    await refundSale(deps, "s-1", 2000);
    expect(refundSale(deps, "s-1", 600)).rejects.toThrow(RefundError);
  });

  test("refuses a cash sale", async () => {
    const deps = fakeDeps([{ id: "s-2", totalCents: 900 }]);
    expect(refundSale(deps, "s-2", 900)).rejects.toThrow("cash");
  });
});
