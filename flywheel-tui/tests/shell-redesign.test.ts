import { describe, it, expect } from "bun:test";
import {
  transitionViewMode,
  escapeForMode,
  ctrlCForMode,
  layoutVisibility,
  assertNever,
  MIN_WIDTH_PANEL,
  MIN_WIDTH_SIDEBAR,
  SIDEBAR_WIDTH,
  PANEL_WIDTH,
  type ViewMode,
  type ViewAction,
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
 * Shell Redesign Tests — Phase 5
 *
 * Tests the pure logic extracted into shell-modes.ts and workflow-panel.tsx:
 *   - ViewMode state machine transitions
 *   - Escape behavior per mode
 *   - Ctrl+C behavior per mode
 *   - Responsive layout collapse thresholds
 *   - assertNever exhaustiveness guard
 *   - WorkflowPanel progress computation
 *   - WorkflowPanel status label mapping
 */

// ---------------------------------------------------------------------------
// ViewMode transitions
// ---------------------------------------------------------------------------

describe("transitionViewMode", () => {
  describe("launcher transitions", () => {
    it("launcher + start-workflow → working", () => {
      expect(transitionViewMode("launcher", "start-workflow")).toBe("working");
    });

    it("launcher + start-import → importing", () => {
      expect(transitionViewMode("launcher", "start-import")).toBe("importing");
    });

    it("launcher + invalid actions → null", () => {
      expect(transitionViewMode("launcher", "workflow-ended")).toBeNull();
      expect(transitionViewMode("launcher", "stop-workflow")).toBeNull();
      expect(transitionViewMode("launcher", "new-session")).toBeNull();
      expect(transitionViewMode("launcher", "cancel-import")).toBeNull();
      expect(transitionViewMode("launcher", "confirm-import")).toBeNull();
    });
  });

  describe("working transitions", () => {
    it("working + workflow-ended → completed", () => {
      expect(transitionViewMode("working", "workflow-ended")).toBe("completed");
    });

    it("working + stop-workflow → completed", () => {
      expect(transitionViewMode("working", "stop-workflow")).toBe("completed");
    });

    it("working + invalid actions → null", () => {
      expect(transitionViewMode("working", "start-workflow")).toBeNull();
      expect(transitionViewMode("working", "new-session")).toBeNull();
      expect(transitionViewMode("working", "start-import")).toBeNull();
      expect(transitionViewMode("working", "cancel-import")).toBeNull();
      expect(transitionViewMode("working", "confirm-import")).toBeNull();
    });
  });

  describe("completed transitions", () => {
    it("completed + start-workflow → working", () => {
      expect(transitionViewMode("completed", "start-workflow")).toBe("working");
    });

    it("completed + new-session → launcher", () => {
      expect(transitionViewMode("completed", "new-session")).toBe("launcher");
    });

    it("completed + start-import → importing", () => {
      expect(transitionViewMode("completed", "start-import")).toBe("importing");
    });

    it("completed + invalid actions → null", () => {
      expect(transitionViewMode("completed", "workflow-ended")).toBeNull();
      expect(transitionViewMode("completed", "stop-workflow")).toBeNull();
      expect(transitionViewMode("completed", "cancel-import")).toBeNull();
      expect(transitionViewMode("completed", "confirm-import")).toBeNull();
    });
  });

  describe("importing transitions", () => {
    it("importing + cancel-import → launcher", () => {
      expect(transitionViewMode("importing", "cancel-import")).toBe("launcher");
    });

    it("importing + confirm-import → working", () => {
      expect(transitionViewMode("importing", "confirm-import")).toBe("working");
    });

    it("importing + invalid actions → null", () => {
      expect(transitionViewMode("importing", "start-workflow")).toBeNull();
      expect(transitionViewMode("importing", "workflow-ended")).toBeNull();
      expect(transitionViewMode("importing", "stop-workflow")).toBeNull();
      expect(transitionViewMode("importing", "new-session")).toBeNull();
      expect(transitionViewMode("importing", "start-import")).toBeNull();
    });
  });

  describe("full lifecycle sequences", () => {
    it("launcher → working → completed → launcher", () => {
      let mode: ViewMode = "launcher";
      mode = transitionViewMode(mode, "start-workflow")!;
      expect(mode).toBe("working");
      mode = transitionViewMode(mode, "workflow-ended")!;
      expect(mode).toBe("completed");
      mode = transitionViewMode(mode, "new-session")!;
      expect(mode).toBe("launcher");
    });

    it("launcher → working → completed → working (re-run)", () => {
      let mode: ViewMode = "launcher";
      mode = transitionViewMode(mode, "start-workflow")!;
      expect(mode).toBe("working");
      mode = transitionViewMode(mode, "stop-workflow")!;
      expect(mode).toBe("completed");
      mode = transitionViewMode(mode, "start-workflow")!;
      expect(mode).toBe("working");
    });

    it("launcher → importing → working (import then run)", () => {
      let mode: ViewMode = "launcher";
      mode = transitionViewMode(mode, "start-import")!;
      expect(mode).toBe("importing");
      mode = transitionViewMode(mode, "confirm-import")!;
      expect(mode).toBe("working");
    });

    it("launcher → importing → launcher (cancel import)", () => {
      let mode: ViewMode = "launcher";
      mode = transitionViewMode(mode, "start-import")!;
      expect(mode).toBe("importing");
      mode = transitionViewMode(mode, "cancel-import")!;
      expect(mode).toBe("launcher");
    });
  });
});

// ---------------------------------------------------------------------------
// Escape behavior
// ---------------------------------------------------------------------------

describe("escapeForMode", () => {
  it("launcher → exit-tui", () => {
    expect(escapeForMode("launcher")).toBe("exit-tui");
  });

  it("working → double-esc-stop", () => {
    expect(escapeForMode("working")).toBe("double-esc-stop");
  });

  it("completed → return-launcher", () => {
    expect(escapeForMode("completed")).toBe("return-launcher");
  });

  it("importing → cancel-import", () => {
    expect(escapeForMode("importing")).toBe("cancel-import");
  });

  it("covers all four modes", () => {
    const modes: ViewMode[] = ["launcher", "working", "completed", "importing"];
    for (const mode of modes) {
      // Should not throw — all modes handled
      expect(() => escapeForMode(mode)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Ctrl+C behavior
// ---------------------------------------------------------------------------

describe("ctrlCForMode", () => {
  it("launcher → exit-tui", () => {
    expect(ctrlCForMode("launcher")).toBe("exit-tui");
  });

  it("working → stop-workflow", () => {
    expect(ctrlCForMode("working")).toBe("stop-workflow");
  });

  it("completed → return-launcher", () => {
    expect(ctrlCForMode("completed")).toBe("return-launcher");
  });

  it("importing → exit-tui", () => {
    expect(ctrlCForMode("importing")).toBe("exit-tui");
  });
});

// ---------------------------------------------------------------------------
// Responsive layout
// ---------------------------------------------------------------------------

describe("layoutVisibility", () => {
  it("wide terminal (160 cols) → both sidebar and panel visible", () => {
    const vis = layoutVisibility(160);
    expect(vis.showSidebar).toBe(true);
    expect(vis.showPanel).toBe(true);
  });

  it("medium terminal (110 cols) → sidebar visible, panel hidden", () => {
    const vis = layoutVisibility(110);
    expect(vis.showSidebar).toBe(true);
    expect(vis.showPanel).toBe(false);
  });

  it("narrow terminal (80 cols) → both hidden", () => {
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
    expect(PANEL_WIDTH).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// assertNever
// ---------------------------------------------------------------------------

describe("assertNever", () => {
  it("throws with descriptive message for unexpected value", () => {
    expect(() => assertNever("bogus" as never)).toThrow(
      "Unexpected ViewMode value: bogus"
    );
  });
});

// ---------------------------------------------------------------------------
// WorkflowPanel — computeProgress
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
// WorkflowPanel — statusLabel
// ---------------------------------------------------------------------------

describe("statusLabel", () => {
  it("maps idle → Idle", () => {
    expect(statusLabel("idle")).toBe("Idle");
  });

  it("maps running → Running", () => {
    expect(statusLabel("running")).toBe("Running");
  });

  it("maps completed → Completed", () => {
    expect(statusLabel("completed")).toBe("Completed");
  });

  it("maps failed → Failed", () => {
    expect(statusLabel("failed")).toBe("Failed");
  });

  it("maps interrupted → Interrupted", () => {
    expect(statusLabel("interrupted")).toBe("Interrupted");
  });

  it("maps stopping → Stopping", () => {
    expect(statusLabel("stopping")).toBe("Stopping");
  });
});

// ---------------------------------------------------------------------------
// SessionHeader — formatSessionStatus
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
