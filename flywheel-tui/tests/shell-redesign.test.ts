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
} from "../src/tui/components/shell-modes";
import {
  computeProgress,
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

describe("computeProgress", () => {
  it("counts all phase statuses correctly", () => {
    const phases = [
      { index: 0, name: "A", status: "completed" as const, steps: [] },
      { index: 1, name: "B", status: "running" as const, steps: [] },
      { index: 2, name: "C", status: "failed" as const, steps: [] },
      { index: 3, name: "D", status: "pending" as const, steps: [] },
    ];
    const result = computeProgress(phases);
    expect(result.completed).toBe(1);
    expect(result.running).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(4);
  });

  it("returns zeros for empty phases", () => {
    const result = computeProgress([]);
    expect(result.completed).toBe(0);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);
  });

  it("counts all completed phases", () => {
    const phases = [
      { index: 0, name: "A", status: "completed" as const, steps: [] },
      { index: 1, name: "B", status: "completed" as const, steps: [] },
    ];
    const result = computeProgress(phases);
    expect(result.completed).toBe(2);
    expect(result.total).toBe(2);
    expect(result.running).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles skipped phases (not counted as completed, running, or failed)", () => {
    const phases = [
      { index: 0, name: "A", status: "completed" as const, steps: [] },
      { index: 1, name: "B", status: "skipped" as const, steps: [] },
      { index: 2, name: "C", status: "pending" as const, steps: [] },
    ];
    const result = computeProgress(phases);
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
  it("returns empty string when no phase or branch", () => {
    const info: SessionHeaderInfo = { sessionName: "test" };
    expect(formatSessionStatus(info)).toBe("");
  });

  it("shows running phase icon", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentPhase: "Build",
      phaseStatus: "running",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u25d3"); // ◓
    expect(result).toContain("Build");
  });

  it("shows completed phase icon", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentPhase: "Setup",
      phaseStatus: "completed",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u25cf"); // ●
    expect(result).toContain("Setup");
  });

  it("shows failed phase icon", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentPhase: "Deploy",
      phaseStatus: "failed",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u2717"); // ✗
    expect(result).toContain("Deploy");
  });

  it("shows pending phase icon for unknown status", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentPhase: "Init",
      phaseStatus: "pending",
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

  it("shows both phase and branch separated by double space", () => {
    const info: SessionHeaderInfo = {
      sessionName: "test",
      currentPhase: "Build",
      phaseStatus: "running",
      branch: "main",
    };
    const result = formatSessionStatus(info);
    expect(result).toContain("\u25d3 Build");
    expect(result).toContain("\u2387 main");
    expect(result).toContain("  "); // double space separator
  });
});
