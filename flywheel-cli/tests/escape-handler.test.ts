import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createEscapeHandler, type EscapeHandler } from "../src/tui/utils/escape-handler";

/**
 * Escape Handler Tests
 *
 * Tests the double-Esc timing logic used by FlywheelShell:
 * - First Esc returns "show-hint"
 * - Second Esc within timeout returns "stop"
 * - After timeout, resets back to "show-hint" on next Esc
 * - reset() clears state so next Esc returns "show-hint"
 */

describe("createEscapeHandler", () => {
  let handler: EscapeHandler;

  afterEach(() => {
    handler?.dispose();
  });

  describe("basic double-Esc pattern", () => {
    beforeEach(() => {
      handler = createEscapeHandler({ timeoutMs: 5000 });
    });

    it("first Esc returns show-hint", () => {
      expect(handler.handleEscape()).toBe("show-hint");
    });

    it("second Esc within timeout returns stop", () => {
      expect(handler.handleEscape()).toBe("show-hint");
      expect(handler.handleEscape()).toBe("stop");
    });

    it("after stop, next Esc returns show-hint again (auto-reset)", () => {
      handler.handleEscape(); // show-hint
      handler.handleEscape(); // stop (resets internally)
      expect(handler.handleEscape()).toBe("show-hint");
    });
  });

  describe("timeout behavior", () => {
    it("after timeout expires, next Esc returns show-hint", async () => {
      handler = createEscapeHandler({ timeoutMs: 50 });

      expect(handler.handleEscape()).toBe("show-hint");

      // Wait for timeout to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Should have reset — next Esc is "show-hint" again
      expect(handler.handleEscape()).toBe("show-hint");
    });

    it("second Esc before timeout returns stop", async () => {
      handler = createEscapeHandler({ timeoutMs: 200 });

      expect(handler.handleEscape()).toBe("show-hint");

      // Press again quickly
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handler.handleEscape()).toBe("stop");
    });
  });

  describe("reset()", () => {
    beforeEach(() => {
      handler = createEscapeHandler({ timeoutMs: 5000 });
    });

    it("reset after first Esc makes next Esc return show-hint", () => {
      handler.handleEscape(); // show-hint
      handler.reset();
      expect(handler.handleEscape()).toBe("show-hint");
    });

    it("reset clears pending timer", async () => {
      handler = createEscapeHandler({ timeoutMs: 50 });
      handler.handleEscape(); // show-hint, starts timer
      handler.reset();

      // Even after waiting, the handler is already reset
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(handler.handleEscape()).toBe("show-hint");
    });
  });

  describe("dispose()", () => {
    it("dispose resets state (same as reset)", () => {
      handler = createEscapeHandler({ timeoutMs: 5000 });
      handler.handleEscape(); // show-hint
      handler.dispose();
      // After dispose, creating behavior is reset
      expect(handler.handleEscape()).toBe("show-hint");
    });
  });

  describe("edge cases", () => {
    it("rapid triple-Esc: stop on second, show-hint on third", () => {
      handler = createEscapeHandler({ timeoutMs: 5000 });
      expect(handler.handleEscape()).toBe("show-hint");
      expect(handler.handleEscape()).toBe("stop");
      expect(handler.handleEscape()).toBe("show-hint");
    });

    it("works with default timeout (no options)", () => {
      handler = createEscapeHandler();
      expect(handler.handleEscape()).toBe("show-hint");
      expect(handler.handleEscape()).toBe("stop");
    });
  });
});
