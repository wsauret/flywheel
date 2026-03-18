import { describe, it, expect } from "bun:test";
import {
  escapeForState,
  ctrlCForState,
  type AppState,
} from "../src/tui/components/shell-modes";

/**
 * Shell Modes — AppState Tests
 *
 * Tests the new AppState type and its escape/ctrl-c behavior mappings.
 * AppState replaces ViewMode — same 4 values but describing activity state
 * rather than screen selection.
 */

// ---------------------------------------------------------------------------
// escapeForState
// ---------------------------------------------------------------------------

describe("escapeForState", () => {
  it("idle → exit-tui", () => {
    expect(escapeForState("idle")).toBe("exit-tui");
  });

  it("working → double-esc-stop", () => {
    expect(escapeForState("working")).toBe("double-esc-stop");
  });

  it("completed → return-idle", () => {
    expect(escapeForState("completed")).toBe("return-idle");
  });

  it("importing → cancel-import", () => {
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
// ctrlCForState
// ---------------------------------------------------------------------------

describe("ctrlCForState", () => {
  it("idle → exit-tui", () => {
    expect(ctrlCForState("idle")).toBe("exit-tui");
  });

  it("working → stop-workflow", () => {
    expect(ctrlCForState("working")).toBe("stop-workflow");
  });

  it("completed → return-idle", () => {
    expect(ctrlCForState("completed")).toBe("return-idle");
  });

  it("importing → exit-tui", () => {
    expect(ctrlCForState("importing")).toBe("exit-tui");
  });
});
