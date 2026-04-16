/**
 * Integration tests for session persistence and resume flow.
 *
 * Exercises:
 * 1. Create session via manager -> persist -> read back -> assert fields match
 * 2. Create session -> transition to paused -> persist output blocks ->
 *    load via loadResumeData -> assert restored
 * 3. Budget continuity — create tracker -> add tokens/cost -> flush ->
 *    create new tracker with same sessionId -> assert values restored via session file
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSessionManager,
  type SessionManager,
  type SessionManagerDeps,
} from "../src/orchestration/session/manager";
import { readSession } from "../src/orchestration/session/persistence";
import { createOutputPersistence } from "../src/orchestration/session/output-persistence";
import { createQueuePersistence } from "../src/workflows/queue/persistence";
import { createBudgetTracker } from "../src/orchestration/session/budget-tracker";
import { loadResumeData } from "../src/orchestration/session-actions";
import {
  fromSnapshot,
  type OutputSnapshot,
} from "../src/orchestration/session/output-schemas";
import { isResumable } from "../src/orchestration/session/types";
import type { Queue } from "../src/workflows/queue/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-resume-integ-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDeps(baseDir: string): SessionManagerDeps {
  return { baseDir };
}


/** Minimal queue for testing — one completed step and one pending step. */
function makeTestQueue(): Queue {
  return {
    steps: [
      {
        id: "step-1",
        type: "work",
        title: "Implement feature",
        description: "Implement the feature",
        status: "completed",
      },
      {
        id: "step-2",
        type: "review",
        title: "Review changes",
        description: "Review the changes",
        status: "pending",
      },
    ],
    cursor: 1,
    status: "paused",
    mutationLog: [],
  } as unknown as Queue;
}

/** Minimal output blocks for testing. */
function makeTestBlocks(): OutputSnapshot[] {
  return [
    {
      kind: "text",
      content: "Implementing feature X",
      timestamp: Date.now() - 5000,
    },
    {
      kind: "tool",
      name: "Edit",
      detail: "src/main.ts",
      timestamp: Date.now() - 3000,
    },
    {
      kind: "system",
      message: "Step 1 completed",
      timestamp: Date.now() - 1000,
    },
  ];
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// Test 1: Create session -> persist -> read back -> assert fields match
// ---------------------------------------------------------------------------

describe("session persistence roundtrip", () => {
  it("creates a session via manager and reads it back with matching fields", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("test plan", "Test Session", "work");

    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");

    // Read back from disk
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.label).toBe("Test Session");
    expect(session!.name).toBe("Test Session");
    expect(session!.planPath).toBe("test plan");
    expect(session!.state).toBe("active");
    expect(session!.command).toBe("work");
    expect(session!.kind).toBe("workflow");
    expect(session!.budgetUsage).toEqual({
      invocations_used: 0,
      tokens_used: 0,
      cost_usd: 0,
      context_prompt_tokens: 0,
      context_window: 0,
    });

    // List should include this session
    const { sessions } = manager.list();
    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeTruthy();
    expect(found!.name).toBe("Test Session");
    expect(found!.state).toBe("active");
  });

  it("transitions through lifecycle states via direct updateState", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));
    const sessionId = manager.create("plan", "Lifecycle Test", "work");

    // Verify starts as active
    const afterCreate = readSession(sessionId, baseDir);
    expect(afterCreate!.state).toBe("active");

    // Transition active -> paused
    manager.updateState(sessionId, "paused");

    const afterPaused = readSession(sessionId, baseDir);
    expect(afterPaused!.state).toBe("paused");
    expect(isResumable(afterPaused!.state!)).toBe(true);

    // Transition paused -> active (resume)
    manager.updateState(sessionId, "active");

    const afterResume = readSession(sessionId, baseDir);
    expect(afterResume!.state).toBe("active");

    // Transition active -> completed
    manager.updateState(sessionId, "completed");

    const afterComplete = readSession(sessionId, baseDir);
    expect(afterComplete!.state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Full resume flow — persist output + queue, load via loadResumeData
// ---------------------------------------------------------------------------

describe("session resume via loadResumeData", () => {
  it("persists output blocks and queue, then restores them on resume", async () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    // 1. Create session (starts as active)
    const sessionId = manager.create("plan", "Resume Test", "work");

    // 2. Persist output blocks
    const blocks = makeTestBlocks();
    const outputPersistence = createOutputPersistence({
      sessionId,
      baseDir,
    });
    outputPersistence.save(blocks);

    // 3. Persist queue state
    const queue = makeTestQueue();
    const queuePersistence = createQueuePersistence({
      sessionId,
      baseDir,
    });
    queuePersistence.save(queue);

    // 4. "Interrupt" — transition to paused
    manager.updateState(sessionId, "paused");

    // Verify session is resumable
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(isResumable(session!.state!)).toBe(true);

    // 5. Resume via loadResumeData
    const result = await loadResumeData(sessionId, baseDir);

    // 6. Assert output blocks restored
    expect(result).not.toBeNull();
    expect(result!.outputBlocks).toHaveLength(3);
    expect(result!.outputBlocks[0].kind).toBe("text");
    expect((result!.outputBlocks[0] as any).content).toBe(
      "Implementing feature X",
    );
    expect(result!.outputBlocks[1].kind).toBe("tool");
    expect(result!.outputBlocks[2].kind).toBe("system");

    // 7. Assert queue restored with crash recovery applied
    expect(result!.queue).not.toBeNull();
    expect(result!.queue.steps).toHaveLength(2);
    // Completed step stays completed
    expect(result!.queue.steps[0].status).toBe("completed");
    // Pending step stays pending
    expect(result!.queue.steps[1].status).toBe("pending");

    // 8. Assert session data
    expect(result!.session.name).toBe("Resume Test");
  });

  it("returns null when session has no persisted queue", async () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "No Queue", "work");

    // Persist output but NOT queue
    const outputPersistence = createOutputPersistence({
      sessionId,
      baseDir,
    });
    outputPersistence.save(makeTestBlocks());

    manager.updateState(sessionId, "paused");

    const result = await loadResumeData(sessionId, baseDir);
    // Should return null because queue is required for resume
    expect(result).toBeNull();
  });

  it("finds most recent resumable session from list", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    // Create two sessions, both paused
    const id1 = manager.create("plan1", "First Session", "work");
    manager.updateState(id1, "paused");

    const id2 = manager.create("plan2", "Second Session", "work");
    manager.updateState(id2, "paused");

    // Find resumable sessions
    const { sessions } = manager.list();
    const resumable = sessions
      .filter((s) => isResumable(s.state))
      .sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() -
          new Date(a.lastUpdated).getTime(),
      );

    expect(resumable).toHaveLength(2);
    // Both sessions should be present and paused
    const ids = resumable.map((s) => s.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(resumable.every((s) => s.state === "paused")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Budget continuity
// ---------------------------------------------------------------------------

describe("budget continuity across session resume", () => {
  it("persists budget usage and reads it back from session file", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));
    const sessionId = manager.create("plan", "Budget Test", "work");

    // Create budget tracker and simulate usage
    const tracker1 = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0, // Immediate writes for testing
    });

    // Simulate Claude result events (NDJSON format: type + data envelope)
    // usage.input_tokens / output_tokens are per-turn values (not cumulative);
    // total_cost_usd IS cumulative within a process.
    tracker1.handleEvent({
      type: "result",
      data: {
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    });
    tracker1.handleEvent({
      type: "result",
      data: {
        total_cost_usd: 0.08,
        usage: { input_tokens: 800, output_tokens: 300 },
      },
    });
    tracker1.incrementInvocations();
    tracker1.incrementInvocations();

    // Force flush to disk
    tracker1.flush();
    tracker1.dispose();

    // Verify budget was persisted to session file
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.totalCost).toBeCloseTo(0.08, 4);
    expect(session!.budgetUsage.cost_usd).toBeCloseTo(0.08, 4);
    expect(session!.budgetUsage.tokens_used).toBe(2600); // (1000+500) + (800+300)
    expect(session!.budgetUsage.invocations_used).toBe(2);

    // Create a new budget tracker with the same sessionId
    // (simulates what happens on resume — tracker reads from session.json)
    const tracker2 = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 0,
    });

    // Add more usage in the resumed session
    tracker2.handleEvent({
      type: "result",
      data: {
        total_cost_usd: 0.02,
        usage: { input_tokens: 400, output_tokens: 200 },
      },
    });
    tracker2.incrementInvocations();
    tracker2.flush();
    tracker2.dispose();

    // Verify the session file has accumulated all usage
    const sessionAfter = readSession(sessionId, baseDir);
    expect(sessionAfter).not.toBeNull();
    expect(sessionAfter!.budgetUsage.cost_usd).toBeCloseTo(0.10, 4); // 0.08 + 0.02
    expect(sessionAfter!.budgetUsage.tokens_used).toBe(3200); // 2600 + 600
    expect(sessionAfter!.budgetUsage.invocations_used).toBe(3); // 2 + 1
  });
});
