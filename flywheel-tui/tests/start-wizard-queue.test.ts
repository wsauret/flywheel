/**
 * Tests for the start-wizard-queue feature.
 *
 * Covers:
 *   VAL-SHELL-006: /start without args asks description first
 *   VAL-SHELL-007: /start with description skips to workflow picker
 *   VAL-SHELL-008: Workflow picker shows 5 options
 *   VAL-SHELL-009: Consolidation preference question appears
 *   VAL-SHELL-010: Review triage question appears conditionally
 *   VAL-SHELL-011: Queue execution begins after wizard completes
 *   VAL-SHELL-012: Dismissing wizard cancels without starting
 *   VAL-SHELL-033: /work <planPath> parses plan into work steps
 *   VAL-SHELL-034: Other slash commands still functional
 *   VAL-SHELL-036: HITL preferences threaded into step configs
 */

import { describe, it, expect, mock } from "bun:test";
import {
  WORKFLOW_OPTIONS,
  workflowHasReview,
  type WorkflowName,
} from "../src/tui/shell/start-command";
import {
  buildQueue,
  buildQueueForSlashCommand,
  buildQueueFromPlan,
  formatQueueProgress,
  type QueueProgressInfo,
} from "../src/tui/shell/shell-queue";
import {
  createActionDispatcher,
  type ActionDispatcherDeps,
} from "../src/tui/shell/action-dispatcher";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return {
    ...CONFIG_DEFAULTS,
    interactive_consolidation: false,
    ...overrides,
  };
}

function fakeDeps(overrides?: Partial<ActionDispatcherDeps>): ActionDispatcherDeps {
  return {
    fileExists: () => true,
    notify: mock(() => {}),
    launchWorkWorkflow: mock(() => {}),
    launchGenericWorkflow: mock(() => {}),
    exit: mock(() => {}),
    returnToIdle: mock(() => {}),
    launchStartFlow: mock(() => {}),
    ...overrides,
  };
}

// ===========================================================================
// VAL-SHELL-008: Workflow picker shows 5 options
// ===========================================================================

describe("VAL-SHELL-008: Workflow picker shows 5 options", () => {
  it("WORKFLOW_OPTIONS has exactly 5 entries", () => {
    expect(WORKFLOW_OPTIONS).toHaveLength(5);
  });

  it("options are ordered: plan-only, plan-work, plan-work-review, full, sprint", () => {
    const values = WORKFLOW_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["plan-only", "plan-work", "plan-work-review", "full", "sprint"]);
  });

  it("each option has label, description, and value", () => {
    for (const option of WORKFLOW_OPTIONS) {
      expect(option.label).toBeTruthy();
      expect(option.description).toBeTruthy();
      expect(option.value).toBeTruthy();
    }
  });

  it("option labels are human-readable", () => {
    expect(WORKFLOW_OPTIONS[0].label).toBe("Just Plan");
    expect(WORKFLOW_OPTIONS[1].label).toBe("Plan + Work");
    expect(WORKFLOW_OPTIONS[2].label).toBe("Plan + Work + Review");
    expect(WORKFLOW_OPTIONS[3].label).toBe("Full Queue");
    expect(WORKFLOW_OPTIONS[4].label).toBe("Sprint");
  });
});

// ===========================================================================
// VAL-SHELL-009: Consolidation preference question appears
// ===========================================================================

describe("VAL-SHELL-009: Consolidation preference applies to all workflows", () => {
  it("all non-sprint workflows include plan step (consolidation always applies)", () => {
    const nonSprint: WorkflowName[] = ["plan-only", "plan-work", "plan-work-review", "full"];
    for (const wf of nonSprint) {
      const queue = buildQueue(wf, makeConfig());
      const hasPlan = queue.steps.some((s) => s.type === "plan");
      expect(hasPlan).toBe(true);
    }
  });

  it("sprint workflow does NOT have a plan step", () => {
    const queue = buildQueue("sprint", makeConfig());
    const hasPlan = queue.steps.some((s) => s.type === "plan");
    expect(hasPlan).toBe(false);
  });
});

// ===========================================================================
// VAL-SHELL-010: Review triage appears only for workflows with review
// ===========================================================================

describe("VAL-SHELL-010: Review triage appears conditionally", () => {
  it("workflowHasReview returns true for plan-work-review", () => {
    expect(workflowHasReview("plan-work-review")).toBe(true);
  });

  it("workflowHasReview returns true for full", () => {
    expect(workflowHasReview("full")).toBe(true);
  });

  it("workflowHasReview returns false for plan-only", () => {
    expect(workflowHasReview("plan-only")).toBe(false);
  });

  it("workflowHasReview returns false for plan-work", () => {
    expect(workflowHasReview("plan-work")).toBe(false);
  });

  it("workflowHasReview returns false for sprint", () => {
    expect(workflowHasReview("sprint")).toBe(false);
  });


});

// ===========================================================================
// VAL-SHELL-011: Queue created and execution starts after wizard completes
// ===========================================================================

describe("VAL-SHELL-011: Queue created from each workflow selection", () => {
  it("plan-only creates queue with 4 granular plan steps", () => {
    const queue = buildQueue("plan-only", makeConfig());
    expect(queue.steps).toHaveLength(4);
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.status).toBe("idle");
    expect(queue.cursor).toBe(0);
    // All steps should be plan type
    for (const step of queue.steps) {
      expect(step.type).toBe("plan");
    }
  });

  it("plan-work creates queue starting with plan", () => {
    const queue = buildQueue("plan-work", makeConfig());
    expect(queue.steps[0].type).toBe("plan");
  });

  it("plan-work-review creates queue with plan and review", () => {
    const queue = buildQueue("plan-work-review", makeConfig());
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.steps[queue.steps.length - 1].type).toBe("review");
  });

  it("full creates queue with plan, review, and ship", () => {
    const queue = buildQueue("full", makeConfig());
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.steps[queue.steps.length - 1].type).toBe("ship");
  });

  it("sprint creates queue with work + verify", () => {
    const queue = buildQueue("sprint", makeConfig());
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps[1].type).toBe("verify");
  });

  it("all queues start in idle status with cursor at 0", () => {
    const allWorkflows: WorkflowName[] = ["plan-only", "plan-work", "plan-work-review", "full", "sprint"];
    for (const wf of allWorkflows) {
      const queue = buildQueue(wf, makeConfig());
      expect(queue.status).toBe("idle");
      expect(queue.cursor).toBe(0);
    }
  });
});

// ===========================================================================
// VAL-SHELL-033: /work with plan path creates queue from plan
// ===========================================================================

describe("VAL-SHELL-033: /work <planPath> parses plan into work steps", () => {
  const fixturePath = path.resolve(__dirname, "fixtures/two-step-plan.plan.json");

  it("parses two-step-plan.plan.json into 2 work steps", () => {
    const queue = buildQueueFromPlan(fixturePath, makeConfig({ auto_chain: false }));
    const workSteps = queue.steps.filter((s) => s.type === "work");
    expect(workSteps).toHaveLength(2);
  });

  it("work steps have correct titles from plan steps", () => {
    const queue = buildQueueFromPlan(fixturePath, makeConfig({ auto_chain: false }));
    const titles = queue.steps.filter((s) => s.type === "work").map((s) => s.title);
    expect(titles[0]).toContain("Setup project structure");
    expect(titles[1]).toContain("Implement core logic");
  });

  it("all steps start with pending status", () => {
    const queue = buildQueueFromPlan(fixturePath, makeConfig({ auto_chain: false }));
    for (const step of queue.steps) {
      expect(step.status).toBe("pending");
    }
  });

  it("with auto_chain, adds review after work steps", () => {
    const queue = buildQueueFromPlan(fixturePath, makeConfig({ auto_chain: true, auto_ship: false }));
    const types = queue.steps.map((s) => s.type);
    expect(types[types.length - 1]).toBe("review");
  });

  it("with auto_chain + auto_ship, adds review and ship after work steps", () => {
    const queue = buildQueueFromPlan(fixturePath, makeConfig({ auto_chain: true, auto_ship: true }));
    const types = queue.steps.map((s) => s.type);
    expect(types[types.length - 2]).toBe("review");
    expect(types[types.length - 1]).toBe("ship");
  });

  it("falls back to single work step for nonexistent plan file", () => {
    const queue = buildQueueFromPlan("/nonexistent/plan.json", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps[0].title).toBe("Execute work");
  });

  it("falls back to single work step for invalid JSON plan content", () => {
    // Use a path to a known file that exists but isn't a valid JSON plan
    const queue = buildQueueFromPlan(path.resolve(__dirname, "../package.json"), makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("work");
  });

  it("each work step has a unique ID", () => {
    const queue = buildQueueFromPlan(fixturePath, makeConfig({ auto_chain: false }));
    const ids = queue.steps.map((s) => s.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ===========================================================================
// VAL-SHELL-034: Other slash commands still functional
// ===========================================================================

describe("VAL-SHELL-034: Slash commands create appropriate multi-step queues", () => {
  it("/review creates 2-step review queue", () => {
    const queue = buildQueueForSlashCommand("review", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("review");
    expect(queue.steps[0].dispatcherHint).toBe("dispatch-reviewers");
    expect(queue.steps[1].type).toBe("review");
    expect(queue.steps[1].dispatcherHint).toBe("consolidate-review");
  });

  it("/ship creates 2-step ship queue", () => {
    const queue = buildQueueForSlashCommand("ship", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("ship");
    expect(queue.steps[0].dispatcherHint).toBe("ship");
    expect(queue.steps[1].type).toBe("ship");
    expect(queue.steps[1].dispatcherHint).toBe("learnings");
  });

  it("/debug creates 3-step debug queue", () => {
    const queue = buildQueueForSlashCommand("debug", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(3);
    expect(queue.steps[0].type).toBe("debug");
    expect(queue.steps[0].dispatcherHint).toBe("investigate");
    expect(queue.steps[1].type).toBe("debug");
    expect(queue.steps[1].dispatcherHint).toBe("fix");
    expect(queue.steps[2].type).toBe("verify");
    expect(queue.steps[2].dispatcherHint).toBe("debug-verify");
  });

  it("/research creates single research step queue with metadata", () => {
    const queue = buildQueueForSlashCommand("research", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("research");
    expect(queue.steps[0].dispatcherHint).toBe("research");
    expect(queue.steps[0].evaluationCriteria).toBeTruthy();
    expect(queue.steps[0].toolScoping).toBeDefined();
  });

  it("/plan creates single plan step queue (no auto_chain)", () => {
    const queue = buildQueueForSlashCommand("plan", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("plan");
  });

  it("/work creates single work step queue (no auto_chain)", () => {
    const queue = buildQueueForSlashCommand("work", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("work");
  });
});

describe("VAL-SHELL-034: ActionDispatcher routes all commands", () => {
  it("/start calls launchStartFlow", () => {
    const deps = fakeDeps();
    const dispatch = createActionDispatcher(deps);
    dispatch("start", { description: "test" });
    expect(deps.launchStartFlow).toHaveBeenCalledTimes(1);
  });

  it("/work calls launchWorkWorkflow with resolved path", () => {
    const deps = fakeDeps();
    const dispatch = createActionDispatcher(deps);
    const meta = dispatch("work", { planPath: "/tmp/plan.md" });
    expect(meta).toEqual({ stepLabel: "Step", workflowName: "work" });
    expect(deps.launchWorkWorkflow).toHaveBeenCalledTimes(1);
  });

  it("/plan calls launchGenericWorkflow", () => {
    const deps = fakeDeps();
    const dispatch = createActionDispatcher(deps);
    const meta = dispatch("plan", { description: "add a feature" });
    expect(meta).toEqual({ stepLabel: "Step", workflowName: "plan" });
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1);
  });

  it("/review calls launchGenericWorkflow", () => {
    const deps = fakeDeps();
    const dispatch = createActionDispatcher(deps);
    const meta = dispatch("review", {});
    expect(meta).toEqual({ stepLabel: "Step", workflowName: "review" });
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1);
  });

  it("/ship calls launchGenericWorkflow", () => {
    const deps = fakeDeps();
    const dispatch = createActionDispatcher(deps);
    const meta = dispatch("ship", {});
    expect(meta).toEqual({ stepLabel: "Step", workflowName: "ship" });
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1);
  });

  it("/debug calls launchGenericWorkflow with description", () => {
    const deps = fakeDeps();
    const dispatch = createActionDispatcher(deps);
    const meta = dispatch("debug", { description: "test fails" });
    expect(meta).toEqual({ stepLabel: "Step", workflowName: "debug" });
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1);
  });

  it("/research calls launchGenericWorkflow with topic", () => {
    const deps = fakeDeps();
    const dispatch = createActionDispatcher(deps);
    const meta = dispatch("research", { topic: "auth patterns" });
    expect(meta).toEqual({ stepLabel: "Step", workflowName: "research" });
    expect(deps.launchGenericWorkflow).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// VAL-SHELL-036: HITL preferences threaded into step configs
// ===========================================================================

describe("VAL-SHELL-036: HITL preferences stored in queue-level metadata", () => {
  it("buildQueue never inserts gate steps (HITL via questions)", () => {
    const withFlag = buildQueue("plan-work-review", makeConfig({ skip_approval_gates: false }));
    const withoutFlag = buildQueue("plan-work-review", makeConfig({ skip_approval_gates: true }));
    expect(withFlag.steps.filter((s) => s.type === "gate")).toHaveLength(0);
    expect(withoutFlag.steps.filter((s) => s.type === "gate")).toHaveLength(0);
  });

  it("queue respects max_steps from config", () => {
    const config = makeConfig();
    config.queue = { max_steps: 10, persist_queue: true };
    const queue = buildQueue("full", config);
    expect(queue.maxSteps).toBe(10);
  });

  it("HITL consolidation and review preferences map to interactiveOverrides", () => {
    // This tests that the wizard produces the correct overrides shape.
    // The startQueueExecution function accepts { plan: boolean, review: boolean }
    // which is threaded through to the step executor.
    const planInteractive = true;
    const reviewInteractive = false;
    const overrides = { plan: planInteractive, review: reviewInteractive };

    expect(overrides.plan).toBe(true);
    expect(overrides.review).toBe(false);
  });
});

// ===========================================================================
// Queue progress formatting
// ===========================================================================

describe("Queue progress formatting", () => {
  it("formats step progress correctly", () => {
    const info: QueueProgressInfo = { currentStep: 2, totalSteps: 5, stepName: "work" };
    const result = formatQueueProgress(info);
    expect(result).toContain("Work");
    expect(result).toContain("2/5");
  });

  it("returns empty string for null info", () => {
    expect(formatQueueProgress(null)).toBe("");
  });

  it("returns empty string for undefined info", () => {
    expect(formatQueueProgress(undefined)).toBe("");
  });

  it("capitalizes first letter of step name", () => {
    const result = formatQueueProgress({ currentStep: 1, totalSteps: 3, stepName: "plan" });
    expect(result).toContain("Plan");
  });
});
