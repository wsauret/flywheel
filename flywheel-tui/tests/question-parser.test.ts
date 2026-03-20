import { describe, it, expect } from "bun:test";
import {
  parseOpenQuestions,
  type OpenQuestion,
} from "../src/workflows/question-parser";

// ---------------------------------------------------------------------------
// ## Open Questions — Numbered List Format
// ---------------------------------------------------------------------------

describe("parseOpenQuestions — numbered list format", () => {
  it("parses numbered questions from ## Open Questions section", () => {
    const output = `# Plan Review Summary

## Critical (P1)

| # | Finding | File | Reviewers | Action Required |
|---|---------|------|-----------|-----------------|
| 1 | Missing auth check | src/api.ts:42 | reviewer-security | Add JWT validation |

## Open Questions

1. Should \`auto_chain\` default to \`true\` or \`false\`?
2. How should \`WorkflowPipeline\` manage the EventBus across stages?
3. Should pipeline gates reuse the approval handler or use a new interface?
`;

    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(3);
    expect(result[0].question).toBe(
      "Should `auto_chain` default to `true` or `false`?"
    );
    expect(result[1].question).toBe(
      "How should `WorkflowPipeline` manage the EventBus across stages?"
    );
    expect(result[2].question).toBe(
      "Should pipeline gates reuse the approval handler or use a new interface?"
    );
  });

  it("generates headers from question text", () => {
    const output = `## Open Questions

1. Should we use JWT tokens?
`;
    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(1);
    expect(result[0].header).toBeTruthy();
    // Header should be ≤30 chars
    expect(result[0].header.length).toBeLessThanOrEqual(30);
  });

  it("sets empty options for plain numbered questions", () => {
    const output = `## Open Questions

1. How should sessions be managed?
`;
    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(1);
    expect(result[0].options).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ## Open Questions — Table Format
// ---------------------------------------------------------------------------

describe("parseOpenQuestions — table format", () => {
  it("parses questions from markdown table with options", () => {
    const output = `## Open Questions

| # | Question | Options | Source(s) |
|---|----------|---------|-----------|
| 1 | Should \`auto_chain\` default to \`true\` or \`false\`? | A: \`true\` B: \`false\` C: Split flags | reviewer-architecture |
| 2 | How should the pipeline manage sessions? | A: Shared B: Per-stage C: Stage events | reviewer-patterns |
`;

    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(2);

    expect(result[0].question).toBe(
      "Should `auto_chain` default to `true` or `false`?"
    );
    expect(result[0].options).toHaveLength(3);
    expect(result[0].options[0].label).toBe("true");
    expect(result[0].options[1].label).toBe("false");
    expect(result[0].options[2].label).toBe("Split flags");

    expect(result[1].question).toBe(
      "How should the pipeline manage sessions?"
    );
    expect(result[1].options).toHaveLength(3);
  });

  it("handles table rows without options column", () => {
    const output = `## Open Questions

| # | Question | Source |
|---|----------|--------|
| 1 | Need more research on caching? | reviewer-performance |
`;

    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe("Need more research on caching?");
    expect(result[0].options).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// **OPEN QUESTION:** blocks (contradiction format)
// ---------------------------------------------------------------------------

describe("parseOpenQuestions — OPEN QUESTION blocks", () => {
  it("parses bold OPEN QUESTION blocks from contradictions", () => {
    const output = `## Critical (P1)

Some findings here.

**OPEN QUESTION:** Should the config use top-level flags or a grouped section?
- reviewer-patterns says: Top-level for consistency
- reviewer-architecture says: Grouped under [pipeline] for clarity
- Recommendation: needs user input

## Minor (P3)

More findings.
`;

    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(1);
    expect(result[0].question).toBe(
      "Should the config use top-level flags or a grouped section?"
    );
  });

  it("parses multiple OPEN QUESTION blocks", () => {
    const output = `
**OPEN QUESTION:** First question about design?
- Reviewer A says: option 1
- Reviewer B says: option 2

Some other text.

**OPEN QUESTION:** Second question about scope?
- Reviewer C says: keep it small
- Recommendation: needs user input
`;

    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(2);
    expect(result[0].question).toBe("First question about design?");
    expect(result[1].question).toBe("Second question about scope?");
  });
});

// ---------------------------------------------------------------------------
// Mixed formats
// ---------------------------------------------------------------------------

describe("parseOpenQuestions — mixed formats", () => {
  it("combines questions from all formats without duplicates", () => {
    const output = `# Plan Review Summary

**OPEN QUESTION:** Should auto_chain default to true?
- reviewer-arch says: true
- reviewer-patterns says: false

## Open Questions

| # | Question | Options | Source(s) |
|---|----------|---------|-----------|
| 1 | Should auto_chain default to true? | A: true B: false | reviewer-architecture |
| 2 | How should sessions be managed? | A: Shared B: Per-stage | reviewer-patterns |
`;

    const result = parseOpenQuestions(output);
    // "Should auto_chain default to true?" appears in both OPEN QUESTION block and table
    // Deduplication should merge them
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Realistic agent output (from actual UAT runs)
// ---------------------------------------------------------------------------

describe("parseOpenQuestions — realistic agent output", () => {
  it("parses questions from actual plan review output with ## Open Questions", () => {
    const output = `# Plan Review Summary

## Critical (P1)

| # | Finding | File | Reviewers | Action Required |
|---|---------|------|-----------|-----------------|
| 1 | No consumer exists in codebase | - | All 6 reviewers | Identify concrete use case |

## Important (P2)

| # | Finding | File | Reviewers | Action Required |
|---|---------|------|-----------|-----------------|
| 1 | Scope too broad | - | reviewer-scope, reviewer-architecture | Narrow to specific need |

## Minor (P3)

| # | Finding | File | Reviewers |
|---|---------|------|-----------|
| 1 | Test strategy insufficient | - | reviewer-testing |

## Open Questions

1. What feature needs this? No reviewer found a consumer in the codebase. The plan should not proceed without identifying the concrete use case that drives this requirement.
2. Library or built-in? If the need is just display formatting with timezone, Intl.DateTimeFormat (zero dependencies) may be sufficient. If arbitrary format parsing is needed, a library is required. The scope determines the answer.

---

Recommendation: Reject this plan.`;

    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(2);
    expect(result[0].question).toContain("What feature needs this?");
    expect(result[1].question).toContain("Library or built-in?");
  });

});



// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("parseOpenQuestions — edge cases", () => {
  it("returns empty array when no open questions exist", () => {
    const output = `# Plan Review Summary

## Critical (P1)

| # | Finding | File | Reviewers | Action Required |
|---|---------|------|-----------|-----------------|
| 1 | Auth issue | src/auth.ts:12 | reviewer-security | Fix it |

## Important (P2)

No findings.
`;

    const result = parseOpenQuestions(output);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty output", () => {
    const result = parseOpenQuestions("");
    expect(result).toEqual([]);
  });

  it("returns empty array when ## Open Questions section is empty", () => {
    const output = `## Open Questions

## Next Section
`;

    const result = parseOpenQuestions(output);
    expect(result).toEqual([]);
  });

  it("deduplicates similar questions (case-insensitive, stripped of backticks)", () => {
    const output = `## Open Questions

1. Should \`auto_chain\` default to true?
2. Should auto_chain default to true?
3. How should sessions be managed?
`;

    const result = parseOpenQuestions(output);
    // Questions 1 and 2 should be deduplicated
    expect(result).toHaveLength(2);
    expect(result[1].question).toBe("How should sessions be managed?");
  });

  it("handles questions spanning multiple lines in numbered list", () => {
    const output = `## Open Questions

1. Should the pipeline automatically chain from plan to work,
   or should it stop and wait for explicit user confirmation?
2. A simple question?
`;

    const result = parseOpenQuestions(output);
    expect(result).toHaveLength(2);
    // The first question should include the continuation line
    expect(result[0].question).toContain("automatically chain");
    expect(result[0].question).toContain("explicit user confirmation");
  });

  it("all returned questions have valid structure", () => {
    const output = `## Open Questions

| # | Question | Options | Source(s) |
|---|----------|---------|-----------|
| 1 | Use JWT? | A: Yes B: No | reviewer-security |

1. What about caching?
`;

    const result = parseOpenQuestions(output);
    for (const q of result) {
      expect(q).toHaveProperty("question");
      expect(q).toHaveProperty("header");
      expect(q).toHaveProperty("options");
      expect(typeof q.question).toBe("string");
      expect(typeof q.header).toBe("string");
      expect(Array.isArray(q.options)).toBe(true);
      expect(q.question.length).toBeGreaterThan(0);
      expect(q.header.length).toBeGreaterThan(0);
      expect(q.header.length).toBeLessThanOrEqual(30);
    }
  });
});
