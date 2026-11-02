import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { Deferred, Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";
import { DebugLog, type DebugLogRecordInput } from "../../../../../src/infra/debug-log.js";
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js";
import type { QueryLauncherConfig } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { inPlaceGate, runInPlaceSelfTest, type SelfTestResult } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/in-place-check.js";

const records: DebugLogRecordInput[] = [];
beforeEach(async () => {
  records.length = 0;
  await DebugLog.forward((record) => { records.push(record); });
});
afterEach(async () => { await DebugLog.close(); });
const checked = () => records.filter(({ type }) => type === "provider.claude_sdk.in_place.checked").map(({ payload }) => payload);

const SONNET = "claude-sonnet-5-5";
const SONNET_1M = "claude-sonnet-5-5[1m]";

/** Runs `body` under a test clock with one owner scope, which the case closes when it chooses. */
function withOwner(body: (owner: Scope.Closeable) => Effect.Effect<void, unknown>): Promise<void> {
  return Effect.runPromise(Effect.gen(function* () {
    const owner = yield* Scope.make();
    yield* body(owner);
    yield* Scope.close(owner, Exit.void);
  }).pipe(Effect.provide(TestClock.layer())));
}

/** A self-test that ends when the case settles it. */
function pendingTests() {
  const runs: { readonly version: string; readonly result: Deferred.Deferred<SelfTestResult> }[] = [];
  const run = (version: string) => Effect.gen(function* () {
    const result = yield* Deferred.make<SelfTestResult>();
    runs.push({ version, result });
    return yield* Deferred.await(result);
  });
  return { runs, run };
}

describe("the in-place gate", () => {
  test("a listed version runs its self-test once for each model, is checking until the test ends, and then is ready; each decision is recorded once", () => withOwner((owner) => Effect.gen(function* () {
    const tests = pendingTests();
    const checks = new Map();
    const sonnet = inPlaceGate(tests.run, SONNET, checks);
    const sonnet1m = inPlaceGate(tests.run, SONNET_1M, checks);
    const ask = (gate: typeof sonnet) => Scope.provide(owner)(gate.status("2.1.295"));

    expect([yield* ask(sonnet), yield* ask(sonnet)]).toEqual(["checking", "checking"]);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(tests.runs[0]!.result, { passed: true });
    yield* Effect.yieldNow;
    expect([yield* ask(sonnet), yield* ask(sonnet)]).toEqual(["ready", "ready"]);
    // The test ran with one model and context window, so another model of the same CLI tests again.
    expect(yield* ask(sonnet1m)).toBe("checking");
    yield* Effect.yieldNow;
    expect(tests.runs.map(({ version }) => version)).toEqual(["2.1.295", "2.1.295"]);
    expect(checked()).toEqual([{ cliVersion: "2.1.295", model: SONNET, outcome: "passed", durationMs: expect.any(Number) }]);
  })));

  test("an unlisted version never runs a self-test, and a conclusive failure keeps its version and model cold", () => withOwner((owner) => Effect.gen(function* () {
    const tests = pendingTests();
    const gate = inPlaceGate(tests.run, SONNET, new Map());
    const ask = (version: string) => Scope.provide(owner)(gate.status(version));

    expect([yield* ask("9.9.9"), yield* ask("9.9.9")]).toEqual(["unlisted", "unlisted"]);
    yield* ask("2.1.294");
    yield* Effect.yieldNow;
    yield* Deferred.succeed(tests.runs[0]!.result, { passed: false, failure: "messages", conclusive: true });
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 day");
    expect([yield* ask("2.1.294"), yield* ask("2.1.294")]).toEqual(["failed", "failed"]);
    expect(tests.runs).toHaveLength(1);
    expect(checked()).toEqual([
      { cliVersion: "9.9.9", model: SONNET, outcome: "unlisted" },
      { cliVersion: "2.1.294", model: SONNET, outcome: "failed", durationMs: expect.any(Number), failure: "messages" },
    ]);
  })));

  test("an inconclusive self-test, such as a timeout under load, keeps the version cold for ten minutes and then runs again", () => withOwner((owner) => Effect.gen(function* () {
    const tests = pendingTests();
    const gate = inPlaceGate(tests.run, SONNET, new Map());
    const ask = () => Scope.provide(owner)(gate.status("2.1.295"));

    yield* ask();
    yield* Effect.yieldNow;
    yield* Deferred.succeed(tests.runs[0]!.result, { passed: false, failure: "timeout", conclusive: false });
    yield* Effect.yieldNow;
    expect(yield* ask()).toBe("failed");
    yield* TestClock.adjust("9 minutes");
    expect(yield* ask()).toBe("failed");
    yield* TestClock.adjust("1 minute");
    expect(yield* ask()).toBe("checking");
    yield* Effect.yieldNow;
    expect(tests.runs).toHaveLength(2);
    expect(checked()).toEqual([{ cliVersion: "2.1.295", model: SONNET, outcome: "inconclusive", durationMs: expect.any(Number), failure: "timeout" }]);
  })));

  test("a self-test whose owner closes stops with it, and the next ask runs it again", () => withOwner((owner) => Effect.gen(function* () {
    const tests = pendingTests();
    const gate = inPlaceGate(tests.run, SONNET, new Map());
    const first = yield* Scope.make();
    expect(yield* Scope.provide(first)(gate.status("2.1.295"))).toBe("checking");
    yield* Effect.yieldNow;
    yield* Scope.close(first, Exit.void);
    expect(yield* Scope.provide(owner)(gate.status("2.1.295"))).toBe("checking");
    yield* Effect.yieldNow;
    expect(tests.runs).toHaveLength(2);
    expect(checked()).toEqual([{ cliVersion: "2.1.295", model: SONNET, outcome: "interrupted", durationMs: expect.any(Number) }]);
  })));

  test("a self-test whose CLI does not start proves nothing, and leaves no scratch directory or host behind", async () => {
    const scratch = () => readdirSync(tmpdir()).filter((name) => name.startsWith("sdk-in-place-"));
    const before = scratch();
    const noLaunch: LauncherScope = {
      spawnOwned: () => Promise.reject(new Error("no launch")), adoptOwned: () => Promise.reject(new Error("no adoption")), open: () => noLaunch, close: async () => ({ settled: true }),
    };
    const launcher: QueryLauncherConfig = { enginePath: "/missing/claude", configDir: "/scratch/config", account: { home: "/scratch/home", user: "person" }, platform: "linux", hostEnvironment: {}, timeZone: "UTC", temporaryDirectory: "/scratch/tmp", launcher: noLaunch };
    const result = await Effect.runPromise(runInPlaceSelfTest({
      launcher, launchQuery: () => () => { throw new TypeError("the CLI did not start"); }, wireModelId: SONNET, contextLimit: 200_000,
    }, "2.1.295"));
    expect(result).toEqual({ passed: false, failure: "TypeError", conclusive: false });
    expect(scratch()).toEqual(before);
  });
});
