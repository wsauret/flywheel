import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createBudgetTracker } from "../src/orchestration/session/budget-tracker";
import { createSession, readSession } from "../src/orchestration/session/persistence";
import type { Session } from "../src/orchestration/session/schemas";
import type { BudgetLimits } from "../src/workflows/schemas";
import type { NDJSONEvent } from "../src/orchestration/worker/ndjson-parser";

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

/** Build a Claude Code "result" NDJSONEvent with total_cost_usd and token counts. */
function resultEvent(
  costUsd: number,
  inputTokens = 1000,
  outputTokens = 500,
  cacheRead = 0,
  cacheCreation = 0,
): NDJSONEvent {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      total_cost_usd: costUsd,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
    raw: JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      total_cost_usd: costUsd,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    }),
  };
}

/** Build a result event with no usage field (cost only). */
function resultNoUsage(costUsd: number): NDJSONEvent {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      total_cost_usd: costUsd,
    },
    raw: JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "abc-123",
      total_cost_usd: costUsd,
    }),
  };
}

/** Build a result event with no cost data (should be ignored). */
function resultNoCost(): NDJSONEvent {
  return {
    type: "result",
    data: {
      type: "result",
      subtype: "success",
      session_id: "abc-123",
    },
    raw: JSON.stringify({ type: "result", subtype: "success", session_id: "abc-123" }),
  };
}

/** Build an assistant event (non-cost, should be ignored by budget tracker). */
function assistantEvent(text: string): NDJSONEvent {
  return {
    type: "assistant",
    data: {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
    raw: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
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
// Cost parsing from result events
// ---------------------------------------------------------------------------

describe("BudgetTracker — cost parsing", () => {
  it("extracts total_cost_usd from a result event", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultEvent(0.025));

    expect(tracker.getTotalCost()).toBe(0.025);
    tracker.dispose();
  });

  it("ignores non-result events (assistant, system, etc.)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(assistantEvent("hello world"));

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });

  it("ignores result events without total_cost_usd", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultNoCost());

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });

  it("ignores result events with invalid cost (non-number)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    const event: NDJSONEvent = {
      type: "result",
      data: {
        type: "result",
        total_cost_usd: "not-a-number",
      },
      raw: "{}",
    };
    tracker.handleEvent(event);

    expect(tracker.getTotalCost()).toBe(0);
    tracker.dispose();
  });

  it("tracks cost when usage field is absent", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultNoUsage(0.01));

    expect(tracker.getTotalCost()).toBe(0.01);
    expect(tracker.getTokensUsed()).toBe(0);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Cost accumulation across multiple events
// ---------------------------------------------------------------------------

describe("BudgetTracker — accumulation", () => {
  it("accumulates cost across multiple result events", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultEvent(0.025));
    tracker.handleEvent(resultEvent(0.050));
    tracker.handleEvent(resultEvent(0.010));

    expect(tracker.getTotalCost()).toBeCloseTo(0.085, 10);
    tracker.dispose();
  });

  it("accumulates cost from mixed events (ignores non-cost events)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultEvent(0.01));
    tracker.handleEvent(assistantEvent("some output"));
    tracker.handleEvent(resultNoCost());
    tracker.handleEvent(resultEvent(0.02));

    expect(tracker.getTotalCost()).toBeCloseTo(0.03, 10);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Token tracking
// ---------------------------------------------------------------------------

describe("BudgetTracker — token tracking", () => {
  it("accumulates input_tokens + output_tokens from result events", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultEvent(0.01, 1000, 500));
    tracker.handleEvent(resultEvent(0.02, 2000, 800));

    expect(tracker.getTokensUsed()).toBe(4300); // (1000+500) + (2000+800)
    tracker.dispose();
  });

  it("returns 0 tokens when usage field is absent", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultNoUsage(0.01));

    expect(tracker.getTokensUsed()).toBe(0);
    expect(tracker.getTotalCost()).toBe(0.01); // cost still tracked
    tracker.dispose();
  });

  it("accumulates tokens from mixed events with and without token fields", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultEvent(0.01, 500, 200)); // 700 tokens
    tracker.handleEvent(resultNoUsage(0.005));          // 0 tokens
    tracker.handleEvent(resultEvent(0.02, 300, 100));  // 400 tokens

    expect(tracker.getTokensUsed()).toBe(1100);
    tracker.dispose();
  });

  it("excludes cache_read_input_tokens from token budget counter", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // 1000 input + 500 output + 50000 cache reads (cheap, excluded)
    tracker.handleEvent(resultEvent(0.05, 1000, 500, 50_000, 0));

    // Only input + output count toward the token budget
    expect(tracker.getTokensUsed()).toBe(1500);
    tracker.dispose();
  });

  it("excludes cache_creation_input_tokens from token budget counter", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // 1000 input + 500 output + 5000 cache creation tokens (excluded)
    tracker.handleEvent(resultEvent(0.05, 1000, 500, 0, 5_000));

    expect(tracker.getTokensUsed()).toBe(1500);
    tracker.dispose();
  });

  it("total_cost_usd is accurate even when cache tokens are present", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // Claude Code already accounts for cache pricing in total_cost_usd
    tracker.handleEvent(resultEvent(0.031, 1000, 500, 15_000, 2_000));

    // Cost should be exactly what Claude Code reported
    expect(tracker.getTotalCost()).toBeCloseTo(0.031, 10);
    // Token budget reflects only non-cache tokens
    expect(tracker.getTokensUsed()).toBe(1500);
    tracker.dispose();
  });
});

// ---------------------------------------------------------------------------
// Invocation tracking
// ---------------------------------------------------------------------------

describe("BudgetTracker — invocation tracking", () => {
  it("incrementInvocations() tracks step-level invocation count", () => {
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

    tracker.handleEvent(resultEvent(0.025));

    // Should NOT have written yet (debounce hasn't fired)
    const session = readSession(sessionId, baseDir);
    expect(session!.budgetUsage.cost_usd).toBe(0);
    tracker.dispose();
  });

  it("writes to session file after debounce interval", async () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 10 });

    tracker.handleEvent(resultEvent(0.025));

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
    tracker.handleEvent(resultEvent(0.01));
    tracker.handleEvent(resultEvent(0.02));
    tracker.handleEvent(resultEvent(0.03));

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
    tracker.handleEvent(resultEvent(0.01));
    await wait(50);

    const session1 = readSession(sessionId, baseDir);
    expect(session1!.totalCost).toBeCloseTo(0.01, 10);

    // Second batch
    tracker.handleEvent(resultEvent(0.02));
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

    tracker.handleEvent(resultEvent(0.05, 2000, 1000));
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

    tracker.handleEvent(resultEvent(0.10, 5000, 2000));
    tracker.handleEvent(resultEvent(0.25, 8000, 3000));
    tracker.incrementInvocations();
    tracker.incrementInvocations();
    tracker.flush();

    // Read raw file to verify structure (directory-per-session layout)
    const filePath = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      sessionId,
      "session.json",
    );
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.budgetUsage).toEqual({
      invocations_used: 2,
      tokens_used: 18000, // (5000+2000) + (8000+3000)
      cost_usd: expect.closeTo(0.35, 10),
    });

    tracker.dispose();
  });

  it("cache tokens are excluded from persisted tokens_used", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    // 2000 input + 1000 output + 50000 cache reads + 5000 cache creation
    tracker.handleEvent(resultEvent(0.05, 2000, 1000, 50_000, 5_000));
    tracker.flush();

    const filePath = path.join(baseDir, ".flywheel", "sessions", sessionId, "session.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(raw.budgetUsage.tokens_used).toBe(3000); // only 2000+1000
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

    tracker.handleEvent(resultEvent(0.01));
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

    tracker.handleEvent(resultEvent(0.07));
    tracker.dispose();

    const session = readSession(sessionId, baseDir);
    expect(session!.totalCost).toBeCloseTo(0.07, 10);
  });

  it("dispose is safe to call multiple times", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 5000 });

    tracker.handleEvent(resultEvent(0.01));
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

    tracker.handleEvent(resultEvent(0.10, 3000, 1000));
    tracker.handleEvent(resultEvent(0.25, 6000, 2000));
    tracker.incrementInvocations();
    tracker.flush();

    // Read raw file to verify structure (directory-per-session layout)
    const filePath = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      sessionId,
      "session.json",
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

    tracker.handleEvent(resultEvent(0.05));
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

    tracker.handleEvent(resultEvent(0.01, 500, 300)); // 800 tokens

    // Token limit not reached
    expect(tracker.isExhausted(unlimitedLimits({ max_tokens: 1000 }))).toBe(false);

    tracker.handleEvent(resultEvent(0.01, 100, 200)); // +300 = 1100 total

    // Token limit exceeded
    expect(tracker.isExhausted(unlimitedLimits({ max_tokens: 1000 }))).toBe(true);

    tracker.dispose();
  });

  it("token limit is not prematurely exhausted by cache tokens", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // 500 input + 300 output = 800 real tokens, but 50000 cache reads
    // Without cache exclusion this would exhaust a 1000-token limit immediately
    tracker.handleEvent(resultEvent(0.01, 500, 300, 50_000, 0));

    expect(tracker.isExhausted(unlimitedLimits({ max_tokens: 1000 }))).toBe(false);
    expect(tracker.getTokensUsed()).toBe(800);

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
    tracker.handleEvent(resultEvent(0.50, 10000, 5000));

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

    tracker.handleEvent(resultEvent(0.01, 1000, 500)); // 1500 tokens

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_tokens: 10000 }));
    expect(status.token_budget_remaining).toBe(8500);

    tracker.dispose();
  });

  it("token_budget_remaining is not reduced by cache tokens", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    // 1000 input + 500 output + 50000 cache reads (excluded)
    tracker.handleEvent(resultEvent(0.05, 1000, 500, 50_000, 0));

    const status = tracker.getBudgetStatus(unlimitedLimits({ max_tokens: 10000 }));
    expect(status.token_budget_remaining).toBe(8500); // only 1500 consumed
    tracker.dispose();
  });

  it("token_budget_remaining floors at 0 (never negative)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);
    const tracker = createBudgetTracker({ sessionId, baseDir, debounceMs: 1000 });

    tracker.handleEvent(resultEvent(0.01, 5000, 3000)); // 8000 tokens

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

// ---------------------------------------------------------------------------
// Budget event emission via emitter
// ---------------------------------------------------------------------------

describe("BudgetTracker — budget event emission", () => {
  it("emits budgetExhausted once when budget transitions to exhausted", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    const calls: { method: string; args: unknown[] }[] = [];
    const mockEmitter = {
      budgetExhausted: (...args: unknown[]) => calls.push({ method: "budgetExhausted", args }),
      budgetWarning: (...args: unknown[]) => calls.push({ method: "budgetWarning", args }),
    };

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 1000,
      emitter: mockEmitter as any,
      workflowId: "wf-test-1",
    });

    const limits = unlimitedLimits({ max_invocations: 2 });

    // Not exhausted yet
    tracker.incrementInvocations();
    expect(tracker.isExhausted(limits)).toBe(false);
    expect(calls).toHaveLength(0);

    // Reaches limit — should emit once
    tracker.incrementInvocations();
    expect(tracker.isExhausted(limits)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("budgetExhausted");
    expect(calls[0].args[0]).toBe("wf-test-1");
    expect((calls[0].args[1] as string)).toContain("Invocation limit reached");

    tracker.dispose();
  });

  it("does NOT emit budgetExhausted on subsequent isExhausted calls", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    const calls: { method: string; args: unknown[] }[] = [];
    const mockEmitter = {
      budgetExhausted: (...args: unknown[]) => calls.push({ method: "budgetExhausted", args }),
      budgetWarning: (...args: unknown[]) => calls.push({ method: "budgetWarning", args }),
    };

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 1000,
      emitter: mockEmitter as any,
      workflowId: "wf-test-2",
    });

    const limits = unlimitedLimits({ max_invocations: 1 });

    tracker.incrementInvocations();

    // First call — emits
    expect(tracker.isExhausted(limits)).toBe(true);
    expect(calls).toHaveLength(1);

    // Subsequent calls — should NOT emit again
    expect(tracker.isExhausted(limits)).toBe(true);
    expect(tracker.isExhausted(limits)).toBe(true);
    expect(tracker.isExhausted(limits)).toBe(true);
    expect(calls).toHaveLength(1); // still just 1

    tracker.dispose();
  });

  it("does NOT emit when emitter is not provided (backward compat)", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    // No emitter — should not throw
    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 1000,
    });

    const limits = unlimitedLimits({ max_invocations: 1 });
    tracker.incrementInvocations();

    // Should work fine without emitter
    expect(tracker.isExhausted(limits)).toBe(true);

    tracker.dispose();
  });

  it("does NOT emit when workflowId is not provided", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    const calls: { method: string; args: unknown[] }[] = [];
    const mockEmitter = {
      budgetExhausted: (...args: unknown[]) => calls.push({ method: "budgetExhausted", args }),
      budgetWarning: (...args: unknown[]) => calls.push({ method: "budgetWarning", args }),
    };

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 1000,
      emitter: mockEmitter as any,
      // workflowId intentionally omitted
    });

    const limits = unlimitedLimits({ max_invocations: 1 });
    tracker.incrementInvocations();
    expect(tracker.isExhausted(limits)).toBe(true);

    // No emission because workflowId is missing
    expect(calls).toHaveLength(0);

    tracker.dispose();
  });

  it("emits correct reason for token limit exhaustion", () => {
    const baseDir = makeTmpDir();
    const sessionId = createSession(minimalSession(), baseDir);

    const calls: { method: string; args: unknown[] }[] = [];
    const mockEmitter = {
      budgetExhausted: (...args: unknown[]) => calls.push({ method: "budgetExhausted", args }),
      budgetWarning: (...args: unknown[]) => calls.push({ method: "budgetWarning", args }),
    };

    const tracker = createBudgetTracker({
      sessionId,
      baseDir,
      debounceMs: 1000,
      emitter: mockEmitter as any,
      workflowId: "wf-token-test",
    });

    tracker.handleEvent(resultEvent(0.01, 5000, 3000)); // 8000 tokens

    const limits = unlimitedLimits({ max_tokens: 5000 });
    expect(tracker.isExhausted(limits)).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("budgetExhausted");
    expect((calls[0].args[1] as string)).toContain("Token limit reached");

    tracker.dispose();
  });
});
