import { describe, it, expect } from "bun:test";
import {
  escapeForState,
  ctrlCForState,
  layoutVisibility,
  assertNever,
  MIN_WIDTH_PANEL,
  MIN_WIDTH_SIDEBAR,
  SIDEBAR_WIDTH,
  PANEL_WIDTH,
  type AppState,
} from "../src/tui/shell/shell-modes";
import {
  computeQueueProgress,
  statusLabel,
} from "../src/tui/components/workflow-panel-logic";
import {
  formatSessionStatus,
  type SessionHeaderInfo,
} from "../src/tui/components/session-header-logic";

/**
 * Shell Redesign Tests
 *
 * Tests the pure logic extracted into shell-modes.ts and workflow-panel-logic.ts:
 *   - AppState escape behavior
 *   - AppState Ctrl+C behavior
 *   - Responsive layout collapse thresholds
 *   - assertNever exhaustiveness guard
 *   - WorkflowPanel progress computation
 *   - WorkflowPanel status label mapping
 *   - SessionHeader status formatting
 */

// ---------------------------------------------------------------------------
// AppState escape behavior
// ---------------------------------------------------------------------------

describe("escapeForState", () => {
  it("idle -> exit-tui", () => {
    expect(escapeForState("idle")).toBe("exit-tui");
  });

  it("working -> double-esc-stop", () => {
    expect(escapeForState("working")).toBe("double-esc-stop");
  });

  it("completed -> return-idle", () => {
    expect(escapeForState("completed")).toBe("return-idle");
  });

  it("importing -> cancel-import", () => {
    expect(escapeForState("importing")).toBe("cancel-import");
  });

  it("covers all four states", () => {
    const states: AppState[] = ["idle", "working", "completed", "importing"];
    for (const state of states) {
      expect(() => escapeForState(state)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// AppState Ctrl+C behavior
// ---------------------------------------------------------------------------

describe("ctrlCForState", () => {
  it("idle -> exit-tui", () => {
    expect(ctrlCForState("idle")).toBe("exit-tui");
  });

  it("working -> stop-workflow", () => {
    expect(ctrlCForState("working")).toBe("stop-workflow");
  });

  it("completed -> return-idle", () => {
    expect(ctrlCForState("completed")).toBe("return-idle");
  });

  it("importing -> exit-tui", () => {
    expect(ctrlCForState("importing")).toBe("exit-tui");
  });
});

// ---------------------------------------------------------------------------
// Responsive layout
// ---------------------------------------------------------------------------

describe("layoutVisibility", () => {
  it("wide terminal (160 cols) -> both sidebar and panel visible", () => {
    const vis = layoutVisibility(160);
    expect(vis.showSidebar).toBe(true);
    expect(vis.showPanel).toBe(true);
  });

  it("medium terminal (110 cols) -> sidebar visible, panel hidden", () => {
    const vis = layoutVisibility(110);
    expect(vis.showSidebar).toBe(true);
    expect(vis.showPanel).toBe(false);
  });

  it("narrow terminal (80 cols) -> both hidden", () => {
    const vis = layoutVisibility(80);
    expect(vis.showSidebar).toBe(false);
    expect(vis.showPanel).toBe(false);
  });

  it("exact threshold: width=120 shows panel", () => {
    const vis = layoutVisibility(MIN_WIDTH_PANEL);
    expect(vis.showPanel).toBe(true);
  });

  it("exact threshold: width=90 shows sidebar", () => {
    const vis = layoutVisibility(MIN_WIDTH_SIDEBAR);
    expect(vis.showSidebar).toBe(true);
  });

  it("one below threshold: width=119 hides panel", () => {
    const vis = layoutVisibility(MIN_WIDTH_PANEL - 1);
    expect(vis.showPanel).toBe(false);
  });

  it("one below threshold: width=89 hides sidebar", () => {
    const vis = layoutVisibility(MIN_WIDTH_SIDEBAR - 1);
    expect(vis.showSidebar).toBe(false);
  });

  it("exports correct constant values", () => {
    expect(MIN_WIDTH_PANEL).toBe(120);
    expect(MIN_WIDTH_SIDEBAR).toBe(90);
    expect(SIDEBAR_WIDTH).toBe(25);
    expect(PANEL_WIDTH).toBe(38);
  });
});

// ---------------------------------------------------------------------------
// assertNever
// ---------------------------------------------------------------------------

describe("assertNever", () => {
  it("throws with descriptive message for unexpected value", () => {
    expect(() => assertNever("bogus" as never)).toThrow(
      "Unexpected value: bogus"
    );
  });
});

// ---------------------------------------------------------------------------
// WorkflowPanel -- computeProgress
// ---------------------------------------------------------------------------

describe("computeQueueProgress", () => {
  it("counts all step statuses correctly", () => {
    const steps = [
      { id: "s1", type: "work", title: "A", status: "completed" as const },
      { id: "s2", type: "work", title: "B", status: "running" as const },
      { id: "s3", type: "work", title: "C", status: "failed" as const },
      { id: "s4", type: "work", title: "D", status: "pending" as const },
    ];
    const result = computeQueueProgress(steps);
    expect(result.completed).toBe(1);
    expect(result.running).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(4);
  });

  it("returns zeros for empty steps", () => {
    const result = computeQueueProgress([]);
    expect(result.completed).toBe(0);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);
  });

  it("counts all completed steps", () => {
    const steps = [
      { id: "s1", type: "work", title: "A", status: "completed" as const },
      { id: "s2", type: "work", title: "B", status: "completed" as const },
    ];
    const result = computeQueueProgress(steps);
    expect(result.completed).toBe(2);
    expect(result.total).toBe(2);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles skipped steps (not counted as completed, running, or failed)", () => {
    const steps = [
      { id: "s1", type: "work", title: "A", status: "completed" as const },
      { id: "s2", type: "work", title: "B", status: "skipped" as const },
      { id: "s3", type: "work", title: "C", status: "pending" as const },
    ];
    const result = computeQueueProgress(steps);
    expect(result.completed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// WorkflowPanel -- statusLabel
// ---------------------------------------------------------------------------

describe("statusLabel", () => {
  it("maps idle -> Idle", () => {
    expect(statusLabel("idle")).toBe("Idle");
  });

  it("maps running -> Running", () => {
    expect(statusLabel("running")).toBe("Running");
  });

  it("maps completed -> Completed", () => {
    expect(statusLabel("completed")).toBe("Completed");
  });

  it("maps failed -> Failed", () => {
    expect(statusLabel("failed")).toBe("Failed");
  });

  it("maps interrupted -> Interrupted", () => {
    expect(statusLabel("interrupted")).toBe("Interrupted");
  });

  it("maps stopping -> Stopping", () => {
    expect(statusLabel("stopping")).toBe("Stopping");
  });
});

// ---------------------------------------------------------------------------
// SessionHeader -- formatSessionStatus
// ---------------------------------------------------------------------------

describe("formatSessionStatus", () => {
  it("returns empty string when no step or branch", () => {
    const info: SessionHeaderInfo = { sessionName: "test" };
    expect(formatSessionStatus(info)).toBe("");
  });

  it("shows running step icon", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentStep: "Build",
      stepStatus: "running",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u25d3"); // ◓
    expect(result).toContain("Build");
  });

  it("shows completed step icon", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentStep: "Setup",
      stepStatus: "completed",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u25cf"); // ●
    expect(result).toContain("Setup");
  });

  it("shows failed step icon", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentStep: "Deploy",
      stepStatus: "failed",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u2717"); // ✗
    expect(result).toContain("Deploy");
  });

  it("shows pending step icon for unknown status", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentStep: "Init",
      stepStatus: "pending",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u25cb"); // ○
  });

  it("shows branch when provided", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      branch: "feature/shell-redesign",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u2387"); // ⎇
    expect(result).toContain("feature/shell-redesign");
  });

  it("shows both step and branch separated by double space", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentStep: "Build",
      stepStatus: "running",
      branch: "main",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u25d3 Build");
    expect(result).toContain("\u2387 main");
    expect(result).toContain("  "); // double space separator
  });
});
