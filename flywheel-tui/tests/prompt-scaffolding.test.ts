import { describe, expect, it } from "bun:test";
import "../src/queue/steps/register-all";
import { buildScaffolding, type ScaffoldingResult, type ScaffoldingPaths } from "../src/queue/shared/scaffolding";
import type { Step } from "../src/queue/types";

/** Combine preamble + postamble for content assertions. */
function combined(r: ScaffoldingResult): string {
  return [r.preamble, r.postamble].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "test-step-id",
    type: "work",
    title: "Test step",
    status: "pending",
    ...overrides,
  };
}

const HANDOFF_PATH = "/tmp/test-project/.flywheel/sessions/test-session/handoffs/dispatcher_inv-123.json";
const PROJECT_CWD = "/tmp/test-project";
const TEST_PLAN_PATH = "/tmp/test-project/.flywheel/sessions/test-session/plan.json";

/** Default scaffolding paths for tests */
const TEST_PATHS: ScaffoldingPaths = {
  handoffPath: HANDOFF_PATH,
  planPath: TEST_PLAN_PATH,
};

// ---------------------------------------------------------------------------
// Plan Draft scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan draft", () => {
  it("returns scaffolding for plan step with dispatcherHint 'draft'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "draft" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("plan.json");
    expect(result).toContain("steps");
    expect(result).toContain("behavioralContract");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("falls back to title matching for 'Draft' keyword", () => {
    const step = makeStep({ type: "plan", title: "Draft implementation plan" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("plan.json");
    expect(result).toContain("Handoff Instructions");
  });

  it("includes JSON schema example", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "draft" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("acceptanceCriteria");
    expect(result).toContain("fileReferences");
    expect(result).toContain("estimatedComplexity");
  });

  it("includes plan file output path instruction", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "draft" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain(TEST_PLAN_PATH);
  });
});

// ---------------------------------------------------------------------------
// Plan Review scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan review", () => {
  it("returns scaffolding for plan step with dispatcherHint 'review'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "review" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.postamble).toContain("Output Requirements");
    expect(result.postamble).toContain("Annotated JSON");
    expect(result.postamble).toContain("NEVER modify draft-authored fields");
    expect(result.postamble).toContain("Handoff Instructions");
    expect(result.postamble).toContain(HANDOFF_PATH);
  });

  it("falls back to title matching for 'Review plan' keyword", () => {
    const step = makeStep({ type: "plan", title: "Review plan" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.postamble).toContain("Annotated JSON");
    expect(result.postamble).toContain("Handoff Instructions");
  });

  it("includes reviewer agent dispatch instructions in preamble", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "review" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("reviewer-architecture");
    expect(result.preamble).toContain("reviewer-code-quality");
    expect(result.preamble).toContain("reviewer-patterns");
    expect(result.preamble).toContain("reviewer-performance");
    expect(result.preamble).toContain("reviewer-data-integrity");
    expect(result.preamble).toContain("reviewer-plan-philosophy");
    expect(result.preamble).toContain("Phase 0");
    expect(result.preamble).toContain("Task");
  });

  it("has preamble before postamble in combined output", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "review" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble.length).toBeGreaterThan(0);
    expect(result.postamble.length).toBeGreaterThan(0);
    // Preamble contains dispatch instructions, postamble contains output format
    expect(result.preamble).toContain("Dispatch Reviewer Agents");
    expect(result.postamble).toContain("openQuestions");
  });
});

// ---------------------------------------------------------------------------
// Plan Consolidate scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan consolidate", () => {
  it("returns scaffolding for plan step with dispatcherHint 'consolidate'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "consolidate" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Synthesis Principles");
    expect(result).toContain("Quality Checks");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("falls back to title matching for 'Consolidate' keyword", () => {
    const step = makeStep({ type: "plan", title: "Consolidate findings" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Synthesis Principles");
    expect(result).toContain("Handoff Instructions");
  });

  it("includes clean JSON output schema", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "consolidate" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("steps");
    expect(result).toContain("behavioralContract");
    expect(result).toContain("decisions");
    expect(result).toContain("risks");
  });

  it("includes plan file output path instruction", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "consolidate" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain(TEST_PLAN_PATH);
  });
});

// ---------------------------------------------------------------------------
// Plan Research scaffolding (research hint — no plan-specific scaffolding, but handoff)
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan research", () => {
  it("returns handoff scaffolding for plan step with dispatcherHint 'research'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "research" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });
});

// ---------------------------------------------------------------------------
// Work step scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — work steps", () => {
  it("returns handoff scaffolding for work steps", () => {
    const step = makeStep({ type: "work", title: "Implement feature" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
    expect(result).toContain("summary");
  });

  it("includes work-specific handoff fields", () => {
    const step = makeStep({ type: "work" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("artifacts");
    expect(result).toContain("verification");
  });
});

// ---------------------------------------------------------------------------
// Review step scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — review steps", () => {
  it("returns handoff scaffolding for review steps", () => {
    const step = makeStep({ type: "review", title: "Multi-agent code review" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("includes review-specific handoff fields", () => {
    const step = makeStep({ type: "review" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("finding_counts");
    expect(result).toContain("p3_findings");
  });
});

// ---------------------------------------------------------------------------
// Verify step scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — verify steps", () => {
  it("returns handoff scaffolding for verify steps", () => {
    const step = makeStep({ type: "verify" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
    expect(result).toContain("verification_script_path");
  });
});

// ---------------------------------------------------------------------------
// Gate steps — no scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — gate steps", () => {
  it("returns empty for gate steps", () => {
    const step = makeStep({ type: "gate", title: "Approve plan" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toBe("");
    expect(result.postamble).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Delimiter format
// ---------------------------------------------------------------------------

describe("buildScaffolding — delimiter format", () => {
  it("postamble starts with --- delimiter for non-gate steps", () => {
    const step = makeStep({ type: "work" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.postamble).toMatch(/^---\n/);
  });

  it("contains ## Output Requirements heading", () => {
    const step = makeStep({ type: "work" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Output Requirements");
  });
});

// ---------------------------------------------------------------------------
// Ship step scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — ship steps", () => {
  it("returns handoff scaffolding for ship steps", () => {
    const step = makeStep({ type: "ship" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });
});

// ---------------------------------------------------------------------------
// Debug step scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — debug steps", () => {
  it("returns handoff scaffolding for debug steps", () => {
    const step = makeStep({ type: "debug" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });
});

// ---------------------------------------------------------------------------
// Research step scaffolding (top-level research, not plan research)
// ---------------------------------------------------------------------------

describe("buildScaffolding — research steps", () => {
  it("returns handoff scaffolding for research steps", () => {
    const step = makeStep({ type: "research" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });
});

// ---------------------------------------------------------------------------
// Generic detectRole tests (via buildScaffolding routing)
// ---------------------------------------------------------------------------

describe("buildScaffolding — generic role detection via strategy map", () => {
  it("routes plan steps via detectRole (backward compat with detectPlanRole)", () => {
    // These tests already exist above and verify plan role detection
    // This test verifies the strategy map doesn't break existing behavior
    const draftStep = makeStep({ type: "plan", dispatcherHint: "draft" });
    const result = combined(buildScaffolding(draftStep, TEST_PATHS));
    expect(result).toContain("plan.json");
    expect(result).toContain("behavioralContract");
  });

  it("routes review steps with dispatcherHint 'dispatch-reviewers' (dispatch role)", () => {
    // Review dispatch scaffolding not yet implemented — should still return review handoff
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("routes review steps with dispatcherHint 'consolidate-review' (consolidate role)", () => {
    const step = makeStep({ type: "review", dispatcherHint: "consolidate-review" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("routes ship steps with dispatcherHint 'learnings' (learnings role)", () => {
    const step = makeStep({ type: "ship", dispatcherHint: "learnings" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("routes debug steps with dispatcherHint 'investigate' (investigate role)", () => {
    const step = makeStep({ type: "debug", dispatcherHint: "investigate" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("routes debug steps with dispatcherHint 'fix' (fix role)", () => {
    const step = makeStep({ type: "debug", dispatcherHint: "fix" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("routes research steps without role detection (single role)", () => {
    const step = makeStep({ type: "research" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });
});

// ---------------------------------------------------------------------------
// Strategy map routing tests
// ---------------------------------------------------------------------------

describe("buildScaffolding — strategy map routing", () => {
  it("strategy map handles all StepType values without errors", () => {
    const stepTypes: Array<import("../src/queue/types").StepType> = [
      "plan", "work", "review", "ship", "debug", "research", "verify", "gate",
    ];
    for (const type of stepTypes) {
      const step = makeStep({ type, dispatcherHint: type === "plan" ? "draft" : undefined });
      const result = buildScaffolding(step, TEST_PATHS);
      expect(result).toBeDefined();
      expect(typeof result.preamble).toBe("string");
      expect(typeof result.postamble).toBe("string");
    }
  });

  it("returns empty for unknown step types", () => {
    const step = makeStep({ type: "unknown" as any });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toBe("");
    expect(result.postamble).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Field spec integration tests
// ---------------------------------------------------------------------------

describe("buildScaffolding — field spec integration", () => {
  it("renderHandoffInstruction produces non-empty output for all field spec arrays", () => {
    const { renderHandoffInstruction } = require("../src/queue/shared/handoff-render");
    const { WORK_STEP_FIELDS } = require("../src/queue/steps/work/fields");
    const { REVIEW_FIELDS } = require("../src/queue/steps/review-consolidate/fields");
    const { SHIP_FIELDS } = require("../src/queue/steps/ship-commit/fields");
    const { SPRINT_FIELDS } = require("../src/queue/steps/sprint-work/fields");
    const { DEBUG_INVESTIGATE_FIELDS } = require("../src/queue/steps/debug-investigate/fields");
    const { DEBUG_FIX_FIELDS } = require("../src/queue/steps/debug-fix/fields");
    const { DEBUG_VERIFY_FIELDS } = require("../src/queue/steps/debug-verify/fields");
    const { RESEARCH_FIELDS } = require("../src/queue/steps/research/fields");
    const { SHIP_COMMIT_FIELDS } = require("../src/queue/steps/ship-commit/fields");
    const { SHIP_LEARNINGS_FIELDS } = require("../src/queue/steps/ship-learnings/fields");
    const { REVIEW_DISPATCH_FIELDS } = require("../src/queue/steps/review-dispatch/fields");
    const { REVIEW_CONSOLIDATE_FIELDS } = require("../src/queue/steps/review-consolidate/fields");

    const allFieldSpecs = [
      WORK_STEP_FIELDS, REVIEW_FIELDS, SHIP_FIELDS, SPRINT_FIELDS,
      DEBUG_INVESTIGATE_FIELDS, DEBUG_FIX_FIELDS, DEBUG_VERIFY_FIELDS, RESEARCH_FIELDS,
      SHIP_COMMIT_FIELDS, SHIP_LEARNINGS_FIELDS, REVIEW_DISPATCH_FIELDS, REVIEW_CONSOLIDATE_FIELDS,
    ];

    for (const fields of allFieldSpecs) {
      expect(fields.length).toBeGreaterThan(0);
      const output = renderHandoffInstruction(fields, "/tmp/test-handoff.json");
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain("Handoff Instructions");
      expect(output).toContain("/tmp/test-handoff.json");
    }
  });

  it("renderHandoffInstruction requires writing artifacts before the handoff file", () => {
    const { renderHandoffInstruction } = require("../src/queue/shared/handoff-render");
    const { PLAN_RESEARCH_FIELDS } = require("../src/queue/steps/plan-research/fields");

    const output = renderHandoffInstruction(PLAN_RESEARCH_FIELDS, "/tmp/test-handoff.json");

    expect(output).toContain("complete those artifact writes first and write the handoff file last");
    expect(output).toContain("the queue may auto-complete the step immediately");
  });
});

// ---------------------------------------------------------------------------
// Review dispatch scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — review dispatch scaffolding", () => {
  it("returns preamble with reviewer dispatch instructions for dispatch-reviewers hint", () => {
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("Dispatch Review Agents");
    expect(result.preamble).toContain("fly/reviewer-architecture");
    expect(result.postamble).toContain("Handoff Instructions");
    expect(result.postamble).toContain(HANDOFF_PATH);
  });

  it("returns finding synthesis instructions in preamble", () => {
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("Collect & Deduplicate");
    expect(result.preamble).toContain("Severity Assignment");
  });
});

// ---------------------------------------------------------------------------
// Review consolidate scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — review consolidate scaffolding", () => {
  it("returns postamble with consolidation instructions for consolidate-review hint", () => {
    const step = makeStep({ type: "review", dispatcherHint: "consolidate-review" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toBe("");
    expect(result.postamble).toContain("Deduplicate");
    expect(result.postamble).toContain("Handoff Instructions");
  });

  it("does not include docs/reviews/ persistent copy instruction", () => {
    const step = makeStep({ type: "review", dispatcherHint: "consolidate-review" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.postamble).not.toContain("docs/reviews/");
  });
});

// ---------------------------------------------------------------------------
// Ship commit scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — ship commit scaffolding", () => {
  it("returns postamble with staging rules for ship hint", () => {
    const step = makeStep({ type: "ship", dispatcherHint: "ship" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("NEVER");
    expect(result).toContain("AI attribution");
    expect(result).toContain("Handoff Instructions");
  });

  it("includes branch naming and PR format", () => {
    const step = makeStep({ type: "ship", dispatcherHint: "ship" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Branch Naming");
    expect(result).toContain("PR Format");
  });
});

// ---------------------------------------------------------------------------
// Ship learnings scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — ship learnings scaffolding", () => {
  it("returns postamble with compound doc format for learnings hint", () => {
    const step = makeStep({ type: "ship", dispatcherHint: "learnings" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Compound Doc Format");
    expect(result).toContain("Handoff Instructions");
  });

  it("includes dedup rules", () => {
    const step = makeStep({ type: "ship", dispatcherHint: "learnings" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Dedup");
  });
});

// ---------------------------------------------------------------------------
// Review/Ship backward compat
// ---------------------------------------------------------------------------

describe("buildScaffolding — review/ship backward compat", () => {
  it("review step without dispatcherHint defaults to dispatch role", () => {
    const step = makeStep({ type: "review" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("Dispatch Review Agents");
  });

  it("ship step without dispatcherHint defaults to ship role", () => {
    const step = makeStep({ type: "ship" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("NEVER");
    expect(result).toContain("Branch Naming");
  });

  it("review step with title 'Consolidate review findings' maps to consolidate", () => {
    const step = makeStep({ type: "review", title: "Consolidate review findings" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.postamble).toContain("Deduplicate");
  });

  it("ship step with title 'Extract learnings' maps to learnings", () => {
    const step = makeStep({ type: "ship", title: "Extract learnings" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Compound Doc Format");
  });
});

// ---------------------------------------------------------------------------
// Debug investigate scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — debug investigate scaffolding", () => {
  it("contains investigation methodology + hypothesis template for investigate hint", () => {
    const step = makeStep({ type: "debug", dispatcherHint: "investigate" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("Investigation");
    expect(result.preamble).toContain("Hypothesis");
    expect(result.postamble).toContain("Handoff Instructions");
    expect(result.postamble).toContain(HANDOFF_PATH);
  });
});

// ---------------------------------------------------------------------------
// Debug fix scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — debug fix scaffolding", () => {
  it("contains fix loop rules + minimum-change principle for fix hint", () => {
    const step = makeStep({ type: "debug", dispatcherHint: "fix" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Minimum change");
    expect(result).toContain("Fix");
    expect(result).toContain("Handoff Instructions");
  });

  it("contains fix iteration template", () => {
    const step = makeStep({ type: "debug", dispatcherHint: "fix" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Attempt");
    expect(result).toContain("Verification");
  });
});

// ---------------------------------------------------------------------------
// Debug verify scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — debug verify scaffolding", () => {
  it("contains verification + resolution format for debug-verify hint", () => {
    const step = makeStep({ type: "debug", dispatcherHint: "debug-verify" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Resolution");
    expect(result).toContain("Escalation");
    expect(result).toContain("Handoff Instructions");
  });
});

// ---------------------------------------------------------------------------
// Research full scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — research scaffolding", () => {
  it("contains full locate→analyze→persist flow", () => {
    const step = makeStep({ type: "research" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("Locator");
    expect(result.preamble).toContain("Analyzer");
    expect(result.postamble).toContain("Handoff Instructions");
  });

  it("contains research document template with YAML frontmatter", () => {
    const step = makeStep({ type: "research" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("type: research");
    expect(result).toContain("Research Question");
  });

  it("uses researchPath from paths when provided", () => {
    const step = makeStep({ type: "research" });
    const paths = { ...TEST_PATHS, researchPath: "/custom/research.md" };
    const result = combined(buildScaffolding(step, paths));
    expect(result).toContain("/custom/research.md");
  });

  it("contains 4-locator dispatch instructions", () => {
    const step = makeStep({ type: "research" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("locator-codebase");
    expect(result.preamble).toContain("locator-patterns");
    expect(result.preamble).toContain("locator-docs");
  });
});

// ---------------------------------------------------------------------------
// Debug/Research backward compat
// ---------------------------------------------------------------------------

describe("buildScaffolding — debug/research backward compat", () => {
  it("debug step without dispatcherHint defaults to investigate", () => {
    const step = makeStep({ type: "debug" });
    const result = buildScaffolding(step, TEST_PATHS);
    expect(result.preamble).toContain("Investigation");
  });

  it("debug step with title 'Fix' maps to fix role", () => {
    const step = makeStep({ type: "debug", title: "Fix the bug" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Minimum change");
  });

  it("debug step with title 'Verify' maps to verify role", () => {
    const step = makeStep({ type: "debug", title: "Verify resolution" });
    const result = combined(buildScaffolding(step, TEST_PATHS));
    expect(result).toContain("Resolution");
  });
});
