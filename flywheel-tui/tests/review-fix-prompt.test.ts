import { describe, it, expect } from "bun:test";
import { buildReviewFixPrompt } from "../src/prompts/review/fix.js";
import type { WorkflowStepContext } from "../src/prompts/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<WorkflowStepContext> = {}): WorkflowStepContext {
  return {
    planContent: "Review and fix auth module",
    keyDecisions: [],
    fileReferences: [],
    previousResult: undefined,
    projectCwd: "/tmp/test-project",
    extra: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1 — Work-style prompt structure
// ---------------------------------------------------------------------------

describe("buildReviewFixPrompt — work-style structure", () => {
  const ctx = makeCtx({
    previousResult: "## Findings\n\n| # | Finding | Severity |\n| 1 | Bug | P1 |",
    extra: {
      hasActionableFindings: true,
      findingCounts: { p1: 2, p2: 1, p3: 3 },
    },
  });

  it("returns a non-empty string", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes Work Step Execution header", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Work Step Execution");
  });

  it("includes TDD cycle instructions", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("TDD Cycle");
    expect(prompt).toContain("RED");
    expect(prompt).toContain("GREEN");
  });

  it("includes Verification Protocol", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Verification Protocol");
    expect(prompt).toContain("IDENTIFY");
    expect(prompt).toContain("Evidence Requirements");
  });

  it("includes Understand-Act-Verify", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Understand-Act-Verify");
  });

  it("includes Scope Discipline", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Scope Discipline");
  });

  it("includes Three-Strike Protocol", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Three-Strike Protocol");
  });

  it("includes Verification Banned Phrases", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Banned Phrases");
  });

  it("includes Two-Stage Review", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Two-Stage Review");
  });
});

// ---------------------------------------------------------------------------
// 2 — Severity definitions and implementation ordering
// ---------------------------------------------------------------------------

describe("buildReviewFixPrompt — severity and ordering", () => {
  const reviewDoc = `---
type: code-review
findings: { p1: 2, p2: 1, p3: 3 }
---

## Critical Findings (P1)

| Finding | File | Action |
|---------|------|--------|
| Null pointer | src/auth.ts:42 | Add null check |
| SQL injection | src/db.ts:15 | Use parameterized query |

## Important Findings (P2)

| Finding | File | Action |
|---------|------|--------|
| Missing validation | src/api.ts:30 | Add Zod schema |`;

  const ctx = makeCtx({
    previousResult: reviewDoc,
    extra: {
      hasActionableFindings: true,
      reviewFilePath: "docs/reviews/2026-03-23-auth.md",
      findingCounts: { p1: 2, p2: 1, p3: 3 },
    },
  });

  it("includes severity definitions", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("P1 (Critical)");
    expect(prompt).toContain("P2 (Important)");
    expect(prompt).toContain("P3 (Minor)");
  });

  it("includes the review document content from ctx.previousResult", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Null pointer");
    expect(prompt).toContain("src/auth.ts:42");
    expect(prompt).toContain("SQL injection");
  });

  it("includes implementation ordering: P1 first, then P2", () => {
    const prompt = buildReviewFixPrompt(ctx);
    const p1Idx = prompt.indexOf("P1");
    const p2Idx = prompt.lastIndexOf("P2");
    expect(p1Idx).toBeLessThan(p2Idx);
    expect(prompt.toLowerCase()).toMatch(/p1.*first|p1.*before.*p2|priority.*p1/i);
  });

  it("mentions skipping P3 unless explicitly included", () => {
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt.toLowerCase()).toMatch(/p3.*skip|skip.*p3|p3.*unless/i);
  });
});

// ---------------------------------------------------------------------------
// 3 — reviewFilePath and findingCounts appear in prompt
// ---------------------------------------------------------------------------

describe("buildReviewFixPrompt — reviewFilePath and findingCounts", () => {
  it("includes ctx.extra.reviewFilePath in the prompt when present", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: {
        hasActionableFindings: true,
        reviewFilePath: "docs/reviews/2026-03-23-auth-refactor.md",
        findingCounts: { p1: 1, p2: 0, p3: 0 },
      },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("docs/reviews/2026-03-23-auth-refactor.md");
  });

  it("includes finding counts summary when present", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: {
        hasActionableFindings: true,
        findingCounts: { p1: 3, p2: 2, p3: 5 },
      },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("3 P1");
    expect(prompt).toContain("2 P2");
    expect(prompt).toContain("5 P3");
  });

  it("does not error when reviewFilePath is absent", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: { hasActionableFindings: true },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("does not error when findingCounts is absent", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: { hasActionableFindings: true },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4 — Scope rules
// ---------------------------------------------------------------------------

describe("buildReviewFixPrompt — scope rules", () => {
  it("includes scope rules limiting work to review findings only", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: { hasActionableFindings: true },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Scope Rules");
    expect(prompt.toLowerCase()).toContain("only fix findings");
  });
});

// ---------------------------------------------------------------------------
// 5 — Project context and iteration budget
// ---------------------------------------------------------------------------

describe("buildReviewFixPrompt — project context integration", () => {
  it("includes project context when conventions/standards/learnings are present", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: {
        hasActionableFindings: true,
        conventions: [{ path: "AGENTS.md", summary: "Agent instructions" }],
        standards: [{ path: "docs/standards/testing.md", summary: "Testing conventions" }],
        learnings: [],
      },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("Project Context");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("docs/standards/testing.md");
  });

  it("includes iteration budget when present", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: {
        hasActionableFindings: true,
        iterationBudget: 5,
      },
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("5 internal iteration cycles");
  });

  it("includes working directory", () => {
    const ctx = makeCtx({
      previousResult: "## Findings\n- P1: Critical bug",
      extra: { hasActionableFindings: true },
      projectCwd: "/home/user/my-project",
    });
    const prompt = buildReviewFixPrompt(ctx);
    expect(prompt).toContain("/home/user/my-project");
  });
});
