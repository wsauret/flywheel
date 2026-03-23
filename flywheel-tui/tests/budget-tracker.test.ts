import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createBudgetTracker } from "../src/session/budget-tracker";
import { createSession, readSession } from "../src/session/persistence";
import type { Session } from "../src/schemas/session";
import type { BudgetLimits } from "../src/schemas/shared";
import type { NDJSONEvent } from "../src/worker/ndjson-parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-budget-test-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalSession(overrides?: Partial<Session>): Session {
  return {
    label: "plans/test.md",
    planPath: "plans/test.md",
    lastUpdated: new Date().toISOString(),
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    workflowType: "work",
    ...overrides,
  };
}

/** Build a step_finish NDJSONEvent with cost_usd and token counts. */
function stepFinishEvent(costUsd: number, inputTokens = 1000, outputTokens = 500): NDJSONEvent {
  return {
    type: "step_finish",
    data: {
      type: "step_finish",
      sessionID: "abc-123",
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
      },
    },
    raw: JSON.stringify({
      type: "step_finish",
      sessionID: "abc-123",
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd },
    }),
  };
}

/** Build a step_finish event with cost but no token fields. */
function stepFinishNoTokens(costUsd: number): NDJSONEvent {
  return {
    type: "step_finish",
    data: {
      type: "step_finish",
      sessionID: "abc-123",
      usage: {
        cost_usd: costUsd,
      },
    },
    raw: JSON.stringify({
      type: "step_finish",
      sessionID: "abc-123",
      usage: { cost_usd: costUsd },
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

/** Default unlimited budget limits. */
function unlimitedLimits(overrides?: Partial<BudgetLimits>): BudgetLimits {
  return {
    max_invocations: 0,
    max_tokens: null,
    wall_clock_deadline: null,
    ...overrides,
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

describe("BudgetTracker — cost parsing", () => {
  it("extracts cost_usd from a step_finish event", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.025));

    expect(tracker.getTotalCost()).toBe(0.025);
    tracker.dispose();
  });

  it("ignores non-step_finish events", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(textEvent("hello world"));

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });

  it("ignores step_finish events without usage/cost data", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishNoCost());

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });

  it("ignores step_finish events with invalid cost (non-number)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

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

describe("BudgetTracker — accumulation", () => {
  it("accumulates cost across multiple step_finish events", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.025));
    tracker.handleEvent(stepFinishEvent(0.050));
    tracker.handleEvent(stepFinishEvent(0.010));

    expect(tracker.getTotalCost()).toBeCloseTo(0.085, 10);
    tracker.dispose();
  });

  it("accumulates cost from mixed events (ignores non-cost events)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.handleEvent(textEvent("some output"));
    tracker.handleEvent(stepFinishNoCost());
    tracker.handleEvent(stepFinishEvent(0.02));

    expect(tracker.getTotalCost()).toBeCloseTo(0.03, 10);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Token tracking
// ---------------------------------------------------------------------------

describe("BudgetTracker — token tracking", () => {
  it("accumulates input_tokens + output_tokens from step_finish events", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.01, 1000, 500));
    tracker.handleEvent(stepFinishEvent(0.02, 2000, 800));

    expect(tracker.getTokensUsed()).toBe(4300); // (1000+500) + (2000+800)
    tracker.dispose();
  });

  it("returns 0 tokens when token fields are absent in NDJSON", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishNoTokens(0.01));

    expect(tracker.getTokensUsed()).toBe(0);
    expect(tracker.getTotalCost()).toBe(0.01); // cost still tracked
    tracker.dispose();
  });

  it("accumulates tokens from mixed events with and without token fields", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.01, 500, 200)); // 700 tokens
    tracker.handleEvent(stepFinishNoTokens(0.005));         // 0 tokens
    tracker.handleEvent(stepFinishEvent(0.02, 300, 100));  // 400 tokens

    expect(tracker.getTokensUsed()).toBe(1100);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Invocation tracking
// ---------------------------------------------------------------------------

describe("BudgetTracker — invocation tracking", () => {
  it("incrementInvocations() tracks phase-level invocation count", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    expect(tracker.getInvocationsUsed()).toBe(0);

    tracker.incrementInvocations();
    expect(tracker.getInvocationsUsed()).toBe(1);

    tracker.incrementInvocations();
    tracker.incrementInvocations();
    expect(tracker.getInvocationsUsed()).toBe(3);

    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Debounced persistence writes
// ---------------------------------------------------------------------------

describe("BudgetTracker — debounced persistence", () => {
  it("does not write to session file immediately on event", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 50 });

    tracker.handleEvent(stepFinishEvent(0.025));

    // Should NOT have written yet (debounce hasn't fired)
    const session = readSession(sessionId, baseDir);
    expect(session!.budgetUsage.cost_usd).toBe(0);
    tracker.dispose();
  });

  it("writes to session file after debounce interval", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 10 });

    tracker.handleEvent(stepFinishEvent(0.025));

    // Wait for debounce to fire
    await wait(50);

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.025, 10);
    expect(session!.budgetUsage.cost_usd).toBeCloseTo(0.025, 10);
    tracker.dispose();
  });

  it("coalesces multiple events into a single write", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 30 });

    // Fire 3 events quickly — should coalesce into one debounced write
    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.handleEvent(stepFinishEvent(0.02));
    tracker.handleEvent(stepFinishEvent(0.03));

    // Wait for debounce to fire
    await wait(80);

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.06, 10);
    expect(session!.budgetUsage.cost_usd).toBeCloseTo(0.06, 10);
    tracker.dispose();
  });

  it("fires additional writes when events arrive after debounce", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 10 });

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

describe("BudgetTracker — flush", () => {
  it("force-writes pending budget usage immediately", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.05, 2000, 1000));
    tracker.incrementInvocations();
    tracker.flush();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.05, 10);
    expect(session!.budgetUsage).toEqual({
      invocations_used: 1,
      tokens_used: 3000,
      cost_usd: expect.closeTo(0.05, 10),
    });
    tracker.dispose();
  });

  it("writes structured budgetUsage to session on flush", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.10, 5000, 2000));
    tracker.handleEvent(stepFinishEvent(0.25, 8000, 3000));
    tracker.incrementInvocations();
    tracker.incrementInvocations();
    tracker.flush();

    // Read raw file to verify structure
    const filePath = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      `${sessionId}.json`,
    );
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.budgetUsage).toEqual({
      invocations_used: 2,
      tokens_used: 18000, // (5000+2000) + (8000+3000)
      cost_usd: expect.closeTo(0.35, 10),
    });

    tracker.dispose();
  });

  it("flush is idempotent when no pending data", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    // No events — flush should not throw or corrupt
    tracker.flush();

    const session = readSession(sessionId, baseDir);
    // budgetUsage should remain at defaults (no write happened)
    expect(session!.budgetUsage).toEqual({
      invocations_used: 0,
      tokens_used: 0,
      cost_usd: 0,
    });
    tracker.dispose();
  });

  it("flush cancels pending debounce timer", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 30 });

    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.flush();

    // Verify the write happened immediately
    const session1 = readSession(sessionId, baseDir);
    expect(session1!.totalCost).toBeCloseTo(0.01, 10);

    // Wait for the original debounce interval — should NOT double-write
    await wait(80);

    const session2 = readSession(sessionId, baseDir);
    expect(session2!.totalCost).toBeCloseTo(0.01, 10);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("BudgetTracker — dispose", () => {
  it("flushes pending data on dispose", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.07));
    tracker.dispose();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.07, 10);
  });

  it("dispose is safe to call multiple times", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.01));
    tracker.dispose();
    tracker.dispose(); // should not throw

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.01, 10);
  });
});

// ---------------------------------------------------------------------------
// Session summary: budgetUsage accessible from session data
// ---------------------------------------------------------------------------

describe("BudgetTracker — session summary", () => {
  it("budgetUsage is accessible in session JSON after flush", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.10, 3000, 1000));
    tracker.handleEvent(stepFinishEvent(0.25, 6000, 2000));
    tracker.incrementInvocations();
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
    expect(raw.budgetUsage.invocations_used).toBe(1);
    expect(raw.budgetUsage.tokens_used).toBe(12000);
    expect(raw.budgetUsage.cost_usd).toBeCloseTo(0.35, 10);

    // Also verify via readSession (Zod-validated)
    const session = readSession(sessionId, baseDir);
    expect(session).not.toBeNull();
    expect(session!.totalCost).toBeCloseTo(0.35, 10);
    expect(session!.budgetUsage.cost_usd).toBeCloseTo(0.35, 10);
    tracker.dispose();
  });

  it("preserves existing session data when writing budget usage", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(
      minimalSession({ name: "My Plan" }),
      baseDir,
    );
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(stepFinishEvent(0.05));
    tracker.flush();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.05, 10);
    expect(session!.name).toBe("My Plan");
    expect(session!.planPath).toBe("plans/test.md");
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// isExhausted() — budget limit checking
// ---------------------------------------------------------------------------

describe("BudgetTracker — isExhausted", () => {
  it("returns true when invocations exceed limit (non-zero)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    const limits = unlimitedLimits({ max_invocations: 2 });

    tracker.incrementInvocations();
    expect(tracker.isExhausted(limits)).toBe(false);

    tracker.incrementInvocations();
    // At limit (2 used, 2 max) — exhausted
    expect(tracker.isExhausted(limits)).toBe(true);

    tracker.incrementInvocations();
    // Over limit — still exhausted
    expect(tracker.isExhausted(limits)).toBe(true);

    tracker.dispose();
  });

  it("returns false when invocation limit is 0 (unlimited)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    const limits = unlimitedLimits({ max_invocations: 0 });

    tracker.incrementInvocations();
    tracker.incrementInvocations();
    tracker.incrementInvocations();

    expect(tracker.isExhausted(limits)).toBe(false);
    tracker.dispose();
  });

  it("checks token limit (null = unlimited)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // null max_tokens = unlimited
    expect(tracker.isExhausted(unlimitedLimits({ max_tokens: null }))).toBe(false);

    tracker.handleEvent(stepFinishEvent(0.01, 500, 300)); // 800 tokens

    // Token limit not reached
    expect(tracker.isExhausted(unlimitedLimits({ max_tokens: 1000 }))).toBe(false);

    tracker.handleEvent(stepFinishEvent(0.01, 100, 200)); // +300 = 1100 total

    // Token limit exceeded
    expect(tracker.isExhausted(unlimitedLimits({ max_tokens: 1000 }))).toBe(true);

    tracker.dispose();
  });

  it("checks wall_clock_deadline — returns true when past deadline", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // Deadline in the past
    const pastDeadline = new Date(Date.now() - 60_000).toISOString();
    expect(tracker.isExhausted(unlimitedLimits({ wall_clock_deadline: pastDeadline }))).toBe(true);

    // Deadline in the future
    const futureDeadline = new Date(Date.now() + 60_000).toISOString();
    expect(tracker.isExhausted(unlimitedLimits({ wall_clock_deadline: futureDeadline }))).toBe(false);

    tracker.dispose();
  });

  it("checks wall_clock_deadline — at-deadline edge case (>=)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // Use a deadline exactly at "now" (technically already past by the time we check)
    // The implementation uses Date.now() >= deadlineMs, so exact match = exhausted
    const nowIso = new Date().toISOString();

    // Small sleep to ensure Date.now() is >= the parsed deadline
    const result = tracker.isExhausted(unlimitedLimits({ wall_clock_deadline: nowIso }));
    expect(result).toBe(true);

    tracker.dispose();
  });

  it("handles invalid wall_clock_deadline gracefully (NaN guard)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // Invalid date string — should NOT exhaust (NaN guard)
    expect(tracker.isExhausted(unlimitedLimits({ wall_clock_deadline: "not-a-date" }))).toBe(false);

    tracker.dispose();
  });

  it("returns false when all limits are unlimited", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.incrementInvocations();
    tracker.handleEvent(stepFinishEvent(0.50, 10000, 5000));

    expect(tracker.isExhausted(unlimitedLimits())).toBe(false);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// getBudgetStatus()
// ---------------------------------------------------------------------------

describe("BudgetTracker — getBudgetStatus", () => {
  it("returns invocations_remaining: null when unlimited (not 999)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.incrementInvocations();

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_invocations: 0 }));
    expect(status.invocations_remaining).toBeNull();

    tracker.dispose();
  });

  it("returns correct invocations_remaining when limited", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.incrementInvocations();
    tracker.incrementInvocations();

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_invocations: 5 }));
    expect(status.invocations_remaining).toBe(3);

    tracker.dispose();
  });

  it("invocations_remaining floors at 0 (never negative)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.incrementInvocations();
    tracker.incrementInvocations();
    tracker.incrementInvocations();

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_invocations: 2 }));
    expect(status.invocations_remaining).toBe(0);

    tracker.dispose();
  });

  it("returns token_budget_remaining: null when unlimited", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_tokens: null }));
    expect(status.token_budget_remaining).toBeNull();

    tracker.dispose();
  });

  it("returns correct token_budget_remaining when limited", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.01, 1000, 500)); // 1500 tokens

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_tokens: 10000 }));
    expect(status.token_budget_remaining).toBe(8500);

    tracker.dispose();
  });

  it("token_budget_remaining floors at 0 (never negative)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(stepFinishEvent(0.01, 5000, 3000)); // 8000 tokens

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_tokens: 5000 }));
    expect(status.token_budget_remaining).toBe(0);

    tracker.dispose();
  });

  it("passes through wall_clock_deadline from limits", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    const deadline = new Date(Date.now() + 60_000).toISOString();
    const status = tracker.getBudgetStatus(unlimitedLimits({ wall_clock_deadline: deadline }));
    expect(status.wall_clock_deadline).toBe(deadline);

    const statusNull = tracker.getBudgetStatus(unlimitedLimits({ wall_clock_deadline: null }));
    expect(statusNull.wall_clock_deadline).toBeNull();

    tracker.dispose();
  });
});
