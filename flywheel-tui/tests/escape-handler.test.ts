import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createEscapeHandler, type EscapeHandler } from "../src/tui/utils/escape-handler";

/**
 * Escape Handler Tests
 *
 * Tests the 3-state interrupt logic used by FlywheelShell:
 * - First Esc returns "interrupt" (send SIGINT to worker)
 * - Second Esc within timeout returns "kill" (full process kill + pause queue)
 * - After timeout, resets back to "interrupt" on next Esc
 * - reset() clears state so next Esc returns "interrupt"
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

    it("first Esc returns interrupt", () => {
      expect(handler.handleEscape()).toBe("interrupt");
    });

    it("second Esc within timeout returns kill", () => {
      expect(handler.handleEscape()).toBe("interrupt");
      expect(handler.handleEscape()).toBe("kill");
    });

    it("after kill, next Esc returns interrupt again (auto-reset)", () => {
      handler.handleEscape(); // interrupt
      handler.handleEscape(); // kill (resets internally)
      expect(handler.handleEscape()).toBe("interrupt");
    });
  });

  describe("timeout behavior", () => {
    it("after timeout expires, next Esc returns interrupt", async () => {
      handler = createEscapeHandler({ timeoutMs: 50 });

      expect(handler.handleEscape()).toBe("interrupt");

      // Wait for timeout to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Should have reset — next Esc is "interrupt" again
      expect(handler.handleEscape()).toBe("interrupt");
    });

    it("second Esc before timeout returns kill", async () => {
      handler = createEscapeHandler({ timeoutMs: 200 });

      expect(handler.handleEscape()).toBe("interrupt");

      // Press again quickly
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handler.handleEscape()).toBe("kill");
    });
  });

  describe("reset()", () => {
    beforeEach(() => {
      handler = createEscapeHandler({ timeoutMs: 5000 });
    });

    it("reset after first Esc makes next Esc return interrupt", () => {
      handler.handleEscape(); // interrupt
      handler.reset();
      expect(handler.handleEscape()).toBe("interrupt");
    });

    it("reset clears pending timer", async () => {
      handler = createEscapeHandler({ timeoutMs: 50 });
      handler.handleEscape(); // interrupt, starts timer
      handler.reset();

      // Even after waiting, the handler is already reset
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(handler.handleEscape()).toBe("interrupt");
    });
  });

  describe("dispose()", () => {
    it("dispose resets state (same as reset)", () => {
      handler = createEscapeHandler({ timeoutMs: 5000 });
      handler.handleEscape(); // interrupt
      handler.dispose();
      // After dispose, creating behavior is reset
      expect(handler.handleEscape()).toBe("interrupt");
    });
  });

  describe("edge cases", () => {
    it("rapid triple-Esc: kill on second, interrupt on third", () => {
      handler = createEscapeHandler({ timeoutMs: 5000 });
      expect(handler.handleEscape()).toBe("interrupt");
      expect(handler.handleEscape()).toBe("kill");
      expect(handler.handleEscape()).toBe("interrupt");
    });

    it("works with default timeout (no options)", () => {
      handler = createEscapeHandler();
      expect(handler.handleEscape()).toBe("interrupt");
      expect(handler.handleEscape()).toBe("kill");
    });
  });
});
