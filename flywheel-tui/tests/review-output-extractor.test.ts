import { describe, it, expect } from "bun:test";
import {
  REVIEW_MULTI_AGENT_STEP_INDEX,
  REVIEW_CONSOLIDATION_STEP_INDEX,
  REVIEW_P3_DIRECTIVE,
  parseP3Findings,
  parseReviewFilePath,
  parseFindingCounts,
  createReviewOnStepComplete,
  type P3Finding,
} from "../src/workflows/review-output-extractor";
import type { WorkerResult } from "../src/schemas/worker";
import { QuestionService } from "../src/controller/question-service";
import { EventBus } from "../src/events/event-bus";

// ---------------------------------------------------------------------------
// Local type helpers for triage assertions
// ---------------------------------------------------------------------------

interface P3TriageExplicit {
  included: P3Finding[];
  excluded: P3Finding[];
  source: string;
}

interface P3TriageDirective {
  directive: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper to create a WorkerResult with the given output. */
function workerResult(output: string): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("review-output-extractor constants", () => {
  it("REVIEW_MULTI_AGENT_STEP_INDEX is 1", () => {
    expect(REVIEW_MULTI_AGENT_STEP_INDEX).toBe(1);
  });

  it("REVIEW_P3_DIRECTIVE is 'include-non-cosmetic'", () => {
    expect(REVIEW_P3_DIRECTIVE).toBe("include-non-cosmetic");
  });
});

// ---------------------------------------------------------------------------
// parseP3Findings
// ---------------------------------------------------------------------------

/** Table format with mixed-severity findings. */
const TABLE_FORMAT = `# Review Summary

## Findings

| # | Finding | Severity | File | Summary |
|---|---------|----------|------|---------|
| 1 | Missing null check | P1 | src/foo.ts:42 | Handle null case |
| 2 | Type safety gap | P2 | src/bar.ts:15 | Use strict types |
| 3 | Variable naming | P3 | src/baz.ts:8 | Use descriptive names |
| 4 | Unused import | P3 | src/qux.ts:1 | Remove dead import |

## Summary

Overall the code is solid.
`;

/** Bullet format with P3 findings under the canonical section heading. */
const BULLET_FORMAT = `# Review

## Minor Findings

- P3: Variable naming could be more descriptive in \`src/baz.ts:8\`
- P3: Consider extracting helper function at \`src/foo.ts:100\`

## Summary

Done.
`;

/** Deferred format under the canonical Minor Findings heading. */
const DEFERRED_FORMAT = `# Review

## Minor Findings

- P3 (deferred): Minor code style issue in utils.ts
- P3 (deferred): Rename internal variable in helpers.ts:20

## Summary

Done.
`;

/** Mixed formats: P3 in both Findings table and Minor Findings bullets. */
const MIXED_FORMAT = `# Review

## Findings

| # | Finding | Severity | File | Summary |
|---|---------|----------|------|---------|
| 1 | Critical bug | P1 | src/a.ts:1 | Fix crash |
| 2 | Naming convention | P3 | src/b.ts:5 | Use camelCase |

## Minor Findings

- P3: Add JSDoc comments to public API in src/c.ts:10

## Summary

Done.
`;

/** No P3 findings at all. */
const NO_P3 = `# Review

## Findings

| # | Finding | Severity | File | Summary |
|---|---------|----------|------|---------|
| 1 | Critical bug | P1 | src/a.ts:1 | Fix crash |
| 2 | Type safety | P2 | src/b.ts:5 | Tighten types |

## Summary

All clear.
`;

/** Malformed output. */
const MALFORMED = `This is not a review output at all.
Just some random text without any structure.
No findings table, no bullet lists, nothing.`;

describe("parseP3Findings", () => {
  it("extracts P3 findings from table format", () => {
    const findings = parseP3Findings(TABLE_FORMAT);
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toBe("Variable naming");
    expect(findings[0].location).toBe("src/baz.ts:8");
    expect(findings[0].summary).toBe("Use descriptive names");
    expect(findings[1].title).toBe("Unused import");
    expect(findings[1].location).toBe("src/qux.ts:1");
    expect(findings[1].summary).toBe("Remove dead import");
  });

  it("extracts P3 findings from bullet format", () => {
    const findings = parseP3Findings(BULLET_FORMAT);
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toContain("Variable naming");
    expect(findings[1].title).toContain("extracting helper");
  });

  it("extracts P3 findings from deferred format", () => {
    const findings = parseP3Findings(DEFERRED_FORMAT);
    expect(findings).toHaveLength(2);
    expect(findings[0].title).toContain("code style");
    expect(findings[1].title).toContain("Rename internal");
  });

  it("extracts all P3 findings from mixed formats", () => {
    const findings = parseP3Findings(MIXED_FORMAT);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    // Should find the table P3 and the bullet P3
    const titles = findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("Naming convention"))).toBe(true);
    expect(titles.some((t) => t.includes("JSDoc"))).toBe(true);
  });

  it("returns empty array when no P3 findings", () => {
    const findings = parseP3Findings(NO_P3);
    expect(findings).toEqual([]);
  });

  it("returns empty array on malformed output (no throw)", () => {
    const findings = parseP3Findings(MALFORMED);
    expect(findings).toEqual([]);
  });

  it("returns empty array on empty string", () => {
    const findings = parseP3Findings("");
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseP3Findings — realistic agent output (from prompt template)
// ---------------------------------------------------------------------------

describe("parseP3Findings — realistic prompt-template output", () => {
  it("extracts from ## Findings table with Severity column (prompt template format)", () => {
    const output = `## Summary

Code quality is generally good with a few issues.

## Findings

| # | Finding | Severity | File | Reviewers | Action Required |
|---|---------|----------|------|-----------|-----------------|
| 1 | Missing error boundary | P1 | src/app.tsx:15 | correctness | Add try/catch |
| 2 | No input validation | P2 | src/api.ts:42 | security | Add Zod schema |
| 3 | Inconsistent naming | P3 | src/utils.ts:8 | architecture | Rename to camelCase |
| 4 | Unused import | P3 | src/helpers.ts:1 | correctness | Remove import |

## Minor Findings

- P3: Consider adding JSDoc to exported functions at \`src/index.ts:5\`
- P3 (deferred): Rename internal variable in \`src/internal.ts:20\` — reason: low impact

## Implementation Order

1. Fix error boundary (P1)
2. Add validation (P2)
3. Clean up naming (P3)`;

    const findings = parseP3Findings(output);
    // Should find P3s from both table and bullet sections
    expect(findings.length).toBeGreaterThanOrEqual(3);
    const titles = findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("naming") || t.includes("Naming"))).toBe(true);
    expect(titles.some((t) => t.includes("import") || t.includes("Unused"))).toBe(true);
    expect(titles.some((t) => t.includes("JSDoc"))).toBe(true);
  });

  it("extracts from ## Minor Findings heading (prompt template format)", () => {
    const output = `## Summary

Clean code.

## Minor Findings

- P3: Variable could be const at \`src/foo.ts:12\`
- P3: Extract repeated logic into helper at \`src/bar.ts:45\`
- P3 (deferred): Rename parameter in \`src/baz.ts:3\` — reason: public API change`;

    const findings = parseP3Findings(output);
    expect(findings).toHaveLength(3);
    expect(findings[0].location).toBe("src/foo.ts:12");
    expect(findings[2].title).toContain("Rename parameter");
  });

});

// ---------------------------------------------------------------------------
// createReviewOnStepComplete — three-mode P3 triage behavior
// ---------------------------------------------------------------------------

/** Review output with P3 findings for hook tests. */
const REVIEW_WITH_P3 = `# Review

## Findings

| # | Finding | Severity | File | Summary |
|---|---------|----------|------|---------|
| 1 | Critical bug | P1 | src/a.ts:1 | Fix crash |
| 2 | Naming convention | P3 | src/b.ts:5 | Use camelCase |
| 3 | Dead code | P3 | src/c.ts:10 | Remove unused function |

## Summary

Done.
`;

/** Review output with no P3 findings. */
const REVIEW_NO_P3 = `# Review

## Findings

| # | Finding | Severity | File | Summary |
|---|---------|----------|------|---------|
| 1 | Critical bug | P1 | src/a.ts:1 | Fix crash |

## Summary

Done.
`;

describe("createReviewOnStepComplete — P3 triage", () => {
  it("interactive: true + user picks items → p3Triage with included/excluded/source", async () => {
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: true,
    });

    // Reply to question as soon as it arrives — select only first P3 finding
    bus.subscribeToType("question:asked", (e) => {
      qs.reply(e.requestId, [["Naming convention"]]);
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult(REVIEW_WITH_P3),
      {},
    );

    expect(result.p3Triage).toBeDefined();
    const triage = result.p3Triage as P3TriageExplicit;
    expect(triage.source).toBe("user");
    expect(triage.included).toHaveLength(1);
    expect(triage.included[0].title).toBe("Naming convention");
    expect(triage.excluded).toHaveLength(1);
    expect(triage.excluded[0].title).toBe("Dead code");
  });

  it("interactive: true + user dismisses → p3Triage with directive", async () => {
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: true,
    });

    // Reject (dismiss) question
    bus.subscribeToType("question:asked", (e) => {
      qs.reject(e.requestId);
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult(REVIEW_WITH_P3),
      {},
    );

    expect(result.p3Triage).toBeDefined();
    const triage = result.p3Triage as P3TriageDirective;
    expect(triage.directive).toBe(REVIEW_P3_DIRECTIVE);
    // Should NOT have included/excluded — directive mode only has directive key
    const triageObj = result.p3Triage as Record<string, unknown>;
    expect(triageObj.included).toBeUndefined();
    expect(triageObj.excluded).toBeUndefined();
  });

  it("interactive: false → p3Triage with directive (never calls ask)", async () => {
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    let askCalled = false;
    bus.subscribe((event) => {
      if (event.type === "question:asked") {
        askCalled = true;
      }
    });

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: false,
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult(REVIEW_WITH_P3),
      {},
    );

    expect(askCalled).toBe(false);
    expect(result.p3Triage).toBeDefined();
    const triage = result.p3Triage as { directive: string };
    expect(triage.directive).toBe(REVIEW_P3_DIRECTIVE);
  });

  it("no P3 findings → empty object (no p3Triage key)", async () => {
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: true,
    });

    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult(REVIEW_NO_P3),
      {},
    );

    expect(result).toEqual({});
    expect(result.p3Triage).toBeUndefined();
  });

  it("unexpected error → logs, returns empty object", async () => {
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    // Monkey-patch ask to throw a generic error
    qs.ask = async () => {
      throw new Error("Unexpected network failure");
    };

    const hook = createReviewOnStepComplete({
      questionService: qs,
      interactive: true,
    });

    // Error is logged to file-based logger (not console.error), so we just
    // verify the hook doesn't throw and returns empty.
    const result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult(REVIEW_WITH_P3),
      {},
    );
    expect(result).toEqual({});
  });

  it("non-review step returns empty object", async () => {
    const hook = createReviewOnStepComplete({
      interactive: false,
    });

    // Step 0 should return {}
    const result = await hook(0, workerResult("Some output"), {});
    expect(result).toEqual({});

    // Step 0 should return {}
    const result3 = await hook(0, workerResult("Some output"), {});
    expect(result3).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseReviewFilePath
// ---------------------------------------------------------------------------

describe("parseReviewFilePath", () => {
  it("extracts backtick-wrapped docs/reviews/*.md path from output", () => {
    const output = `Review saved to \`docs/reviews/2026-03-23-auth-refactor.md\`

Done.`;
    expect(parseReviewFilePath(output)).toBe(
      "docs/reviews/2026-03-23-auth-refactor.md",
    );
  });

  it("returns undefined when no docs/reviews path present", () => {
    const output = `Review complete. No file was written.`;
    expect(parseReviewFilePath(output)).toBeUndefined();
  });

  it("extracts path even with surrounding text on the same line", () => {
    const output = `I wrote the consolidated review to \`docs/reviews/my-review.md\` for your reference.`;
    expect(parseReviewFilePath(output)).toBe("docs/reviews/my-review.md");
  });

  it("extracts the first matching path if multiple are present", () => {
    const output = `Saved \`docs/reviews/first.md\` and also \`docs/reviews/second.md\``;
    expect(parseReviewFilePath(output)).toBe("docs/reviews/first.md");
  });
});

// ---------------------------------------------------------------------------
// parseFindingCounts
// ---------------------------------------------------------------------------

describe("parseFindingCounts", () => {
  it("extracts finding counts from YAML frontmatter", () => {
    const output = `---
title: "Review: auth refactor"
findings: { p1: 2, p2: 3, p3: 1 }
---

## Summary
...`;
    expect(parseFindingCounts(output)).toEqual({ p1: 2, p2: 3, p3: 1 });
  });

  it("tolerates spacing variations in findings line", () => {
    const output = `---
title: "Review"
findings: {p1: 2, p2:3, p3: 1}
---

Content here.`;
    expect(parseFindingCounts(output)).toEqual({ p1: 2, p2: 3, p3: 1 });
  });

  it("returns zeros when no findings line present", () => {
    const output = `No frontmatter here, just plain text.`;
    expect(parseFindingCounts(output)).toEqual({ p1: 0, p2: 0, p3: 0 });
  });

  it("returns zeros when frontmatter is malformed", () => {
    const output = `---
title: "Review"
findings: not a valid object
---`;
    expect(parseFindingCounts(output)).toEqual({ p1: 0, p2: 0, p3: 0 });
  });

  it("handles missing individual counts gracefully", () => {
    const output = `---
findings: { p1: 5 }
---`;
    expect(parseFindingCounts(output)).toEqual({ p1: 5, p2: 0, p3: 0 });
  });
});

// ---------------------------------------------------------------------------
// Constants — consolidation step index
// ---------------------------------------------------------------------------

describe("review-output-extractor consolidation constants", () => {
  it("REVIEW_CONSOLIDATION_STEP_INDEX is 2", () => {
    expect(REVIEW_CONSOLIDATION_STEP_INDEX).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createReviewOnStepComplete — consolidation step (stepIndex 2)
// ---------------------------------------------------------------------------

/** Consolidation output with findings and file path. */
const CONSOLIDATION_WITH_FINDINGS = `---
title: "Review: auth refactor"
findings: { p1: 1, p2: 2, p3: 3 }
---

## Summary

Review saved to \`docs/reviews/2026-03-23-auth-refactor.md\`

## Findings

| # | Finding | Severity |
|---|---------|----------|
| 1 | Missing null check | P1 |
| 2 | Type safety gap | P2 |
| 3 | Unused import | P3 |
`;

/** Consolidation output with zero actionable findings. */
const CONSOLIDATION_NO_ACTIONABLE = `---
title: "Review: cleanup"
findings: { p1: 0, p2: 0, p3: 4 }
---

## Summary

Review saved to \`docs/reviews/2026-03-23-cleanup.md\`

Only minor issues found.
`;

describe("createReviewOnStepComplete — consolidation step", () => {
  it("stepIndex 2 returns reviewFilePath, findingCounts, hasActionableFindings: true when P1+P2 > 0", async () => {
    const hook = createReviewOnStepComplete({ interactive: false });

    const result = await hook(
      REVIEW_CONSOLIDATION_STEP_INDEX,
      workerResult(CONSOLIDATION_WITH_FINDINGS),
      {},
    );

    expect(result.reviewFilePath).toBe(
      "docs/reviews/2026-03-23-auth-refactor.md",
    );
    expect(result.findingCounts).toEqual({ p1: 1, p2: 2, p3: 3 });
    expect(result.hasActionableFindings).toBe(true);
  });

  it("stepIndex 2 returns hasActionableFindings: false when P1+P2 are 0", async () => {
    const hook = createReviewOnStepComplete({ interactive: false });

    const result = await hook(
      REVIEW_CONSOLIDATION_STEP_INDEX,
      workerResult(CONSOLIDATION_NO_ACTIONABLE),
      {},
    );

    expect(result.reviewFilePath).toBe(
      "docs/reviews/2026-03-23-cleanup.md",
    );
    expect(result.findingCounts).toEqual({ p1: 0, p2: 0, p3: 4 });
    expect(result.hasActionableFindings).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: full onStepComplete data flow (accumulated extra)
// ---------------------------------------------------------------------------

describe("createReviewOnStepComplete — full data flow integration", () => {
  it("step 1 → p3Triage, step 2 → reviewFilePath + findingCounts + hasActionableFindings, accumulated together", async () => {
    const hook = createReviewOnStepComplete({ interactive: false });

    // Simulate ExecutionLoop accumulator pattern: start empty, merge after each step
    const accumulatedExtra: Record<string, unknown> = {};

    // Step 1: multi-agent review — produces p3Triage
    const step1Result = await hook(
      REVIEW_MULTI_AGENT_STEP_INDEX,
      workerResult(REVIEW_WITH_P3),
      { ...accumulatedExtra },
    );
    Object.assign(accumulatedExtra, step1Result);

    // After step 1: p3Triage should be in accumulated extra
    expect(accumulatedExtra.p3Triage).toBeDefined();
    const triage = accumulatedExtra.p3Triage as P3TriageDirective;
    expect(triage.directive).toBe(REVIEW_P3_DIRECTIVE);

    // Step 2: consolidation — produces reviewFilePath, findingCounts, hasActionableFindings
    const step2Result = await hook(
      REVIEW_CONSOLIDATION_STEP_INDEX,
      workerResult(CONSOLIDATION_WITH_FINDINGS),
      { ...accumulatedExtra },
    );
    Object.assign(accumulatedExtra, step2Result);

    // After step 2: all data should be accumulated
    expect(accumulatedExtra.p3Triage).toBeDefined(); // still from step 1
    expect(accumulatedExtra.reviewFilePath).toBe(
      "docs/reviews/2026-03-23-auth-refactor.md",
    );
    expect(accumulatedExtra.findingCounts).toEqual({ p1: 1, p2: 2, p3: 3 });
    expect(accumulatedExtra.hasActionableFindings).toBe(true);
  });
});
