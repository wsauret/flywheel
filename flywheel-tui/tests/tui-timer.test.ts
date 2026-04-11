import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TimerService, formatTimerDisplay } from "../src/tui/shared/services/timer";

// Create a shared instance for tests (replaces the removed singleton)
let timerService: TimerService;

describe("TimerService", () => {
  beforeEach(() => {
    timerService = new TimerService();
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
      timerService.registerAgent("step-0");
      timerService.reset();
      expect(timerService.getStatus()).toBe("idle");
      expect(timerService.hasAgent("step-0")).toBe(false);
    });
  });

  // ── Agent/Step registration ──

  describe("agent registration (step-based)", () => {
    it("registerAgent registers a step", () => {
      timerService.start();
      timerService.registerAgent("step-0");
      expect(timerService.hasAgent("step-0")).toBe(true);
    });

    it("completeAgent removes the agent and returns duration", () => {
      timerService.start();
      timerService.registerAgent("step-1");
      // Small delay
      const duration = timerService.completeAgent("step-1");
      expect(duration).toBeGreaterThanOrEqual(0);
      expect(timerService.hasAgent("step-1")).toBe(false);
    });

    it("completeAgent returns 0 for unknown agent", () => {
      timerService.start();
      const duration = timerService.completeAgent("nonexistent");
      expect(duration).toBe(0);
    });

    it("hasAgent returns false for unregistered agent", () => {
      expect(timerService.hasAgent("step-99")).toBe(false);
    });

    it("registerAgent auto-starts if idle", () => {
      expect(timerService.getStatus()).toBe("idle");
      timerService.registerAgent("step-0");
      expect(timerService.getStatus()).toBe("running");
      expect(timerService.hasAgent("step-0")).toBe(true);
    });
  });

  // ── formatTimerDisplay ──

  describe("formatTimerDisplay", () => {
    it("formats 0 seconds as 00:00", () => {
      expect(formatTimerDisplay(0)).toBe("00:00");
    });

    it("formats seconds under a minute", () => {
      expect(formatTimerDisplay(5)).toBe("00:05");
      expect(formatTimerDisplay(59)).toBe("00:59");
    });

    it("formats minutes", () => {
      expect(formatTimerDisplay(60)).toBe("01:00");
      expect(formatTimerDisplay(90)).toBe("01:30");
      expect(formatTimerDisplay(3599)).toBe("59:59");
    });

    it("formats hours", () => {
      expect(formatTimerDisplay(3600)).toBe("01:00:00");
      expect(formatTimerDisplay(3661)).toBe("01:01:01");
      expect(formatTimerDisplay(7200)).toBe("02:00:00");
    });

    it("clamps negative to 00:00", () => {
      expect(formatTimerDisplay(-5)).toBe("00:00");
    });

    it("floors fractional seconds", () => {
      expect(formatTimerDisplay(1.9)).toBe("00:01");
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

  // ── Instance Independence (Step 1 — per-session timers) ──

  describe("instance independence", () => {
    it("new TimerService() returns distinct instances", () => {
      const a = new TimerService();
      const b = new TimerService();
      expect(a).not.toBe(b);
      a.reset();
      b.reset();
    });

    it("start/stop on instance A does not affect instance B", () => {
      const a = new TimerService();
      const b = new TimerService();

      a.start();
      expect(a.isRunning()).toBe(true);
      expect(b.isRunning()).toBe(false);
      expect(b.getStatus()).toBe("idle");

      a.stop();
      expect(a.isStopped()).toBe(true);
      expect(b.getStatus()).toBe("idle");

      a.reset();
      b.reset();
    });

    it("agent registration on instance A does not leak to instance B", () => {
      const a = new TimerService();
      const b = new TimerService();

      a.start();
      b.start();
      a.registerAgent("step-0");

      expect(a.hasAgent("step-0")).toBe(true);
      expect(b.hasAgent("step-0")).toBe(false);

      a.reset();
      b.reset();
    });

    it("pause/resume on instance A does not affect instance B", () => {
      const a = new TimerService();
      const b = new TimerService();

      a.start();
      b.start();
      a.pause("user");

      expect(a.isPaused()).toBe(true);
      expect(b.isRunning()).toBe(true);
      expect(b.isPaused()).toBe(false);

      a.resume();
      expect(a.isRunning()).toBe(true);
      expect(b.isRunning()).toBe(true);

      a.reset();
      b.reset();
    });

    it("subscriptions on instance A do not fire for instance B events", () => {
      const a = new TimerService();
      const b = new TimerService();

      let aCalled = 0;
      let bCalled = 0;
      const unsubA = a.subscribe(() => { aCalled++; });
      const unsubB = b.subscribe(() => { bCalled++; });

      a.start();
      const aCalledAfterStart = aCalled;
      expect(aCalledAfterStart).toBeGreaterThanOrEqual(1);
      expect(bCalled).toBe(0);

      b.start();
      expect(bCalled).toBeGreaterThanOrEqual(1);
      // A should not have been notified again
      expect(aCalled).toBe(aCalledAfterStart);

      unsubA();
      unsubB();
      a.reset();
      b.reset();
    });

    it("reset on instance A does not affect instance B", () => {
      const a = new TimerService();
      const b = new TimerService();

      a.start();
      b.start();
      a.registerAgent("step-0");
      b.registerAgent("step-1");

      a.reset();

      expect(a.getStatus()).toBe("idle");
      expect(a.hasAgent("step-0")).toBe(false);
      expect(b.isRunning()).toBe(true);
      expect(b.hasAgent("step-1")).toBe(true);

      b.reset();
    });
  });
});
