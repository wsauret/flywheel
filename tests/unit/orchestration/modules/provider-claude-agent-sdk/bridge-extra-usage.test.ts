import { describe, expect, test } from "bun:test";
import { LlmStreamError, QuotaCoordinationError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import {
  A1, admittedStart, answers, callHandler, forwardDiagnostics, init, messageStop, parked, payloads, R1, readsFile, rateLimitReport, request, send, settle, STEP, text, turnDone, U1, U2, A2, until, withBridge,
} from "./_bridge-harness.js";
import { releaseLiveBridges } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/live-bridges.js";

forwardDiagnostics();

const RESET_S = 1_791_540_527;
/** The CLI's report after a response that extra usage served: the five-hour window is spent and extra usage serves
 *  its overflow (CLI 2.1.295 on the fake host). */
const extraUsage = rateLimitReport({
  status: "rejected", resetsAt: RESET_S, rateLimitType: "five_hour", overageStatus: "allowed", overageResetsAt: 1_793_261_328, isUsingOverage: true, overageInUse: true,
});
/** The CLI's report after a response that included usage served. */
const included = rateLimitReport({ status: "allowed", resetsAt: RESET_S, rateLimitType: "five_hour", overageStatus: "allowed", isUsingOverage: false });
/** The CLI's report after a response without the service's usage headers. */
const unconfirmed = rateLimitReport({ status: "allowed", isUsingOverage: false });
/** The error with which the bridge refused to open a request, or undefined when it opened it. */
const refusal = (opened: Promise<unknown>): Promise<Error | undefined> => opened.then(() => undefined, (error: unknown) => error instanceof Error ? error : new Error(String(error)));

describe("the extra-usage guard", () => {
  test("with extra usage off, a response that the CLI reports as extra usage keeps its answer, holds the account until the included reset, stops the CLI, and tells the person", () => withBridge(async ({ ops, queries, quotaMarks, usageStops, log }) => {
    const first = await send(ops, request([U1]));
    // The CLI reads the usage headers only when the response ends, so the report follows the answer.
    queries[0]?.emit(init, ...answers("Done."), extraUsage);
    expect(await first.error).toBeUndefined();
    await until(() => log.includes("close"));

    expect(log).toEqual(["push", "close"]);
    expect(quotaMarks).toEqual([RESET_S * 1000]);
    expect(usageStops).toEqual([{ evidence: "extra-usage", heldUntilMs: RESET_S * 1000 }]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "extra-usage", rule: "extra-usage", poisoned: true }]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("a report of extra usage while the next request waits fails that request with the account's hold, so the walk moves on", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const second = refusal(send(harness.ops, request([U1, A1, R1])));
    await settle();
    query.emit(extraUsage);
    const error = await second;

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error instanceof QuotaExhaustedError ? error.quotaObservation?.exhaustion.resetsAtMs : undefined).toBe(RESET_S * 1000);
    await until(() => harness.log.includes("close"));
    expect(harness.log).toEqual(["push", "interrupt", "close"]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("with extra usage allowed, the account serves on after a report of extra usage", () => withBridge(async ({ ops, queries, quotaMarks, usageStops, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), extraUsage, turnDone);
    expect(await first.error).toBeUndefined();
    const second = await send(ops, request([U1, A2, U2]));
    queries[0]?.emit(...answers("Next done."));
    expect(await second.error).toBeUndefined();

    expect(log).toEqual(["push", "push"]);
    expect([quotaMarks, usageStops]).toEqual([[], []]);
  }, { reports: "manual", extraUsage: "allow" }));

  test("a report of included usage keeps the query, which serves later responses that the CLI does not report again", () => withBridge(async ({ ops, queries, quotaMarks, usageStops, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), included, turnDone);
    expect(await first.error).toBeUndefined();
    const second = await send(ops, request([U1, A2, U2]));
    queries[0]?.emit(...answers("Next done."), turnDone);
    expect(await second.error).toBeUndefined();
    await settle();

    expect(log).toEqual(["push", "push"]);
    expect([quotaMarks, usageStops]).toEqual([[], []]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("a report that names no usage window stops the account until the safe recheck", () => withBridge(async ({ ops, queries, quotaMarks, usageStops, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), unconfirmed);
    expect(await first.error).toBeUndefined();
    await until(() => log.includes("close"));

    expect(quotaMarks).toEqual([undefined]);
    expect(usageStops).toEqual([{ evidence: "unconfirmed", heldUntilMs: 300_000 }]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("a first response with no report before the CLI's turn result stops the account, as a login that is not a subscription does", () => withBridge(async ({ ops, queries, quotaMarks, usageStops, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), turnDone);
    expect(await first.error).toBeUndefined();
    await until(() => log.includes("close"));

    expect(quotaMarks).toEqual([undefined]);
    expect(usageStops).toEqual([{ evidence: "unreported", heldUntilMs: 300_000 }]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "extra-usage", rule: "unreported" }]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("the next request on a query that still owes its first report waits for the report, and with none it fails with the account's hold and the CLI never gets the tool results", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const handler = callHandler(query, "toolu_1");
    const second = refusal(send(harness.ops, request([U1, A1, R1])));
    await settle();
    await harness.advance(1_999);
    expect(harness.usageStops).toEqual([]);
    await harness.advance(1);

    expect(await second).toBeInstanceOf(QuotaExhaustedError);
    expect(await handler).toMatchObject({ isError: true });
    expect(harness.usageStops).toEqual([{ evidence: "unreported", heldUntilMs: 300_000 }]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("a request that reaches a parked query before its first report hands the CLI no tool results when the report shows extra usage", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const handler = callHandler(query, "toolu_1");
    const second = refusal(send(harness.ops, request([U1, A1, R1])));
    await settle();
    query.emit(extraUsage);

    expect(await second).toBeInstanceOf(QuotaExhaustedError);
    expect(await handler).toMatchObject({ isError: true });
  }, { reports: "manual", extraUsage: "refuse" }));

  test("a request that reaches a parked query before an included report serves on the same CLI once the report arrives", () => withBridge(async (harness) => {
    const { query } = await parked(harness);
    const handler = callHandler(query, "toolu_1");
    const second = send(harness.ops, request([U1, A1, R1]));
    await settle();
    query.emit(included);
    expect(await handler).toEqual({ content: [{ type: "text", text: "file a" }] });
    query.emit(...answers("Done."));

    expect(await (await second).error).toBeUndefined();
    expect([harness.log, harness.usageStops]).toEqual([["push"], []]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("a cut response owes no report, so the CLI's success turn result after the cut fails the request as a cut and leaves the account in service", () => withBridge(async ({ ops, queries, quotaMarks, usageStops, log }) => {
    const first = await send(ops, request([U1]));
    // The CLI reports no usage for a response that a network cut ended.
    queries[0]?.emit(init, ...admittedStart(), ...text(0, "partial"), messageStop, STEP, turnDone);

    expect(await first.error).toBeInstanceOf(LlmStreamError);
    await until(() => log.includes("close"));
    expect([quotaMarks, usageStops]).toEqual([[], []]);
    const second = await send(ops, request([U1]));
    queries[1]?.emit(init, ...answers("Done."), included);
    expect(await second.error).toBeUndefined();
  }, { reports: "manual", extraUsage: "refuse" }));

  test("after a stop, the next request fails at once with the account's hold and starts no CLI until the hold ends", () => withBridge(async ({ ops, queries, log, advance }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), turnDone);
    expect(await first.error).toBeUndefined();
    await until(() => log.includes("close"));

    expect(await refusal(send(ops, request([U1, A2, U2])))).toBeInstanceOf(QuotaExhaustedError);
    expect(queries).toHaveLength(1);
    await advance(300_000);
    const third = await send(ops, request([U1, A2, U2]));
    queries[1]?.emit(init, ...answers("Next done."), included);
    expect(await third.error).toBeUndefined();
  }, { reports: "manual", extraUsage: "refuse" }));

  test("an account whose quota row refuses the mark stays held in the bridge, so its next request starts no CLI", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), extraUsage);
    expect(await first.error).toBeUndefined();
    await until(() => log.includes("close"));

    expect(await refusal(send(ops, request([U1, A2, U2])))).toBeInstanceOf(QuotaCoordinationError);
    expect(queries).toHaveLength(1);
  }, { reports: "manual", extraUsage: "refuse", quotaRowRefused: true }));

  test("a cold rotation of a query that still owes its first report waits for it, and with none it stops the account before a new CLI starts", () => withBridge(async ({ ops, queries, usageStops, advance }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...readsFile);
    await first.read;
    const rotated = refusal(send(ops, request([U1, A1, R1], { system: [{ type: "text", text: "A changed system prompt" }] })));
    await settle();
    await advance(2_000);

    expect(await rotated).toBeInstanceOf(QuotaExhaustedError);
    expect(queries).toHaveLength(1);
    expect(usageStops).toEqual([{ evidence: "unreported", heldUntilMs: 300_000 }]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("a usage-based login's report never confirms included usage, because its CLI omits the extra-usage state", () => withBridge(async ({ ops, queries, usageStops, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), included);
    expect(await first.error).toBeUndefined();
    await until(() => log.includes("close"));

    expect(usageStops).toEqual([{ evidence: "unconfirmed", heldUntilMs: 300_000 }]);
  }, { reports: "manual", extraUsage: "refuse", reportsExtraUsage: false }));

  test("a release of an idle CLI that still owes its first report keeps the CLI until the report arrives, then stops it", () => withBridge(async ({ ops, queries, quotaMarks, log, advance }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    await settle();
    releaseLiveBridges();
    await settle();
    await advance(0);
    expect(log).toEqual(["push"]);

    queries[0]?.emit(included);
    await settle();
    await advance(2_000);
    await until(() => log.includes("close"));
    expect(quotaMarks).toEqual([]);
    expect(payloads("provider.claude_sdk.query.stopped")).toMatchObject([{ reason: "release", rule: "module-off" }]);
  }, { reports: "manual", extraUsage: "refuse" }));

  test("records the account's usage windows that each report carries, whichever usage served the response", () => withBridge(async ({ ops, queries, usageWindows }) => {
    const windows = { five_hour: { utilization: 0.42, resetsAt: RESET_S }, seven_day: { utilization: 0.17, resetsAt: RESET_S + 86_400 } };
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."), rateLimitReport({ status: "allowed", resetsAt: RESET_S, rateLimitType: "five_hour", isUsingOverage: false, unifiedWindows: windows }), turnDone);
    expect(await first.error).toBeUndefined();
    const second = await send(ops, request([U1, A2, U2]));
    queries[0]?.emit(...answers("Next done."), rateLimitReport({ status: "allowed", resetsAt: RESET_S, rateLimitType: "five_hour", isUsingOverage: true, unifiedWindows: { five_hour: { utilization: 1, resetsAt: RESET_S } } }), turnDone);
    expect(await second.error).toBeUndefined();
    await settle();

    expect(usageWindows).toEqual([
      { fiveHour: { usedFraction: 0.42, resetsAtMs: RESET_S * 1000 }, sevenDay: { usedFraction: 0.17, resetsAtMs: (RESET_S + 86_400) * 1000 } },
      { fiveHour: { usedFraction: 1, resetsAtMs: RESET_S * 1000 } },
    ]);
  }, { reports: "manual", extraUsage: "allow" }));

  test("a release of an idle CLI whose first report never arrives stops the account when the hold ends", () => withBridge(async ({ ops, queries, usageStops, log, advance }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init, ...answers("Done."));
    await first.read;
    await settle();
    releaseLiveBridges();
    await settle();
    await advance(0);
    await settle();
    await advance(2_000);
    await until(() => log.includes("close"));

    expect(usageStops).toEqual([{ evidence: "unreported", heldUntilMs: 300_000 }]);
  }, { reports: "manual", extraUsage: "refuse" }));
});
