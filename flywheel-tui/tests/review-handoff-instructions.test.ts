import { describe, it, expect } from "bun:test";
import { buildReviewDispatchPrompt } from "../src/prompts/review/dispatch.js";
import { buildReviewConsolidatePrompt } from "../src/prompts/review/consolidate.js";
import { buildReviewFixPrompt } from "../src/prompts/review/fix.js";
import type { WorkflowStepContext } from "../src/prompts/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<WorkflowStepContext> = {}): WorkflowStepContext {
  return {
    planContent: "Review auth module changes",
    keyDecisions: [],
    fileReferences: [],
    previousResult: "## Findings\n- P1: Critical bug in auth.ts:42",
    projectCwd: "/tmp/test-project",
    extra: {},
    ...overrides,
  };
}

const HANDOFF_PATH = ".flywheel/handoffs/test-invocation-123.json";

// ---------------------------------------------------------------------------
// Review Dispatch — handoff instructions
// ---------------------------------------------------------------------------

describe("buildReviewDispatchPrompt — handoff instructions", () => {
  it("includes handoff instructions when handoffPath is provided", () => {
    const ctx = makeCtx({ extra: { handoffPath: HANDOFF_PATH } });
    const prompt = buildReviewDispatchPrompt(ctx);
    expect(prompt).toContain("Handoff Instructions");
    expect(prompt).toContain(HANDOFF_PATH);
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("valid JSON handoff file");
  });

  it("includes REVIEW_FIELDS field names in handoff instructions", () => {
    const ctx = makeCtx({ extra: { handoffPath: HANDOFF_PATH } });
    const prompt = buildReviewDispatchPrompt(ctx);
    expect(prompt).toContain("summary");
    expect(prompt).toContain("review_file_path");
    expect(prompt).toContain("finding_counts");
  });

  it("does not include handoff instructions when handoffPath is absent", () => {
    const ctx = makeCtx({ extra: {} });
    const prompt = buildReviewDispatchPrompt(ctx);
    expect(prompt).not.toContain("Handoff Instructions");
  });

  it("does not include handoff instructions when extra is undefined", () => {
    const ctx = makeCtx({ extra: undefined });
    const prompt = buildReviewDispatchPrompt(ctx);
    expect(prompt).not.toContain("Handoff Instructions");
  });
});

// ---------------------------------------------------------------------------
// Review Consolidate — handoff instructions
// ---------------------------------------------------------------------------

describe("buildReviewConsolidatePrompt — handoff instructions", () => {
  it("includes handoff instructions when handoffPath is provided", () => {
    const ctx = makeCtx({ extra: { handoffPath: HANDOFF_PATH } });
    const prompt = buildReviewConsolidatePrompt(ctx);
    expect(prompt).toContain("Handoff Instructions");
    expect(prompt).toContain(HANDOFF_PATH);
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("valid JSON handoff file");
  });

  it("includes REVIEW_FIELDS field names in handoff instructions", () => {
    const ctx = makeCtx({ extra: { handoffPath: HANDOFF_PATH } });
    const prompt = buildReviewConsolidatePrompt(ctx);
    expect(prompt).toContain("summary");
    expect(prompt).toContain("review_file_path");
    expect(prompt).toContain("finding_counts");
  });

  it("does not include handoff instructions when handoffPath is absent", () => {
    const ctx = makeCtx({ extra: {} });
    const prompt = buildReviewConsolidatePrompt(ctx);
    expect(prompt).not.toContain("Handoff Instructions");
  });

  it("does not include handoff instructions when extra is undefined", () => {
    const ctx = makeCtx({ extra: undefined });
    const prompt = buildReviewConsolidatePrompt(ctx);
    expect(prompt).not.toContain("Handoff Instructions");
  });
});

// ---------------------------------------------------------------------------
// Review Fix — handoff instructions
// ---------------------------------------------------------------------------

describe("buildReviewFixPrompt — handoff instructions", () => {
  it("includes handoff instructions when handoffPath is provided", () => {
    const ctx = makeCtx({
      extra: { handoffPath: HANDOFF_PATH, hasActionableFindings: true },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Handoff Instructions");
    expect(prompt).toContain(HANDOFF_PATH);
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("valid JSON handoff file");
  });

  it("includes REVIEW_FIELDS field names in handoff instructions", () => {
    const ctx = makeCtx({
      extra: { handoffPath: HANDOFF_PATH, hasActionableFindings: true },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("summary");
    expect(prompt).toContain("review_file_path");
    expect(prompt).toContain("finding_counts");
  });

  it("falls back to basic completion section when handoffPath is absent", () => {
    const ctx = makeCtx({ extra: { hasActionableFindings: true } });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).not.toContain("Handoff Instructions");
    expect(prompt).toContain("Completion");
    expect(prompt).toContain("Summary of what was fixed");
  });

  it("falls back to basic completion section when extra is undefined", () => {
    const ctx = makeCtx({ extra: undefined });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).not.toContain("Handoff Instructions");
    expect(prompt).toContain("Completion");
  });

  it("handoff instructions replace the basic completion section", () => {
    const ctx = makeCtx({
      extra: { handoffPath: HANDOFF_PATH, hasActionableFindings: true },
    });
    const prompt = buildReviewFixPrompt(ctx);
    // When handoff instructions are present, the basic completion section should NOT appear
    expect(prompt).not.toContain("Summary of what was fixed (by finding ID/severity)");
    expect(prompt).toContain("Handoff Instructions");
  });
});

// ---------------------------------------------------------------------------
// Consistency across all review prompts
// ---------------------------------------------------------------------------

describe("Review prompts — consistent handoff instruction pattern", () => {
  const ctxWithHandoff = makeCtx({ extra: { handoffPath: HANDOFF_PATH } });

  it("all three review prompts include handoff instructions when handoffPath is set", () => {
    const dispatch = buildReviewDispatchPrompt(ctxWithHandoff);
    const consolidate = buildReviewConsolidatePrompt(ctxWithHandoff);
    const fix = buildReviewFixPrompt(ctxWithHandoff);

    for (const prompt of [dispatch, consolidate, fix]) {
      expect(prompt).toContain("Handoff Instructions");
      expect(prompt).toContain(HANDOFF_PATH);
      expect(prompt).toContain("write a valid JSON handoff file");
    }
  });

  it("handoff instructions tell the worker to write to the handoffPath", () => {
    const dispatch = buildReviewDispatchPrompt(ctxWithHandoff);
    const consolidate = buildReviewConsolidatePrompt(ctxWithHandoff);
    const fix = buildReviewFixPrompt(ctxWithHandoff);

    for (const prompt of [dispatch, consolidate, fix]) {
      expect(prompt).toContain(`\`${HANDOFF_PATH}\``);
    }
  });

  it("handoff instructions include rules about valid JSON format", () => {
    const dispatch = buildReviewDispatchPrompt(ctxWithHandoff);
    const consolidate = buildReviewConsolidatePrompt(ctxWithHandoff);
    const fix = buildReviewFixPrompt(ctxWithHandoff);

    for (const prompt of [dispatch, consolidate, fix]) {
      expect(prompt).toContain("valid JSON");
      expect(prompt).toContain("summary");
    }
  });
});
