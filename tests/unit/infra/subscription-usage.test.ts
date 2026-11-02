import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CHATGPT_RATE_LIMIT_RESET_TYPE,
  SubscriptionUsageMetricSchema,
  SubscriptionUsageResetCreditsSchema,
  SubscriptionUsageSpendSourceSchema,
  normalizeSubscriptionUsageReport,
  selectSubscriptionUsageResetCredit,
} from "../../../src/infra/llm/subscription-usage.js";

const exactMetric = {
  metricKey: "primary_window",
  label: "Primary window",
  scope: { kind: "account" },
  rank: 0,
  usedFraction: 0.25,
  timing: { kind: "exact", startMs: 1_000, endMs: 2_000 },
} as const;

describe("subscription usage metric contract", () => {
  test("accepts exact integer half-open bounds", () => {
    const report = normalizeSubscriptionUsageReport({
      providerId: "chatgpt",
      instanceId: "account-a",
      identity: "user@example.com",
      providerStatus: "ok",
      observedAtMs: 1_500,
      metrics: [exactMetric],
    });
    expect(report.metrics[0]).toEqual(exactMetric);
  });

  test("rejects unsafe, fractional, empty, and reversed exact bounds", () => {
    const decode = Schema.decodeUnknownSync(SubscriptionUsageMetricSchema, { onExcessProperty: "error" });
    for (const timing of [
      { kind: "exact", startMs: 1.5, endMs: 2_000 },
      { kind: "exact", startMs: 1_000, endMs: Number.MAX_SAFE_INTEGER + 1 },
      { kind: "exact", startMs: 1_000, endMs: 1_000 },
      { kind: "exact", startMs: 2_000, endMs: 1_000 },
    ]) {
      expect(() => decode({ ...exactMetric, timing })).toThrow();
    }
  });

  test("preserves reset evidence only on explicitly unavailable timing", () => {
    const metric = Schema.decodeUnknownSync(SubscriptionUsageMetricSchema, { onExcessProperty: "error" })({
      ...exactMetric,
      timing: { kind: "unavailable", resetId: "2026-09-01", resetAtMs: Date.parse("2026-09-01") },
    });
    expect(metric.timing).toEqual({ kind: "unavailable", resetId: "2026-09-01", resetAtMs: Date.parse("2026-09-01") });
  });

  test("rejects fractional and unsafe unavailable reset times", () => {
    const decode = Schema.decodeUnknownSync(SubscriptionUsageMetricSchema, { onExcessProperty: "error" });
    for (const resetAtMs of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decode({ ...exactMetric, timing: { kind: "unavailable", resetAtMs } })).toThrow();
    }
  });

  test("offers the soonest available ChatGPT rate-limit reset without predicting applicability", () => {
    const later = { id: "later", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available" } as const;
    const first = { ...later, id: "first", expiresAtMs: 1_800_000_000_000 };
    const spent = { ...later, id: "spent", status: "redeemed" };
    expect(selectSubscriptionUsageResetCredit({ availableCount: 2, credits: [later, spent, first] })?.id).toBe("first");
    expect(selectSubscriptionUsageResetCredit({ availableCount: 0, credits: [later] })).toBeUndefined();
    expect(selectSubscriptionUsageResetCredit({ availableCount: 1, credits: [spent] })).toBeUndefined();
    expect(Schema.decodeUnknownSync(SubscriptionUsageResetCreditsSchema, { onExcessProperty: "error" })({ availableCount: 1, credits: [first] })).toEqual({ availableCount: 1, credits: [first] });
    expect(() => Schema.decodeUnknownSync(SubscriptionUsageResetCreditsSchema, { onExcessProperty: "error" })({ availableCount: 1, applicableCount: 0, credits: [first] })).toThrow();
  });

  test("rejects fractional and unsafe subscription spend reset times", () => {
    const decode = Schema.decodeUnknownSync(SubscriptionUsageSpendSourceSchema, { onExcessProperty: "error" });
    for (const resetAtMs of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decode({ kind: "prepaid", availability: "available", resetAtMs })).toThrow();
    }
  });

  test("rejects duplicate metric keys within one report", () => {
    expect(() => normalizeSubscriptionUsageReport({
      providerId: "chatgpt",
      instanceId: "account-a",
      identity: "user@example.com",
      providerStatus: "ok",
      observedAtMs: 1_500,
      metrics: [exactMetric, { ...exactMetric, label: "Duplicate" }],
    })).toThrow();
  });

});
