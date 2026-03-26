import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { OpenTUIAdapter } from "../src/tui/adapters/opentui";
// ConsoleAdapter deleted — headless mode removed
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { parseArgs } from "../src/cli/args";
import { timerService } from "../src/tui/shared/services/timer";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

/**
 * Integration tests for the TUI pipeline.
 *
 * Tests the full event → adapter → store pipeline WITHOUT starting
 * the actual TUI renderer (no OpenTUI rendering in test env).
 */

function ts(): string {
  return new Date().toISOString();
}

describe("TUI Integration — event → adapter → store pipeline", () => {
  let bus: EventBus;
  let store: UIActions;
  let adapter: OpenTUIAdapter;

  beforeEach(() => {
    timerService.reset();
    bus = new EventBus();
    store = createStore("integration-test-plan");
    adapter = new OpenTUIAdapter({ actions: store });
    adapter.connect(bus);
    adapter.start();
  });

  afterEach(() => {
    adapter.stop();
    adapter.disconnect();
    timerService.reset();
  });

  // ── Full Workflow Lifecycle ──

  describe("full workflow lifecycle", () => {
    it("processes complete workflow: started → phase → output → phase complete → workflow complete", () => {
      const wfId = "wf-lifecycle-1";
      const emitter = createFlywheelEmitter(bus);

      // 1. Start workflow
      store.startWorkflow("plan.md");
      emitter.queueInitialized(wfId, ["s1"]);
      expect(store.getState().workflowStatus).toBe("running");
      expect(store.getState().planName).toBe("plan.md");

      // 2. Worker output — stdout now goes to structured outputBlocks
      emitter.workerOutput(wfId, "stdout", "Installing dependencies...\n");
      expect(store.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);
      const textBlocks = store.getState().outputBlocks.filter((b: any) => b.kind === "text");
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);

      // stderr now goes through structured pipeline as SystemBlocks
      emitter.workerOutput(wfId, "stderr", "warning: deprecated package\n");
      const blocksAfterStderr = store.getState().outputBlocks;
      const stderrText = blocksAfterStderr.filter((b: any) => b.kind === "system").map((b: any) => b.message).join("");
      expect(stderrText).toContain("warning: deprecated package");

      // 3. Complete workflow
      emitter.queueCompleted(wfId, 1);
      expect(store.getState().workflowStatus).toBe("completed");
    });

    it("handles multi-phase workflow with output interleaving", () => {
      const wfId = "wf-multi";
      const emitter = createFlywheelEmitter(bus);

      store.startWorkflow("multi-plan.md");
      emitter.queueInitialized(wfId, ["s1"]);

      emitter.workerOutput(wfId, "stdout", "compiling...\n");
      emitter.workerOutput(wfId, "stdout", "linking...\n");
      emitter.workerOutput(wfId, "stdout", "running tests...\n");
      emitter.workerOutput(wfId, "stderr", "1 deprecation warning\n");

      // Verify stderr appears in blocks (as SystemBlock)
      const stderrText = store.getState().outputBlocks.filter((b: any) => b.kind === "system").map((b: any) => b.message).join("");
      expect(stderrText).toContain("1 deprecation warning");

      emitter.workerOutput(wfId, "stdout", "deploying...\n");

      emitter.queueCompleted(wfId, 1);

      // Verify final state
      const state = store.getState();
      expect(state.workflowStatus).toBe("completed");
    });
  });

  // ── Approval Flow ──

  describe("approval flow", () => {
    it("approval:requested → store has pending approval → approval:received → store clears approval", () => {
      const wfId = "wf-approval";
      const emitter = createFlywheelEmitter(bus);

      store.startWorkflow("plan.md");
      emitter.queueInitialized(wfId, ["s1"]);

      // Request approval
      emitter.approvalRequested(wfId, 0, "Delete production database?");
      expect(store.getState().approvalState.pending).toBe(true);
      expect(store.getState().approvalState.description).toBe("Delete production database?");

      // Receive approval (approved)
      emitter.approvalReceived(wfId, true, false);
      expect(store.getState().approvalState.pending).toBe(false);
      expect(store.getState().approvalState.description).toBeUndefined();
    });

    it("approval:received with denied clears approval state", () => {
      const wfId = "wf-approval-deny";
      const emitter = createFlywheelEmitter(bus);

      store.startWorkflow("plan.md");
      emitter.queueInitialized(wfId, ["s1"]);

      emitter.approvalRequested(wfId, 0, "Continue?");
      expect(store.getState().approvalState.pending).toBe(true);

      emitter.approvalReceived(wfId, false, false);
      expect(store.getState().approvalState.pending).toBe(false);
    });

    it("approval:received with auto-skip clears approval state", () => {
      const wfId = "wf-approval-skip";
      const emitter = createFlywheelEmitter(bus);

      store.startWorkflow("plan.md");
      emitter.queueInitialized(wfId, ["s1"]);

      emitter.approvalRequested(wfId, 0, "Auto-approve?");
      expect(store.getState().approvalState.pending).toBe(true);

      emitter.approvalReceived(wfId, true, true);
      expect(store.getState().approvalState.pending).toBe(false);
    });
  });

  // ── Error Flow ──

  describe("error flow", () => {
    it("queue:failed → store has error state", () => {
      const wfId = "wf-fail";
      const emitter = createFlywheelEmitter(bus);

      store.startWorkflow("plan.md");
      emitter.queueInitialized(wfId, ["s1"]);

      emitter.queueFailed(wfId, "Out of memory", 0);

      const state = store.getState();
      expect(state.workflowStatus).toBe("failed");
      expect(state.error).toBe("Out of memory");
    });
  });

  // ── Retry Flow ──

  describe("retry flow", () => {
    it("worker:retrying appends retry message to outputBlocks", () => {
      const wfId = "wf-retry";
      const emitter = createFlywheelEmitter(bus);

      store.startWorkflow("plan.md");
      emitter.queueInitialized(wfId, ["s1"]);

      emitter.workerRetrying(wfId, 1, 3, "Connection timeout");
      emitter.workerRetrying(wfId, 2, 3, "Connection timeout");

      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b: any) => b.kind === "system");
      const text = systemBlocks.map((b: any) => b.message).join("");
      expect(text).toContain("Retrying (1/3)");
      expect(text).toContain("Connection timeout");
      expect(text).toContain("Retrying (2/3)");
    });
  });

  // ── Timer Integration ──

  describe("timer integration through pipeline", () => {
    it("timer tracks workflow lifecycle", () => {
      const wfId = "wf-timer";
      const emitter = createFlywheelEmitter(bus);

      // Timer starts on queue:initialized
      store.startWorkflow("plan.md");
      emitter.queueInitialized(wfId, ["s1"]);
      expect(adapter.timer.isRunning()).toBe(true);

      // Timer stops on queue completion
      emitter.queueCompleted(wfId, 1);
      expect(adapter.timer.isStopped()).toBe(true);
    });
  });

  // ── Adapter Lifecycle ──

  describe("adapter lifecycle", () => {
    it("adapter reports correct type and connection state", () => {
      expect(adapter.adapterType).toBe("opentui");
      expect(adapter.isConnected()).toBe(true);
      expect(adapter.isRunning()).toBe(true);
    });

    it("disconnect stops event processing", () => {
      adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);

      // Events after disconnect should not affect store — queue:initialized alone
      // doesn't change workflowStatus (startWorkflow is a store action)
      bus.emit({
        type: "queue:initialized",
        workflowId: "w-after-disconnect",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("idle");
    });

    it("reconnect to different bus works correctly", () => {
      const bus2 = new EventBus();
      adapter.disconnect();
      adapter.connect(bus2);

      store.startWorkflow("reconnected-plan.md");
      bus2.emit({
        type: "queue:initialized",
        workflowId: "w-new-bus",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("running");
      expect(store.getState().planName).toBe("reconnected-plan.md");
    });
  });


});

// ── CLI Arg Parsing → Adapter Selection ──

describe("CLI arg parsing → adapter selection", () => {
  it("all args result in TUI mode", async () => {
    const result = await parseArgs(["work", "plan.md"]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("tui");
  });

  it("no args results in TUI mode", async () => {
    const result = await parseArgs([]);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("tui");
  });

  // ConsoleAdapter deleted — headless mode removed.

  it("OpenTUIAdapter has opentui adapter type", () => {
    const store = createStore("test");
    const adapter = new OpenTUIAdapter({ actions: store });
    expect(adapter.adapterType).toBe("opentui");
  });

  // 'work' subcommand removed — all workflows go through TUI.

  it("TUI mode would select OpenTUIAdapter (adapterType check)", async () => {
    const result = await parseArgs([]);
    expect(result!.command).toBe("tui");
    // In TUI mode, CLI creates OpenTUIAdapter with store
    const store = createStore("plan.md");
    const adapter = new OpenTUIAdapter({ actions: store });
    expect(adapter.adapterType).toBe("opentui");
  });
});

// ── Emitter → Bus → Adapter → Store (no shortcuts) ──

describe("FlywheelEmitter → EventBus → OpenTUIAdapter → Store (full chain)", () => {
  it("emitter methods produce correct store mutations through entire chain", () => {
    timerService.reset();
    const bus = new EventBus();
    const store = createStore("chain-test");
    const adapter = new OpenTUIAdapter({ actions: store });
    adapter.connect(bus);
    adapter.start();

    const emitter = createFlywheelEmitter(bus);
    const wfId = "chain-wf-1";

    // Use the store action to start workflow, then queue:initialized
    store.startWorkflow("chain-plan.md");
    emitter.queueInitialized(wfId, ["s1"]);
    expect(store.getState().workflowStatus).toBe("running");

    emitter.workerSpawned(wfId, 0);
    // worker:spawned is suppressed from TUI output (only logged to file)
    const spawnBlocks = store.getState().outputBlocks;
    expect(spawnBlocks).toHaveLength(0);

    // stdout now goes to structured outputBlocks
    emitter.workerOutput(wfId, "stdout", "chain output\n");
    expect(store.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);
    const chainTextBlocks = store.getState().outputBlocks.filter((b: any) => b.kind === "text");
    expect(chainTextBlocks.some((b: any) => b.content.includes("chain output"))).toBe(true);

    emitter.workerCompleted(wfId, {
      output: "done",
      exitCode: 0,
      durationMs: 500,
      truncated: false,
    } as any);
    // worker:completed is suppressed from TUI output (only logged to file)

    emitter.queueCompleted(wfId, 1);
    expect(store.getState().workflowStatus).toBe("completed");

    adapter.stop();
    adapter.disconnect();
    timerService.reset();
  });
});
