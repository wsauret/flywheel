import { describe, expect, it } from "bun:test";
import { CompletionStateMachine } from "../../src/harness/completion.js";
import type { CompletionResult } from "../../src/harness/completion.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function validHandoff() {
  return {
    summary: "Implemented the feature successfully with full test coverage and verified output.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// State Transitions
// ═══════════════════════════════════════════════════════════════════════════

describe("CompletionStateMachine", () => {
  it("transitions idle -> pending -> confirmed", () => {
    const sm = new CompletionStateMachine();
    expect(sm.isComplete()).toBe(false);
    expect(sm.isPending()).toBe(false);

    // First call: idle -> pending
    const result1 = sm.handleTaskComplete(validHandoff());
    expect(result1.status).toBe("pending");
    expect(sm.isPending()).toBe(true);
    expect(sm.isComplete()).toBe(false);
    expect((result1 as Extract<CompletionResult, { status: "pending" }>).checklist).toContain("Test Engineer");

    // Second call: pending -> confirmed
    const result2 = sm.handleTaskComplete(validHandoff());
    expect(result2.status).toBe("confirmed");
    expect(sm.isComplete()).toBe(true);
    expect(sm.isPending()).toBe(false);
    expect((result2 as Extract<CompletionResult, { status: "confirmed" }>).handoff).toBeDefined();
  });

  it("validates handoff on both calls", () => {
    const sm = new CompletionStateMachine();

    // First call with valid handoff succeeds
    const result1 = sm.handleTaskComplete(validHandoff());
    expect(result1.status).toBe("pending");

    // Second call with invalid handoff fails and stays pending
    const result2 = sm.handleTaskComplete({ summary: "" });
    expect(result2.status).toBe("error");
    expect(sm.isPending()).toBe(true);
    expect(sm.isComplete()).toBe(false);

    // Third call with valid handoff confirms
    const result3 = sm.handleTaskComplete(validHandoff());
    expect(result3.status).toBe("confirmed");
    expect(sm.isComplete()).toBe(true);
  });

  it("returns error for invalid handoff from idle state", () => {
    const sm = new CompletionStateMachine();
    const result = sm.handleTaskComplete({ summary: "" });

    expect(result.status).toBe("error");
    expect((result as Extract<CompletionResult, { status: "error" }>).message).toContain("Invalid handoff");
    expect(sm.isPending()).toBe(false);
    expect(sm.isComplete()).toBe(false);
  });

  it("returns error for missing summary field", () => {
    const sm = new CompletionStateMachine();
    const result = sm.handleTaskComplete({});

    expect(result.status).toBe("error");
  });

  it("returns error for non-object handoff", () => {
    const sm = new CompletionStateMachine();
    const result = sm.handleTaskComplete("not an object");

    expect(result.status).toBe("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reset
// ═══════════════════════════════════════════════════════════════════════════

describe("reset", () => {
  it("returns to idle state after reset", () => {
    const sm = new CompletionStateMachine();

    sm.handleTaskComplete(validHandoff());
    expect(sm.isPending()).toBe(true);

    sm.reset();
    expect(sm.isPending()).toBe(false);
    expect(sm.isComplete()).toBe(false);

    // Should behave as fresh — first call returns pending again
    const result = sm.handleTaskComplete(validHandoff());
    expect(result.status).toBe("pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Abnormal Exit
// ═══════════════════════════════════════════════════════════════════════════

describe("abnormal exit without second confirm", () => {
  it("remains pending if second confirm never arrives", () => {
    const sm = new CompletionStateMachine();

    sm.handleTaskComplete(validHandoff());
    expect(sm.isPending()).toBe(true);
    expect(sm.isComplete()).toBe(false);
    // No second call — machine stays pending
  });
});
