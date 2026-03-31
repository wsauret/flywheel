import { describe, it, expect } from "bun:test";
import { resolvePromptMode } from "../src/tui/components/unified-prompt-logic";
import type { AppState } from "../src/tui/shell/shell-modes";

/**
 * Unified Prompt Logic Tests
 *
 * Tests the pure resolvePromptMode() function that determines which
 * prompt behavior to use based on AppState and approval status.
 */

describe("resolvePromptMode", () => {
  describe("command mode", () => {
    it("idle → command", () => {
      expect(resolvePromptMode("idle", false)).toBe("command");
    });

    it("completed → command", () => {
      expect(resolvePromptMode("completed", false)).toBe("command");
    });

    it("completed with approval pending still → command (approval irrelevant when completed)", () => {
      expect(resolvePromptMode("completed", true)).toBe("command");
    });
  });

  describe("active mode", () => {
    it("working with approval pending → active", () => {
      expect(resolvePromptMode("working", true)).toBe("active");
    });
  });

  describe("active mode (injection)", () => {
    it("working without approval → active (allows mid-execution injection)", () => {
      expect(resolvePromptMode("working", false)).toBe("active");
    });
  });

  describe("exhaustive coverage", () => {
    it("covers all AppState values", () => {
      const states: AppState[] = ["idle", "working", "completed"];
      for (const state of states) {
        expect(() => resolvePromptMode(state, false)).not.toThrow();
        expect(() => resolvePromptMode(state, true)).not.toThrow();
      }
    });
  });
});
