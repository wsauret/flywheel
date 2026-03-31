import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// Store is now factory-based (no singleton to reset)
import { timerService } from "../src/tui/shared/services/timer";
import {
  createWorkflowSession,
  destroyWorkflowSession,
  type WorkflowSession,
} from "../src/tui/session/workflow-session";
import { createEscapeHandler, type EscapeHandler } from "../src/tui/utils/escape-handler";

/** Shell state — matches the AppState type used in flywheel-shell.tsx */
type ShellState = "idle" | "working" | "completed";

/** Minimal slash command parser for test harness (production uses parseHomeCommand) */
const KNOWN_COMMANDS = new Set(["exit", "new", "stop", "help"]);
function parseSlashCommand(input: string): { command: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIndex = trimmed.indexOf(" ");
  const rawCommand = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
  const command = rawCommand.toLowerCase();
  if (!command || !KNOWN_COMMANDS.has(command)) return null;
  return { command, args };
}

/**
 * Persistent Session Integration Test
 *
 * Exercises the full non-UI lifecycle that FlywheelShell orchestrates:
 *   idle → start workflow → complete → start another → stop → exit
 *
 * Integrates:
 *   - createWorkflowSession / destroyWorkflowSession
 *   - Store actions (startWorkflow, appendOutput, completeStep, stopWorkflow)
 *   - Timer service reset between runs
 *   - Slash command parsing in context of shell state
 *   - Escape handler state machine in context of workflow states
 *
 * Does NOT render TUI components (no OpenTUI runtime needed).
 */

function ts(): string {
  return new Date().toISOString();
}

/**
 * Simulates the FlywheelShell's state management logic without rendering.
 * Mirrors the real handleSubmit / handleEscape decision tree.
 */
class ShellSimulator {
  shellState: ShellState = "idle";
  runs: Array<{ id: string; planName: string; status: string; startTime: number; endTime?: number }> = [];
  activeSession: WorkflowSession | null = null;
  escapeHandler: EscapeHandler;
  escHint = "";
  exitCalled = false;

  // Pipeline pause state (mirrors flywheel-shell.tsx Step 5)
  isPipelineRunning = false;
  userInitiatedPause = false;
  pauseMessageEmitted = false;

  constructor() {
    this.escapeHandler = createEscapeHandler({ timeoutMs: 200 }); // fast timeout for tests
  }

  startWorkflow(planPath: string): void {
    // Clean up any previous session
    if (this.activeSession) {
      destroyWorkflowSession(this.activeSession);
      this.activeSession = null;
    }

    // Reset pause state on new workflow
    this.userInitiatedPause = false;
    this.pauseMessageEmitted = false;
    this.isPipelineRunning = false;

    const session = createWorkflowSession(planPath);
    this.activeSession = session;

    const planName = planPath.split("/").pop() ?? planPath;
    const runId = `run-${this.runs.length}`;
    this.runs.push({
      id: runId,
      planName,
      status: "running",
      startTime: Date.now(),
    });
    this.shellState = "working";

    // Subscribe to store for state updates → update runs
    session.store.subscribe(() => {
      const state = session.store.getState();
      const wfStatus = state.workflowStatus;
      const run = this.runs.find((r) => r.id === runId);
      if (run) {
        run.status = wfStatus;
        if (wfStatus === "completed" || wfStatus === "failed" || wfStatus === "interrupted") {
          run.endTime = Date.now();
        }
      }
      if (wfStatus === "completed" || wfStatus === "failed" || wfStatus === "interrupted") {
        this.shellState = "completed";
      }
    });
  }

  stopWorkflow(): void {
    this.escapeHandler.reset();
    this.escHint = "";
    if (this.activeSession) {
      destroyWorkflowSession(this.activeSession);
      this.activeSession = null;
    }
    this.shellState = "completed";
  }

  /**
   * Pause the pipeline (user-initiated via double-Esc).
   * Mirrors the pausePipeline() function in flywheel-shell.tsx.
   */
  pausePipeline(): void {
    this.userInitiatedPause = true;
    this.escapeHandler.reset();
    this.escHint = "";

    // Set suppressQueueError on the adapter before shutdown triggers pipeline:failed
    if (this.activeSession) {
      this.activeSession.adapter.suppressQueueError = true;
    }

    // Push pause message through event bus
    if (this.activeSession) {
      this.activeSession.eventBus.emit({
        type: "worker:output",
        workflowId: "pipeline-pause",
        stream: "stderr",
        data: "⏸ Pipeline paused. Resume with /work or select from session sidebar.\n",
        timestamp: new Date().toISOString(),
      });
      this.pauseMessageEmitted = true;
    }

    // Transition app state to completed (keeps output visible)
    this.shellState = "completed";
  }

  handleSubmit(input: string): void {
    const trimmed = input.trim();
    if (!trimmed) return;

    const cmd = parseSlashCommand(trimmed);
    if (cmd) {
      switch (cmd.command) {
        case "exit":
          this.exitCalled = true;
          return;
        case "new":
          this.stopWorkflow();
          this.runs = [];
          this.shellState = "idle";
          return;
        case "stop":
          if (this.shellState === "working") {
            this.stopWorkflow();
          }
          return;
        case "help":
          return;
      }
      return;
    }

    if (this.shellState === "idle" || this.shellState === "completed") {
      this.startWorkflow(trimmed);
    }
    // "working" state: steering text (no-op for now)
  }

  handleEscape(): void {
    if (this.shellState === "idle" || this.shellState === "completed") {
      this.exitCalled = true;
      return;
    }
    if (this.shellState === "working") {
      const result = this.escapeHandler.handleEscape();
      if (result === "interrupt") {
        this.escHint = "Press Esc again to kill worker";
      } else {
        this.escHint = "";
        // During pipeline: pause instead of full stop
        if (this.isPipelineRunning) {
          this.pausePipeline();
        } else {
          this.stopWorkflow();
        }
      }
    }
  }

  dispose(): void {
    this.escapeHandler.dispose();
    if (this.activeSession) {
      destroyWorkflowSession(this.activeSession);
      this.activeSession = null;
    }
  }
}

describe("Persistent Session Integration", () => {
  let shell: ShellSimulator;

  beforeEach(() => {
    timerService.reset();
    shell = new ShellSimulator();
  });

  afterEach(() => {
    shell.dispose();
    timerService.reset();
  });

  // ── Full lifecycle: idle → start → complete → start another → stop → exit ──

  describe("full lifecycle", () => {
    it("idle → start workflow → steps → complete → start another → complete", () => {
      // Initial state: idle
      expect(shell.shellState).toBe("idle");
      expect(shell.runs).toHaveLength(0);
      expect(shell.activeSession).toBeNull();

      // Submit a plan path → starts first workflow
      shell.handleSubmit("plans/build.md");
      expect(shell.shellState).toBe("working");
      expect(shell.runs).toHaveLength(1);
      expect(shell.runs[0].planName).toBe("build.md");
      expect(shell.activeSession).not.toBeNull();

      const session1 = shell.activeSession!;
      expect(session1.store.getState().workflowStatus).toBe("idle"); // not yet started via events
      expect(session1.adapter.isConnected()).toBe(true);
      expect(session1.adapter.isRunning()).toBe(true);

      // Start workflow via store action + queue event through the session's eventBus
      session1.store.startWorkflow("plans/build.md");
      session1.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(session1.store.getState().workflowStatus).toBe("running");

      // Output — stdout now goes to structured outputBlocks
      session1.eventBus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "Installing dependencies...\n",
        timestamp: ts(),
      });
      expect(session1.store.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);

      // Workflow completes
      session1.eventBus.emit({
        type: "queue:completed",
        workflowId: "w1",
        stepsCompleted: 1,
        timestamp: ts(),
      });
      expect(session1.store.getState().workflowStatus).toBe("completed");

      // Store subscription is throttled (16ms). In the real TUI, the shell state
      // transitions asynchronously. For this synchronous test, set it explicitly.
      shell.shellState = "completed";

      // Now start a second workflow by submitting a new plan path
      shell.handleSubmit("plans/deploy.md");
      expect(shell.shellState).toBe("working");
      expect(shell.runs).toHaveLength(2);
      expect(shell.runs[1].planName).toBe("deploy.md");

      // First session should have been destroyed, new one created
      const session2 = shell.activeSession!;
      expect(session2).not.toBe(session1);
      expect(session2.store.getState().workflowStatus).toBe("idle");
      expect(session2.store.getState().queueSteps).toHaveLength(0);
      expect(session2.store.getState().outputLines).toHaveLength(0);

      // Complete second workflow
      session2.store.startWorkflow("plans/deploy.md");
      session2.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w2",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      session2.eventBus.emit({
        type: "queue:completed",
        workflowId: "w2",
        stepsCompleted: 1,
        timestamp: ts(),
      });
      expect(session2.store.getState().workflowStatus).toBe("completed");
    });

    it("idle → start → /stop → completed → /new → idle → /exit", () => {
      // Start a workflow
      shell.handleSubmit("plans/test.md");
      expect(shell.shellState).toBe("working");

      const session = shell.activeSession!;
      session.store.startWorkflow("plans/test.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      // Stop with slash command
      shell.handleSubmit("/stop");
      expect(shell.shellState).toBe("completed");
      expect(shell.activeSession).toBeNull();

      // /new resets to idle
      shell.handleSubmit("/new");
      expect(shell.shellState).toBe("idle");
      expect(shell.runs).toHaveLength(0);

      // /exit sets exitCalled
      shell.handleSubmit("/exit");
      expect(shell.exitCalled).toBe(true);
    });
  });

  // ── Session isolation: no cross-contamination between runs ──

  describe("session isolation", () => {
    it("second session has zero contamination from first", () => {
      // First session with lots of state
      shell.handleSubmit("plan-A.md");
      const session1 = shell.activeSession!;

      session1.store.startWorkflow("plan-A.md");
      session1.eventBus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      for (let i = 0; i < 10; i++) {
        session1.eventBus.emit({
          type: "worker:output",
          workflowId: "w1",
          stream: "stdout",
          data: `line ${i}\n`,
          timestamp: ts(),
        });
      }
      session1.eventBus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });

      // Verify first session has accumulated state
      // Stdout worker:output now goes to structured outputBlocks, not outputLines
      expect(session1.store.getState().outputBlocks.length).toBeGreaterThanOrEqual(1);
      expect(session1.store.getState().workflowStatus).toBe("completed");

      // Store subscription is throttled — set shell state explicitly for sync test
      shell.shellState = "completed";

      // Start second session (first is destroyed automatically in startWorkflow)
      shell.handleSubmit("plan-B.md");
      const session2 = shell.activeSession!;

      // Second session must be completely clean
      expect(session2.store.getState().workflowStatus).toBe("idle");
      expect(session2.store.getState().queueSteps).toHaveLength(0);
      expect(session2.store.getState().outputLines).toHaveLength(0);
      expect(session2.store.getState().planName).toBe("plan-B.md");
      expect(session2.timer.getStatus()).toBe("idle");
    });

    it("destroying session stops events from reaching store", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;

      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(session.store.getState().workflowStatus).toBe("running");

      // Stop the workflow (destroys session)
      shell.handleSubmit("/stop");
      expect(shell.activeSession).toBeNull();

      // Events on the old event bus should not update the store
      session.eventBus.emit({
        type: "queue:completed",
        workflowId: "w1",
        stepsCompleted: 1,
        timestamp: ts(),
      });
      // Store still shows 'running' because adapter is disconnected
      expect(session.store.getState().workflowStatus).toBe("running");
    });
  });

  // ── Timer service integration ──

  describe("timer service lifecycle", () => {
    it("each session has its own fresh timer", () => {
      // First session
      shell.handleSubmit("plan-1.md");
      const session1 = shell.activeSession!;
      session1.store.startWorkflow("plan-1.md");
      session1.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(session1.timer.isRunning()).toBe(true);

      // Stop first — timer is stopped (not reset, since destroy calls .stop())
      shell.handleSubmit("/stop");
      expect(session1.timer.isStopped()).toBe(true);

      // Second session gets a fresh timer
      shell.handleSubmit("plan-2.md");
      const session2 = shell.activeSession!;
      // New session timer is idle (fresh instance)
      expect(session2.timer.getStatus()).toBe("idle");

      // Start events on second session
      session2.store.startWorkflow("plan-2.md");
      session2.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w2",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(session2.timer.isRunning()).toBe(true);

      shell.handleSubmit("/stop");
      expect(session2.timer.isStopped()).toBe(true);
    });

    it("timer agents are cleaned up when session is destroyed", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;

      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      session.timer.registerAgent("step-0");
      expect(session.timer.hasAgent("step-0")).toBe(true);

      // Stop workflow → destroys session → stops timer
      shell.handleSubmit("/stop");
      expect(session.timer.isStopped()).toBe(true);
    });
  });

  // ── Slash commands in context of shell state ──

  describe("slash commands in shell state context", () => {
    it("/stop is no-op when idle", () => {
      expect(shell.shellState).toBe("idle");
      shell.handleSubmit("/stop");
      expect(shell.shellState).toBe("idle"); // unchanged
    });

    it("/stop stops workflow when working", () => {
      shell.handleSubmit("plan.md");
      expect(shell.shellState).toBe("working");

      shell.handleSubmit("/stop");
      expect(shell.shellState).toBe("completed");
      expect(shell.activeSession).toBeNull();
    });

    it("/new during working stops and resets to idle", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(shell.shellState).toBe("working");

      shell.handleSubmit("/new");
      expect(shell.shellState).toBe("idle");
      expect(shell.runs).toHaveLength(0);
      expect(shell.activeSession).toBeNull();
    });

    it("/new during completed clears runs and resets to idle", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      session.eventBus.emit({
        type: "queue:completed",
        workflowId: "w1",
        stepsCompleted: 1,
        timestamp: ts(),
      });

      shell.handleSubmit("/new");
      expect(shell.shellState).toBe("idle");
      expect(shell.runs).toHaveLength(0);
    });

    it("/exit always triggers exit regardless of state", () => {
      shell.handleSubmit("/exit");
      expect(shell.exitCalled).toBe(true);
    });

    it("empty input is ignored", () => {
      shell.handleSubmit("");
      expect(shell.shellState).toBe("idle");
      shell.handleSubmit("   ");
      expect(shell.shellState).toBe("idle");
    });

    it("unrecognized slash commands are treated as plan paths", () => {
      // parseSlashCommand returns null for unknown commands,
      // so they're treated as regular input (plan path when idle)
      shell.handleSubmit("/foobar");
      expect(shell.shellState).toBe("working");
      expect(shell.runs[0].planName).toBe("foobar"); // split("/").pop() strips leading /
    });

    it("non-slash input during working is treated as steering (no-op)", () => {
      shell.handleSubmit("plan.md");
      expect(shell.shellState).toBe("working");
      expect(shell.runs).toHaveLength(1);

      // Typing during working state should not start a new workflow
      shell.handleSubmit("some steering text");
      expect(shell.runs).toHaveLength(1); // no new run added
      expect(shell.shellState).toBe("working");
    });
  });

  // ── Escape handler in context of workflow states ──

  describe("escape handler in workflow context", () => {
    it("Esc when idle triggers exit", () => {
      expect(shell.shellState).toBe("idle");
      shell.handleEscape();
      expect(shell.exitCalled).toBe(true);
    });

    it("Esc when completed triggers exit", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      session.eventBus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });

      // shellState transitions to completed via store subscription,
      // but subscription is throttled (16ms). Manually set for this test.
      shell.shellState = "completed";

      shell.handleEscape();
      expect(shell.exitCalled).toBe(true);
    });

    it("single Esc when working shows hint, does not stop", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(shell.shellState).toBe("working");

      shell.handleEscape();
      expect(shell.escHint).toBe("Press Esc again to kill worker");
      expect(shell.shellState).toBe("working"); // still working
      expect(shell.activeSession).not.toBeNull(); // session still alive
    });

    it("double Esc when working stops the workflow", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(shell.shellState).toBe("working");

      // First Esc → hint
      shell.handleEscape();
      expect(shell.escHint).toBe("Press Esc again to kill worker");

      // Second Esc → stop
      shell.handleEscape();
      expect(shell.escHint).toBe("");
      expect(shell.shellState).toBe("completed");
      expect(shell.activeSession).toBeNull();
    });

    it("Esc hint resets after timeout, requires fresh double-Esc", async () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      // First Esc → hint
      shell.handleEscape();
      expect(shell.escHint).toBe("Press Esc again to kill worker");

      // Wait for timeout (200ms in test config)
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Esc after timeout → hint again (not stop)
      shell.handleEscape();
      expect(shell.escHint).toBe("Press Esc again to kill worker");
      expect(shell.shellState).toBe("working"); // still working
    });
  });

  // ── Store subscription drives shell state transitions ──

  describe("store subscription state transitions", () => {
    it("queue:completed transitions shell to completed", (done) => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;

      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      expect(shell.shellState).toBe("working");

      session.eventBus.emit({
        type: "queue:completed",
        workflowId: "w1",
        stepsCompleted: 1,
        timestamp: ts(),
      });

      // Store subscription is throttled at 16ms, wait for it
      setTimeout(() => {
        expect(shell.shellState).toBe("completed");
        expect(shell.runs[0].status).toBe("completed");
        expect(shell.runs[0].endTime).toBeDefined();
        done();
      }, 50);
    });

    it("queue:failed transitions shell to completed", (done) => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;

      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      session.eventBus.emit({
        type: "queue:failed",
        workflowId: "w1",
        reason: "Something went wrong",
        stepsCompleted: 0,
        timestamp: ts(),
      });

      setTimeout(() => {
        expect(shell.shellState).toBe("completed");
        expect(shell.runs[0].status).toBe("failed");
        done();
      }, 50);
    });

    it("run entry tracks correct plan names across multiple runs", () => {
      shell.handleSubmit("path/to/first-plan.md");
      expect(shell.runs[0].planName).toBe("first-plan.md");

      // Complete first
      const s1 = shell.activeSession!;
      s1.store.startWorkflow("first-plan.md");
      s1.eventBus.emit({ type: "queue:initialized", workflowId: "w1", stepIds: ["s1"], timestamp: ts() });
      s1.eventBus.emit({ type: "queue:completed", workflowId: "w1", stepsCompleted: 1, timestamp: ts() });

      // Throttled subscription — set shell state explicitly for sync test
      shell.shellState = "completed";

      // Start second
      shell.handleSubmit("another/second-plan.md");
      expect(shell.runs).toHaveLength(2);
      expect(shell.runs[0].planName).toBe("first-plan.md");
      expect(shell.runs[1].planName).toBe("second-plan.md");
    });
  });

  // ── Double-Esc Pause Behavior ──

  describe("double-Esc pause behavior", () => {
    it("double-Esc during pipeline sets session state to work:paused", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      // Simulate pipeline running
      shell.isPipelineRunning = true;

      // First Esc → hint
      shell.handleEscape();
      expect(shell.escHint).toBe("Press Esc again to kill worker");
      expect(shell.shellState).toBe("working");

      // Second Esc → pause (not full teardown)
      shell.handleEscape();
      expect(shell.shellState).toBe("completed");
      expect(shell.userInitiatedPause).toBe(true);
      // Session adapter should have suppressQueueError set
      expect(session.adapter.suppressQueueError).toBe(true);
    });

    it("queue:failed is NOT turned into ErrorModal when suppressQueueError is set", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      // Set suppress flag on adapter (as pause would)
      session.adapter.suppressQueueError = true;

      // Emit queue:failed (happens internally when shutdown is requested)
      session.eventBus.emit({
        type: "queue:failed",
        workflowId: "w1",
        reason: "Pipeline shut down",
        stepsCompleted: 0,
        timestamp: ts(),
      });

      // Error should NOT be set on the store (no ErrorModal)
      expect(session.store.getState().error).toBeUndefined();
    });

    it("pause pushes system text to output", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      shell.isPipelineRunning = true;

      // Double-Esc to pause
      shell.handleEscape();
      shell.handleEscape();

      // Check that pause message was emitted through event bus
      expect(shell.pauseMessageEmitted).toBe(true);
    });

    it("userInitiatedPause flag distinguishes pause from failure", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      // Normal stop (not pipeline) — userInitiatedPause stays false
      shell.handleSubmit("/stop");
      expect(shell.userInitiatedPause).toBe(false);
      expect(shell.shellState).toBe("completed");
    });

    it("userInitiatedPause is true only for double-Esc during pipeline", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      shell.isPipelineRunning = true;

      // Double-Esc
      shell.handleEscape();
      shell.handleEscape();

      expect(shell.userInitiatedPause).toBe(true);
    });

    it("userInitiatedPause resets when starting a new workflow", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });
      shell.isPipelineRunning = true;

      // Double-Esc to pause
      shell.handleEscape();
      shell.handleEscape();
      expect(shell.userInitiatedPause).toBe(true);

      // Start new workflow
      shell.handleSubmit("plan-2.md");
      expect(shell.userInitiatedPause).toBe(false);
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("starting workflow while another is running destroys the first", () => {
      shell.handleSubmit("plan-1.md");
      const session1 = shell.activeSession!;
      session1.store.startWorkflow("plan-1.md");
      session1.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      // Force shell state to completed so handleSubmit treats next input as plan path
      shell.shellState = "completed";

      shell.handleSubmit("plan-2.md");
      const session2 = shell.activeSession!;

      // session1's adapter should be disconnected
      expect(session1.adapter.isConnected()).toBe(false);
      expect(session1.adapter.isRunning()).toBe(false);

      // session2 is fresh
      expect(session2.adapter.isConnected()).toBe(true);
      expect(session2.adapter.isRunning()).toBe(true);
      expect(session2.store.getState().workflowStatus).toBe("idle");
    });

    it("/stop when already idle is harmless", () => {
      shell.handleSubmit("/stop");
      expect(shell.shellState).toBe("idle");
      expect(shell.activeSession).toBeNull();
    });

    it("/new when already idle is harmless", () => {
      shell.handleSubmit("/new");
      expect(shell.shellState).toBe("idle");
      expect(shell.runs).toHaveLength(0);
    });

    it("multiple /stop calls are idempotent", () => {
      shell.handleSubmit("plan.md");
      const session = shell.activeSession!;
      session.store.startWorkflow("plan.md");
      session.eventBus.emit({
        type: "queue:initialized",
        workflowId: "w1",
        stepIds: ["s1"],
        timestamp: ts(),
      });

      shell.handleSubmit("/stop");
      expect(shell.shellState).toBe("completed");

      // Second /stop is no-op (not in working state)
      shell.handleSubmit("/stop");
      expect(shell.shellState).toBe("completed");
    });

    it("rapid start-stop-start cycle maintains clean state", () => {
      // Start first
      shell.handleSubmit("plan-1.md");
      expect(shell.shellState).toBe("working");

      // Immediately stop
      shell.handleSubmit("/stop");
      expect(shell.shellState).toBe("completed");
      expect(shell.activeSession).toBeNull();

      // Start second
      shell.handleSubmit("plan-2.md");
      expect(shell.shellState).toBe("working");
      const session = shell.activeSession!;
      expect(session.store.getState().workflowStatus).toBe("idle");
      expect(session.store.getState().queueSteps).toHaveLength(0);
      expect(session.store.getState().outputLines).toHaveLength(0);
    });
  });
});
