/**
 * Resume Flow Tests (Phase 4)
 *
 * Tests the end-to-end resume path:
 * - injectOutputBlocks utility: chunked block injection into the store
 * - Resume result → store → shell wiring
 * - OutputSnapshot → AnyBlock compatibility
 * - Session state transition work:paused → work:active
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createTestStore } from "../src/tui/routes/work/context/ui-state/store";
import { injectOutputBlocks } from "../src/tui/components/resume-utils";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type { AnyBlock, TextBlock, ToolBlock, AgentBlock, SystemBlock } from "../src/tui/routes/work/state/types";
import type { OutputSnapshot } from "../src/schemas/output";

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
    { kind: "system", message: "Phase started", timestamp: 4000 },
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
// injectOutputBlocks — chunked injection
// ---------------------------------------------------------------------------

describe("injectOutputBlocks", () => {
  let store: UIActions;

  beforeEach(() => {
    store = createTestStore("test-plan");
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
      { kind: "system", message: "Phase started", timestamp: 3000 },
      { kind: "contextGroup", tools: [{ kind: "tool", name: "grep", detail: "*.ts", timestamp: 4000 }], timestamp: 4000 },
    ];

    injectOutputBlocks(store, blocks);
    expect(store.getState().outputBlocks).toHaveLength(4);
    expect(store.getState().outputBlocks[0].kind).toBe("text");
    expect(store.getState().outputBlocks[1].kind).toBe("tool");
    expect(store.getState().outputBlocks[2].kind).toBe("system");
    expect(store.getState().outputBlocks[3].kind).toBe("contextGroup");
  });
});

// ---------------------------------------------------------------------------
// OutputSnapshot → AnyBlock compatibility
// ---------------------------------------------------------------------------

describe("OutputSnapshot → AnyBlock compatibility", () => {
  it("snapshots with 'paused' agent status can be cast to AnyBlock[]", () => {
    // OutputSnapshot uses "paused" for agent blocks. On resume,
    // these are injected as-is into the store. The renderer should handle
    // "paused" status for display purposes.
    const snapshots = makeVariedSnapshots();

    // Cast snapshots to AnyBlock[] — this is what the shell does on resume
    const blocks = snapshots as unknown as AnyBlock[];

    const store = createTestStore("test");
    injectOutputBlocks(store, blocks);

    expect(store.getState().outputBlocks).toHaveLength(5);

    // Agent block retains its "paused" status from the snapshot.
    // Note: AnyBlock's AgentBlock type only declares "active" | "completed" | "error",
    // but the persisted snapshot uses "paused". At runtime the value is preserved.
    const agentBlock = store.getState().outputBlocks[2];
    expect(agentBlock.kind).toBe("agent");
    expect((agentBlock as any).status).toBe("paused");
    expect((agentBlock as any).agentLabel).toBe("worker");
  });

  it("text snapshots are identical to TextBlock", () => {
    const snapshot: OutputSnapshot = { kind: "text", content: "hello", timestamp: 1000 };
    const block = snapshot as unknown as TextBlock;

    expect(block.kind).toBe("text");
    expect(block.content).toBe("hello");
    expect(block.timestamp).toBe(1000);
  });

  it("tool snapshots are identical to ToolBlock", () => {
    const snapshot: OutputSnapshot = { kind: "tool", name: "read", detail: "file.ts", timestamp: 2000 };
    const block = snapshot as unknown as ToolBlock;

    expect(block.kind).toBe("tool");
    expect(block.name).toBe("read");
    expect(block.detail).toBe("file.ts");
  });

  it("system snapshots are identical to SystemBlock", () => {
    const snapshot: OutputSnapshot = { kind: "system", message: "Phase started", timestamp: 3000 };
    const block = snapshot as unknown as SystemBlock;

    expect(block.kind).toBe("system");
    expect(block.message).toBe("Phase started");
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
    const store = createTestStore("resumed-plan");

    // Simulate orchestrator result
    const resumeResult = {
      session: {
        planPath: "plans/test.md",
        statePath: ".flywheel/state/test.state.md",
        contextPath: ".flywheel/context/test.ctx.md",
        currentPhase: 2,
        lastUpdated: new Date().toISOString(),
        workflowId: crypto.randomUUID(),
        sessionLifecycleState: "work:paused" as const,
      },
      outputBlocks: makeVariedSnapshots(),
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
    };

    // Inject output blocks (what the shell does)
    injectOutputBlocks(store, resumeResult.outputBlocks as unknown as AnyBlock[]);

    // Verify all blocks are injected
    expect(store.getState().outputBlocks).toHaveLength(5);
    expect(store.getState().outputBlocks[0].kind).toBe("text");
    expect(store.getState().outputBlocks[4].kind).toBe("contextGroup");
  });

  it("store with existing blocks gets replaced on resume", () => {
    const store = createTestStore("old-plan");

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
