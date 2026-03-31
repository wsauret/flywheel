import { describe, it, expect } from "bun:test";
import {
  escapeForState,
  ctrlCForState,
  resolveAppState,
  type AppState,
} from "../src/tui/shell/shell-modes";

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

// ---------------------------------------------------------------------------
// resolveAppState
// ---------------------------------------------------------------------------

describe("resolveAppState", () => {
  const hasRuntime = (ids: Set<string>) => (id: string) => ids.has(id);

  it("isImporting takes priority over everything", () => {
    expect(resolveAppState("s1", hasRuntime(new Set(["s1"])), "s1", true)).toBe("importing");
  });

  it("focused + running runtime → working", () => {
    expect(resolveAppState("s1", hasRuntime(new Set(["s1"])), "s1", false)).toBe("working");
  });

  it("focused but no runtime → falls through to viewedId check", () => {
    expect(resolveAppState("s1", hasRuntime(new Set()), "s1", false)).toBe("completed");
  });

  it("no focused, has viewed → completed", () => {
    expect(resolveAppState(null, hasRuntime(new Set()), "s2", false)).toBe("completed");
  });

  it("no focused, no viewed → idle", () => {
    expect(resolveAppState(null, hasRuntime(new Set()), null, false)).toBe("idle");
  });

  it("focused with runtime but no viewedId → working", () => {
    expect(resolveAppState("s1", hasRuntime(new Set(["s1"])), null, false)).toBe("working");
  });
});
