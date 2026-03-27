import { describe, it, expect } from "bun:test";
import type { WorkflowStepContext } from "../src/prompts/index";
import { buildReviewConsolidatePrompt } from "../src/prompts/review/consolidate";
import { REVIEW_P3_DIRECTIVE } from "../src/workflows/review-output-extractor";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCtx: WorkflowStepContext = {
  planContent: "Review of user authentication implementation",
  keyDecisions: [],
  fileReferences: [],
  previousResult: "## Findings\n\n- P1: SQL injection in login handler\n- P2: Missing rate limiting",
  projectCwd: "/home/user/project",
};

const minimalCtx: WorkflowStepContext = {
  planContent: "Review of small fix",
  keyDecisions: [],
  fileReferences: [],
};

// ---------------------------------------------------------------------------
// P3 triage: included/excluded (user-triaged)
// ---------------------------------------------------------------------------

describe("buildReviewConsolidatePrompt with included/excluded P3 triage", () => {
  const ctx: WorkflowStepContext = {
    ...baseCtx,
    extra: {
      p3Triage: {
        included: [
          { title: "Fix naming", summary: "Rename foo to bar", location: "src/utils.ts:12" },
          { title: "Add return type", summary: "Explicit return type", location: "src/auth.ts:5" },
        ],
        excluded: [
          { title: "Style fix", summary: "Trailing comma", location: "src/config.ts:3" },
        ],
        source: "user",
      },
    },
  };

  it("produces non-empty output", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains included P3 findings", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    expect(result).toContain("Fix naming");
    expect(result).toContain("Rename foo to bar");
    expect(result).toContain("src/utils.ts:12");
    expect(result).toContain("Add return type");
  });

  it("contains excluded P3 findings", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    expect(result).toContain("Style fix");
    expect(result).toContain("Trailing comma");
    expect(result).toContain("src/config.ts:3");
  });

  it("labels included and excluded sections distinctly", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    // The prompt should clearly distinguish included from excluded
    expect(result).toContain("Include");
    expect(result).toContain("Exclude");
  });

  it("does NOT contain the auto-triage directive", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    expect(result).not.toContain("Triage P3 findings yourself");
  });
});

// ---------------------------------------------------------------------------
// P3 triage: directive (non-interactive / dismissed)
// ---------------------------------------------------------------------------

describe("buildReviewConsolidatePrompt with directive P3 triage", () => {
  const ctx: WorkflowStepContext = {
    ...baseCtx,
    extra: {
      p3Triage: {
        directive: REVIEW_P3_DIRECTIVE,
      },
    },
  };

  it("produces non-empty output", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains the exact directive text for self-triage", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    expect(result).toContain("Triage P3 findings yourself");
  });

  it("includes guidance for the directive mode", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    // Should tell the worker to include non-cosmetic P3s and exclude cosmetic ones
    expect(result).toContain("cosmetic");
  });

  it("does NOT contain explicit include/exclude lists", () => {
    const result = buildReviewConsolidatePrompt(ctx);
    // There are no specific findings listed in directive mode
    expect(result).not.toContain("Fix naming");
    expect(result).not.toContain("Style fix");
  });
});

// ---------------------------------------------------------------------------
// No P3 triage data (no p3Triage key)
// ---------------------------------------------------------------------------

describe("buildReviewConsolidatePrompt with no P3 triage data", () => {
  it("produces non-empty output with no extra", () => {
    const result = buildReviewConsolidatePrompt(minimalCtx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("produces non-empty output with empty extra", () => {
    const ctx: WorkflowStepContext = {
      ...baseCtx,
      extra: {},
    };
    const result = buildReviewConsolidatePrompt(ctx);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("does NOT contain explicit P3 triage sections", () => {
    const result = buildReviewConsolidatePrompt(minimalCtx);
    expect(result).not.toContain("Triage P3 findings yourself");
    // Should not have include/exclude lists either
    expect(result).not.toContain("P3 Findings to Include");
    expect(result).not.toContain("P3 Findings to Exclude");
  });

  it("contains default guidance for P3 handling", () => {
    const result = buildReviewConsolidatePrompt(minimalCtx);
    expect(result).toContain("worth fixing");
    expect(result).toContain("cosmetic");
  });
});

// ---------------------------------------------------------------------------
// General prompt content
// ---------------------------------------------------------------------------

describe("buildReviewConsolidatePrompt general content", () => {
  it("includes previousResult (review findings)", () => {
    const result = buildReviewConsolidatePrompt(baseCtx);
    expect(result).toContain("SQL injection in login handler");
    expect(result).toContain("Missing rate limiting");
  });

  it("contains consolidation header", () => {
    const result = buildReviewConsolidatePrompt(baseCtx);
    expect(result).toContain("Review Consolidation");
  });

  it("contains automated queue instruction", () => {
    const result = buildReviewConsolidatePrompt(baseCtx);
    expect(result).toContain("automated queue");
    expect(result).toContain("Do not ask questions");
  });

  it("contains review document template", () => {
    const result = buildReviewConsolidatePrompt(baseCtx);
    expect(result).toContain("type: code-review");
    expect(result).toContain("Summary");
    expect(result).toContain("Critical Findings");
    expect(result).toContain("Implementation Order");
  });

  it("contains file output instruction with .flywheel/reviews/ path", () => {
    const result = buildReviewConsolidatePrompt(baseCtx);
    expect(result).toContain(".flywheel/reviews/");
    expect(result).toContain("YYYY-MM-DD");
  });

  it("contains severity definitions", () => {
    const result = buildReviewConsolidatePrompt(baseCtx);
    expect(result).toContain("P1");
    expect(result).toContain("P2");
    expect(result).toContain("P3");
  });

  it("contains consolidation guidance (dedup, severity, implementation order)", () => {
    const result = buildReviewConsolidatePrompt(baseCtx);
    expect(result).toContain("Deduplicate");
    expect(result).toContain("severity");
    expect(result).toContain("Implementation Order");
  });
});
