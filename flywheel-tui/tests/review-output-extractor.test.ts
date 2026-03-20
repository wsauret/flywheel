import { describe, it, expect } from "bun:test";
import {
  REVIEW_MULTI_AGENT_STEP_INDEX,
  REVIEW_P3_DIRECTIVE,
  parseP3Findings,
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

    // Step 2 should return {}
    const result2 = await hook(2, workerResult("Some output"), {});
    expect(result2).toEqual({});
  });
});
