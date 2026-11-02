import { describe, expect, test } from "bun:test";
import { runBackfill } from "./backfill.ts";
import { ingestEvent } from "./ingest.ts";
import type { WebhookEvent } from "./types.ts";

function event(id: string, kind: WebhookEvent["kind"], payload: Record<string, unknown>): WebhookEvent {
  return { id, kind, payload };
}

describe("live ingest", () => {
  test("accepts a valid order.placed event", () => {
    expect(ingestEvent(event("evt_1", "order.placed", { orderId: "ord_1", totalCents: 1250 }))).toEqual({
      status: "accepted",
      eventId: "evt_1",
    });
  });

  test("rejects an order.cancelled event with a missing reason", () => {
    const result = ingestEvent(event("evt_2", "order.cancelled", { orderId: "ord_1" }));
    expect(result.status).toBe("rejected");
  });
});

describe("nightly backfill", () => {
  test("replays every kind the job is configured for", () => {
    const report = runBackfill([
      event("evt_3", "order.placed", { orderId: "ord_2", totalCents: 900 }),
      event("evt_4", "order.cancelled", { orderId: "ord_2", reason: "customer request" }),
      event("evt_5", "refund.issued", { orderId: "ord_2", amountCents: 900 }),
    ]);
    expect(report.accepted).toEqual(["evt_3", "evt_4", "evt_5"]);
    expect(report.skipped).toEqual([]);
  });

  test("marks a malformed archived event invalid", () => {
    const report = runBackfill([event("evt_6", "refund.issued", { orderId: "ord_3", amountCents: -1 })]);
    expect(report.invalid).toEqual(["evt_6"]);
  });
});
