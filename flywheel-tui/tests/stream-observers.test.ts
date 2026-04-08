// ---------------------------------------------------------------------------
// Stream Observers — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for engine-agnostic observers that watch EngineEvents and produce
// injection messages at turn boundaries.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "bun:test";

import {
  createObserverChain,
  createToolFailureObserver,
  createNoActionObserver,
  type EngineEvent,
  type StreamObserver,
} from "../src/orchestration/engines/stream-observers.js";

import {
  createDoomLoopObserver,
  extractToolSignature,
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
// extractToolSignature
// ---------------------------------------------------------------------------

describe("extractToolSignature", () => {
  it("uses shallow value hash (sliced to 100 chars)", () => {
    const longVal = "x".repeat(200);
    const sig1 = extractToolSignature("Read", { file_path: longVal });
    const sig2 = extractToolSignature("Read", { file_path: longVal + "extra" });
    // Both should produce the same signature because we only look at first 100 chars
    expect(sig1).toBe(sig2);
  });

  it("sorts keys deterministically", () => {
    const sig1 = extractToolSignature("Write", { content: "a", file_path: "/b" });
    const sig2 = extractToolSignature("Write", { file_path: "/b", content: "a" });
    expect(sig1).toBe(sig2);
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
// NoActionObserver
// ---------------------------------------------------------------------------

describe("NoActionObserver", () => {
  it("fires when turn completes with no tool_use events", () => {
    const obs = createNoActionObserver();
    obs.onEvent(textEvent());
    const msg = obs.onTurnComplete();
    expect(msg).not.toBeNull();
    expect(msg).toContain("No tool calls were made");
  });

  it("does NOT fire when tools were used", () => {
    const obs = createNoActionObserver();
    obs.onEvent(textEvent());
    obs.onEvent(toolUse("Read", { file_path: "/a.ts" }));
    const msg = obs.onTurnComplete();
    expect(msg).toBeNull();
  });

  it("resets between turns", () => {
    const obs = createNoActionObserver();
    obs.onEvent(toolUse("Read", { file_path: "/a.ts" }));
    obs.onTurnComplete(); // first turn — had tools
    // second turn — no tools
    obs.onEvent(textEvent());
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
      createNoActionObserver(),
    ]);
    // No tool_use + 3 error tool_results → both should fire
    chain.onEvent(toolResult(true));
    chain.onEvent(toolResult(true));
    chain.onEvent(toolResult(true));
    const messages = chain.onTurnComplete();
    // NoActionObserver fires (no tool_use), ToolFailureObserver fires (3 errors)
    expect(messages.length).toBe(2);
  });

  it("returns empty array when no observers fire", () => {
    const chain = createObserverChain([
      createToolFailureObserver(),
      createNoActionObserver(),
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
