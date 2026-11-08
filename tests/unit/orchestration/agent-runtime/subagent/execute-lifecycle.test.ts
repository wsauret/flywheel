import { afterEach, describe, expect, it } from "bun:test";

import * as os from "node:os";
import * as path from "node:path";
import { rmSync } from "node:fs";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../../src/infra/runtime-event-types.js";
import { childTask, createNotificationCapture, grantOf, makeCapabilityAccess, makeContext, makeDeps, makeMockRunnerFactory, refusedAdmission, settleDispatchedWork, TEST_RATIONALE } from "./_fixtures.js";
import type { Agent, AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js";
import { createOutputSession } from "../../../../../src/orchestration/runner/output-session.js";
import type { SessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { isRecord, type UnknownRecord } from "../../../../../src/infra/record.js";
import type { ResolvedRoles } from "../../../../../src/orchestration/config/roles.js";

function parseRecord(json: string): UnknownRecord {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) throw new Error("expected a JSON object");
  return value;
}

function pendingSubagentOutput(sessionDir: string, toolUseId: string) {
  const output = createOutputSession({ updateEntry: () => {}, executionCwd: sessionDir });
  output.applyProjectionEvent({
    type: "tool-use",
    toolUseId,
    name: "subagent",
    input: { persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" },
    timestamp: Date.now(),
  });
  return output;
}

describe("subagent tool — execute lifecycle", () => {
    afterEach(settleDispatchedWork);

    it("configured providerOptions are passed to nested runner", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const roles: ResolvedRoles = new Map([
        ["explorer", { roleId: "explorer", model: "claude-sonnet-4-6", effort: "medium", providerOptions: { anthropic: { speed: "fast" } } }],
      ]);
      const deps = makeDeps({
        sessionDir,
        resolveRoles: async () => roles,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find stuff" }, makeContext());

      expect(calls[0]?.options.providerOptions).toEqual({ anthropic: { speed: "fast" } });

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("implementer agent gets full tool set and its own maxTurns", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({
        sessionDir,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "implementer", rationale: TEST_RATIONALE, prompt: "implement feature" }, ctx);

      const opts = calls[0]!.options;
      expect(opts.toolGrant).toContain("edit");
      expect(opts.toolGrant).toContain("write");
      expect(opts.maxLLMCalls).toBe(100);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("runs against the durable child conversation", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());

      const opts = calls[0]!.options;
      expect(opts.conversation.kind).toBe("durable-tree");
      if (opts.conversation.kind !== "durable-tree") throw new Error("Expected durable subagent conversation");
      expect(opts.conversation.sessionId).not.toBe(deps.sessionId);
      expect(opts.conversation.priorMessages).toEqual([{ kind: "user", content: "look" }, { kind: "user", content: childTask(opts), origin: "system" }]);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("returns immediately without awaiting runner.done", async () => {
      // The run ends only when it is aborted, so if execute() awaited it, this test would hang.
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const neverResolveFactory = (_options: AgentOptions): Agent => {
        const done = Promise.withResolvers<AgentRunResult>();
        return {
          send(_text: string): void {},
          end() {},
          abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); },
          done: done.promise,
        };
      };

      const deps = makeDeps({ sessionDir, createRunner: neverResolveFactory });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext({ toolUseId: "tc_nonblock" });

      const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, ctx);
      expect(result.outcome).toBe("ok");
      const ack = parseRecord(result.content);
      expect(ack.status).toBe("running");
      expect(ack.result_available).toBe(false);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("returned ToolResult.content is an ack string, isError is false", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "The answer is 42" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "search" }, ctx);
      // The immediate result should be an ack, not the final text.
      expect(result.outcome).toBe("ok");
      expect(result.content).not.toContain("The answer is 42");
      const ack = parseRecord(result.content);
      expect(ack).toEqual({
        status: "running",
        result_available: false,
        id: expect.any(String),
        session_id: expect.any(String),
        type: "explorer",
        description: "explorer",
        active_count: 1,
        result_delivery: "subagent_notifications",
        guidance: expect.stringContaining("Do not duplicate this subagent's assigned work"),
      });

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it.each(["agent", "user"] as const)("settles %s stop in the live parent row after nested stream completion", async (authority) => {
      const backgroundTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
      const done = Promise.withResolvers<AgentRunResult>();
      const output = pendingSubagentOutput("/workspace", "dispatch-call");
      const facts: Parameters<SessionFactWriter["record"]>[0][] = [];
      const sessionEventWriter: SessionFactWriter = {
        record: async (fact) => { facts.push(fact); return null; },
        recordBatch: async (batch) => { facts.push(...batch); return null; },
        recordGuarded: async () => null,
        transaction: async (fn) => { fn(); },
        dispose: () => {},
      };
      const tool = createSubagentDispatch(makeDeps({
        backgroundTasks,
        sessionEventWriter,
        onRenderEvent: (event) => output.dispatchRuntimeEvent(event),
        createRunner: (options) => ({
          send() {}, end() {},
          abort() {
            options.onEvent(createRuntimeEvent("budget.stream.completed", { parent_tool_use_id: "nested-dispatch" }));
            done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
          },
          done: done.promise,
        }),
      }));
      const context = makeContext({ conversationId: "parent-conversation", toolUseId: "dispatch-call" });

      const launched = parseRecord((await tool.execute(
        { persona: "explorer", rationale: TEST_RATIONALE, prompt: "inspect" },
        context,
      )).content);
      const sessionId = launched.session_id;
      const processId = launched.id;
      expect(typeof sessionId).toBe("string");
      expect(typeof processId).toBe("string");

      if (typeof processId !== "string") throw new Error("dispatch did not return a process id");
      if (authority === "agent") expect(backgroundTasks.terminateProcess(processId, "agent")).toBe("requested");
      else expect(backgroundTasks.terminate("dispatch-call")).toBe(true);
      expect(await backgroundTasks.waitProcess(processId)).toBe(true);
      expect(facts).toContainEqual(expect.objectContaining({
        type: "budget.stream.completed", payload: { parentToolUseId: "nested-dispatch" },
      }));
      expect(facts).toContainEqual(expect.objectContaining({ type: "subagent.completed" }));
      expect(output.getBlocks().find((block) => block.kind === "agentGroup")?.status)
        .toBe(authority === "agent" ? "cancelled" : "stopped");
      output.dispose();
    });

    it("notification contains completed status and text on success", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "Found it at src/config.ts", totalCostUsd: 0.03, inputTokens: 200, outputTokens: 100 });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      const deps = makeDeps({
        sessionDir,
        backgroundTasks: notification.backgroundTasks,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext();

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config" }, ctx);
      await notification.next;

      expect(notification.read()).toContain("<status>completed</status>");
      expect(notification.read()).toContain("Found it at src/config.ts");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("an admitted dispatch settles after the capability is disabled", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "Finished under the grant" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      // The selection turns off while the child runs: the first admission wins a
      // grant and every later one refuses. An admitted operation settles on its
      // own grant, so the later disable must not reach into this run.
      let admissions = 0;
      const capabilityAccess = makeCapabilityAccess({
        admit: (request) => {
          admissions += 1;
          return admissions === 1
            ? { ok: true, grant: { ...grantOf(["subagents"]), operation: request.operation, required: request.required } }
            : refusedAdmission("the subagent tool is unavailable: subagents is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml");
        },
      });
      const deps = makeDeps({
        sessionDir,
        backgroundTasks: notification.backgroundTasks,
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);

      const result = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config" }, makeContext({ capabilityAccess }));
      await notification.next;

      expect(result.outcome).toBe("ok");
      expect(admissions).toBe(1);
      expect(notification.read()).toContain("<status>completed</status>");
      expect(notification.read()).toContain("Finished under the grant");

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("still tells the parent, as a failure, when the completion fact cannot be recorded", async () => {
      // The runner settles normally but the durable completion append is
      // refused. A throw after the runner settled used to skip the rejection
      // arm entirely: no terminal fact, no notification, and the parent
      // parked on a child it would never hear from again.
      const { factory } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      const sessionEventWriter: SessionFactWriter = {
        record: async (fact) => {
          if (fact.type === "subagent.completed") throw new Error("store refused the append");
          return null;
        },
        recordBatch: async () => null,
        recordGuarded: async () => null,
        transaction: async (fn) => { fn(); },
        dispose: () => {},
      };
      const deps = makeDeps({ sessionDir, backgroundTasks: notification.backgroundTasks, createRunner: factory, sessionEventWriter });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "find config" }, makeContext());
      const text = await notification.next;

      expect(text).toContain("<status>failed</status>");
      expect(text).toContain("store refused the append");
      expect(notification.backgroundTasks.activeSubagentCount()).toBe(0);

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("notification contains failed status on a failure that needs a person", async () => {
      const { factory } = makeMockRunnerFactory({ failure: { kind: "api_error", message: "LLM request rejected", recovery: { kind: "none" } } });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      const output = pendingSubagentOutput(sessionDir, "tc_failed");
      const deps = makeDeps({
        sessionDir,
        backgroundTasks: notification.backgroundTasks,
        onRenderEvent: (event) => output.dispatchRuntimeEvent(event),
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext({ toolUseId: "tc_failed" });

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "search" }, ctx);
      await notification.next;

      expect(notification.read()).toContain("<status>failed</status>");
      expect(notification.read()).toContain("failed");
      expect(output.getBlocks().find((block) => block.kind === "agentGroup")?.status).toBe("error");

      output.dispose();
      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("streams child events and publishes the terminal result to the live parent row", async () => {
      const renderedEvents: RuntimeEvent[] = [];
      const { factory } = makeMockRunnerFactory({ finalText: "answer" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const notification = createNotificationCapture();
      const output = pendingSubagentOutput(sessionDir, "tc_stream_123");
      expect(output.getBlocks().find((block) => block.kind === "agentGroup")?.status).toBe("pending");
      const deps = makeDeps({
        sessionDir,
        backgroundTasks: notification.backgroundTasks,
        onRenderEvent: (event) => {
          renderedEvents.push(event);
          output.dispatchRuntimeEvent(event);
        },
        createRunner: factory,
      });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext({ toolUseId: "tc_stream_123" });

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" }, ctx);
      await notification.next;

      const assistantEvents = renderedEvents.filter(e => e.type === "model.assistant_message.recorded");
      expect(assistantEvents.length).toBeGreaterThan(0);
      const terminal = renderedEvents.find((event) => event.type === "tool.result.available");
      expect(terminal).toEqual({
        type: "tool.result.available",
        data: expect.objectContaining({
          tool_use_id: "tc_stream_123",
          content: [{ type: "text", text: "answer" }],
          outcome: "ok",
        }),
      });
      expect(output.getBlocks().find((block) => block.kind === "agentGroup")?.status).toBe("completed");

      output.dispose();
      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("emits child-stream completion once after a multi-turn subagent settles", async () => {
      const renderedEvents: RuntimeEvent[] = [];
      const { promise, resolve } = Promise.withResolvers<AgentRunResult>();
      let onEvent: ((event: RuntimeEvent) => void) | undefined;
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const tool = createSubagentDispatch(makeDeps({
        sessionDir,
        onRenderEvent: (event) => renderedEvents.push(event),
        createRunner: (options) => {
          onEvent = options.onEvent;
          return { send() {}, end() {}, abort() {}, done: promise };
        },
      }));

      await tool.execute(
        { persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" },
        makeContext({ toolUseId: "tc_multi_turn" }),
      );
      const turn = createRuntimeEvent("model.turn.completed", {
        total_cost_usd: 0.02,
        billed_cost_usd: 0.02,
        usage: { input_tokens: 100, output_tokens: 40 },
        parent_tool_use_id: "tc_multi_turn",
      });
      onEvent!(turn);
      onEvent!(turn);
      expect(renderedEvents.filter((event) => event.type === "budget.stream.completed")).toHaveLength(0);

      resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: "agent-mock", terminal: { kind: "completed" } });
      await new Promise((settle) => setTimeout(settle, 10));

      expect(renderedEvents.filter((event) => event.type === "budget.stream.completed")).toEqual([
        expect.objectContaining({ data: { parent_tool_use_id: "tc_multi_turn" } }),
      ]);
      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("retires the child cost stream after terminal failure", async () => {
      const renderedEvents: RuntimeEvent[] = [];
      const { promise, reject } = Promise.withResolvers<AgentRunResult>();
      let onEvent: ((event: RuntimeEvent) => void) | undefined;
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const tool = createSubagentDispatch(makeDeps({
        sessionDir,
        onRenderEvent: (event) => renderedEvents.push(event),
        createRunner: (options) => {
          onEvent = options.onEvent;
          return { send() {}, end() {}, abort() {}, done: promise };
        },
      }));

      await tool.execute(
        { persona: "explorer", rationale: TEST_RATIONALE, prompt: "investigate" },
        makeContext({ toolUseId: "tc_failed" }),
      );
      onEvent!(createRuntimeEvent("model.usage.measured", {
        usage_entry: { attemptId: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.02, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" },
        parent_tool_use_id: "tc_failed",
        budget_stream_id: "subagent:tc_failed",
      }));
      reject(new DOMException("aborted", "AbortError"));
      await new Promise((settle) => setTimeout(settle, 20));

      expect(renderedEvents.filter((event) => event.type === "budget.stream.completed")).toEqual([
        expect.objectContaining({ data: { parent_tool_use_id: "tc_failed" } }),
      ]);
      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("repeated direct execute calls with the same toolUseId start distinct background tasks", async () => {
      const { factory } = makeMockRunnerFactory({ finalText: "model.turn.completed" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);
      const ctx = makeContext({ toolUseId: "tc_idem_1" });

      const r1 = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "search" }, ctx);
      const r2 = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "search" }, ctx);

      expect(r1.deferCompletion).toBe(true);
      expect(r2.deferCompletion).toBe(true);
      expect(JSON.parse(r1.content)).toMatchObject({ status: "running", result_available: false, active_count: 1 });
      expect(JSON.parse(r2.content)).toMatchObject({ status: "running", result_available: false, active_count: 2 });

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("subagent runner gets inputSource and onTurnEnded wired with handoff observer (graceTurns=0)", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());

      const opts = calls[0]!.options;
      expect(typeof opts.lifecycle.inputSource?.drainPending).toBe("function");
      expect(typeof opts.lifecycle.inputSource?.prepareWaitForInput).toBe("function");
      expect(typeof opts.lifecycle.onTurnEnded).toBe("function");

      // graceTurns=0 means a text-only turn immediately enqueues the nudge.
      opts.lifecycle.onTurnEnded!({ handoffWritten: false, turnCount: 1 });
      const pending = opts.lifecycle.inputSource!.drainPending();
      if (pending === null) throw new Error("the observer enqueued no nudge");
      expect(pending.kind).toBe("message");
      if (pending.kind === "message") {
        expect(pending.text).toContain("your last turn ended without a handoff");
      }

      rmSync(sessionDir, { recursive: true, force: true });
    });

    it("subagent handoff observer goes permanently quiet once the handoff is written", async () => {
      const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
      const sessionDir = path.join(os.tmpdir(), `subagent-test-${Date.now()}`);
      const deps = makeDeps({ sessionDir, createRunner: factory });
      const tool = createSubagentDispatch(deps);

      await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());

      const opts = calls[0]!.options;
      // The loop exits on its own after the handoff (canComplete); the observer
      // enqueues nothing further, even for later text-only turns.
      opts.lifecycle.onTurnEnded!({ handoffWritten: true, turnCount: 1 });
      opts.lifecycle.onTurnEnded!({ handoffWritten: false, turnCount: 2 });
      expect(opts.lifecycle.inputSource!.drainPending()).toBeNull();

      rmSync(sessionDir, { recursive: true, force: true });
    });

});
