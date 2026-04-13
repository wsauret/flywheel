import { describe, expect, test } from "bun:test";
import {
  createContextAccumulator,
  type ContextAccumulator,
  type AccumulatorState,
  type HandoffEntry,
  type HandoffSummary,
  type AccumulatedContext,
} from "../src/workflows/queue/context-accumulator";
import type { Step } from "../src/workflows/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHandoffData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: "step completed",
    decisions: ["decision-A"],
    artifacts: ["src/foo.ts"],
    issues: ["warning-1"],
    ...overrides,
  };
}

function accumulateN(
  acc: ContextAccumulator,
  n: number,
  prefix = "step",
): void {
  for (let i = 1; i <= n; i++) {
    acc.accumulate({
      stepId: `${prefix}-${i}`,
      stepType: "work" as Step["type"],
      stepTitle: `Step ${i}`,
      handoff: makeHandoffData({
        decisions: [`decision-${i}`],
        artifacts: [`file-${i}.ts`],
        issues: [`issue-${i}`],
      }),
    });
  }
}

// ---------------------------------------------------------------------------
// VAL-CTX-001: Handoffs contribute to accumulated context
// ---------------------------------------------------------------------------

describe("VAL-CTX-001: Handoffs contribute to accumulated context", () => {
  test("accumulator starts empty", () => {
    const acc = createContextAccumulator();
    expect(acc.size()).toBe(0);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.totalSteps).toBe(0);
    expect(ctx.summaries).toEqual([]);
    expect(ctx.recentHandoffs).toEqual([]);
  });

  test("single handoff is accumulated", () => {
    const acc = createContextAccumulator();
    acc.accumulate({
      stepId: "s1",
      stepType: "work",
      stepTitle: "Work step",
      handoff: makeHandoffData(),
    });
    expect(acc.size()).toBe(1);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.totalSteps).toBe(1);
    expect(ctx.recentHandoffs).toHaveLength(1);
    expect(ctx.recentHandoffs[0].stepId).toBe("s1");
  });

  test("multiple handoffs accumulate monotonically", () => {
    const acc = createContextAccumulator();
    accumulateN(acc, 3);
    expect(acc.size()).toBe(3);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.totalSteps).toBe(3);
  });

  test("each step's handoff data is preserved in entries", () => {
    const acc = createContextAccumulator();
    acc.accumulate({
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Research",
      handoff: { decisions: ["use Bun"], artifacts: ["research.md"] },
    });
    acc.accumulate({
      stepId: "s2",
      stepType: "work",
      stepTitle: "Implement",
      handoff: { decisions: ["add tests"], artifacts: ["src/index.ts"] },
    });
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs).toHaveLength(2);
    expect(ctx.recentHandoffs[0].stepId).toBe("s1");
    expect(ctx.recentHandoffs[1].stepId).toBe("s2");
  });
});

// ---------------------------------------------------------------------------
// VAL-CTX-002: Windowed detail strategy
// ---------------------------------------------------------------------------

describe("VAL-CTX-002: Windowed detail strategy", () => {
  test("with <= N entries, all are in recentHandoffs (no summaries)", () => {
    const acc = createContextAccumulator({ windowSize: 3 });
    accumulateN(acc, 3);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs).toHaveLength(3);
    expect(ctx.summaries).toHaveLength(0);
  });

  test("with > N entries, older ones become summaries", () => {
    const acc = createContextAccumulator({ windowSize: 3 });
    accumulateN(acc, 5);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs).toHaveLength(3);
    expect(ctx.summaries).toHaveLength(2);
    expect(ctx.totalSteps).toBe(5);
  });

  test("summaries contain key decisions, artifacts, issues", () => {
    const acc = createContextAccumulator({ windowSize: 3 });
    accumulateN(acc, 5);
    const ctx = acc.getContext() as AccumulatedContext;
    // First two entries become summaries
    const s0 = ctx.summaries[0];
    expect(s0.stepId).toBe("step-1");
    expect(s0.decisions).toEqual(["decision-1"]);
    expect(s0.artifacts).toEqual(["file-1.ts"]);
    expect(s0.issues).toEqual(["issue-1"]);
    const s1 = ctx.summaries[1];
    expect(s1.stepId).toBe("step-2");
    expect(s1.decisions).toEqual(["decision-2"]);
  });

  test("recent handoffs are the last N entries in full detail", () => {
    const acc = createContextAccumulator({ windowSize: 3 });
    accumulateN(acc, 5);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs[0].stepId).toBe("step-3");
    expect(ctx.recentHandoffs[1].stepId).toBe("step-4");
    expect(ctx.recentHandoffs[2].stepId).toBe("step-5");
    // Full handoff data is preserved
    expect(ctx.recentHandoffs[0].handoff.decisions).toEqual(["decision-3"]);
  });

  test("window size is configurable", () => {
    const acc = createContextAccumulator({ windowSize: 1 });
    accumulateN(acc, 4);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs).toHaveLength(1);
    expect(ctx.summaries).toHaveLength(3);
    expect(ctx.recentHandoffs[0].stepId).toBe("step-4");
  });

  test("default window size is 3", () => {
    const acc = createContextAccumulator(); // no opts
    accumulateN(acc, 6);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs).toHaveLength(3);
    expect(ctx.summaries).toHaveLength(3);
  });

  test("summary extracts from alternative field names", () => {
    const acc = createContextAccumulator({ windowSize: 1 });
    acc.accumulate({
      stepId: "s1",
      stepType: "work",
      stepTitle: "Step 1",
      handoff: {
        artifacts_produced: ["out.json"],
        files_created: ["new.ts"],
        warnings: ["deprecation"],
        discoveredIssues: ["edge case"],
      },
    });
    acc.accumulate({
      stepId: "s2",
      stepType: "work",
      stepTitle: "Step 2",
      handoff: {},
    });
    const ctx = acc.getContext() as AccumulatedContext;
    const summary = ctx.summaries[0];
    expect(summary.artifacts).toEqual(["out.json", "new.ts"]);
    expect(summary.issues).toEqual(["deprecation", "edge case"]);
  });
});

// ---------------------------------------------------------------------------
// VAL-CTX-003: Context persisted alongside queue state
// ---------------------------------------------------------------------------

describe("VAL-CTX-003: Context persisted and restorable", () => {
  test("serialize returns entries array", () => {
    const acc = createContextAccumulator();
    accumulateN(acc, 3);
    const state = acc.serialize();
    expect(state.entries).toHaveLength(3);
    expect(state.entries[0].stepId).toBe("step-1");
    expect(state.entries[2].stepId).toBe("step-3");
  });

  test("serialize is JSON-serializable", () => {
    const acc = createContextAccumulator();
    accumulateN(acc, 2);
    const state = acc.serialize();
    const json = JSON.stringify(state);
    const restored = JSON.parse(json);
    expect(restored.entries).toHaveLength(2);
  });

  test("restore from serialized state preserves all entries", () => {
    const acc1 = createContextAccumulator();
    accumulateN(acc1, 4);
    const serialized = acc1.serialize();

    // Simulate persistence round-trip
    const json = JSON.stringify(serialized);
    const restored: AccumulatorState = JSON.parse(json);

    const acc2 = createContextAccumulator({ initialState: restored });
    expect(acc2.size()).toBe(4);
    const ctx = acc2.getContext() as AccumulatedContext;
    expect(ctx.totalSteps).toBe(4);
    // Last 3 in full detail
    expect(ctx.recentHandoffs).toHaveLength(3);
    // First 1 summarized
    expect(ctx.summaries).toHaveLength(1);
    expect(ctx.summaries[0].stepId).toBe("step-1");
  });

  test("restored accumulator can continue accumulating", () => {
    const acc1 = createContextAccumulator();
    accumulateN(acc1, 2);
    const state = acc1.serialize();

    const acc2 = createContextAccumulator({ initialState: state });
    acc2.accumulate({
      stepId: "step-3",
      stepType: "review",
      stepTitle: "Review step",
      handoff: makeHandoffData({ decisions: ["review-decision"] }),
    });
    expect(acc2.size()).toBe(3);
    const ctx = acc2.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs).toHaveLength(3);
    expect(ctx.recentHandoffs[2].stepId).toBe("step-3");
  });

  test("empty accumulator serializes to empty entries", () => {
    const acc = createContextAccumulator();
    const state = acc.serialize();
    expect(state.entries).toEqual([]);
  });

  test("restoring from empty state works", () => {
    const acc = createContextAccumulator({ initialState: { entries: [] } });
    expect(acc.size()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-CTX-004: Failed step handoff excluded from context
// ---------------------------------------------------------------------------

describe("VAL-CTX-004: Failed step handoffs excluded", () => {
  test("malformed data is silently ignored", () => {
    const acc = createContextAccumulator();
    // These should be silently ignored (no stepId/stepType/stepTitle/handoff)
    acc.accumulate(null);
    acc.accumulate(undefined);
    acc.accumulate("string");
    acc.accumulate(42);
    acc.accumulate({});
    acc.accumulate({ stepId: "s1" }); // missing other fields
    acc.accumulate({ stepId: "s1", stepType: "work" }); // missing stepTitle, handoff
    expect(acc.size()).toBe(0);
  });

  test("only well-formed data is accumulated", () => {
    const acc = createContextAccumulator();
    // Invalid: no handoff
    acc.accumulate({ stepId: "bad", stepType: "work", stepTitle: "Bad" });
    expect(acc.size()).toBe(0);

    // Valid
    acc.accumulate({
      stepId: "good",
      stepType: "work",
      stepTitle: "Good",
      handoff: { summary: "ok" },
    });
    expect(acc.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-CTX-005: Dispatcher receives accumulated context
// ---------------------------------------------------------------------------

describe("VAL-CTX-005: Dispatcher context shape", () => {
  test("getContext returns summaries, recentHandoffs, totalSteps", () => {
    const acc = createContextAccumulator();
    accumulateN(acc, 2);
    const ctx = acc.getContext();
    expect(ctx).toHaveProperty("summaries");
    expect(ctx).toHaveProperty("recentHandoffs");
    expect(ctx).toHaveProperty("totalSteps");
  });

  test("context is spreadable into Record<string, unknown>", () => {
    const acc = createContextAccumulator();
    accumulateN(acc, 2);
    const ctx = acc.getContext();
    const dispatcherContext: Record<string, unknown> = {
      ...ctx,
      previousHandoff: { summary: "last step" },
    };
    expect(dispatcherContext.summaries).toBeDefined();
    expect(dispatcherContext.recentHandoffs).toBeDefined();
    expect(dispatcherContext.totalSteps).toBe(2);
    expect(dispatcherContext.previousHandoff).toBeDefined();
  });

  test("step N context reflects contributions from steps 1..N-1", () => {
    const acc = createContextAccumulator({ windowSize: 3 });
    // Simulate 4 completed steps
    for (let i = 1; i <= 4; i++) {
      acc.accumulate({
        stepId: `s${i}`,
        stepType: "work",
        stepTitle: `Step ${i}`,
        handoff: { decisions: [`decided-${i}`] },
      });
    }
    const ctx = acc.getContext() as AccumulatedContext;
    // Step 5's dispatcher would see: 1 summary + 3 recent
    expect(ctx.summaries).toHaveLength(1);
    expect(ctx.summaries[0].stepId).toBe("s1");
    expect(ctx.summaries[0].decisions).toEqual(["decided-1"]);
    expect(ctx.recentHandoffs).toHaveLength(3);
    expect(ctx.recentHandoffs.map(h => h.stepId)).toEqual(["s2", "s3", "s4"]);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-004: Context accumulates across step boundaries
// ---------------------------------------------------------------------------

describe("VAL-CROSS-004: Context across step boundaries", () => {
  test("step 3 dispatcher receives step 1 and step 2 contributions", () => {
    const acc = createContextAccumulator({ windowSize: 3 });
    acc.accumulate({
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Research",
      handoff: { decisions: ["use Bun runtime"] },
    });
    acc.accumulate({
      stepId: "s2",
      stepType: "plan",
      stepTitle: "Draft plan",
      handoff: { decisions: ["TDD approach"], artifacts: ["plan.json"] },
    });
    // Before step 3, get context
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.totalSteps).toBe(2);
    // All within window, so all in recentHandoffs
    expect(ctx.recentHandoffs).toHaveLength(2);
    const s1 = ctx.recentHandoffs[0];
    expect(s1.handoff.decisions).toEqual(["use Bun runtime"]);
    const s2 = ctx.recentHandoffs[1];
    expect(s2.handoff.decisions).toEqual(["TDD approach"]);
    expect(s2.handoff.artifacts).toEqual(["plan.json"]);
  });

  test("decisions from step 1 survive windowing as summaries", () => {
    const acc = createContextAccumulator({ windowSize: 2 });
    for (let i = 1; i <= 5; i++) {
      acc.accumulate({
        stepId: `s${i}`,
        stepType: "work",
        stepTitle: `Step ${i}`,
        handoff: { decisions: [`key-decision-${i}`] },
      });
    }
    const ctx = acc.getContext() as AccumulatedContext;
    // Steps 1-3 summarized, steps 4-5 in full
    expect(ctx.summaries).toHaveLength(3);
    expect(ctx.summaries[0].decisions).toEqual(["key-decision-1"]);
    expect(ctx.summaries[1].decisions).toEqual(["key-decision-2"]);
    expect(ctx.summaries[2].decisions).toEqual(["key-decision-3"]);
    expect(ctx.recentHandoffs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  test("accumulator with windowSize=0 summarizes everything", () => {
    const acc = createContextAccumulator({ windowSize: 0 });
    accumulateN(acc, 3);
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.recentHandoffs).toHaveLength(0);
    expect(ctx.summaries).toHaveLength(3);
  });

  test("handoff without array fields produces empty summary arrays", () => {
    const acc = createContextAccumulator({ windowSize: 1 });
    acc.accumulate({
      stepId: "s1",
      stepType: "work",
      stepTitle: "Step 1",
      handoff: { summary: "done", randomField: 42 },
    });
    acc.accumulate({
      stepId: "s2",
      stepType: "work",
      stepTitle: "Step 2",
      handoff: {},
    });
    const ctx = acc.getContext() as AccumulatedContext;
    const summary = ctx.summaries[0];
    expect(summary.decisions).toEqual([]);
    expect(summary.artifacts).toEqual([]);
    expect(summary.issues).toEqual([]);
  });

  test("non-string array items are filtered out of summaries", () => {
    const acc = createContextAccumulator({ windowSize: 1 });
    acc.accumulate({
      stepId: "s1",
      stepType: "work",
      stepTitle: "Step 1",
      handoff: { decisions: ["valid", 42, null, "also-valid"] },
    });
    acc.accumulate({
      stepId: "s2",
      stepType: "work",
      stepTitle: "Step 2",
      handoff: {},
    });
    const ctx = acc.getContext() as AccumulatedContext;
    expect(ctx.summaries[0].decisions).toEqual(["valid", "also-valid"]);
  });
});
