import { describe, it, expect } from "bun:test";
import {
  escapeForState,
  ctrlCForState,
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

  it("chatting → return-idle", () => {
    expect(escapeForState("chatting")).toBe("return-idle");
  });

  it("completed → return-chat", () => {
    expect(escapeForState("completed")).toBe("return-chat");
  });

  it("covers all states", () => {
    const states: AppState[] = ["idle", "chatting", "working", "completed"];
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

  it("chatting \u2192 return-idle", () => {
    expect(ctrlCForState("chatting")).toBe("return-idle");
  });

  it("completed → return-chat", () => {
    expect(ctrlCForState("completed")).toBe("return-chat");
  });

});
