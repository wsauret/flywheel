import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { OpenTUIAdapter } from "../src/tui/adapters/opentui";
// ConsoleAdapter deleted — headless mode removed
import { createTestStore } from "../src/tui/routes/work/context/ui-state/store";
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
    store = createTestStore("integration-test-plan");
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
      emitter.workflowStarted(wfId, "plan.md");
      expect(store.getState().workflowStatus).toBe("running");
      expect(store.getState().planName).toBe("plan.md");

      // 2. Start phase 0
      emitter.phaseStarted(wfId, 0, "Setup environment");
      expect(store.getState().phases).toHaveLength(1);
      expect(store.getState().phases[0].status).toBe("running");
      expect(store.getState().phases[0].name).toBe("Setup environment");

      // 3. Worker output — stdout now goes to structured outputBlocks
      emitter.workerOutput(wfId, "stdout", "Installing dependencies...\n");
      expect(store.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);
      const textBlocks = store.getState().outputBlocks.filter((b: any) => b.kind === "text");
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);

      // stderr now goes through structured pipeline as SystemBlocks
      emitter.workerOutput(wfId, "stderr", "warning: deprecated package\n");
      const blocksAfterStderr = store.getState().outputBlocks;
      const stderrText = blocksAfterStderr.filter((b: any) => b.kind === "system").map((b: any) => b.message).join("");
      expect(stderrText).toContain("warning: deprecated package");

      // 4. Complete phase 0
      emitter.phaseCompleted(wfId, 0);
      expect(store.getState().phases[0].status).toBe("completed");
      expect(store.getState().phases[0].endTime).toBeDefined();
      expect(store.getState().phases[0].duration).toBeDefined();

      // 5. Start phase 1
      emitter.phaseStarted(wfId, 1, "Run tests");
      expect(store.getState().phases).toHaveLength(2);
      expect(store.getState().phases[1].status).toBe("running");

      // 6. Complete phase 1
      emitter.phaseCompleted(wfId, 1);
      expect(store.getState().phases[1].status).toBe("completed");

      // 7. Complete workflow
      emitter.workflowCompleted(wfId);
      expect(store.getState().workflowStatus).toBe("completed");
    });

    it("handles multi-phase workflow with output interleaving", () => {
      const wfId = "wf-multi";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "multi-plan.md");

      // Phase 0
      emitter.phaseStarted(wfId, 0, "Build");
      emitter.workerOutput(wfId, "stdout", "compiling...\n");
      emitter.workerOutput(wfId, "stdout", "linking...\n");
      emitter.phaseCompleted(wfId, 0);

      // Phase 1
      emitter.phaseStarted(wfId, 1, "Test");
      emitter.workerOutput(wfId, "stdout", "running tests...\n");
      emitter.workerOutput(wfId, "stderr", "1 deprecation warning\n");

      // Verify stderr appears in blocks during the phase it was emitted (as SystemBlock)
      const phase1Text = store.getState().outputBlocks.filter((b: any) => b.kind === "system").map((b: any) => b.message).join("");
      expect(phase1Text).toContain("1 deprecation warning");

      emitter.phaseCompleted(wfId, 1);

      // Phase 2 — blocks reset on phase:started
      emitter.phaseStarted(wfId, 2, "Deploy");
      emitter.workerOutput(wfId, "stdout", "deploying...\n");
      emitter.phaseCompleted(wfId, 2);

      emitter.workflowCompleted(wfId);

      // Verify final state
      const state = store.getState();
      expect(state.workflowStatus).toBe("completed");
      expect(state.phases).toHaveLength(3);
      expect(state.phases.every((p) => p.status === "completed")).toBe(true);
      // Final blocks contain only Phase 2's output (blocks reset per phase)
      const finalText = state.outputBlocks.filter((b: any) => b.kind === "text").map((b: any) => b.content).join("");
      expect(finalText).toContain("deploying...");
    });
  });

  // ── Approval Flow ──

  describe("approval flow", () => {
    it("approval:requested → store has pending approval → approval:received → store clears approval", () => {
      const wfId = "wf-approval";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "plan.md");
      emitter.phaseStarted(wfId, 0, "Dangerous operation");

      // Request approval
      emitter.approvalRequested(wfId, 0, 0, "Delete production database?");
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

      emitter.workflowStarted(wfId, "plan.md");
      emitter.phaseStarted(wfId, 0, "Risky op");

      emitter.approvalRequested(wfId, 0, 0, "Continue?");
      expect(store.getState().approvalState.pending).toBe(true);

      emitter.approvalReceived(wfId, false, false);
      expect(store.getState().approvalState.pending).toBe(false);
    });

    it("approval:received with auto-skip clears approval state", () => {
      const wfId = "wf-approval-skip";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "plan.md");
      emitter.phaseStarted(wfId, 0, "Auto-approved op");

      emitter.approvalRequested(wfId, 0, 0, "Auto-approve?");
      expect(store.getState().approvalState.pending).toBe(true);

      emitter.approvalReceived(wfId, true, true);
      expect(store.getState().approvalState.pending).toBe(false);
    });
  });

  // ── Error Flow ──

  describe("error flow", () => {
    it("workflow:failed → store has error state", () => {
      const wfId = "wf-fail";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "plan.md");
      emitter.phaseStarted(wfId, 0, "Build");

      emitter.workflowFailed(wfId, "Out of memory");

      const state = store.getState();
      expect(state.workflowStatus).toBe("failed");
      expect(state.error).toBe("Out of memory");
    });

    it("phase:failed sets phase error, workflow can still complete later phases", () => {
      const wfId = "wf-phase-fail";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "plan.md");
      emitter.phaseStarted(wfId, 0, "Flaky phase");
      emitter.phaseFailed(wfId, 0, "Compilation error");

      expect(store.getState().phases[0].status).toBe("failed");
      expect(store.getState().phases[0].error).toBe("Compilation error");
      // Workflow is still running (phase failure != workflow failure)
      expect(store.getState().workflowStatus).toBe("running");
    });

    it("workflow:interrupted sets interrupted status", () => {
      const wfId = "wf-interrupt";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "plan.md");
      emitter.phaseStarted(wfId, 0, "Long running");

      emitter.workflowInterrupted(wfId, "User pressed Ctrl+C");

      expect(store.getState().workflowStatus).toBe("interrupted");
    });
  });

  // ── Retry Flow ──

  describe("retry flow", () => {
    it("worker:retrying appends retry message to outputBlocks", () => {
      const wfId = "wf-retry";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "plan.md");
      emitter.phaseStarted(wfId, 0, "Network phase");

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
    it("timer tracks workflow and phase lifecycle", () => {
      const wfId = "wf-timer";
      const emitter = createFlywheelEmitter(bus);

      // Timer starts on workflow:started
      emitter.workflowStarted(wfId, "plan.md");
      expect(timerService.isRunning()).toBe(true);

      // Phase registers agent
      emitter.phaseStarted(wfId, 0, "Phase A");
      expect(timerService.hasAgent("phase-0")).toBe(true);

      // Phase completion removes agent
      emitter.phaseCompleted(wfId, 0);
      expect(timerService.hasAgent("phase-0")).toBe(false);

      // Multiple phases tracked simultaneously
      emitter.phaseStarted(wfId, 1, "Phase B");
      emitter.phaseStarted(wfId, 2, "Phase C");
      expect(timerService.hasAgent("phase-1")).toBe(true);
      expect(timerService.hasAgent("phase-2")).toBe(true);

      emitter.phaseCompleted(wfId, 1);
      expect(timerService.hasAgent("phase-1")).toBe(false);
      expect(timerService.hasAgent("phase-2")).toBe(true);

      emitter.phaseFailed(wfId, 2, "failed");
      expect(timerService.hasAgent("phase-2")).toBe(false);

      // Timer stops on workflow completion
      emitter.workflowCompleted(wfId);
      expect(timerService.isStopped()).toBe(true);
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

      // Events after disconnect should not affect store
      bus.emit({
        type: "workflow:started",
        workflowId: "w-after-disconnect",
        planPath: "plan.md",
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("idle");
    });

    it("reconnect to different bus works correctly", () => {
      const bus2 = new EventBus();
      adapter.disconnect();
      adapter.connect(bus2);

      bus2.emit({
        type: "workflow:started",
        workflowId: "w-new-bus",
        planPath: "reconnected-plan.md",
        timestamp: ts(),
      });
      expect(store.getState().workflowStatus).toBe("running");
      expect(store.getState().planName).toBe("reconnected-plan.md");
    });
  });

  // ── Navigation State ──

  describe("navigation state during workflow", () => {
    it("auto-selects latest started phase", () => {
      const wfId = "wf-nav";
      const emitter = createFlywheelEmitter(bus);

      emitter.workflowStarted(wfId, "plan.md");

      emitter.phaseStarted(wfId, 0, "Phase 0");
      expect(store.getState().selectedPhaseIndex).toBe(0);

      emitter.phaseCompleted(wfId, 0);
      emitter.phaseStarted(wfId, 1, "Phase 1");
      expect(store.getState().selectedPhaseIndex).toBe(1);

      emitter.phaseCompleted(wfId, 1);
      emitter.phaseStarted(wfId, 2, "Phase 2");
      expect(store.getState().selectedPhaseIndex).toBe(2);
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
    const store = createTestStore("test");
    const adapter = new OpenTUIAdapter({ actions: store });
    expect(adapter.adapterType).toBe("opentui");
  });

  // 'work' subcommand removed — all workflows go through TUI.

  it("TUI mode would select OpenTUIAdapter (adapterType check)", async () => {
    const result = await parseArgs([]);
    expect(result!.command).toBe("tui");
    // In TUI mode, CLI creates OpenTUIAdapter with store
    const store = createTestStore("plan.md");
    const adapter = new OpenTUIAdapter({ actions: store });
    expect(adapter.adapterType).toBe("opentui");
  });
});

// ── Emitter → Bus → Adapter → Store (no shortcuts) ──

describe("FlywheelEmitter → EventBus → OpenTUIAdapter → Store (full chain)", () => {
  it("emitter methods produce correct store mutations through entire chain", () => {
    timerService.reset();
    const bus = new EventBus();
    const store = createTestStore("chain-test");
    const adapter = new OpenTUIAdapter({ actions: store });
    adapter.connect(bus);
    adapter.start();

    const emitter = createFlywheelEmitter(bus);
    const wfId = "chain-wf-1";

    // Use the named emitter (same way WorkController does)
    emitter.workflowStarted(wfId, "chain-plan.md");
    expect(store.getState().workflowStatus).toBe("running");

    emitter.phaseStarted(wfId, 0, "Chain Phase");
    expect(store.getState().phases[0].name).toBe("Chain Phase");

    emitter.workerSpawned(wfId, 0, 0);
    // worker:spawned is suppressed from TUI output (only logged to file)
    expect(store.getState().phases).toHaveLength(1);
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
    expect(store.getState().phases[0].status).toBe("running");

    emitter.phaseCompleted(wfId, 0);
    expect(store.getState().phases[0].status).toBe("completed");

    emitter.workflowCompleted(wfId);
    expect(store.getState().workflowStatus).toBe("completed");

    adapter.stop();
    adapter.disconnect();
    timerService.reset();
  });
});
