import { describe, it, expect } from "bun:test";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { UIApprovalHandler } from "../src/controller/ui-approval-handler";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

function createHandler(configOverrides?: Partial<FlywheelConfig>) {
  const bus = new EventBus();
  const emitter = createFlywheelEmitter(bus);
  const adapter = new MockAdapter();
  adapter.connect(bus);
  adapter.start();
  const config = defaultConfig(configOverrides);
  const handler = new UIApprovalHandler(emitter, config, adapter, "test-wf");

  return { handler, adapter, bus, emitter };
}

// ---------------------------------------------------------------------------
// UIApprovalHandler
// ---------------------------------------------------------------------------

describe("UIApprovalHandler", () => {
  describe("config-level auto-approve", () => {
    it("resolves true when skip_approval_gates is set", async () => {
      const { handler } = createHandler({ skip_approval_gates: true });
      const result = await handler.requestApproval(0, "Phase 1: Setup");
      expect(result).toBe(true);
    });

    it("does not emit events when skip_approval_gates is set", async () => {
      const { handler, adapter } = createHandler({ skip_approval_gates: true });
      await handler.requestApproval(0, "Phase 1: Setup");
      // No approval events should be emitted
      const approvalEvents = adapter.events.filter(
        (e) => e.type === "approval:requested" || e.type === "approval:received",
      );
      expect(approvalEvents).toHaveLength(0);
    });
  });

  describe("UI callback flow", () => {
    it("emits approval:requested and waits for callback", async () => {
      const { handler, adapter } = createHandler();

      // Install a callback that auto-approves
      adapter.onApprovalDecision = (approved: boolean) => {};

      // Start the approval process
      const approvalPromise = handler.requestApproval(0, "Setup");

      // The handler should have installed its own callback
      // Simulate the UI calling the callback
      adapter.onApprovalDecision!(true);

      const result = await approvalPromise;
      expect(result).toBe(true);
    });

    it("resolves false when callback rejects", async () => {
      const { handler, adapter } = createHandler();

      adapter.onApprovalDecision = () => {};

      const approvalPromise = handler.requestApproval(0, "Setup");
      adapter.onApprovalDecision!(false);

      const result = await approvalPromise;
      expect(result).toBe(false);
    });

    it("auto-approves when no callback is installed (fallback)", async () => {
      const { handler, adapter } = createHandler();

      // Don't install onApprovalDecision — it should auto-approve
      adapter.onApprovalDecision = undefined;

      const result = await handler.requestApproval(0, "Setup");
      expect(result).toBe(true);
    });

    it("restores original callback after approval", async () => {
      const { handler, adapter } = createHandler();

      const originalCallback = (_approved: boolean) => {};
      adapter.onApprovalDecision = originalCallback;

      const approvalPromise = handler.requestApproval(0, "Setup");
      adapter.onApprovalDecision!(true);
      await approvalPromise;

      expect(adapter.onApprovalDecision).toBe(originalCallback);
    });
  });

  describe("session-level skip", () => {
    it("skip flag resolves with approved: true and sets skipRemainingGates", async () => {
      const { handler, adapter } = createHandler();

      adapter.onApprovalDecision = () => {};

      const approvalPromise = handler.requestApproval(0, "Setup");
      // Simulate "Skip" button: approved=true, skip=true
      adapter.onApprovalDecision!(true, true);

      const result = await approvalPromise;
      expect(result).toBe(true);
      expect(handler.skipRemainingGates).toBe(true);
    });

    it("after skip, subsequent phases auto-approve without showing modal", async () => {
      const { handler, adapter } = createHandler();

      // First approval: user clicks Skip
      adapter.onApprovalDecision = () => {};
      const first = handler.requestApproval(0, "Phase 1");
      adapter.onApprovalDecision!(true, true);
      await first;

      expect(handler.skipRemainingGates).toBe(true);

      // Second approval: should auto-approve without touching the callback
      const secondCallbackCalled = { value: false };
      adapter.onApprovalDecision = () => {
        secondCallbackCalled.value = true;
      };

      const result = await handler.requestApproval(1, "Phase 2");
      expect(result).toBe(true);
      // The callback should NOT have been replaced
      expect(secondCallbackCalled.value).toBe(false);
    });

    it("skipRemainingGates starts as false", () => {
      const { handler } = createHandler();
      expect(handler.skipRemainingGates).toBe(false);
    });

    it("reject does not set skipRemainingGates", async () => {
      const { handler, adapter } = createHandler();

      adapter.onApprovalDecision = () => {};
      const approvalPromise = handler.requestApproval(0, "Setup");
      adapter.onApprovalDecision!(false);
      await approvalPromise;

      expect(handler.skipRemainingGates).toBe(false);
    });

    it("approve without skip does not set skipRemainingGates", async () => {
      const { handler, adapter } = createHandler();

      adapter.onApprovalDecision = () => {};
      const approvalPromise = handler.requestApproval(0, "Setup");
      adapter.onApprovalDecision!(true, false);
      await approvalPromise;

      expect(handler.skipRemainingGates).toBe(false);
    });
  });

  describe("event emission", () => {
    it("emits approval:requested with correct description", async () => {
      const { handler, adapter } = createHandler();

      adapter.onApprovalDecision = () => {};
      const approvalPromise = handler.requestApproval(2, "Manual verification");
      adapter.onApprovalDecision!(true);
      await approvalPromise;

      const requested = adapter.events.find((e) => e.type === "approval:requested");
      expect(requested).toBeDefined();
      expect(requested!.type).toBe("approval:requested");
      if (requested!.type === "approval:requested") {
        expect(requested!.description).toBe("Step 3: Manual verification");
        expect(requested!.stepIndex).toBe(2);
      }
    });

    it("emits approval:received after decision", async () => {
      const { handler, adapter } = createHandler();

      adapter.onApprovalDecision = () => {};
      const approvalPromise = handler.requestApproval(0, "Setup");
      adapter.onApprovalDecision!(true);
      await approvalPromise;

      const received = adapter.events.find((e) => e.type === "approval:received");
      expect(received).toBeDefined();
      expect(received!.type).toBe("approval:received");
      if (received!.type === "approval:received") {
        expect(received!.approved).toBe(true);
      }
    });
  });
});
