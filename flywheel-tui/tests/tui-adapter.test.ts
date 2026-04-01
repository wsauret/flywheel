import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../src/events/event-bus";
import { OpenTUIAdapter, createOpenTUIAdapter } from "../src/tui/adapters/opentui";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { timerService } from "../src/tui/shared/services/timer";
import { StructuredOutputBuilder } from "../src/tui/adapters/structured-output-builder";
import type { FlywheelEvent } from "../src/events/types";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

/**
 * Helper to create a test harness with event bus, store, and adapter
 */
function createHarness() {
  const bus = new EventBus();
  const store = createStore("test-plan");
  const adapter = createOpenTUIAdapter(store);
  adapter.connect(bus);
  adapter.start();
  return { bus, store, adapter };
}

function ts(): string {
  return new Date().toISOString();
}

describe("OpenTUIAdapter", () => {
  beforeEach(() => {
    timerService.reset();
  });

  afterEach(() => {
    timerService.reset();
  });

  // ── Basics ──

  describe("basics", () => {
    it("has adapterType 'opentui'", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      expect(adapter.adapterType).toBe("opentui");
    });

    it("connects to event bus and receives events", () => {
      const { bus, store } = createHarness();
      store.startWorkflow("plan.md");
      bus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("running");
    });

    it("factory function creates adapter", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      expect(adapter).toBeInstanceOf(OpenTUIAdapter);
    });
  });

  // ── Event-to-Action translation ──

  describe("event-to-action translation", () => {
    // -- Queue lifecycle events --

    it("queue:initialized → timer start", () => {
      const { bus, store, adapter } = createHarness();
      store.startWorkflow("plan.md");
      bus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("running");
      expect(adapter.timer.isRunning()).toBe(true);
    });

    it("queue:completed → stopWorkflow('completed') + timer stop", () => {
      const { bus, store, adapter } = createHarness();
      store.startWorkflow("p");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      bus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("completed");
      expect(adapter.timer.isStopped()).toBe(true);
    });

    it("queue:failed → setError + timer stop", () => {
      const { bus, store, adapter } = createHarness();
      store.startWorkflow("p");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      bus.emit({ type: "queue:failed", workflowId: "w1", reason: "kaboom", stepsCompleted: 0, timestamp: ts() });
      expect(store.getState().workflowStatus).toBe("failed");
      expect(store.getState().error).toBe("kaboom");
      expect(adapter.timer.isStopped()).toBe(true);
    });

    it("queue:step-started adds a visible step boundary system block", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "queue:step-started",
        workflowId: "w1",
        stepId: "s1",
        stepType: "work",
        stepTitle: "Implement feature",
        timestamp: ts(),
      });

      const systemBlocks = store.getState().outputBlocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      expect(systemBlocks[0].message).toContain("[step-boundary]");
      expect(systemBlocks[0].message).toContain("WORK · Implement feature");
    });

    // -- Worker events --

    it("worker:output stdout → structured outputBlocks", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "hello world\n",
        timestamp: "2025-01-01T00:00:00Z",
      });
      // Stdout now goes through the structured pipeline → outputBlocks
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(blocks[0].kind).toBe("text");
      expect((blocks[0] as any).content).toContain("hello world");
    });

    it("worker:output stderr → structured outputBlocks (SystemBlock)", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stderr",
        data: "error output\n",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      expect((systemBlocks[0] as any).message).toContain("error output");
    });

    it("worker:retrying → structured outputBlocks with retry message (SystemBlock)", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:retrying",
        workflowId: "w1",
        attempt: 2,
        maxAttempts: 3,
        reason: "timeout",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("Retrying (2/3)");
      expect(text).toContain("timeout");
    });

    it("worker:spawned is suppressed from TUI output (no blocks)", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:spawned",
        workflowId: "w1",
        stepIndex: 0,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks).toHaveLength(0);
    });

    it("worker:completed is suppressed from TUI output (no blocks)", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:completed",
        workflowId: "w1",
        result: { output: "", exitCode: 0, durationMs: 100, truncated: false } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks).toHaveLength(0);
    });

    it("worker:failed produces a SystemBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:failed",
        workflowId: "w1",
        failure: { kind: "timeout", timeoutMs: 5000, message: "timed out" } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("Worker failed: timed out");
    });

    // -- Raw text passthrough (completion marker stripping removed) --

    it("raw text is passed through without modification", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "some output text\n",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      const textBlocks = blocks.filter((b: any) => b.kind === "text");
      if (textBlocks.length > 0) {
        const content = textBlocks.map((b: any) => b.content).join("");
        expect(content).toContain("some output text");
      }
    });

    // -- Approval events --

    it("approval:requested → setApprovalPending", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "approval:requested",
        workflowId: "w1",
        stepIndex: 0,
        description: "Delete database?",
        timestamp: ts(),
      });
      expect(store.getState().approvalState.pending).toBe(true);
      expect(store.getState().approvalState.description).toBe("Delete database?");
    });

    it("approval:received → clearApproval", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "approval:requested",
        workflowId: "w1",
        stepIndex: 0,
        description: "Delete?",
        timestamp: ts(),
      });
      bus.emit({
        type: "approval:received",
        workflowId: "w1",
        approved: true,
        skipped: false,
        timestamp: ts(),
      });
      expect(store.getState().approvalState.pending).toBe(false);
    });

    // -- Dispatcher events --

    it("dispatcher:invoked produces AgentBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "dispatcher:invoked",
        workflowId: "w1",
        stepIndex: 2,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const agentBlocks = blocks.filter((b: any) => b.kind === "agent");
      expect(agentBlocks.length).toBeGreaterThanOrEqual(1);
      const agent = agentBlocks[0] as any;
      expect(agent.agentLabel).toBe("Dispatcher");
      expect(agent.description).toBe("Analyzing step and crafting worker prompt");
      expect(agent.status).toBe("active");
    });

    it("dispatcher:completed produces SystemBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "dispatcher:completed",
        workflowId: "w1",
        decision: { action: "continue", stepIndex: 0, warnings: [] } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("Dispatcher: prompt ready");
    });

    it("dispatcher:failed produces SystemBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "dispatcher:failed",
        workflowId: "w1",
        reason: "dispatch error",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("Dispatcher unavailable: dispatch error");
      expect(text).toContain("Using static prompt");
    });

    // -- Evaluator events --

    it("evaluator:invoked produces AgentBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:invoked",
        workflowId: "w1",
        stepIndex: 0,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const agentBlocks = blocks.filter((b: any) => b.kind === "agent");
      expect(agentBlocks.length).toBeGreaterThanOrEqual(1);
      const agent = agentBlocks[0] as any;
      expect(agent.agentLabel).toBe("Evaluator");
      expect(agent.description).toBe("Checking output quality");
      expect(agent.status).toBe("active");
    });

    it("evaluator:completed (passed) produces SystemBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:completed",
        workflowId: "w1",
        result: { passed: true, reasoning: "All tests pass" } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("passed");
      expect(text).toContain("All tests pass");
    });

    it("evaluator:completed (failed) produces SystemBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:completed",
        workflowId: "w1",
        result: { passed: false, reasoning: "Missing error handling" } as any,
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("needs revision");
      expect(text).toContain("Missing error handling");
    });

    it("evaluator:failed produces SystemBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "evaluator:failed",
        workflowId: "w1",
        reason: "eval error",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("Evaluator failed: eval error");
      expect(text).toContain("Skipping");
    });
  });

  // ── Timer Integration ──

  describe("timer integration", () => {
    it("timer starts on queue:initialized", () => {
      const { bus, adapter } = createHarness();
      expect(adapter.timer.getStatus()).toBe("idle");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      expect(adapter.timer.isRunning()).toBe(true);
    });

    it("timer stops on queue:completed", () => {
      const { bus, adapter } = createHarness();
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      bus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });
      expect(adapter.timer.isStopped()).toBe(true);
    });

    it("timer stops on queue:failed", () => {
      const { bus, adapter } = createHarness();
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      bus.emit({ type: "queue:failed", workflowId: "w1", reason: "fail", stepsCompleted: 0, timestamp: ts() });
      expect(adapter.timer.isStopped()).toBe(true);
    });

    it("timer resets on new queue:initialized", () => {
      const { bus, adapter } = createHarness();
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      expect(adapter.timer.isRunning()).toBe(true);
    });

  });

  // ── Suppress Pipeline Error (Pause Behavior) ──

  describe("suppressQueueError", () => {
    it("suppressQueueError defaults to false", () => {
      const { adapter } = createHarness();
      expect(adapter.suppressQueueError).toBe(false);
    });

    it("suppressQueueError resets to false after being set", () => {
      const { adapter } = createHarness();
      adapter.suppressQueueError = true;
      expect(adapter.suppressQueueError).toBe(true);
      adapter.suppressQueueError = false;
      expect(adapter.suppressQueueError).toBe(false);
    });

    it("queue:failed skips setError when suppressQueueError is true", () => {
      const { bus, store, adapter } = createHarness();
      store.startWorkflow("p");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      adapter.suppressQueueError = true;
      bus.emit({ type: "queue:failed", workflowId: "w1", reason: "interrupted by user", stepsCompleted: 0, timestamp: ts() });
      // Error should NOT be set (suppressed)
      expect(store.getState().error).toBeUndefined();
    });

    it("queue:failed still calls setError when suppressQueueError is false", () => {
      const { bus, store } = createHarness();
      store.startWorkflow("p");
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      bus.emit({ type: "queue:failed", workflowId: "w1", reason: "real failure", stepsCompleted: 0, timestamp: ts() });
      expect(store.getState().error).toBe("real failure");
    });
  });

  // ── Standalone workflow:started does full reset ──

  describe("standalone workflow reset", () => {
    it("startWorkflow does full reset", () => {
      const { store } = createHarness();

      store.startWorkflow("plan-a.md");
      store.appendOutput({ stream: "stdout", data: "output\n", timestamp: ts() });

      // Another startWorkflow → full reset
      store.startWorkflow("plan-b.md");

      const state = store.getState();
      expect(state.planName).toBe("plan-b.md");
      // startWorkflow wipes output
      expect(state.outputLines).toEqual([]);
    });
  });

  // ── Disconnect ──

  describe("disconnect", () => {
    it("disconnect prevents further event processing", () => {
      const { bus, store, adapter } = createHarness();
      adapter.disconnect();
      bus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      // Timer should remain idle since adapter is disconnected
      expect(adapter.timer.getStatus()).toBe("idle");
    });
  });

  // ── Stale Agent Detection ──

  describe("stale agent detection", () => {
    afterEach(() => {
      // Clean up any lingering intervals from adapters created in these tests
    });

    it("checkStaleAgents completes agents inactive for >30s", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      const builder = (adapter as any).builder as StructuredOutputBuilder;
      const activityMap = (adapter as any).agentActivityMap as Map<string, number>;

      builder.startAgent("stale-1", "Explore", "Searching", Date.now());

      // Simulate the agent being started 31 seconds ago
      activityMap.set("stale-1", Date.now() - 31_000);

      // Run the check
      (adapter as any).checkStaleAgents();

      // Agent should now be completed
      const blocks = builder.getBlocks();
      const agent = blocks.find((b: any) => b.kind === "agent" && b.id === "stale-1") as any;
      expect(agent).toBeDefined();
      expect(agent.status).toBe("completed");
      // Activity map should be cleaned up
      expect(activityMap.has("stale-1")).toBe(false);

      adapter.disconnect();
    });

    it("checkStaleAgents does not complete recently active agents", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      const builder = (adapter as any).builder as StructuredOutputBuilder;
      const activityMap = (adapter as any).agentActivityMap as Map<string, number>;

      builder.startAgent("active-1", "Explore", "Searching", Date.now());
      // Activity was just now — should NOT be completed
      activityMap.set("active-1", Date.now());

      (adapter as any).checkStaleAgents();

      const blocks = builder.getBlocks();
      const agent = blocks.find((b: any) => b.kind === "agent" && b.id === "active-1") as any;
      expect(agent).toBeDefined();
      expect(agent.status).toBe("active");
      expect(activityMap.has("active-1")).toBe(true);

      adapter.disconnect();
    });

    it("tool activity resets the agent's stale timer", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      const builder = (adapter as any).builder as StructuredOutputBuilder;
      const activityMap = (adapter as any).agentActivityMap as Map<string, number>;

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      const initialTime = activityMap.get("a1")!;

      // Simulate time passing by setting activity in the past
      activityMap.set("a1", initialTime - 5000);
      const beforeTool = activityMap.get("a1")!;

      // Adding a tool triggers onAgentActivity, which updates the timestamp
      builder.pushTool("Read", "file.ts", Date.now());

      // The callback should have updated the timestamp to something more recent
      expect(activityMap.get("a1")!).toBeGreaterThan(beforeTool);

      adapter.disconnect();
    });

    it("normally completed agent is removed from activity tracking", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      const builder = (adapter as any).builder as StructuredOutputBuilder;
      const activityMap = (adapter as any).agentActivityMap as Map<string, number>;

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      expect(activityMap.has("a1")).toBe(true);

      builder.completeAgent("a1", 500, 2);
      expect(activityMap.has("a1")).toBe(false);

      adapter.disconnect();
    });

    it("errored agent is removed from activity tracking", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      const builder = (adapter as any).builder as StructuredOutputBuilder;
      const activityMap = (adapter as any).agentActivityMap as Map<string, number>;

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      expect(activityMap.has("a1")).toBe(true);

      builder.errorAgent("a1", "timeout");
      expect(activityMap.has("a1")).toBe(false);

      adapter.disconnect();
    });

    it("stale check uses children.length when completing with toolCount=0", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      const builder = (adapter as any).builder as StructuredOutputBuilder;
      const activityMap = (adapter as any).agentActivityMap as Map<string, number>;

      builder.startAgent("a1", "Explore", "Searching", Date.now());
      builder.pushTool("Read", "file1.ts", Date.now());
      builder.pushTool("Grep", "pattern", Date.now());

      // Simulate staleness
      activityMap.set("a1", Date.now() - 31_000);
      (adapter as any).checkStaleAgents();

      const blocks = builder.getBlocks();
      const agent = blocks.find((b: any) => b.kind === "agent" && b.id === "a1") as any;
      expect(agent.status).toBe("completed");
      expect(agent.toolCount).toBe(2); // children.length fallback

      adapter.disconnect();
    });

    it("disconnect clears the stale check interval", () => {
      const store = createStore("test");
      const adapter = createOpenTUIAdapter(store);
      const staleInterval = (adapter as any).staleCheckInterval;
      expect(staleInterval).not.toBeNull();

      adapter.disconnect();
      expect((adapter as any).staleCheckInterval).toBeNull();
    });
  });
});
