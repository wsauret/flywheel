/**
 * Pause Wiring Tests (Step 2)
 *
 * Tests the gap where pausePipeline() cannot persist state because:
 * 1. No Session exists (startPipeline never calls manager.create())
 * 2. activeSessionId is never set
 *
 * These tests verify the building blocks that will be wired into startPipeline:
 * - manager.create() returns a usable session ID
 * - updateState() to work:paused succeeds when activeSessionId is set
 * - Output flusher integration with session lifecycle
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSessionManager,
  type SessionManagerDeps,
} from "../src/session/manager";
import { readSession, updateSession } from "../src/session/persistence";
import { createOutputPersistence } from "../src/session/output-persistence";
import type { WorkflowSession } from "../src/tui/session/workflow-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-pause-wiring-test-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMockWorkflowSession(planPath: string): WorkflowSession {
  return {
    store: {} as WorkflowSession["store"],
    adapter: {
      stop: () => {},
      disconnect: () => {},
    } as WorkflowSession["adapter"],
    eventBus: {} as WorkflowSession["eventBus"],
    planPath,
  };
}

function makeDeps(
  baseDir: string,
  overrides?: Partial<SessionManagerDeps>,
): SessionManagerDeps {
  return {
    baseDir,
    createWorkflowSessionFn: (planPath: string) =>
      makeMockWorkflowSession(planPath),
    destroyWorkflowSessionFn: (_session: WorkflowSession) => {},
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
// Session creation for pipeline → pause flow
// ---------------------------------------------------------------------------

describe("Pause wiring — session creation in startPipeline", () => {
  it("manager.create() returns a session ID that can be used with updateState", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const sessionId = mgr.create("plan -> work -> review");
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Verify session exists on disk
    const persisted = readSession(sessionId, baseDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.planPath).toBe("plan -> work -> review");
  });

  it("session can be transitioned to work:active and then work:paused", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const sessionId = mgr.create("plans/test.md");

    // Transition through the required states to reach work:paused
    mgr.updateState(sessionId, "plan:imported");
    mgr.updateState(sessionId, "plan:approved");
    mgr.updateState(sessionId, "work:active");
    mgr.updateState(sessionId, "work:paused");

    const persisted = readSession(sessionId, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("work:paused");
  });

  it("outputPath can be set on a created session", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const sessionId = mgr.create("plans/test.md");

    // Set outputPath (what startPipeline will do after creating session)
    updateSession(sessionId, { outputPath: `${sessionId}.output.json` }, baseDir);

    const persisted = readSession(sessionId, baseDir);
    expect(persisted!.outputPath).toBe(`${sessionId}.output.json`);
  });

  it("updateState to work:paused fails when session does not exist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.updateState("non-existent-id", "work:paused")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Output flusher integration with pause
// ---------------------------------------------------------------------------

describe("Pause wiring — output flusher integration", () => {
  it("flusher.flush() persists current blocks immediately", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const blocks = [
      { kind: "text" as const, content: "output before pause", timestamp: Date.now() },
      { kind: "system" as const, message: "step completed", timestamp: Date.now() },
    ];

    const flusher = persistence.createFlusher(() => blocks, { intervalMs: 60000 });

    // schedule() sets pending data, flush() forces immediate write
    flusher.schedule();
    await flusher.flush();

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].kind).toBe("text");

    flusher.dispose();
  });

  it("flusher.flush() then dispose() preserves data", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const blocks = [
      { kind: "text" as const, content: "preserved", timestamp: Date.now() },
    ];

    const flusher = persistence.createFlusher(() => blocks, { intervalMs: 60000 });

    // schedule + flush + dispose (pause sequence)
    flusher.schedule();
    await flusher.flush();
    flusher.dispose();

    // Data should still be on disk
    const loaded = await persistence.load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as any).content).toBe("preserved");
  });

  it("flusher schedule + flush works with step:completed event pattern", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    let currentBlocks = [
      { kind: "text" as const, content: "step-1-output", timestamp: Date.now() },
    ];

    const flusher = persistence.createFlusher(() => currentBlocks, { intervalMs: 20 });

    // Simulate step:completed event triggering flush
    flusher.schedule();
    await flusher.flush();

    // Update blocks (next step)
    currentBlocks = [
      ...currentBlocks,
      { kind: "text" as const, content: "step-2-output", timestamp: Date.now() },
    ];

    // Another step completed — schedule + flush for the new data
    flusher.schedule();
    await flusher.flush();

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(2);

    flusher.dispose();
  });
});

// ---------------------------------------------------------------------------
// Full pause sequence: create session → set outputPath → flush → updateState
// ---------------------------------------------------------------------------

describe("Pause wiring — full pause sequence", () => {
  it("simulates the complete startPipeline + pausePipeline flow", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // === startPipeline flow ===
    // 1. Create session
    const sessionId = mgr.create("plan -> work -> review");

    // 2. Set outputPath
    updateSession(sessionId, { outputPath: `${sessionId}.output.json` }, baseDir);

    // 3. Transition to work:active
    mgr.updateState(sessionId, "plan:imported");
    mgr.updateState(sessionId, "plan:approved");
    mgr.updateState(sessionId, "work:active");

    // 4. Start output flusher
    const persistence = createOutputPersistence({ sessionId, baseDir });
    const blocks = [
      { kind: "text" as const, content: "work output", timestamp: Date.now() },
      { kind: "tool" as const, name: "read", detail: "file.ts", timestamp: Date.now() },
    ];
    const flusher = persistence.createFlusher(() => blocks, { intervalMs: 5000 });

    // === pausePipeline flow ===
    // 5. Flush output before shutdown (schedule marks data pending, flush writes)
    flusher.schedule();
    await flusher.flush();
    flusher.dispose();

    // 6. Persist work:paused state
    mgr.updateState(sessionId, "work:paused");

    // === Verify everything persisted ===
    const session = readSession(sessionId, baseDir);
    expect(session!.sessionLifecycleState).toBe("work:paused");
    expect(session!.outputPath).toBe(`${sessionId}.output.json`);

    const output = await persistence.load();
    expect(output).toHaveLength(2);
  });

  it("session can be resumed after pause", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const sessionId = mgr.create("plans/resumable.md");
    mgr.updateState(sessionId, "plan:imported");
    mgr.updateState(sessionId, "plan:approved");
    mgr.updateState(sessionId, "work:active");
    mgr.updateState(sessionId, "work:paused");

    // Resume: work:paused -> work:active
    mgr.updateState(sessionId, "work:active");

    const session = readSession(sessionId, baseDir);
    expect(session!.sessionLifecycleState).toBe("work:active");
  });
});
