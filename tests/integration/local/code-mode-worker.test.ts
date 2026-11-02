/**
 * Live proof of the Code Mode invocation Worker (EXS-2). Real Bun Workers run
 * the guest. The module's production `code` tool and process service own each
 * invocation. The real nested-dispatch batch publishes every nested terminal
 * through a durable SQLite fact writer, and MCP calls cross production
 * `createMcpConnection` to a loopback server. Unit tests prove the protocol
 * and the cleanup order with an in-process guest. Only real threads prove
 * where the work runs and how long cleanup takes.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { join } from "node:path";
import { asAsyncEventWriter } from "../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js";
import { installedModules } from "../../../src/orchestration/module-catalog.js";
import { createNestedToolDispatchBatch, createNestedToolFactPublisher } from "../../../src/orchestration/agent-runtime/tools/nested-tool-dispatch.js";
import { createToolConcurrencyGate } from "../../../src/orchestration/agent-runtime/tools/tool-concurrency-gate.js";
import { boundedStringCodeModeOutput, type RuntimeTool, type ToolContext, type ToolResult } from "../../../src/orchestration/agent-runtime/tools/types.js";
import { spawnInvocationWorker } from "../../../src/orchestration/modules/code-mode/worker-pool.js";
import type { CodeModeLimits } from "../../../src/orchestration/modules/code-mode/limits.js";
import { createCodeModeService, type CodeModeService } from "../../../src/orchestration/modules/code-mode/service.js";
import { createMcpNestedTool } from "../../../src/orchestration/modules/mcp/nested-tool.js";
import { createSessionFactWriter } from "../../../src/orchestration/session/session-fact-writer.js";
import { startLoopbackMcpServer, type LoopbackMcpServer } from "../../helpers/code-mode-loopback-mcp.js";
import { codeToolOver } from "../../helpers/code-mode-worker.js";
import { temporaryDirectories } from "../../helpers/directories.js";

/** The EXS-2 ceilings from the approved plan. */
const HOST_GAP_CEILING_MS = 50;
const INTERRUPT_CEILING_MS = 250;
/** A soft budget small enough to cross quickly, far below the 512 MiB default. */
const TEST_HEAP_BUDGET_BYTES = 64 * 1024 * 1024;

const directories = temporaryDirectories();
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Runs `work` while a 1 ms host interval records the longest gap between
 *  its ticks, including the interval still open when the work settles. */
async function hostTimerGap<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly gapMs: number }> {
  let previous = performance.now();
  let gapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - previous);
    previous = now;
  }, 1);
  try {
    const value = await work();
    gapMs = Math.max(gapMs, performance.now() - previous);
    return { value, gapMs };
  } finally {
    clearInterval(timer);
  }
}

/** Settles when `signal` aborts or after `ms`, whichever comes first. */
async function holdUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const ended = AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
  if (!ended.aborted) await once(ended, "abort");
}

interface Terminal {
  readonly name: string;
  readonly outcome: ToolResult["outcome"];
  /** When the durable writer acknowledged the terminal fact. */
  readonly at: number;
}

interface LiveFixture {
  readonly mcp: LoopbackMcpServer;
  readonly service: CodeModeService;
  readonly code: RuntimeTool;
  readonly terminals: Terminal[];
  /** When each Worker the service opened fired `close`, by opening order. */
  readonly workerClosedAt: (number | undefined)[];
  /** The heap baseline each confirmed reset reported, in order. */
  readonly resetHeapBytes: number[];
  /** The most Workers that were open at one time. */
  maxOpenWorkers(): number;
  context(session: string, options?: { readonly signal?: AbortSignal; readonly output?: (text: string) => void }): ToolContext;
}

/** A host tool a script can call. */
function hostTool(name: string, execute: RuntimeTool["execute"]): RuntimeTool {
  return {
    name,
    action: "file_read",
    description: `${name} fixture`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    codeMode: "exclusive",
    codeModeOutput: boundedStringCodeModeOutput,
    isConcurrencySafe: true,
    execute,
  };
}

async function liveFixture(options: { readonly limits?: Partial<CodeModeLimits>; readonly hostTools?: readonly RuntimeTool[] } = {}): Promise<LiveFixture> {
  // The executor composes its module catalog before any tool runs. The test
  // realm loads it on the first read, so read it here, outside every measurement.
  installedModules();
  const mcp = startLoopbackMcpServer();
  cleanups.push(() => mcp.close());
  const ports = await mcp.connect();
  const store = createSqliteEventStore(join(directories("code-mode-worker-"), "events.sqlite"));
  cleanups.push(async () => store.close());
  const terminals: Terminal[] = [];
  const workerClosedAt: (number | undefined)[] = [];
  const resetHeapBytes: number[] = [];
  let openWorkers = 0;
  let maxOpenWorkers = 0;
  const service = createCodeModeService({
    ...(options.limits ? { limits: options.limits } : {}),
    openWorker: () => {
      const worker = spawnInvocationWorker();
      const index = workerClosedAt.push(undefined) - 1;
      maxOpenWorkers = Math.max(maxOpenWorkers, ++openWorkers);
      worker.addEventListener("close", () => {
        openWorkers--;
        workerClosedAt[index] = performance.now();
      });
      worker.addEventListener("message", (event) => {
        if (event.data.type === "ready") resetHeapBytes.push(event.data.heapBytes);
      });
      return worker;
    },
  });
  cleanups.push(async () => { await service.dispose(); });
  const eligible = new Map<string, RuntimeTool>();
  for (const hit of ports.tools()) {
    const tool = createMcpNestedTool(ports, hit);
    eligible.set(tool.name, tool);
  }
  for (const tool of options.hostTools ?? []) eligible.set(tool.name, tool);
  const gate = createToolConcurrencyGate(10);

  return {
    mcp,
    service,
    code: codeToolOver(eligible, service),
    terminals,
    workerClosedAt,
    resetHeapBytes,
    maxOpenWorkers: () => maxOpenWorkers,
    context(session, contextOptions = {}) {
      const context: ToolContext = {
        executionCwd: process.cwd(), userDataRoot: "/scratch/test-account", projectRoot: process.cwd(), artifactScopeId: session, sessionId: session, toolUseId: `outer-${session}`,
        retrievalSessionId: session,
        modelRequestId: `request-${session}`,
        sessionEventWriter: createSessionFactWriter({ sessionId: session, writer: asAsyncEventWriter(store) }),
        ...(contextOptions.signal ? { signal: contextOptions.signal } : {}),
        ...(contextOptions.output ? { onExecutionOutput: contextOptions.output } : {}),
      };
      const durable = createNestedToolFactPublisher(context);
      context.createNestedToolDispatchBatch = (batchOptions) => createNestedToolDispatchBatch({
        ...batchOptions, context, gate,
        executionAdmission: () => ({ ok: true }),
        publisher: {
          ...durable,
          result: async (call, result, meta) => {
            await durable.result(call, result, meta);
            terminals.push({ name: call.name, outcome: result.outcome, at: performance.now() });
          },
        },
      });
      return context;
    },
  };
}

/** Starts one outer `code` call that the test interrupts. `ready` settles
 *  once the guest has published `marker` through the host log mirror. */
function interruptible(fixture: LiveFixture, session: string, source: string, marker: string) {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  const context = fixture.context(session, {
    signal: controller.signal,
    output: (text) => { if (text.includes(marker)) ready.resolve(); },
  });
  let settledAt: number | undefined;
  const outer = fixture.code.execute({ source }, context).finally(() => { settledAt = performance.now(); });
  return {
    ready: ready.promise,
    /** Aborts the outer call and returns when the abort was dispatched. */
    interrupt(): number {
      const dispatchedAt = performance.now();
      controller.abort();
      return dispatchedAt;
    },
    outer,
    settledAt: () => settledAt,
  };
}

describe("Code Mode invocation Worker", () => {
  it("parses an 8 MB MCP result in the Worker while host timers keep running", async () => {
    const fixture = await liveFixture();
    const source = "const result = await tools.loop.large({}); return { outcome: result.outcome, items: result.content.length, last: result.content.at(-1).index }";
    const { value, gapMs } = await hostTimerGap(() => fixture.code.execute({ source }, fixture.context("large")));
    expect(value.outcome).toBe("ok");
    expect(JSON.parse(String(value.content))).toEqual({ outcome: "ok", items: fixture.mcp.largeItemCount, last: fixture.mcp.largeItemCount - 1 });
    expect(fixture.terminals.map(({ name, outcome }) => ({ name, outcome }))).toEqual([{ name: "loop.large", outcome: "ok" }]);
    expect(gapMs).toBeLessThanOrEqual(HOST_GAP_CEILING_MS);
  }, 30_000);

  it("runs at most four invocations at once on four reused Workers and closes them at disposal", async () => {
    const fixture = await liveFixture();
    const source = "const result = await tools.loop.large({}); return result.content.length";
    const jobs = Array.from({ length: 12 }, (_, index) => fixture.code.execute({ source }, fixture.context(`capacity-${index % 3}`)));
    const results = await Promise.all(jobs);
    expect(results).toEqual(Array.from({ length: 12 }, () => ({ outcome: "ok", content: String(fixture.mcp.largeItemCount) })));
    expect(fixture.maxOpenWorkers()).toBe(4);
    expect(fixture.workerClosedAt).toEqual([undefined, undefined, undefined, undefined]);
    expect(fixture.terminals.filter(({ outcome }) => outcome === "ok")).toHaveLength(12);
    await fixture.service.dispose();
    expect(fixture.workerClosedAt.every((closedAt) => closedAt !== undefined)).toBe(true);
  }, 30_000);

  it("runs the next invocation on the same Worker with nothing of the previous one and from the collected baseline", async () => {
    const hold = hostTool("hold", async (_input, context) => {
      await holdUnlessAborted(20_000, context.signal);
      return { outcome: "ok", content: "stale reply" };
    });
    const echo = hostTool("echo", async () => ({ outcome: "ok", content: "fresh reply" }));
    const fixture = await liveFixture({ limits: { maxHeapDeltaBytes: TEST_HEAP_BUDGET_BYTES }, hostTools: [hold, echo] });
    // Each array of 300,000 parsed objects takes about 40 MiB of this
    // Worker's heap, so two of them together exceed the 64 MiB budget. The
    // last program passes only if it is not charged the garbage of the one
    // before it. (Bun does not count a large array of numbers in `heapUsed`,
    // so the garbage is objects.)
    const items = 300_000;
    const allocate = `JSON.parse("[" + "{\\"text\\":\\"left behind\\"},".repeat(${items}) + "{}]")`;
    expect(await fixture.code.execute({ source: "return 1" }, fixture.context("isolation"))).toEqual({ outcome: "ok", content: "1" });
    const leaving = [
      `var leakedVar = "var"; let leakedLet = "let"; function leakedFn() { return "fn" }`,
      `console.log("line of the first program")`,
      `new Promise(() => {})`,
      `tools.hold({})`,
      `const garbage = ${allocate}`,
      `return garbage.length`,
    ].join("\n");
    expect(await fixture.code.execute({ source: leaving }, fixture.context("isolation"))).toEqual({ outcome: "ok", content: `${items + 1}\n\nLogs:\nline of the first program\nCalls still running when the program ended, whose effects may have completed: hold. Check their effects before you run them again.` });
    const outputs: string[] = [];
    const probing = [
      `const probe = (read) => { try { return typeof read() } catch { return "unavailable" } }`,
      `const names = { leakedVar: probe(() => leakedVar), leakedLet: probe(() => leakedLet), leakedFn: probe(() => leakedFn), garbage: probe(() => garbage),`,
      `  globalThis: probe(() => globalThis), self: probe(() => self), process: probe(() => process), Bun: probe(() => Bun),`,
      `  setTimeout: probe(() => setTimeout), postMessage: probe(() => postMessage), onmessage: probe(() => onmessage) }`,
      `const echoed = await tools.echo({})`,
      `return { names, echoed: echoed.content, allocated: ${allocate}.length }`,
    ].join("\n");
    const probed = await fixture.code.execute({ source: probing }, fixture.context("isolation", { output: (text) => outputs.push(text) }));
    expect(probed.outcome).toBe("ok");
    expect(JSON.parse(String(probed.content))).toEqual({
      names: Object.fromEntries(["leakedVar", "leakedLet", "leakedFn", "garbage", "globalThis", "self", "process", "Bun", "setTimeout", "postMessage", "onmessage"].map((name) => [name, "unavailable"])),
      echoed: "fresh reply",
      allocated: items + 1,
    });
    // The console carries only the nested row of this program's own call.
    expect(outputs).toEqual(["-> tools.echo {}"]);
    // One Worker served all three programs. The call the second program left
    // pending settled, with its stale reply, before that invocation ended,
    // and its reply never reached the next program.
    expect(fixture.workerClosedAt).toEqual([undefined]);
    expect(fixture.terminals.map(({ name }) => name)).toEqual(["hold", "echo"]);
    // The resets collect the previous programs' garbage: a baseline returns
    // to within a small margin of the first, far below one 40 MiB array.
    // JavaScriptCore scans the stack conservatively, so on a loaded machine a
    // stale stack slot can keep a program's array through one reset, and a
    // later reset frees it. So the test reads the lower of the two later
    // baselines. Without the collection, both are at least 40 MiB higher.
    const [clean = 0, ...later] = fixture.resetHeapBytes;
    expect(later).toHaveLength(2);
    expect(Math.min(...later.map((heapBytes) => Math.abs(heapBytes - clean)))).toBeLessThan(4 * 1024 * 1024);
  }, 30_000);

  it("does not charge a host allocation to the guest's heap budget", async () => {
    let hostGrowthBytes = 0;
    const allocate = hostTool("allocate", async (_input, context) => {
      const before = process.memoryUsage().heapUsed;
      // Four times the guest budget. The reported heap lags an allocation
      // until the collector runs, so hold it until this thread reports the
      // growth, then across eight more guest samples.
      const retained = Array.from({ length: TEST_HEAP_BUDGET_BYTES / 2 }, () => 1.5);
      while (hostGrowthBytes <= TEST_HEAP_BUDGET_BYTES && context.signal?.aborted !== true) {
        await holdUnlessAborted(25, context.signal);
        hostGrowthBytes = Math.max(hostGrowthBytes, process.memoryUsage().heapUsed - before);
      }
      await holdUnlessAborted(200, context.signal);
      return { outcome: "ok", content: `held ${retained.length}` };
    });
    const fixture = await liveFixture({ limits: { maxHeapDeltaBytes: TEST_HEAP_BUDGET_BYTES }, hostTools: [allocate] });
    const result = await fixture.code.execute({ source: "const held = await tools.allocate({}); return held.content" }, fixture.context("host-heap"));
    // The allocation really grew this thread's heap past the guest budget.
    expect(hostGrowthBytes).toBeGreaterThan(TEST_HEAP_BUDGET_BYTES);
    expect(result).toEqual({ outcome: "ok", content: `held ${TEST_HEAP_BUDGET_BYTES / 2}` });
  }, 30_000);

  it("charges a surviving guest allocation to its own invocation, not to a sibling", async () => {
    // The allocating program holds its array until its own sampler trips,
    // which ends the hold. The sibling holds until that invocation settled,
    // so its sampler runs across the whole life of the allocation.
    const allocatingSettled = Promise.withResolvers<void>();
    const hold = hostTool("hold", async (_input, context) => {
      await holdUnlessAborted(20_000, context.signal);
      return { outcome: "ok", content: "held" };
    });
    const outlast = hostTool("outlast", async (_input, context) => {
      await allocatingSettled.promise;
      await holdUnlessAborted(200, context.signal);
      return { outcome: "ok", content: "outlasted" };
    });
    const fixture = await liveFixture({ limits: { maxHeapDeltaBytes: TEST_HEAP_BUDGET_BYTES }, hostTools: [hold, outlast] });
    const [allocating, sibling] = await Promise.all([
      fixture.code.execute({ source: `const big = new Array(${TEST_HEAP_BUDGET_BYTES / 2}).fill(1.5); await tools.hold({}); return big.length` }, fixture.context("allocating"))
        .finally(() => allocatingSettled.resolve()),
      fixture.code.execute({ source: "const held = await tools.outlast({}); return held.content" }, fixture.context("sibling")),
    ]);
    expect(allocating.outcome).toBe("error");
    expect(String(allocating.content)).toContain(`Execution exceeded the ${TEST_HEAP_BUDGET_BYTES}-byte heap growth budget.`);
    expect(sibling).toEqual({ outcome: "ok", content: "outlasted" });
    expect(fixture.terminals.map(({ name }) => name).toSorted()).toEqual(["hold", "outlast"]);
  }, 30_000);

  it("interrupts a computing guest within the ceiling, through Worker close and service idle", async () => {
    const fixture = await liveFixture();
    const run = interruptible(fixture, "compute", `console.log("spinning"); while (true) {}`, "spinning");
    await run.ready;
    const dispatchedAt = run.interrupt();
    expect(await run.outer).toEqual({ outcome: "interrupted", content: "Execution was interrupted by the user.\n\nLogs:\nspinning" });
    // Disposal settles only once no invocation is live, so it observes idle.
    await fixture.service.dispose();
    const idleAt = performance.now();
    expect(fixture.workerClosedAt[0] ?? Infinity).toBeLessThanOrEqual(run.settledAt() ?? -Infinity);
    expect(fixture.terminals).toEqual([]);
    expect(idleAt - dispatchedAt).toBeLessThanOrEqual(INTERRUPT_CEILING_MS);
  }, 30_000);

  it("interrupts a guest awaiting a pending MCP call within the ceiling, through host settlement and durable terminal", async () => {
    const fixture = await liveFixture();
    const run = interruptible(fixture, "pending", `console.log("calling"); return await tools.loop.pending({})`, "calling");
    await Promise.all([run.ready, fixture.mcp.pendingReceived(1)]);
    // The guest is parked on a bridge reply and receives no cancel: the host
    // terminates its Worker and closes the batch that owns the MCP request.
    const dispatchedAt = run.interrupt();
    expect(await run.outer).toEqual({ outcome: "interrupted", content: "Execution was interrupted by the user.\n\nLogs:\ncalling\nCalls still running when the program ended, whose effects may have completed: loop.pending. Check their effects before you run them again." });
    await fixture.mcp.pendingAbandoned(1);
    await fixture.service.dispose();
    const idleAt = performance.now();
    const settledAt = run.settledAt() ?? -Infinity;
    expect(fixture.workerClosedAt[0] ?? Infinity).toBeLessThanOrEqual(settledAt);
    expect(fixture.terminals.map(({ name, outcome }) => ({ name, outcome }))).toEqual([{ name: "loop.pending", outcome: "interrupted" }]);
    expect(fixture.terminals[0]?.at ?? Infinity).toBeLessThanOrEqual(settledAt);
    expect(idleAt - dispatchedAt).toBeLessThanOrEqual(INTERRUPT_CEILING_MS);
  }, 30_000);

  it("holds the outer call until a host call that ignores its abort really settles", async () => {
    const started = Promise.withResolvers<void>();
    let hostSettledAt: number | undefined;
    const stubborn = hostTool("stubborn", async () => {
      started.resolve();
      // Ignores its signal on purpose: only its own timer ends it.
      await Bun.sleep(400);
      hostSettledAt = performance.now();
      return { outcome: "ok", content: "finished anyway" };
    });
    const fixture = await liveFixture({ hostTools: [stubborn] });
    const run = interruptible(fixture, "stubborn", `console.log("calling"); return await tools.stubborn({})`, "calling");
    await Promise.all([run.ready, started.promise]);
    run.interrupt();
    expect(await run.outer).toEqual({ outcome: "interrupted", content: "Execution was interrupted by the user.\n\nLogs:\ncalling\nCalls still running when the program ended, whose effects may have completed: stubborn. Check their effects before you run them again." });
    const settledAt = run.settledAt() ?? -Infinity;
    expect(hostSettledAt ?? Infinity).toBeLessThanOrEqual(settledAt);
    expect(fixture.terminals.map(({ name }) => name)).toEqual(["stubborn"]);
    expect(fixture.terminals[0]?.at ?? Infinity).toBeLessThanOrEqual(settledAt);
    expect(fixture.workerClosedAt[0] ?? Infinity).toBeLessThanOrEqual(settledAt);
  }, 30_000);
});
