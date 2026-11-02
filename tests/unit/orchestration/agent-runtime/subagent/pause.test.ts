import { describe, expect, it } from "bun:test";
import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import type { LiveChildControl } from "../../../../../src/orchestration/session/live-session-control.js";
import type { SessionFact, SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import type { AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js";
import { createOutputSession } from "../../../../../src/orchestration/runner/output-session.js";
import type { BackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import type { BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { CommandHandoverAuthority } from "../../../../../src/orchestration/agent-runtime/command-handover.js";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { allCommandHandoversAsync, COMMAND_HANDOVER_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/command-handover.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { fakeContainer, handedOverRow, handoverAuthority } from "../_command-handover-fixtures.js";
import { makeMockOps } from "../tools/_bash-fixtures.js";
import { createNotificationCapture, makeContext, makeDeps, TEST_RATIONALE } from "./_fixtures.js";

const temporary = temporaryDirectories();

/** A dispatch whose runner holds until it is aborted, the way a held
 *  provider request does, with every seam the pause touches recorded. With
 *  `commandHandover`, its parent lends the child the executor's handover, and
 *  the child's run is `child-run`, its session `child`, and its conversation
 *  `child-conversation`. */
function heldDispatch(commandHandover?: CommandHandoverAuthority) {
  const done = Promise.withResolvers<AgentRunResult>();
  const background = Promise.withResolvers<BackgroundExecutionOwner>();
  const runningAtRequest: string[][] = [];
  const facts: SessionFact[] = [];
  const events: RuntimeEvent[] = [];
  const deactivated: string[] = [];
  let control: LiveChildControl | undefined;
  const notification = createNotificationCapture();
  const track = notification.backgroundTasks.track;
  notification.backgroundTasks.track = (work) => track({ ...work, ...(work.stall ? { stall: { ...work.stall, timeoutMs: 10 } } : {}) });
  const sessionEventWriter: SessionFactWriter = {
    record: async (fact) => { facts.push(fact); return null; },
    recordBatch: async () => null,
    recordGuarded: async () => null,
    transaction: async (fn) => { fn(); },
    dispose: () => {},
  };
  const output = createOutputSession({ updateEntry: () => {}, executionCwd: "/workspace" });
  output.applyProjectionEvent({ type: "tool-use", toolUseId: "dispatch-call", name: "subagent", input: { persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, timestamp: 1 });
  const deps = makeDeps({
    backgroundTasks: notification.backgroundTasks,
    sessionEventWriter,
    onRenderEvent: (event) => { events.push(event); output.dispatchRuntimeEvent(event); },
    ...(commandHandover ? { inheritableRuntimeSurfaces: { commandHandover } } : {}),
    createRunner: (options) => {
      runningAtRequest.push(options.runtimeSurfaces?.background?.tasks.activeBackgroundCommands().map((command) => command.id) ?? []);
      if (options.runtimeSurfaces?.background) background.resolve(options.runtimeSurfaces.background);
      return { send() { options.lifecycle.signal?.addEventListener("abort", () => done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }), { once: true }); }, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); }, done: done.promise };
    },
  });
  const ids = ["child-run", "child", "child-conversation"];
  deps.subagentSessions = {
    ...deps.subagentSessions,
    ...(commandHandover ? { allocateId: () => ids.shift() ?? crypto.randomUUID() } : {}),
    registerLiveControl: (run) => { control = run; return () => { control = undefined; }; },
    deactivate: async (childSessionId) => { deactivated.push(childSessionId); },
  };
  const tool = createSubagentDispatch(deps);
  return {
    tool,
    facts,
    events,
    deactivated,
    notification,
    output,
    runningAtRequest,
    background: background.promise,
    control: () => { if (!control) throw new Error("no live session control"); return control; },
  };
}

describe("subagent pause", () => {
  it("pauses when the supplied parent lifecycle signal aborts", async () => {
    const run = heldDispatch();
    const controller = new AbortController();
    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext({ signal: controller.signal }));
    const settled = run.control().settled;
    controller.abort();
    await settled;
    expect(run.facts.find((fact) => fact.type === "subagent.paused")?.payload).toMatchObject({ pausedBy: "runtime" });
    expect(run.facts.some((fact) => fact.type === "subagent.completed")).toBe(false);
    // An interrupted child is not active work: a notice that names the
    // runtime wakes a parent that waits, and no result reaches it.
    expect(run.notification.read()).toContain("The runtime interrupted this child.");
    run.output.dispose();
  });
  it("cuts the run, records who paused it instead of a completion, takes the child inactive, and keeps it the parent's work without a notice", async () => {
    const run = heldDispatch();
    const launched: { session_id: string } = JSON.parse((await run.tool.execute(
      { persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" },
      makeContext({ conversationId: "parent-conversation", toolUseId: "dispatch-call" }),
    )).content);
    expect(run.notification.backgroundTasks.activeSubagentCount()).toBe(1);

    await run.control().child.interrupt("person");

    expect(run.facts.map((fact) => fact.type)).toContain("subagent.paused");
    expect(run.facts.find((fact) => fact.type === "subagent.paused")?.payload).toMatchObject({ pausedBy: "person" });
    expect(run.facts.some((fact) => fact.type === "subagent.completed")).toBe(false);
    expect(run.deactivated).toEqual([launched.session_id]);
    // The parent's card learns of the pause; no result reaches the parent.
    expect(run.events.some((event) => event.type === "agent.subagent.paused" && event.data.paused_by === "person")).toBe(true);
    expect(run.events.some((event) => event.type === "tool.result.available")).toBe(false);
    expect(run.output.getBlocks().find((block) => block.kind === "agentGroup")).toMatchObject({ status: "paused", pausedBy: "person" });
    // A person's interrupt does not change what the parent waits on: the
    // child stays its active work, and no notice reaches it.
    expect(run.notification.backgroundTasks.activeSubagentCount()).toBe(1);
    expect(run.notification.backgroundTasks.awaitedTaskCount()).toBe(1);
    expect(run.notification.read()).toBe("");
    run.output.dispose();
  });

  it("the runtime's pause at a planned shutdown is the same operation with its own name", async () => {
    const run = heldDispatch();
    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext({ conversationId: "parent-conversation", toolUseId: "dispatch-call" }));
    await run.control().child.interrupt("runtime");
    expect(run.facts.find((fact) => fact.type === "subagent.paused")?.payload).toMatchObject({ pausedBy: "runtime" });
    expect(run.output.getBlocks().find((block) => block.kind === "agentGroup")).toMatchObject({ status: "paused", pausedBy: "runtime" });
    run.output.dispose();
  });

  it("a planned replacement's cut tells the parent nothing, because the successor resumes the child", async () => {
    const run = heldDispatch();
    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext({ conversationId: "parent-conversation", toolUseId: "dispatch-call" }));
    await run.control().child.interrupt("replacement");
    expect(run.facts.find((fact) => fact.type === "subagent.paused")?.payload).toMatchObject({ pausedBy: "runtime" });
    expect(run.notification.backgroundTasks.awaitedTaskCount()).toBe(0);
    expect(run.notification.read()).toBe("");
    run.output.dispose();
  });

  it("the watchdog does not cut a child whose registry still awaits background work", async () => {
    const run = heldDispatch();
    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext());
    const background = await run.background;
    const work = Promise.withResolvers<BackgroundWorkResult>();
    background.tasks.track({ done: work.promise, meta: { id: "awaited", type: "subagent", description: "awaited work" } });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(run.notification.backgroundTasks.activeSubagentCount()).toBe(1);
      expect(run.facts.some((fact) => fact.type === "subagent.paused" || fact.type === "subagent.completed")).toBe(false);
    } finally {
      work.resolve({ status: "completed", content: "done" });
      await run.control().child.interrupt("person");
      run.output.dispose();
    }
  });

  it("an owner-close AbortError remains failed rather than paused", async () => {
    const run = heldDispatch();
    const controller = new AbortController();
    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext({ signal: controller.signal }));
    const background = await run.background;
    const close = background.close;
    background.close = async () => { await close(); throw new DOMException("close failed", "AbortError"); };
    const settled = run.control().settled;
    controller.abort();
    await settled;
    expect(run.facts.some((fact) => fact.type === "subagent.paused")).toBe(false);
    expect(run.facts.find((fact) => fact.type === "subagent.completed")?.payload).toMatchObject({ status: "failed" });
    expect(await run.notification.next).toContain("<status>failed</status>");
    run.output.dispose();
  });

  it("a child paused for replacement after its executor heard a handoff hands its running command over instead of ending it", async () => {
    const dir = temporary("child-command-handover-");
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir));
    const events: string[] = [];
    const container = fakeContainer(events, "handed_over");
    const run = heldDispatch(handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) }));
    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext({ conversationId: "parent-conversation", toolUseId: "dispatch-call" }));
    const background = await run.background;
    await background.shell.runBackground({
      command: "bun run dev",
      context: { executionCwd: dir, userDataRoot: `${dir}/.test-account`, projectRoot: dir, scratchDir: dir, toolUseId: "toolu_child", artifactScopeId: "child", retrievalSessionId: "child", sessionId: "child" },
      spawnOwned: async () => container.owned,
      env: {}, operations: makeMockOps(), platform: "linux", tempDir: dir,
      executionOutputThrottleMs: 5, foreground: false, rawOutput: false,
    });

    await run.control().child.interrupt("replacement");

    expect(events).toEqual([expect.stringMatching(/^handOver /)]);
    expect((await allCommandHandoversAsync(asAsyncEventReadSurface(store))).map((stored) => ({ sessionId: stored.row.sessionId, conversationId: stored.row.conversationId, toolUseId: stored.row.toolUseId })))
      .toEqual([{ sessionId: "child", conversationId: "child-conversation", toolUseId: "toolu_child" }]);
    run.output.dispose();
    store.close();
  });

  it("a child whose run's conversation holds a handed-over command adopts it before its first request", async () => {
    const dir = temporary("child-command-handover-");
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir));
    const container = fakeContainer([]);
    const row = handedOverRow(dir, { sessionId: "child", conversationId: "child-conversation" });
    store.putInFlight("child", COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row);
    const run = heldDispatch(handoverAuthority({ reader: store, writer: asAsyncEventWriter(store), heard: false, adopt: () => ({ kind: "adopted", owned: container.owned }) }));

    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext({ conversationId: "parent-conversation", toolUseId: "dispatch-call" }));
    await run.background;

    expect(run.runningAtRequest).toEqual([[row.processId]]);
    expect(store.readInFlight("child", COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([]);
    await run.control().child.interrupt("runtime");
    run.output.dispose();
    store.close();
  });

  it("a planned replacement's cut records the runtime pause but leaves the parent's card silent", async () => {
    const run = heldDispatch();
    await run.tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, makeContext({ conversationId: "parent-conversation", toolUseId: "dispatch-call" }));
    await run.control().child.interrupt("replacement");
    expect(run.facts.find((fact) => fact.type === "subagent.paused")?.payload).toMatchObject({ pausedBy: "runtime" });
    expect(run.events.some((event) => event.type === "agent.subagent.paused")).toBe(false);
    expect(run.output.getBlocks().find((block) => block.kind === "agentGroup")).not.toMatchObject({ status: "paused" });
    run.output.dispose();
  });
});
