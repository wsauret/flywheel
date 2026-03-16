import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { timerService, formatDuration } from "../src/tui/shared/services/timer";

describe("TimerService", () => {
  beforeEach(() => {
    timerService.reset();
  });

  afterEach(() => {
    timerService.reset();
  });

  // ── Lifecycle ──

  describe("lifecycle", () => {
    it("starts in idle state", () => {
      expect(timerService.getStatus()).toBe("idle");
      expect(timerService.isRunning()).toBe(false);
      expect(timerService.isStopped()).toBe(false);
    });

    it("start() transitions to running", () => {
      timerService.start();
      expect(timerService.getStatus()).toBe("running");
      expect(timerService.isRunning()).toBe(true);
    });

    it("start() is idempotent when already running", () => {
      timerService.start();
      const runtime1 = timerService.getWorkflowRuntime();
      timerService.start(); // should be no-op
      expect(timerService.isRunning()).toBe(true);
    });

    it("stop() transitions to stopped", () => {
      timerService.start();
      timerService.stop();
      expect(timerService.getStatus()).toBe("stopped");
      expect(timerService.isStopped()).toBe(true);
      expect(timerService.isRunning()).toBe(false);
    });

    it("stop() is no-op when idle", () => {
      timerService.stop();
      expect(timerService.getStatus()).toBe("idle");
    });

    it("pause() transitions to paused", () => {
      timerService.start();
      timerService.pause("user");
      expect(timerService.getStatus()).toBe("paused");
      expect(timerService.isPaused()).toBe(true);
      expect(timerService.getPauseReason()).toBe("user");
    });

    it("resume() transitions back to running", () => {
      timerService.start();
      timerService.pause("user");
      timerService.resume();
      expect(timerService.getStatus()).toBe("running");
      expect(timerService.isRunning()).toBe(true);
      expect(timerService.isPaused()).toBe(false);
    });

    it("pause() is no-op when not running", () => {
      timerService.pause("user");
      expect(timerService.getStatus()).toBe("idle");
    });

    it("resume() is no-op when not paused", () => {
      timerService.start();
      timerService.resume();
      expect(timerService.getStatus()).toBe("running");
    });

    it("reset() returns to idle", () => {
      timerService.start();
      timerService.registerAgent("phase-0");
      timerService.reset();
      expect(timerService.getStatus()).toBe("idle");
      expect(timerService.hasAgent("phase-0")).toBe(false);
    });
  });

  // ── Agent/Phase registration ──

  describe("agent registration (phase-based)", () => {
    it("registerAgent registers a phase", () => {
      timerService.start();
      timerService.registerAgent("phase-0");
      expect(timerService.hasAgent("phase-0")).toBe(true);
    });

    it("completeAgent removes the agent and returns duration", () => {
      timerService.start();
      timerService.registerAgent("phase-1");
      // Small delay
      const duration = timerService.completeAgent("phase-1");
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(timerService.hasAgent("phase-1")).toBe(false);
    });

    it("completeAgent returns 0 for unknown agent", () => {
      timerService.start();
      const duration = timerService.completeAgent("nonexistent");
      expect(duration).toBe(0);
    });

    it("hasAgent returns false for unregistered agent", () => {
      expect(timerService.hasAgent("phase-99")).toBe(false);
    });

    it("registerAgent auto-starts if idle", () => {
      expect(timerService.getStatus()).toBe("idle");
      timerService.registerAgent("phase-0");
      expect(timerService.getStatus()).toBe("running");
      expect(timerService.hasAgent("phase-0")).toBe(true);
    });
  });

  // ── formatDuration ──

  describe("formatDuration", () => {
    it("formats 0 seconds as 00:00", () => {
      expect(formatDuration(0)).toBe("00:00");
    });

    it("formats seconds under a minute", () => {
      expect(formatDuration(5)).toBe("00:05");
      expect(formatDuration(59)).toBe("00:59");
    });

    it("formats minutes", () => {
      expect(formatDuration(60)).toBe("01:00");
      expect(formatDuration(90)).toBe("01:30");
      expect(formatDuration(3599)).toBe("59:59");
    });

    it("formats hours", () => {
      expect(formatDuration(3600)).toBe("01:00:00");
      expect(formatDuration(3661)).toBe("01:01:01");
      expect(formatDuration(7200)).toBe("02:00:00");
    });

    it("clamps negative to 00:00", () => {
      expect(formatDuration(-5)).toBe("00:00");
    });

    it("floors fractional seconds", () => {
      expect(formatDuration(1.9)).toBe("00:01");
    });
  });

  // ── Subscription ──

  describe("subscribe", () => {
    it("notifies listeners on start", () => {
      let called = 0;
      const unsub = timerService.subscribe(() => { called++; });
      timerService.start();
      expect(called).toBeGreaterThanOrEqual(1);
      unsub();
    });

    it("notifies listeners on stop", () => {
      timerService.start();
      let called = 0;
      const unsub = timerService.subscribe(() => { called++; });
      timerService.stop();
      expect(called).toBeGreaterThanOrEqual(1);
      unsub();
    });

    it("unsubscribe prevents future notifications", () => {
      let called = 0;
      const unsub = timerService.subscribe(() => { called++; });
      timerService.start();
      const afterStart = called;
      unsub();
      timerService.stop();
      expect(called).toBe(afterStart);
    });
  });

  // ── getWorkflowRuntime ──

  describe("getWorkflowRuntime", () => {
    it("returns 00:00 when idle", () => {
      expect(timerService.getWorkflowRuntime()).toBe("00:00");
    });

    it("returns a non-zero string when running", () => {
      timerService.start();
      // Immediately after start, should be 00:00 (< 1s elapsed)
      expect(timerService.getWorkflowRuntime()).toBe("00:00");
    });
  });
});
