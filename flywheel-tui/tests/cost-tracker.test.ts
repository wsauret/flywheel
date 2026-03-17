import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createCostTracker } from "../src/session/cost-tracker";
import { createSession, readSession } from "../src/session/persistence";
import type { CliSession } from "../src/schemas/session";
import type { NDJSONEvent } from "../src/worker/ndjson-parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-cost-test-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalSession(overrides?: Partial<CliSession>): CliSession {
  return {
    planPath: "plans/test.md",
    statePath: ".flywheel/state/test.state.md",
    contextPath: ".flywheel/context/test.ctx.md",
    currentPhase: 0,
    lastUpdated: new Date().toISOString(),
    workflowId: crypto.randomUUID(),
    ...overrides,
  };
}

/** Build a step_finish NDJSONEvent with cost_usd. */
function stepFinishEvent(costUsd: number): NDJSONEvent {
  return {
    type: "step_finish",
    data: {
      type: "step_finish",
      sessionID: "abc-123",
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cost_usd: costUsd,
      },
    },
    raw: JSON.stringify({
      type: "step_finish",
      sessionID: "abc-123",
      usage: { input_tokens: 1000, output_tokens: 500, cost_usd: costUsd },
    }),
  };
}

/** Build a step_finish event with no cost data. */
function stepFinishNoCost(): NDJSONEvent {
  return {
    type: "step_finish",
    data: {
      type: "step_finish",
      sessionID: "abc-123",
    },
    raw: JSON.stringify({ type: "step_finish", sessionID: "abc-123" }),
  };
}

/** Build a non-step_finish event (text). */
function textEvent(text: string): NDJSONEvent {
  return {
    type: "text",
    data: { type: "text", content: text },
    raw: JSON.stringify({ type: "text", content: text }),
  };
}

/** Wait for debounce to settle. */
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
// Cost parsing from step_finish events
// ---------------------------------------------------------------------------

describe("CostTracker — cost parsing", () => {
  it("extracts cost_usd from a step_finish event", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.025));

    expect(tracker.getTotalCost()).toBe(0.025);
    tracker.dispose();
  });

  it("ignores non-step_finish events", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(textEvent("hello world"));

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });

  it("ignores step_finish events without usage/cost data", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishNoCost());

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });

  it("ignores step_finish events with invalid cost (non-number)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 1000 });

    const event: NDJSONEvent = {
      type: "step_finish",
      data: {
        type: "step_finish",
        usage: { cost_usd: "not-a-number" },
      },
      raw: "{}",
    };
    tracker.handleEvent(event);

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cost accumulation across multiple events
// ---------------------------------------------------------------------------

describe("CostTracker — accumulation", () => {
  it("accumulates cost across multiple step_finish events", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.025));
    tracker.handleEvent(stepFinishEvent(0.050));
    tracker.handleEvent(stepFinishEvent(0.010));

    expect(tracker.getTotalCost()).toBeCloseTo(0.085, 10);
    tracker.dispose();
  });

  it("accumulates cost from mixed events (ignores non-cost events)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.handleEvent(textEvent("some output"));
    tracker.handleEvent(stepFinishNoCost());
    tracker.handleEvent(stepFinishEvent(0.02));

    expect(tracker.getTotalCost()).toBeCloseTo(0.03, 10);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Debounced persistence writes
// ---------------------------------------------------------------------------

describe("CostTracker — debounced persistence", () => {
  it("does not write to session file immediately on event", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 50 });

    tracker.handleEvent(stepFinishEvent(0.025));

    // Should NOT have written yet (debounce hasn't fired)
    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeUndefined();
    tracker.dispose();
  });

  it("writes to session file after debounce interval", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 10 });

    tracker.handleEvent(stepFinishEvent(0.025));

    // Wait for debounce to fire
    await wait(50);

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.025, 10);
    tracker.dispose();
  });

  it("coalesces multiple events into a single write", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 30 });

    // Fire 3 events quickly — should coalesce into one debounced write
    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.handleEvent(stepFinishEvent(0.02));
    tracker.handleEvent(stepFinishEvent(0.03));

    // Wait for debounce to fire
    await wait(80);

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.06, 10);
    tracker.dispose();
  });

  it("fires additional writes when events arrive after debounce", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 10 });

    // First batch
    tracker.handleEvent(stepFinishEvent(0.01));
    await wait(50);

    const session1 = readSession(sessionId, baseDir);
    expect(session1!.totalCost).toBeCloseTo(0.01, 10);

    // Second batch
    tracker.handleEvent(stepFinishEvent(0.02));
    await wait(50);

    const session2 = readSession(sessionId, baseDir);
    expect(session2!.totalCost).toBeCloseTo(0.03, 10);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// flush()
// ---------------------------------------------------------------------------

describe("CostTracker — flush", () => {
  it("force-writes pending cost immediately", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.05));
    tracker.flush();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.05, 10);
    tracker.dispose();
  });

  it("flush is idempotent when no pending cost", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 5000 });

    // No events — flush should not throw or corrupt
    tracker.flush();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeUndefined();
    tracker.dispose();
  });

  it("flush cancels pending debounce timer", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 30 });

    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.flush();

    // Verify the write happened immediately
    const session1 = readSession(sessionId, baseDir);
    expect(session1!.totalCost).toBeCloseTo(0.01, 10);

    // Wait for the original debounce interval — should NOT double-write
    // (No harm if it does, but we want to verify debounce was cancelled)
    await wait(80);

    const session2 = readSession(sessionId, baseDir);
    expect(session2!.totalCost).toBeCloseTo(0.01, 10);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("CostTracker — dispose", () => {
  it("flushes pending cost on dispose", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.07));
    tracker.dispose();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.07, 10);
  });

  it("dispose is safe to call multiple times", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.dispose();
    tracker.dispose(); // should not throw

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.01, 10);
  });
});

// ---------------------------------------------------------------------------
// Session summary: totalCost accessible from session data
// ---------------------------------------------------------------------------

describe("CostTracker — session summary", () => {
  it("totalCost is accessible in session JSON after flush", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.10));
    tracker.handleEvent(stepFinishEvent(0.25));
    tracker.flush();

    // Read raw file to verify structure
    const filePath = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      `${sessionId}.json`,
    );
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.totalCost).toBeCloseTo(0.35, 10);

    // Also verify via readSession (Zod-validated)
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.totalCost).toBeCloseTo(0.35, 10);
    tracker.dispose();
  });

  it("preserves existing session data when writing cost", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(
      minimalSession({ currentPhase: 3, name: "My Plan" }),
      baseDir,
    );
    const tracker = createCostTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.05));
    tracker.flush();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.05, 10);
    expect(session!.currentPhase).toBe(3);
    expect(session!.name).toBe("My Plan");
    expect(session!.planPath).toBe("plans/test.md");
    tracker.dispose();
  });
});
