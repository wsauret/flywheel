import { describe, expect, it, spyOn } from "bun:test";
import * as abort from "../../../../../src/infra/abort.js";
import * as os from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";
import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { createBackgroundWorkRegistry, type BackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import type { Agent, AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js";
import type { SessionFact } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { buildRegistry, createNotificationCapture, grantOf, makeCapabilityAccess, makeContext, makeDeps, TEST_RATIONALE } from "./_fixtures.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { loginWaitingRequest } from "../_login-wait-fixture.js";

const temporary = temporaryDirectories();

describe("child execution liveness and interruption", () => {
    it.each(["renewed", "stopped"] as const)("excludes a production login wait from stalling, then releases it when %s", async (answer) => {
      const request = loginWaitingRequest();
      const controller = new AbortController();
      const stop = new Error("child stopped");
      const done = Promise.withResolvers<AgentRunResult>();
      const requestFinished = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<BackgroundWorkResult>();
      const firstAbort = Promise.withResolvers<void>();
      const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
      const track = registry.track;
      let stall: Parameters<typeof track>[0]["stall"];
      let bumps = 0;
      let aborts = 0;
      let rejected: unknown;
      let requestWaiting = false;
      const waits: boolean[] = [];
      registry.track = (work) => {
        stall = work.stall;
        void work.done.then(settled.resolve);
        const watchdog = work.stall;
        const handle = track({ ...work, stall: watchdog && {
          ...watchdog, timeoutMs: 20,
          isIdle: () => requestWaiting && watchdog.isIdle(),
        } });
        return { ...handle, bump: () => { bumps += 1; handle.bump(); } };
      };
      const deps = makeDeps({
        sessionDir: temporary("child-login-wait-"),
        backgroundTasks: registry,
        keepAliveIntervalMs: 5,
        createRunner: (options) => ({
          send() {
            void request.start(controller.signal, options.lifecycle.onLoginWait).then(
              () => { requestFinished.resolve(); },
              (error) => { rejected = error; requestFinished.resolve(); done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); },
            );
          },
          end() {},
          abort() { aborts += 1; firstAbort.resolve(); controller.abort(stop); done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); },
          done: done.promise,
        }),
      });
      const originalPublish = deps.subagentSessions.publish;
      deps.subagentSessions.publish = async (...args) => {
        const published = await originalPublish(...args);
        return { ...published, projection: {
          onEvent: () => {},
          queueUserMessage: () => {},
          updateMetrics: () => {},
          updateBackgroundCommands: () => {},
          updateForegroundBash: () => {}, updateOperations: () => {},
          dispose: async () => {},
          lifecycle: { onLoginWait: (waiting: boolean) => { waits.push(waiting); } },
        } };
      };
      await createSubagentDispatch(deps).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "wait" }, makeContext());
      try {
        await request.entered;
        requestWaiting = true;
        expect(stall?.isIdle()).toBe(false);
        const before = bumps;
        await Bun.sleep(30);
        expect(bumps).toBeGreaterThan(before);
        expect(aborts).toBe(0);
        if (answer === "renewed") {
          request.renew();
          await requestFinished.promise;
          expect(request.calls()).toBe(2);
          expect(stall?.isIdle()).toBe(true);
          expect(aborts).toBe(0);
          // The real registry watchdog regains a fresh idle budget after
          // renewal: it ends the silent generation, and the stop ends the child.
          await firstAbort.promise;
          expect(aborts).toBe(1);
          expect(registry.terminate("test-tool-use")).toBe(true);
        } else {
          expect(registry.terminate("test-tool-use")).toBe(true);
          await requestFinished.promise;
          expect(rejected).toBe(stop);
          expect(request.calls()).toBe(1);
        }
        await settled.promise;
        expect(aborts).toBe(answer === "renewed" ? 2 : 1);
        expect(waits).toEqual([true, false]);
        const after = bumps;
        await Bun.sleep(20);
        expect(bumps).toBe(after);
      } finally {
        controller.abort(stop);
        done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
        await settled.promise;
      }
    });

    it("an unowned AbortError pauses without completing or notifying the parent", async () => {
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      const facts: SessionFact[] = [];
      const inactive = Promise.withResolvers<string>();

      const abortFactory = (options: AgentOptions): Agent => {
        const { promise, reject } = Promise.withResolvers<AgentRunResult>();
        return {
          send(_text: string): void {
            options.onEvent(createRuntimeEvent("model.turn.completed", {
              type: "model.turn.completed",
              subtype: "success",
              session_id: "agent-mock",
              total_cost_usd: 0.01,
              usage: { input_tokens: 50, output_tokens: 25 },
            }));
            setTimeout(() => {
              const abortError = new DOMException("The operation was aborted", "AbortError");
              reject(abortError);
            }, 0);
          },
          end() {},
          abort() {},
          done: promise,
        };
      };

      const deps = makeDeps({
        sessionDir,
        backgroundTasks: notification.backgroundTasks,
        createRunner: abortFactory,
        sessionEventWriter: {
          record: async (fact) => { facts.push(fact); return null; },
          recordBatch: async () => null,
          recordGuarded: async () => null,
          transaction: async (fn) => { fn(); },
          dispose() {},
        },
      });
      deps.subagentSessions = { ...deps.subagentSessions, deactivate: async (id) => { inactive.resolve(id); },
        reconcileParentCompletion: () => { inactive.resolve("completed"); } };
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "search" }, ctx);
      await inactive.promise;

      expect(facts.filter((fact) => fact.type === "subagent.paused").map((fact) => fact.payload)).toEqual([expect.objectContaining({ pausedBy: "runtime" })]);
      expect(facts.some((fact) => fact.type === "subagent.completed")).toBe(false);
      expect(notification.read()).toBe("");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("feeds the stall watchdog while a child tool call is in flight and stops when it resolves or the run settles", async () => {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let bumps = 0;
      const fakeRegistry = createBackgroundWorkRegistry({
        kind: "chat",
        enqueueNotification: () => {},
      });
      const track = fakeRegistry.track;
      fakeRegistry.track = (work) => {
        const handle = track(work);
        return { ...handle, bump: () => { bumps++; handle.bump(); } };
      };
      const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
      let onEvent: ((event: RuntimeEvent) => void) | undefined;
      let background: BackgroundWorkRegistry | undefined;
      let childOptions: AgentOptions | undefined;
      const factory = (options: AgentOptions): Agent => {
        childOptions = options;
        onEvent = options.onEvent;
        background = options.runtimeSurfaces?.background?.tasks;
        return { send() {}, end() {}, abort() {}, done: promise };
      };
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        createRunner: factory,
        backgroundTasks: fakeRegistry,
        keepAliveIntervalMs: 5,
      });
      const tool = createSubagentDispatch(deps);
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());
      const work = Promise.withResolvers<BackgroundWorkResult>();
      try {

      // Quiet child with no tool in flight: flat idleness, no keep-alive.
      bumps = 0;
      await delay(25);
      expect(bumps).toBe(0);

      background!.track({ done: work.promise, meta: { id: "awaited-child", type: "subagent", description: "awaited work" } });
      bumps = 0;
      const backgroundBumpedThrice = () => bumps >= 3;
      for (let attempt = 0; attempt < 500 && !backgroundBumpedThrice(); attempt++) await delay(5);
      expect(bumps).toBeGreaterThanOrEqual(3);
      work.resolve({ status: "completed", content: "done" });
      await delay(10);
      // The child's canonical save point acknowledges its completion notice.
      if (!background || background.kind !== "workflow") throw new Error("expected the child-owned workflow registry");
      const notice = childOptions?.lifecycle.inputSource?.drainPending();
      if (notice?.kind !== "message" || childOptions?.conversation.kind !== "durable-tree") throw new Error("expected child completion input");
      await childOptions.conversation.append({ kind: "user", content: notice.text, origin: "system", backgroundNotificationIds: notice.backgroundNotificationIds });
      await childOptions.conversation.flush?.();
      bumps = 0;
      await delay(30);
      expect(bumps).toBe(0);

      // A tool call in flight is activity: the keep-alive feeds the watchdog.
      // Interval slippage on a loaded machine makes a fixed window flaky, so
      // the test polls for the repeated bumps instead of counting per window.
      onEvent!(createRuntimeEvent("tool.input.completed", {
        model_request_id: "request-1",
        tool_use: {
          id: "tc1",
          name: "bash",
          provider_call_id: "call-1",
          provider_tool_name: "bash",
          executable_tool_name: "bash",
          input: {},
          execution: { mode: "foreground", trace_kind: "tool" },
        },
      }));
      bumps = 0;
      const bumpedThrice = () => bumps >= 3;
      for (let attempt = 0; attempt < 500 && !bumpedThrice(); attempt++) await delay(5);
      expect(bumps).toBeGreaterThanOrEqual(3);

      // Its result lands: back to flat idleness.
      onEvent!(createRuntimeEvent("tool.result.recorded", { tool_use_id: "tc1", content: [{ type: "text", text: "ok" }], is_error: false }));
      await delay(10);
      bumps = 0;
      await delay(30);
      expect(bumps).toBe(0);

      // A tool still in flight when the runner settles must not leak the interval.
      onEvent!(createRuntimeEvent("tool.input.completed", {
        model_request_id: "request-2",
        tool_use: {
          id: "tc2",
          name: "bash",
          provider_call_id: "call-2",
          provider_tool_name: "bash",
          executable_tool_name: "bash",
          input: {},
          execution: { mode: "foreground", trace_kind: "tool" },
        },
      }));
      resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "agent-mock", terminal: { kind: "completed" } });
      await delay(10);
      bumps = 0;
      await delay(30);
      expect(bumps).toBe(0);

      } finally {
        work.resolve({ status: "completed", content: "done" });
        resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
        await delay(10);
        rmSync(sessionDir, { recursive: true, force: true });
      }
    });

    // A command that the child launched in the background is owed work, so
    // the child that waits on it is not stalled, even while the command writes
    // nothing for longer than the watchdog's window.
    it("feeds the stall watchdog while the child's background command runs, and stops when the command ends", async () => {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let bumps = 0;
      const fakeRegistry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
      const track = fakeRegistry.track;
      fakeRegistry.track = (work) => {
        const handle = track(work);
        return { ...handle, bump: () => { bumps++; handle.bump(); } };
      };
      const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
      let options: AgentOptions | undefined;
      const sessionDir = temporary("child-command-wait-");
      const deps = makeDeps({
        sessionDir,
        createRunner: (agentOptions) => { options = agentOptions; return { send() {}, end() {}, abort() {}, done: promise }; },
        backgroundTasks: fakeRegistry,
        keepAliveIntervalMs: 5,
      });
      await createSubagentDispatch(deps).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "run it" }, makeContext());
      const background = options?.runtimeSurfaces?.background?.tasks;
      if (!background) throw new Error("every child runs with a background owner");
      const command = Promise.withResolvers<BackgroundWorkResult>();
      try {
        background.track({ done: command.promise, meta: { id: "bash-bg-1", type: "bash", description: "ssh winhost run.ps1" } });

        bumps = 0;
        const bumpedThrice = () => bumps >= 3;
        for (let attempt = 0; attempt < 500 && !bumpedThrice(); attempt++) await delay(5);
        expect(bumps).toBeGreaterThanOrEqual(3);

        command.resolve({ status: "completed", content: "done" });
        await delay(10);
        bumps = 0;
        await delay(30);
        expect(bumps).toBe(0);
      } finally {
        command.resolve({ status: "completed", content: "done" });
        resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
        await delay(10);
      }
    });

    it("closes the nested dispatch owner before the child's result reaches the parent", async () => {
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const agentRegistry = new Map(buildRegistry());
      agentRegistry.set("worker", {
        kind: "persona",
        name: "worker",
        description: "Implementation worker with scout access.",
        role: "implementer",
        tools: ["read"],
        maxTurns: 5,
        systemPrompt: "You are a worker.",
        subagentRoles: ["explorer"],
      });

      const order: string[] = [];
      const notified = Promise.withResolvers<void>();
      let childOptions: AgentOptions | undefined;
      let finishChild!: () => void;
      const createRunner = (options: AgentOptions): Agent => {
        childOptions = options;
        const done = new Promise<AgentRunResult>((resolve) => {
          finishChild = () => resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
        });
        return { send() {}, end() {}, abort() {}, done };
      };
      const deps = makeDeps({
        sessionDir,
        agentRegistry,
        createRunner,
        backgroundTasks: createBackgroundWorkRegistry({
          kind: "workflow",
          enqueueNotification: () => { order.push("parent notification"); notified.resolve(); },
        }),
      });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "worker", rationale: TEST_RATIONALE, prompt: "build it" }, makeContext());
      const childClosing = Promise.withResolvers<void>();
      const grandchildKilled = Promise.withResolvers<void>();

      const childBackground = childOptions?.runtimeSurfaces?.background;
      if (!childBackground) throw new Error("expected the granted child to receive a background owner");
      childBackground.signal.addEventListener("abort", () => childClosing.resolve(), { once: true });
      const grandchild = Promise.withResolvers<BackgroundWorkResult>();
      childBackground.tasks.track({
        done: grandchild.promise,
        meta: { id: "grandchild-1", type: "subagent", description: "nested work" },
        kill: { run: () => { order.push("grandchild killed"); grandchildKilled.resolve(); } },
      });

      finishChild();
      await childClosing.promise;
      await grandchildKilled.promise;

      expect(order).toEqual(["grandchild killed"]);
      grandchild.resolve({ status: "failed", content: "settled" });
      await notified.promise;
      expect(order).toEqual(["grandchild killed", "parent notification"]);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("reports a child's settled background command on the child's own stream", async () => {
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const agentRegistry = new Map(buildRegistry());
      agentRegistry.set("worker", { kind: "persona", name: "worker", description: "Worker.", role: "implementer", tools: ["read"], maxTurns: 5, systemPrompt: "You are a worker.", subagentRoles: ["explorer"] });
      let childOptions: AgentOptions | undefined;
      let finishChild!: () => void;
      const parentEvents: RuntimeEvent[] = [];
      const childEvents: { childSessionId: string; event: RuntimeEvent }[] = [];
      const deps = makeDeps({
        sessionDir,
        agentRegistry,
        createRunner: (options) => {
          childOptions = options;
          const done = new Promise<AgentRunResult>((resolve) => { finishChild = () => resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }); });
          return { send() {}, end() {}, abort() {}, done };
        },
        onRenderEvent: (event) => parentEvents.push(event),
        onChildRenderEvent: (childSessionId, event) => childEvents.push({ childSessionId, event }),
      });
      await createSubagentDispatch(deps).execute({ persona: "worker", rationale: TEST_RATIONALE, prompt: "build it" }, makeContext());

      const childBackground = childOptions?.runtimeSurfaces?.background;
      if (!childBackground) throw new Error("expected the granted child to receive a background owner");
      childBackground.tasks.track({
        done: Promise.resolve({ status: "completed", content: "ok", executionOutputTail: "tail" }),
        meta: { id: "bash-bg-1", type: "bash", description: "long build", toolUseId: "child-bash", modelRequestId: "child-request" },
      });
      await Bun.sleep(5);

      const recorded = (event: RuntimeEvent) => event.type === "tool.execution_output.recorded";
      expect(parentEvents.filter(recorded)).toEqual([]);
      const [childRecorded, ...extra] = childEvents.filter(({ event }) => recorded(event));
      expect(extra).toEqual([]);
      expect(childRecorded?.event.data).toEqual({ tool_use_id: "child-bash", model_request_id: "child-request", output: "tail" });

      finishChild();
      rmSync(sessionDir, { recursive: true, force: true });
    });
});

/** Records each recovery wait of the unattended policy, which lasts 5 s or
 *  more, and ends it when `release` resolves, at once by default. Shorter
 *  sleeps keep their real duration. */
function recoveryWaits(release: () => Promise<void> = async () => {}) {
  const real = abort.abortableSleep;
  const waits: number[] = [];
  const spy = spyOn(abort, "abortableSleep").mockImplementation((ms, signal) => {
    if (ms < 5_000) return real(ms, signal);
    waits.push(ms);
    return release();
  });
  return { waits, restore: () => { spy.mockRestore(); } };
}

/** A dispatch whose runs follow `script` in order, with a stall watchdog of
 *  20 ms. A run with no scripted end holds until it is aborted. The last run
 *  writes its handoff and completes. */
function scriptedDispatch(script: ReadonlyArray<AgentRunResult["terminal"] | "hold" | "complete">) {
  const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
  const track = registry.track;
  const settled = Promise.withResolvers<BackgroundWorkResult>();
  let bumps = 0;
  registry.track = (work) => {
    void work.done.then(settled.resolve);
    const handle = track({ ...work, ...(work.stall ? { stall: { ...work.stall, timeoutMs: 20 } } : {}) });
    return { ...handle, bump: () => { bumps += 1; handle.bump(); } };
  };
  const facts: SessionFact[] = [];
  const notices: unknown[] = [];
  let runs = 0;
  const deps = makeDeps({
    sessionDir: temporary("child-recovery-"),
    backgroundTasks: registry,
    keepAliveIntervalMs: 5,
    sessionEventWriter: {
      record: async (fact) => { facts.push(fact); return null; },
      recordBatch: async () => null,
      recordGuarded: async () => null,
      transaction: async (fn) => { fn(); },
      dispose() {},
    },
    createRunner: (options) => {
      const step = script[runs] ?? "complete";
      runs += 1;
      const done = Promise.withResolvers<AgentRunResult>();
      return {
        send() {
          if (step === "hold") return;
          setTimeout(() => {
            if (step === "complete") options.runtimeSurfaces?.handoff?.onContent({ summary: "done" });
            done.resolve({ servedRequests: 0, durationMs: 1, terminal: step === "complete" ? { kind: "completed" } : step });
          }, 0);
        },
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); },
        done: done.promise,
      };
    },
  });
  const publish = deps.subagentSessions.publish;
  deps.subagentSessions.publish = async (...args) => {
    const published = await publish(...args);
    const emit = published.emit;
    const observed: typeof emit = (type, payload) => {
      if (type === "agent.notice.changed") notices.push(payload);
      emit(type, payload);
    };
    return { ...published, emit: observed };
  };
  return { deps, settled: settled.promise, facts, notices, runs: () => runs, bumps: () => bumps };
}

describe("child execution recovery", () => {
  it("runs a child again after a provider fault, and the child completes", async () => {
    const waits = recoveryWaits();
    try {
      const run = scriptedDispatch([{ kind: "transient_disconnect", message: "socket closed" }, "complete"]);
      await createSubagentDispatch(run.deps).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());
      expect((await run.settled).status).toBe("completed");
      expect(run.runs()).toBe(2);
      expect(waits.waits).toEqual([5_000]);
    } finally { waits.restore(); }
  });

  it("restarts the generation each time the stall watchdog fires, and the child completes", async () => {
    const waits = recoveryWaits();
    try {
      const run = scriptedDispatch(["hold", "hold", "complete"]);
      await createSubagentDispatch(run.deps).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());
      expect((await run.settled).status).toBe("completed");
      expect(run.runs()).toBe(3);
      expect(waits.waits).toEqual([5_000, 10_000]);
      expect(run.facts.some((fact) => fact.type === "subagent.paused")).toBe(false);
    } finally { waits.restore(); }
  });

  it("holds the stall watchdog open through a capacity wait and shows the wait on the child session", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    // The released wait finds its stated time passed on the wall clock.
    const realNow = Date.now.bind(Date);
    let passed = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + passed);
    const waits = recoveryWaits(async () => { entered.resolve(); await release.promise; passed = 120_000; });
    try {
      const run = scriptedDispatch([{ kind: "api_error", message: "no capacity", recovery: { kind: "at", atMs: Date.now() + 60_000, hold: { kind: "usage_limit", stated: true } } }, "complete"]);
      await createSubagentDispatch(run.deps).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());
      await entered.promise;
      const before = run.bumps();
      await Bun.sleep(60);
      expect(run.bumps()).toBeGreaterThan(before);
      expect(run.runs()).toBe(1);
      expect(run.notices).toEqual([expect.objectContaining({ data: { operation: expect.objectContaining({ type: "upsert", notice: expect.objectContaining({ title: "Waiting for model capacity" }) }) } })]);
      release.resolve();
      expect((await run.settled).status).toBe("completed");
      expect(run.runs()).toBe(2);
      expect(run.notices.at(-1)).toEqual(expect.objectContaining({ data: { operation: expect.objectContaining({ type: "resolve" }) } }));
    } finally { release.resolve(); waits.restore(); clock.mockRestore(); }
  });

  // No person can end the wait of an unattended run, whose chat waits on the child's work (PI-AGENT-074).
  it("lets a stated usage limit stand at once as the failure of a child of an unattended run, which shows no wait", async () => {
    const waiting = Promise.withResolvers<"waiting">();
    const release = Promise.withResolvers<void>();
    const waits = recoveryWaits(async () => { waiting.resolve("waiting"); await release.promise; });
    try {
      const run = scriptedDispatch([{ kind: "api_error", message: "no capacity", recovery: { kind: "at", atMs: Date.now() + 3_600_000, hold: { kind: "usage_limit", stated: true } } }, "complete"]);
      const unattended = makeCapabilityAccess({ grant: grantOf(["subagents"]), unattended: true });
      await createSubagentDispatch(run.deps).execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext({ capabilityAccess: unattended }));
      expect(await Promise.race([run.settled.then((result) => result.status), waiting.promise])).toBe("failed");
      expect(run.runs()).toBe(1);
      expect(waits.waits).toEqual([]);
      expect(run.notices).toEqual([]);
    } finally { release.resolve(); waits.restore(); }
  });
});
