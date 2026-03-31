/**
 * Resume Flow Tests (Step 4)
 *
 * Tests the end-to-end resume path:
 * - appendOutputBlocks: delta-only append to existing blocks
 * - injectOutputBlocks utility: chunked block injection with cancellation
 * - Resume result → store → shell wiring
 * - OutputSnapshot → AnyBlock compatibility
 * - Session state transition work:paused → work:active
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { injectOutputBlocks } from "../src/tui/session/resume-utils";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type { AnyBlock, TextBlock, ToolBlock, AgentBlock, SystemBlock } from "../src/tui/types";
import { snapshotToBlocks } from "../src/session/output-schemas";
import type { OutputSnapshot } from "../src/session/output-schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create N fake text blocks. */
function makeTextBlocks(count: number): AnyBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "text" as const,
    content: `block-${i}`,
    timestamp: Date.now() + i,
  }));
}

/** Create varied output snapshots for type compatibility tests. */
function makeVariedSnapshots(): OutputSnapshot[] {
  return [
    { kind: "text", content: "hello", timestamp: 1000 },
    { kind: "tool", name: "read", detail: "file.ts", timestamp: 2000 },
    { kind: "agent", id: "a1", agentLabel: "worker", description: "doing work", status: "paused", children: [], timestamp: 3000 },
    { kind: "system", message: "Step started", timestamp: 4000 },
    { kind: "contextGroup", tools: [{ kind: "tool", name: "grep", detail: "*.ts", timestamp: 5000 }], timestamp: 5000 },
  ];
}

/** Helper: wait for setTimeout(0) ticks to drain. */
function flushTimers(count: number = 1): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const tick = () => {
      remaining--;
      if (remaining <= 0) resolve();
      else setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
  });
}

// ---------------------------------------------------------------------------
// appendOutputBlocks — delta-only append
// ---------------------------------------------------------------------------

describe("appendOutputBlocks", () => {
  let store: UIActions;

  beforeEach(() => {
    store = createStore("test-plan");
  });

  it("appends blocks to an empty store", () => {
    const blocks = makeTextBlocks(3);
    store.appendOutputBlocks(blocks);

    expect(store.getState().outputBlocks).toHaveLength(3);
    expect((store.getState().outputBlocks[0] as TextBlock).content).toBe("block-0");
    expect((store.getState().outputBlocks[2] as TextBlock).content).toBe("block-2");
  });

  it("appends delta to existing blocks without replacing", () => {
    // Start with some existing blocks
    store.setOutputBlocks([
      { kind: "text", content: "existing-0", timestamp: 1 },
      { kind: "text", content: "existing-1", timestamp: 2 },
    ]);
    expect(store.getState().outputBlocks).toHaveLength(2);

    // Append new blocks (delta only)
    const delta: AnyBlock[] = [
      { kind: "text", content: "new-0", timestamp: 3 },
      { kind: "text", content: "new-1", timestamp: 4 },
    ];
    store.appendOutputBlocks(delta);

    // Should have 4 total: 2 existing + 2 new
    const output = store.getState().outputBlocks;
    expect(output).toHaveLength(4);
    expect((output[0] as TextBlock).content).toBe("existing-0");
    expect((output[1] as TextBlock).content).toBe("existing-1");
    expect((output[2] as TextBlock).content).toBe("new-0");
    expect((output[3] as TextBlock).content).toBe("new-1");
  });

  it("handles empty delta array as no-op", () => {
    store.setOutputBlocks(makeTextBlocks(3));
    store.appendOutputBlocks([]);
    expect(store.getState().outputBlocks).toHaveLength(3);
  });

  it("preserves block types when appending varied blocks", () => {
    store.setOutputBlocks([{ kind: "text", content: "first", timestamp: 1 }]);

    const delta: AnyBlock[] = [
      { kind: "tool", name: "read", detail: "file.ts", timestamp: 2 },
      { kind: "system", message: "Step started", timestamp: 3 },
    ];
    store.appendOutputBlocks(delta);

    const output = store.getState().outputBlocks;
    expect(output).toHaveLength(3);
    expect(output[0].kind).toBe("text");
    expect(output[1].kind).toBe("tool");
    expect(output[2].kind).toBe("system");
  });

  it("multiple sequential appends accumulate correctly", () => {
    store.appendOutputBlocks(makeTextBlocks(2));
    expect(store.getState().outputBlocks).toHaveLength(2);

    store.appendOutputBlocks(makeTextBlocks(3));
    expect(store.getState().outputBlocks).toHaveLength(5);

    store.appendOutputBlocks(makeTextBlocks(1));
    expect(store.getState().outputBlocks).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// injectOutputBlocks — chunked injection with cancellation
// ---------------------------------------------------------------------------

describe("injectOutputBlocks", () => {
  let store: UIActions;

  beforeEach(() => {
    store = createStore("test-plan");
  });

  it("injects empty blocks as no-op", () => {
    injectOutputBlocks(store, []);
    expect(store.getState().outputBlocks).toHaveLength(0);
  });

  it("injects small array (<= 100) immediately in one call", () => {
    const blocks = makeTextBlocks(50);
    injectOutputBlocks(store, blocks);

    // Should be injected immediately (synchronously)
    expect(store.getState().outputBlocks).toHaveLength(50);
    expect((store.getState().outputBlocks[0] as TextBlock).content).toBe("block-0");
    expect((store.getState().outputBlocks[49] as TextBlock).content).toBe("block-49");
  });

  it("injects exactly 100 blocks immediately", () => {
    const blocks = makeTextBlocks(100);
    injectOutputBlocks(store, blocks);

    expect(store.getState().outputBlocks).toHaveLength(100);
  });

  it("injects first 100 blocks immediately when total > 100", () => {
    const blocks = makeTextBlocks(500);
    injectOutputBlocks(store, blocks);

    // First batch (100) should be injected synchronously
    expect(store.getState().outputBlocks).toHaveLength(100);
    expect((store.getState().outputBlocks[0] as TextBlock).content).toBe("block-0");
    expect((store.getState().outputBlocks[99] as TextBlock).content).toBe("block-99");
  });

  it("injects remaining blocks in batches of 200 via setTimeout", async () => {
    const blocks = makeTextBlocks(500);
    injectOutputBlocks(store, blocks);

    // After first tick: 100 + 200 = 300
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(300);

    // After second tick: 300 + 200 = 500 (all done)
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(500);
  });

  it("handles large arrays (1000+ blocks) with multiple batches", async () => {
    const blocks = makeTextBlocks(1000);
    injectOutputBlocks(store, blocks);

    // Sync: 100
    expect(store.getState().outputBlocks).toHaveLength(100);

    // Tick 1: +200 = 300
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(300);

    // Tick 2: +200 = 500
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(500);

    // Tick 3: +200 = 700
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(700);

    // Tick 4: +200 = 900
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(900);

    // Tick 5: +100 = 1000 (remainder)
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(1000);
  });

  it("preserves block ordering across batches", async () => {
    const blocks = makeTextBlocks(400);
    injectOutputBlocks(store, blocks);

    // Wait for all batches
    await flushTimers(2);

    const output = store.getState().outputBlocks;
    expect(output).toHaveLength(400);

    // Verify ordering
    for (let i = 0; i < 400; i++) {
      expect((output[i] as TextBlock).content).toBe(`block-${i}`);
    }
  });

  it("handles varied block types (text, tool, agent, system, contextGroup)", () => {
    // OutputSnapshot types are structurally compatible with AnyBlock
    // (except agent "paused" status which is handled on resume)
    const blocks: AnyBlock[] = [
      { kind: "text", content: "hello", timestamp: 1000 },
      { kind: "tool", name: "read", detail: "file.ts", timestamp: 2000 },
      { kind: "system", message: "Step started", timestamp: 3000 },
      { kind: "contextGroup", tools: [{ kind: "tool", name: "grep", detail: "*.ts", timestamp: 4000 }], timestamp: 4000 },
    ];

    injectOutputBlocks(store, blocks);
    expect(store.getState().outputBlocks).toHaveLength(4);
    expect(store.getState().outputBlocks[0].kind).toBe("text");
    expect(store.getState().outputBlocks[1].kind).toBe("tool");
    expect(store.getState().outputBlocks[2].kind).toBe("system");
    expect(store.getState().outputBlocks[3].kind).toBe("contextGroup");
  });

  // --- Cancellation ---

  it("returns a handle with cancel()", () => {
    const blocks = makeTextBlocks(500);
    const handle = injectOutputBlocks(store, blocks);

    expect(handle).toBeDefined();
    expect(typeof handle.cancel).toBe("function");
  });

  it("cancel() stops further batches from being injected", async () => {
    const blocks = makeTextBlocks(500);
    const handle = injectOutputBlocks(store, blocks);

    // First batch (100) is already injected synchronously
    expect(store.getState().outputBlocks).toHaveLength(100);

    // Cancel before async batches run
    handle.cancel();

    // Wait for would-be timer ticks
    await flushTimers(3);

    // Should still be 100 — cancellation prevented further batches
    expect(store.getState().outputBlocks).toHaveLength(100);
  });

  it("cancel() mid-injection stops at the current progress", async () => {
    const blocks = makeTextBlocks(1000);
    const handle = injectOutputBlocks(store, blocks);

    // Let one async batch run: 100 + 200 = 300
    await flushTimers(1);
    expect(store.getState().outputBlocks).toHaveLength(300);

    // Cancel now
    handle.cancel();

    // Wait for more would-be ticks
    await flushTimers(5);

    // Should still be 300
    expect(store.getState().outputBlocks).toHaveLength(300);
  });

  it("cancelling an already-completed injection is a no-op", async () => {
    const blocks = makeTextBlocks(50);
    const handle = injectOutputBlocks(store, blocks);

    // All blocks fit in the first batch (< 100) — already done
    expect(store.getState().outputBlocks).toHaveLength(50);

    // Cancel after completion — should not throw or corrupt state
    handle.cancel();
    expect(store.getState().outputBlocks).toHaveLength(50);
  });

  it("new injection after cancel replaces content correctly", async () => {
    // Start first injection
    const blocks1 = makeTextBlocks(500);
    const handle1 = injectOutputBlocks(store, blocks1);

    // Cancel after first batch
    handle1.cancel();
    expect(store.getState().outputBlocks).toHaveLength(100);

    // Start new injection with different blocks
    const blocks2: AnyBlock[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "text" as const,
      content: `replacement-${i}`,
      timestamp: Date.now() + i,
    }));
    injectOutputBlocks(store, blocks2);

    // New injection uses setOutputBlocks for first batch, so it replaces
    expect(store.getState().outputBlocks).toHaveLength(50);
    expect((store.getState().outputBlocks[0] as TextBlock).content).toBe("replacement-0");
  });
});

// ---------------------------------------------------------------------------
// OutputSnapshot → AnyBlock compatibility
// ---------------------------------------------------------------------------

describe("OutputSnapshot → AnyBlock compatibility", () => {
  it("snapshotToBlocks converts snapshots with 'paused' agent status", () => {
    // OutputSnapshot uses "paused" for agent blocks. snapshotToBlocks
    // provides type-safe conversion without double-casts.
    const snapshots = makeVariedSnapshots();
    const blocks = snapshotToBlocks(snapshots) as AnyBlock[];

    const store = createStore("test");
    injectOutputBlocks(store, blocks);

    expect(store.getState().outputBlocks).toHaveLength(5);

    // Agent block retains its "paused" status from the snapshot.
    // AgentBlock.status now includes "paused" — no need for (as any).
    const agentBlock = store.getState().outputBlocks[2] as AgentBlock;
    expect(agentBlock.kind).toBe("agent");
    expect(agentBlock.status).toBe("paused");
    expect(agentBlock.agentLabel).toBe("worker");
  });

  it("text snapshots are identical to TextBlock", () => {
    const snapshot: OutputSnapshot = { kind: "text", content: "hello", timestamp: 1000 };
    const [block] = snapshotToBlocks([snapshot]) as AnyBlock[];

    expect(block.kind).toBe("text");
    expect((block as TextBlock).content).toBe("hello");
    expect((block as TextBlock).timestamp).toBe(1000);
  });

  it("tool snapshots are identical to ToolBlock", () => {
    const snapshot: OutputSnapshot = { kind: "tool", name: "read", detail: "file.ts", timestamp: 2000 };
    const [block] = snapshotToBlocks([snapshot]) as AnyBlock[];

    expect(block.kind).toBe("tool");
    expect((block as ToolBlock).name).toBe("read");
    expect((block as ToolBlock).detail).toBe("file.ts");
  });

  it("system snapshots are identical to SystemBlock", () => {
    const snapshot: OutputSnapshot = { kind: "system", message: "Step started", timestamp: 3000 };
    const [block] = snapshotToBlocks([snapshot]) as AnyBlock[];

    expect(block.kind).toBe("system");
    expect((block as SystemBlock).message).toBe("Step started");
  });
});

// ---------------------------------------------------------------------------
// Resume session state transitions
// ---------------------------------------------------------------------------

describe("Resume session state transitions", () => {
  it("work:paused → work:active is a valid state transition", () => {
    // Import the state machine validation
    const { isValidTransition } = require("../src/session/state-machine");

    expect(isValidTransition("work:paused", "work:active")).toBe(true);
  });

  it("work:paused → work:active → completed is valid", () => {
    const { isValidTransition } = require("../src/session/state-machine");

    expect(isValidTransition("work:paused", "work:active")).toBe(true);
    expect(isValidTransition("work:active", "completed")).toBe(true);
  });

  it("work:paused → completed is not directly valid (must go through work:active)", () => {
    const { isValidTransition } = require("../src/session/state-machine");

    // Check if work:paused can go directly to completed
    // Based on the state machine: work:paused -> work:active | trashed | archived
    // So work:paused -> completed is NOT valid
    expect(isValidTransition("work:paused", "completed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resume result → store injection integration
// ---------------------------------------------------------------------------

describe("Resume result → store injection", () => {
  it("full resume flow: orchestrator result → injectOutputBlocks → store has blocks", () => {
    // Simulate what resumeSession() in the shell does
    const store = createStore("resumed-plan");

    // Simulate orchestrator result
    const resumeResult = {
      session: {
        planPath: "plans/test.md",
        statePath: ".flywheel/state/test.state.md",
        contextPath: ".flywheel/context/test.ctx.md",
        currentStep: 2,
        lastUpdated: new Date().toISOString(),
        workflowId: crypto.randomUUID(),
        sessionLifecycleState: "work:paused" as const,
      },
      outputBlocks: makeVariedSnapshots(),
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
    };

    // Inject output blocks (what the shell does — using snapshotToBlocks)
    injectOutputBlocks(store, snapshotToBlocks(resumeResult.outputBlocks) as AnyBlock[]);

    // Verify all blocks are injected
    expect(store.getState().outputBlocks).toHaveLength(5);
    expect(store.getState().outputBlocks[0].kind).toBe("text");
    expect(store.getState().outputBlocks[4].kind).toBe("contextGroup");
  });

  it("store with existing blocks gets replaced on resume", () => {
    const store = createStore("old-plan");

    // Simulate existing blocks
    store.setOutputBlocks([
      { kind: "text", content: "old content", timestamp: 1 },
    ]);
    expect(store.getState().outputBlocks).toHaveLength(1);

    // Resume with new blocks
    const newBlocks: AnyBlock[] = makeTextBlocks(5);
    injectOutputBlocks(store, newBlocks);

    // Should have replaced, not appended
    expect(store.getState().outputBlocks).toHaveLength(5);
    expect((store.getState().outputBlocks[0] as TextBlock).content).toBe("block-0");
  });
});
