import { describe, expect, it, jest, spyOn } from "bun:test";
import { Effect } from "effect";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import type { NestedToolDispatchBatch } from "../../../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { CodeModeInvocation } from "../../../../../src/orchestration/modules/code-mode/invocation-runner.js";
import { createCodeModeService } from "../../../../../src/orchestration/modules/code-mode/service.js";
import { scriptedWorker, workerLog, type FakeWorker } from "../../../../helpers/code-mode-worker.js";

/** Guests that hold their program until the test answers it. */
function heldGuests(onMessage?: Parameters<typeof scriptedWorker>[0]) {
  return workerLog(() => scriptedWorker(onMessage));
}

function answer(worker: FakeWorker | undefined, text: string): void {
  worker?.send({ type: "result", outcome: "ok", text, ending: "returned" });
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fakes `setTimeout` until disposal. `setImmediate` stays real, so guest
 *  messages still arrive, but no deadline passes until the test advances the
 *  clock, however slowly this process runs. */
function fakeClock(): Disposable {
  jest.useFakeTimers();
  return { [Symbol.dispose]: () => jest.useRealTimers() };
}

/** Resolves once `worker` closes. Call it before the step that terminates
 *  the Worker. The pool waits for the thread join on a zero-delay timer after
 *  `close`, which a faked clock runs only when the test advances it. */
async function terminated(worker: FakeWorker | undefined): Promise<void> {
  await new Promise((resolve) => worker?.addEventListener("close", resolve, { once: true }));
  jest.advanceTimersByTime(0);
}

function invocation(batches: { opened: number }): CodeModeInvocation {
  const batch: NestedToolDispatchBatch = { execute: () => Effect.die(new Error("no nested calls")), unsettled: () => [], close: () => Effect.void };
  return {
    source: "return 1",
    tools: { descriptors: [], callable: new Map(), omissions: [] },
    parentToolUseId: "outer",
    createBatch: () => { batches.opened++; return batch; },
  };
}

function context(sessionId: string, signal?: AbortSignal): ToolContext {
  return { executionCwd: process.cwd(), userDataRoot: "/scratch/test-account", projectRoot: process.cwd(), artifactScopeId: sessionId, sessionId, retrievalSessionId: sessionId, toolUseId: "outer", ...(signal ? { signal } : {}) };
}

describe("Code Mode service", () => {
  it("runs four invocations at once and starts the fifth on the first Worker once its reset is confirmed", async () => {
    const guests = heldGuests();
    const service = createCodeModeService({ openWorker: guests.openWorker });
    const batches = { opened: 0 };
    const runs = ["a", "b", "c", "d", "e"].map((session) => service.run(invocation(batches), context(session)));
    await settle();
    expect(guests.opened).toHaveLength(4);
    expect(batches.opened).toBe(4);

    const first = guests.opened[0];
    answer(first, "first");
    expect(await runs[0]).toEqual({ outcome: "ok", content: "first" });
    await settle();
    expect(guests.opened).toHaveLength(4);
    expect(first?.terminated).toBe(false);
    expect(first?.hostMessages.map(({ type }) => type)).toEqual(["start", "reset", "start"]);
    expect(batches.opened).toBe(5);

    for (const [index, worker] of guests.opened.entries()) answer(worker, `run ${index}`);
    await Promise.all(runs);
    expect(guests.opened.some((worker) => worker.terminated)).toBe(false);
    await service.dispose();
    expect(guests.opened.every((worker) => worker.terminated)).toBe(true);
  });

  it("never leases a Worker again after it retires it", async () => {
    const retirements: { reason: unknown; notable: boolean }[] = [];
    using _recorder = spyOn(DebugLog, "record").mockImplementation((entry) => {
      const { payload } = entry;
      if (entry.type !== "runtime.worker.retired" || typeof payload !== "object" || payload === null || !("reason" in payload)) return;
      retirements.push({ reason: payload.reason, notable: entry.notable === true });
    });
    // Only the two steps that advance the clock past 5 ms miss a deadline;
    // every other invocation and reset meets its deadline under any load.
    using _clock = fakeClock();
    const resetRequested = Promise.withResolvers<void>();
    const guests = heldGuests((message) => { if (message.type === "reset") resetRequested.resolve(); });
    const service = createCodeModeService({ openWorker: guests.openWorker, limits: { timeoutMs: 5 }, pool: { maxUses: 2, resetTimeoutMs: 5 } });
    const batches = { opened: 0 };
    // A timeout retires the first Worker.
    const timingOut = service.run(invocation(batches), context("a"));
    await settle();
    const timedOut = guests.opened[0];
    const timedOutClosed = terminated(timedOut);
    jest.advanceTimersByTime(5);
    await timedOutClosed;
    expect((await timingOut).outcome).toBe("error");
    expect(timedOut?.terminated).toBe(true);

    // A Worker that misses its reset confirmation retires too.
    const reused = service.run(invocation(batches), context("a"));
    await settle();
    const silent = guests.opened[1];
    if (silent) silent.answersReset = false;
    const silentClosed = terminated(silent);
    answer(silent, "kept nothing");
    await resetRequested.promise;
    jest.advanceTimersByTime(5);
    await silentClosed;
    expect(await reused).toEqual({ outcome: "ok", content: "kept nothing" });
    expect(silent?.terminated).toBe(true);

    // A Worker that served its last allowed use retires without a reset.
    const once = service.run(invocation(batches), context("a"));
    await settle();
    const spent = guests.opened[2];
    answer(spent, "once");
    expect(await once).toEqual({ outcome: "ok", content: "once" });
    const twice = service.run(invocation(batches), context("a"));
    await settle();
    const spentClosed = terminated(spent);
    answer(guests.opened.at(-1), "twice");
    await spentClosed;
    expect(await twice).toEqual({ outcome: "ok", content: "twice" });
    expect(guests.opened).toHaveLength(3);
    expect(spent?.terminated).toBe(true);

    const next = service.run(invocation(batches), context("a"));
    await settle();
    expect(guests.opened).toHaveLength(4);
    // Each retired Worker received nothing after the invocation that retired it.
    expect(guests.opened.slice(0, 3).map((worker) => worker.hostMessages.map(({ type }) => type))).toEqual([
      ["start"],
      ["start", "reset"],
      ["start", "reset", "start"],
    ]);
    const fresh = guests.opened[3];
    answer(fresh, "fresh");
    expect(await next).toEqual({ outcome: "ok", content: "fresh" });
    const freshClosed = terminated(fresh);
    const disposal = service.dispose();
    await freshClosed;
    await disposal;
    // Only the failed reset is a fault that reaches the default log level.
    expect(retirements).toEqual([
      { reason: "timeout", notable: false },
      { reason: "reset-failed", notable: true },
      { reason: "used-up", notable: false },
      { reason: "closed", notable: false },
    ]);
  });

  it("retires every idle Worker after the idle period and opens a new one on the next call", async () => {
    const guests = heldGuests();
    const service = createCodeModeService({ openWorker: guests.openWorker, pool: { idleMs: 5 } });
    const batches = { opened: 0 };
    const runs = ["a", "b"].map((session) => service.run(invocation(batches), context(session)));
    await settle();
    for (const worker of guests.opened) answer(worker, "done");
    await Promise.all(runs);
    expect(guests.opened.map((worker) => worker.terminated)).toEqual([false, false]);

    await Bun.sleep(20);
    expect(guests.opened.map((worker) => worker.terminated)).toEqual([true, true]);
    const restarted = service.run(invocation(batches), context("a"));
    await settle();
    expect(guests.opened).toHaveLength(3);
    answer(guests.opened[2], "restarted");
    expect(await restarted).toEqual({ outcome: "ok", content: "restarted" });
    await service.dispose();
    expect(guests.opened[2]?.terminated).toBe(true);
  });

  it("removes a call aborted while it waits before any batch or Worker exists", async () => {
    const guests = heldGuests();
    const service = createCodeModeService({ openWorker: guests.openWorker });
    const batches = { opened: 0 };
    const running = ["a", "b", "c", "d"].map((session) => service.run(invocation(batches), context(session)));
    const controller = new AbortController();
    const queued = service.run(invocation(batches), context("e", controller.signal));
    await settle();
    controller.abort();
    await expect(queued).rejects.toBeDefined();
    expect({ workers: guests.opened.length, batches: batches.opened }).toEqual({ workers: 4, batches: 4 });

    for (const worker of guests.opened) answer(worker, "done");
    await Promise.all(running);
    expect(guests.opened).toHaveLength(4);
    // An undisposed service keeps its idle Workers and their retirement
    // timers, which fire inside a later file of the same test process.
    await service.dispose();
  });

  it("rejects queued calls when admission closes, and disposal waits for running invocations to clean up", async () => {
    const guests = heldGuests();
    const service = createCodeModeService({ openWorker: guests.openWorker });
    const batches = { opened: 0 };
    const controllers = ["a", "b", "c", "d"].map(() => new AbortController());
    const running = controllers.map((controller, index) => service.run(invocation(batches), context(`s${index}`, controller.signal)).then((result) => result.outcome));
    const queued = service.run(invocation(batches), context("e"));
    await settle();

    let disposed = false;
    const disposal = Promise.resolve(service.dispose()).then(() => { disposed = true; });
    await expect(queued).rejects.toThrow("Code Mode is shutting down");
    await expect(service.run(invocation(batches), context("late"))).rejects.toThrow("Code Mode is shutting down");
    await settle();
    expect(disposed).toBe(false);

    // Shutdown aborts every running tool's signal; disposal then waits for each scope.
    for (const controller of controllers) controller.abort();
    await disposal;
    expect(await Promise.all(running)).toEqual(["interrupted", "interrupted", "interrupted", "interrupted"]);
    expect(guests.opened.every((worker) => worker.terminated)).toBe(true);
    expect(batches.opened).toBe(4);
  });
});
