import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { createNestedToolDispatchBatch } from "../../../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import { createToolConcurrencyGate } from "../../../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import { boundedStringCodeModeOutput, type RuntimeTool, type ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { HostMessage } from "../../../../../src/orchestration/modules/code-mode/invocation-protocol.js";
import type { InvocationWorker } from "../../../../../src/orchestration/modules/code-mode/worker-pool.js";
import type { CodeModeLimits } from "../../../../../src/orchestration/modules/code-mode/limits.js";
import { codeModeServices, codeToolOver, InProcessInvocationWorker, scriptedWorker, workerLog, type FakeWorker } from "../../../../helpers/code-mode-worker.js";

const codeModeService = codeModeServices();

interface InterruptionOptions {
  readonly signal?: AbortSignal;
  readonly limits?: Partial<CodeModeLimits>;
  readonly openWorker?: () => InvocationWorker;
  /** Makes every batch close die after its join, as a failed terminal publication does. */
  readonly failClose?: boolean;
}

function interruptionFixture(execute: RuntimeTool["execute"], options: InterruptionOptions = {}) {
  const nested: RuntimeTool = {
    name: "slow",
    action: "file_read",
    description: "slow fixture",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    codeMode: "exclusive",
    codeModeOutput: boundedStringCodeModeOutput,
    isConcurrencySafe: true,
    execute,
  };
  const eligibleTools = new Map([[nested.name, nested]]);
  const outputs: string[] = [];
  const context: ToolContext = {
    executionCwd: process.cwd(), userDataRoot: "/scratch/test-account", projectRoot: process.cwd(), artifactScopeId: "session", sessionId: "session", toolUseId: "outer",
    retrievalSessionId: "session",
    ...(options.signal ? { signal: options.signal } : {}),
    onExecutionOutput: (output) => { outputs.push(output); },
  };
  const terminals: string[] = [];
  const batches = { opened: 0, closed: 0 };
  context.createNestedToolDispatchBatch = (batchOptions) => {
    batches.opened++;
    const batch = createNestedToolDispatchBatch({
      ...batchOptions, context, gate: createToolConcurrencyGate(10),
      executionAdmission: () => ({ ok: true }),
      publisher: {
        input: () => {}, validation: () => {}, output: () => {},
        result: (_call, result) => { terminals.push(result.outcome); },
      },
    });
    return {
      ...batch,
      close: () => batch.close().pipe(
        Effect.tap(() => Effect.sync(() => { batches.closed++; })),
        Effect.andThen(options.failClose ? Effect.die(new Error("terminal publication failed")) : Effect.void),
      ),
    };
  };
  const service = codeModeService({ limits: { timeoutMs: 1_000, ...options.limits }, ...(options.openWorker ? { openWorker: options.openWorker } : {}) });
  return { tool: codeToolOver(eligibleTools, service), context, terminals, outputs, batches };
}

function untilAborted(context: ToolContext): Promise<void> {
  return new Promise<void>((resolve) => {
    if (context.signal?.aborted) resolve();
    else context.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A guest that logs one line, calls `slow`, and then never sends again. */
function unresponsiveGuest(): FakeWorker {
  return scriptedWorker((message: HostMessage, worker) => {
    if (message.type !== "start") return;
    worker.send({ type: "log", lines: ["before the call"] });
    worker.send({ type: "call", id: 0, name: "slow", input: {} });
  });
}

describe("code tool interruption", () => {
  it("flushes the final dirty console prefix once on pure interruption", async () => {
    const controller = new AbortController();
    const workers = workerLog(() => new InProcessInvocationWorker());
    const run = interruptionFixture(async () => ({ content: "unused", outcome: "ok" }), { signal: controller.signal, openWorker: workers.openWorker });
    const outer = run.tool.execute({
      source: `console.log("dirty-tail"); while (true) {}`,
    }, run.context);
    await Promise.resolve();
    await workers.opened[0]?.posted("log");
    controller.abort();
    expect((await outer).outcome).toBe("interrupted");
    expect(run.outputs).toEqual(["dirty-tail"]);
    expect(run.terminals).toEqual([]);
    expect(workers.opened[0]?.terminated).toBe(true);
  });

  it("waits for an aborted child Promise to settle before the outer call answers, and names it in the answer", async () => {
    const started = Promise.withResolvers<void>();
    const observedAbort = Promise.withResolvers<void>();
    const releaseSettlement = Promise.withResolvers<void>();
    const controller = new AbortController();
    const run = interruptionFixture(async (_input, context) => {
      started.resolve();
      await untilAborted(context);
      observedAbort.resolve();
      await releaseSettlement.promise;
      return { content: "child finalizer", outcome: "interrupted" };
    }, { signal: controller.signal });

    let outerSettled = false;
    const outer = run.tool.execute({ source: "return await tools.slow({})" }, run.context).finally(() => { outerSettled = true; });
    await started.promise;
    controller.abort();
    await observedAbort.promise;
    await Promise.resolve();
    expect(outerSettled).toBe(false);
    expect(run.terminals).toEqual([]);

    releaseSettlement.resolve();
    const result = await outer;
    expect(outerSettled).toBe(true);
    expect(run.terminals).toEqual(["interrupted"]);
    // The interrupt is an ending like any other: the result names the call it left running.
    expect(result.outcome).toBe("interrupted");
    expect(result.content).toContain("Execution was interrupted by the user.");
    expect(result.content).toEndWith("\nCalls still running when the program ended, whose effects may have completed: slow. Check their effects before you run them again.");
  });

  it("aborts and joins the actual batch when the Worker can no longer send, before the outer call settles", async () => {
    const started = Promise.withResolvers<void>();
    const releaseSettlement = Promise.withResolvers<void>();
    const controller = new AbortController();
    const workers = workerLog(unresponsiveGuest);
    const run = interruptionFixture(async (_input, context) => {
      started.resolve();
      await untilAborted(context);
      await releaseSettlement.promise;
      return { content: "child finalizer", outcome: "interrupted" };
    }, { signal: controller.signal, openWorker: workers.openWorker });

    let outerSettled = false;
    const outer = run.tool.execute({ source: "unused by the scripted guest" }, run.context).finally(() => { outerSettled = true; });
    await started.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const worker = workers.opened[0];
    expect(worker?.terminated).toBe(true);
    expect(worker?.listeners("message")).toBe(0);
    expect(outerSettled).toBe(false);
    expect(run.terminals).toEqual([]);

    releaseSettlement.resolve();
    expect((await outer).outcome).toBe("interrupted");
    expect(run.terminals).toEqual(["interrupted"]);
    expect(run.batches).toEqual({ opened: 1, closed: 1 });
    expect(run.outputs).toEqual(["before the call\n-> tools.slow {}"]);
    worker?.dispatchEvent(new MessageEvent("message", { data: { type: "log", lines: ["after settlement"] } }));
    expect(run.outputs).toEqual(["before the call\n-> tools.slow {}"]);
  });

  it("closes the batch exactly once and retires the Worker on timeout, guest failure, and outer abort, even when publication fails", async () => {
    const triggers = {
      timeout: { openWorker: () => scriptedWorker(), limits: { timeoutMs: 5 } },
      "guest failure": {
        openWorker: () => scriptedWorker((message, worker) => {
          if (message.type === "start") worker.send({ type: "result", outcome: "error", text: "Execution exceeded the 8-byte heap growth budget.", ending: "heap-limit" });
        }),
        limits: {},
      },
      abort: { openWorker: () => scriptedWorker(), limits: {} },
    } as const;
    for (const [name, trigger] of Object.entries(triggers)) {
      const controller = new AbortController();
      const workers = workerLog(trigger.openWorker);
      const run = interruptionFixture(async () => ({ content: "unused", outcome: "ok" }), { signal: controller.signal, failClose: true, limits: trigger.limits, openWorker: workers.openWorker });
      const outer = run.tool.execute({ source: "unused by the scripted guest" }, run.context);
      if (name === "abort") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();
      }
      await expect(outer, name).rejects.toThrow("terminal publication failed");
      expect(run.batches, name).toEqual({ opened: 1, closed: 1 });
      // None of these endings leaves a guest a reset may clear.
      expect(workers.opened.map((worker) => ({ terminated: worker.terminated, reset: worker.hostMessages.some(({ type }) => type === "reset") })), name).toEqual([{ terminated: true, reset: false }]);
    }
  });

  it("reports a Worker that cannot start, spends no second spawn, and still closes the batch", async () => {
    const workers = workerLog((): InvocationWorker => { throw new Error("native allocation failed"); });
    const run = interruptionFixture(async () => ({ content: "unused", outcome: "ok" }), { openWorker: workers.openWorker });
    let attempts = 0;
    const result = await run.tool.execute({ source: "return 1" }, { ...run.context, createNestedToolDispatchBatch: (options) => {
      attempts++;
      // SAFETY: the fixture always installs a batch factory.
      return run.context.createNestedToolDispatchBatch!(options);
    } });
    expect(result).toEqual({ outcome: "error", content: "Code runtime could not start: native allocation failed" });
    expect(attempts).toBe(1);
    expect(run.batches).toEqual({ opened: 1, closed: 1 });
  });

  it("fails the invocation when its Worker errors or ends before it answers", async () => {
    const errored = interruptionFixture(async () => ({ content: "unused", outcome: "ok" }), {
      openWorker: () => scriptedWorker((message, worker) => {
        if (message.type === "start") setImmediate(() => worker.dispatchEvent(new ErrorEvent("error", { message: "guest crashed" })));
      }),
    });
    expect(await errored.tool.execute({ source: "unused" }, errored.context)).toEqual({ outcome: "error", content: "Code runtime failed: guest crashed" });

    const ended = interruptionFixture(async () => ({ content: "unused", outcome: "ok" }), {
      openWorker: () => scriptedWorker((message, worker) => {
        if (message.type === "start") setImmediate(() => worker.terminate());
      }),
    });
    expect(await ended.tool.execute({ source: "unused" }, ended.context)).toEqual({ outcome: "error", content: "Code runtime failed: its Worker ended before it answered." });
  });

  it("interrupts and settles nested work when heap growth exceeds the budget", async () => {
    const started = Promise.withResolvers<void>();
    const observedAbort = Promise.withResolvers<void>();
    const run = interruptionFixture(async (_input, context) => {
      started.resolve();
      await untilAborted(context);
      observedAbort.resolve();
      return { content: "child finalizer", outcome: "interrupted" };
    }, {
      limits: { timeoutMs: 10_000, maxHeapDeltaBytes: 8 * 1024 * 1024, heapSampleMs: 5 },
      // The in-process guest shares this test process's heap, and it takes
      // its baseline when it starts. Garbage that earlier tests left would sit
      // in that baseline, and a collection during the guest's allocations
      // would then hide its growth. A real Worker starts on an empty heap of
      // its own, so collect first to give the guest the same baseline.
      openWorker: () => {
        Bun.gc(true);
        return new InProcessInvocationWorker();
      },
    });

    // The guest awaits the never-settling child after allocating past the
    // budget, so the heap watchdog deterministically wins the race instead of
    // depending on sample timing against a finishing program. The allocations
    // hold the event loop for hundreds of milliseconds on a loaded host, so the
    // execution timeout sits far beyond them: this test measures the watchdog,
    // never the timeout.
    const outer = run.tool.execute({
      source: `const child = tools.slow({}); await Promise.resolve(); const held = []; for (let index = 0; index < 6; index++) { held.push(JSON.stringify("x".repeat(10 * 1024 * 1024))); await Promise.resolve(); } await child; return held.length`,
    }, run.context);
    await started.promise;
    const result = await outer;
    await observedAbort.promise;
    expect(result.outcome).toBe("error");
    expect(result.content).toBe("Execution exceeded the 8388608-byte heap growth budget. Keep heavy computation in Bash scratch scripts.\nCalls still running when the program ended, whose effects may have completed: slow. Check their effects before you run them again.");
    expect(run.terminals).toEqual(["interrupted"]);
  });

  it("opens no batch and no Worker for an already aborted signal", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const workers = workerLog(() => new InProcessInvocationWorker());
    const run = interruptionFixture(async () => {
      calls += 1;
      return { content: "unexpected", outcome: "ok" };
    }, { signal: controller.signal, openWorker: workers.openWorker });

    await expect(run.tool.execute({ source: "return await tools.slow({})" }, run.context)).rejects.toBeDefined();
    expect(calls).toBe(0);
    expect(run.terminals).toEqual([]);
    expect(run.batches).toEqual({ opened: 0, closed: 0 });
    expect(workers.opened).toEqual([]);
  });

  it("leaves the program to its own deadline while a nested call reports progress past the dispatcher watchdog", async () => {
    const run = interruptionFixture(async (_input, context) => {
      for (let tick = 0; tick < 8; tick++) {
        await Bun.sleep(10);
        context.onExecutionOutput?.(`tick ${tick}`);
      }
      return { content: "finished", outcome: "ok" };
    });
    // As in the agent loop, the batch publishes nested progress through the
    // context the dispatcher received, not the one it wraps for the program.
    const prepared = prepareToolCall({ id: "outer", name: "code", input: { source: "return (await tools.slow({})).content" } }, new Map([["code", run.tool]]), { ok: true });
    const result = await executePreparedTool(prepared, run.context, { watchdogMs: 30 });
    expect(result).toEqual({ outcome: "ok", content: "finished" });
  });

  it("keeps a child interruption branchable when the outer program is live", async () => {
    const run = interruptionFixture(async () => ({ content: "stopped", outcome: "interrupted" }));
    const result = await run.tool.execute({ source: "const child = await tools.slow({}); return child.outcome === 'interrupted' ? 'handled' : 'missed'" }, run.context);
    expect(result.outcome).toBe("ok");
    expect(result.content).toBe("handled");
    expect(run.terminals).toEqual(["interrupted"]);
  });
});
