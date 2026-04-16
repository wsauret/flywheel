// ---------------------------------------------------------------------------
// Stream Observers — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for engine-agnostic observers that watch EngineEvents and produce
// injection messages at turn boundaries.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "bun:test";

import type { EngineEvent } from "../src/orchestration/engines/core/types.js";
import {
  createObserverChain,
  createToolFailureObserver,
  createBudgetAwarenessObserver,
  createContextPressureObserver,
  type StreamObserver,
} from "../src/orchestration/engines/stream-observers.js";

import {
  createDoomLoopObserver,
} from "../src/orchestration/engines/doom-loop.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolUse(name: string, input: Record<string, unknown> = {}): EngineEvent {
  return { type: "tool_use", toolName: name, toolInput: input };
}

function toolResult(isError = false): EngineEvent {
  return { type: "tool_result", isError };
}

function textEvent(): EngineEvent {
  return { type: "text" };
}

function resultEvent(): EngineEvent {
  return { type: "result" };
}

// ---------------------------------------------------------------------------
// DoomLoopObserver
// ---------------------------------------------------------------------------

describe("DoomLoopObserver", () => {
  it("fires after 3 identical tool calls", () => {
    const obs = createDoomLoopObserver();
    for (let i = 0; i < 3; i++) {
      obs.onEvent(toolUse("Read", { file_path: "/foo.ts" }));
    }
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
    expect(msg).toContain("Doom loop detected");
  });

  it("fires for ABAB cycle patterns", () => {
    const obs = createDoomLoopObserver();
    for (let i = 0; i < 3; i++) {
      obs.onEvent(toolUse("Read", { file_path: "/a.ts" }));
      obs.onEvent(toolUse("Write", { file_path: "/a.ts", content: "x" }));
    }
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
    expect(msg).toContain("sequence of 2 tool calls");
  });

  it("does NOT fire for varied tool calls", () => {
    const obs = createDoomLoopObserver();
    obs.onEvent(toolUse("Read", { file_path: "/a.ts" }));
    obs.onEvent(toolUse("Write", { file_path: "/b.ts", content: "y" }));
    obs.onEvent(toolUse("Bash", { command: "ls" }));
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("resets state correctly", () => {
    const obs = createDoomLoopObserver();
    for (let i = 0; i < 3; i++) {
      obs.onEvent(toolUse("Read", { file_path: "/foo.ts" }));
    }
    obs.reset();
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("caps history at 13 entries", () => {
    const obs = createDoomLoopObserver();
    // Push 20 varied tool calls — should not blow up, and history stays bounded
    for (let i = 0; i < 20; i++) {
      obs.onEvent(toolUse("Tool" + i, { idx: i }));
    }
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull(); // varied calls, no pattern
  });
});

// ---------------------------------------------------------------------------
// ToolFailureObserver
// ---------------------------------------------------------------------------

describe("ToolFailureObserver", () => {
  it("fires after 3 consecutive tool_result errors", () => {
    const obs = createToolFailureObserver();
    obs.onEvent(toolResult(true));
    obs.onEvent(toolResult(true));
    obs.onEvent(toolResult(true));
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
    expect(msg).toContain("tool calls are failing");
  });

  it("resets counter to 0 on successful tool_result", () => {
    const obs = createToolFailureObserver();
    obs.onEvent(toolResult(true));
    obs.onEvent(toolResult(true));
    obs.onEvent(toolResult(false)); // success resets
    obs.onEvent(toolResult(true));
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("does not fire when mixed success/failure", () => {
    const obs = createToolFailureObserver();
    obs.onEvent(toolResult(true));
    obs.onEvent(toolResult(false));
    obs.onEvent(toolResult(true));
    obs.onEvent(toolResult(false));
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("supports custom threshold", () => {
    const obs = createToolFailureObserver({ maxConsecutive: 2 });
    obs.onEvent(toolResult(true));
    obs.onEvent(toolResult(true));
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ObserverChain
// ---------------------------------------------------------------------------

describe("ObserverChain", () => {
  it("collects all non-null messages from multiple observers", () => {
    const chain = createObserverChain([
      createToolFailureObserver(),
      createDoomLoopObserver(),
    ]);
    // 3 error tool_results → tool failure fires; 3 repeated tool_use → doom loop fires
    for (let i = 0; i < 3; i++) {
      chain.onEvent(toolUse("Read", { file_path: "/a.ts" }));
      chain.onEvent(toolResult(true));
    }
    const messages = chain.onTurnComplete();
    expect(messages.length).toBe(2);
  });

  it("returns empty array when no observers fire", () => {
    const chain = createObserverChain([
      createToolFailureObserver(),
      createDoomLoopObserver(),
    ]);
    chain.onEvent(toolUse("Read", { file_path: "/a.ts" }));
    chain.onEvent(toolResult(false));
    const messages = chain.onTurnComplete();
    expect(messages).toEqual([]);
  });

  it("exposes reset() that resets all observers", () => {
    const chain = createObserverChain([
      createDoomLoopObserver(),
      createToolFailureObserver(),
    ]);
    for (let i = 0; i < 3; i++) {
      chain.onEvent(toolUse("Read", { file_path: "/foo.ts" }));
      chain.onEvent(toolResult(true));
    }
    chain.reset();
    const messages = chain.onTurnComplete();
    expect(messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BudgetAwarenessObserver
// ---------------------------------------------------------------------------

describe("BudgetAwarenessObserver", () => {
  it("fires when remaining calls are below threshold", () => {
    const obs = createBudgetAwarenessObserver(() => ({
      remainingCalls: 3,
      remainingTokens: 50_000,
    }));
    obs.onEvent(toolUse("Read", { file_path: "/a.ts" }));
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
    expect(msg).toContain("3 API calls remaining");
    expect(msg).toContain("50000 tokens remaining");
  });

  it("fires when remaining tokens are below threshold", () => {
    const obs = createBudgetAwarenessObserver(() => ({
      remainingCalls: 20,
      remainingTokens: 5_000,
    }));
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
    expect(msg).toContain("5000 tokens remaining");
  });

  it("does NOT fire when budget is comfortable", () => {
    const obs = createBudgetAwarenessObserver(() => ({
      remainingCalls: 10,
      remainingTokens: 100_000,
    }));
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("does NOT fire when budget info is null (unlimited)", () => {
    const obs = createBudgetAwarenessObserver(() => null);
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("fires at exact threshold boundary (calls = 4)", () => {
    const obs = createBudgetAwarenessObserver(() => ({
      remainingCalls: 4,
      remainingTokens: 100_000,
    }));
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
  });

  it("does NOT fire at boundary (calls = 5)", () => {
    const obs = createBudgetAwarenessObserver(() => ({
      remainingCalls: 5,
      remainingTokens: 100_000,
    }));
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ContextPressureObserver
// ---------------------------------------------------------------------------

describe("ContextPressureObserver", () => {
  it("fires when context exceeds 60%", () => {
    const obs = createContextPressureObserver(() => 65);
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
    expect(msg).toContain("Context is filling up");
    expect(msg).toContain("Be concise");
  });

  it("does NOT fire when context is below 60%", () => {
    const obs = createContextPressureObserver(() => 55);
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("does NOT fire at exactly 60%", () => {
    const obs = createContextPressureObserver(() => 60);
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("fires only once per threshold crossing", () => {
    const obs = createContextPressureObserver(() => 70);
    const msg1 = obs.onTurnComplete();
    expect(msg1).not.toBeNull();
    const msg2 = obs.onTurnComplete();
    expect(msg2).toBeNull();
  });

  it("reset allows it to fire again", () => {
    const obs = createContextPressureObserver(() => 70);
    obs.onTurnComplete(); // fires
    obs.reset();
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// New observers work with generic EngineEvents (engine-agnostic)
// ---------------------------------------------------------------------------

describe("Engine-agnostic observer compatibility", () => {
  it("budget and context observers work in a chain with all event types", () => {
    const chain = createObserverChain([
      createBudgetAwarenessObserver(() => ({ remainingCalls: 2, remainingTokens: 3_000 })),
      createContextPressureObserver(() => 75),
      createToolFailureObserver(),
    ]);

    // Feed events that any engine (harness or Claude) would emit
    chain.onEvent(toolUse("Read", { file_path: "/a.ts" }));
    chain.onEvent(toolResult(false));
    chain.onEvent(textEvent());
    chain.onEvent(resultEvent());

    const messages = chain.onTurnComplete();
    // Budget awareness and context pressure should fire; tool failure should not
    expect(messages.length).toBe(2);
    expect(messages.some((m) => m.includes("Budget running low"))).toBe(true);
    expect(messages.some((m) => m.includes("Context is filling up"))).toBe(true);
  });

  it("observers handle the full EngineEvent union without errors", () => {
    const events: EngineEvent[] = [
      { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" } },
      { type: "tool_result", isError: false },
      { type: "text" },
      { type: "result" },
      { type: "other" },
    ];

    const budget = createBudgetAwarenessObserver(() => ({ remainingCalls: 10, remainingTokens: 50_000 }));
    const context = createContextPressureObserver(() => 30);

    for (const event of events) {
      budget.onEvent(event);
      context.onEvent(event);
    }

    // Neither should fire with comfortable budget and low context
    expect(budget.onTurnComplete()).toBeNull();
    expect(context.onTurnComplete()).toBeNull();
  });
});
