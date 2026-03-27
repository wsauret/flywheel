import { describe, expect, it } from "bun:test";
import { buildScaffolding } from "../src/queue/prompt-scaffolding";
import type { Step } from "../src/queue/types";
import { HANDOFFS_DIR, DEFAULT_PLANS_DIR } from "../src/config/paths";

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

const HANDOFF_PATH = `${HANDOFFS_DIR}/inv-123.json`;
const PROJECT_CWD = "/tmp/test-project";

// ---------------------------------------------------------------------------
// Plan Draft scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan draft", () => {
  it("returns scaffolding for plan step with dispatcherHint 'draft'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "draft" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("## Output Requirements");
    expect(result).toContain(".plan.json");
    expect(result).toContain("steps");
    expect(result).toContain("behavioralContract");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("falls back to title matching for 'Draft' keyword", () => {
    const step = makeStep({ type: "plan", title: "Draft implementation plan" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain(".plan.json");
    expect(result).toContain("Handoff Instructions");
  });

  it("includes JSON schema example", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "draft" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("acceptanceCriteria");
    expect(result).toContain("fileReferences");
    expect(result).toContain("estimatedComplexity");
  });

  it("includes plan file output path instruction", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "draft" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain(DEFAULT_PLANS_DIR);
  });
});

// ---------------------------------------------------------------------------
// Plan Review scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan review", () => {
  it("returns scaffolding for plan step with dispatcherHint 'review'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "review" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Annotated JSON");
    expect(result).toContain("DO NOT MODIFY");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("falls back to title matching for 'Review plan' keyword", () => {
    const step = makeStep({ type: "plan", title: "Review plan" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("Annotated JSON");
    expect(result).toContain("Handoff Instructions");
  });

  it("includes review dispatch instructions", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "review" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("openQuestions");
    expect(result).toContain("findings");
    expect(result).toContain("severity");
  });
});

// ---------------------------------------------------------------------------
// Plan Consolidate scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan consolidate", () => {
  it("returns scaffolding for plan step with dispatcherHint 'consolidate'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "consolidate" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Synthesis Principles");
    expect(result).toContain("Quality Checks");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("falls back to title matching for 'Consolidate' keyword", () => {
    const step = makeStep({ type: "plan", title: "Consolidate findings" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("Synthesis Principles");
    expect(result).toContain("Handoff Instructions");
  });

  it("includes clean JSON output schema", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "consolidate" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("steps");
    expect(result).toContain("behavioralContract");
    expect(result).toContain("decisions");
    expect(result).toContain("risks");
  });

  it("includes plan file output path instruction", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "consolidate" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain(DEFAULT_PLANS_DIR);
  });
});

// ---------------------------------------------------------------------------
// Plan Research scaffolding (research hint — no plan-specific scaffolding, but handoff)
// ---------------------------------------------------------------------------

describe("buildScaffolding — plan research", () => {
  it("returns handoff scaffolding for plan step with dispatcherHint 'research'", () => {
    const step = makeStep({ type: "plan", dispatcherHint: "research" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
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
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
    expect(result).toContain("summary");
  });

  it("includes work-specific handoff fields", () => {
    const step = makeStep({ type: "work" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
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
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("includes review-specific handoff fields", () => {
    const step = makeStep({ type: "review" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("review_file_path");
    expect(result).toContain("finding_counts");
  });
});

// ---------------------------------------------------------------------------
// Sprint / Verify step scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — sprint/verify steps", () => {
  it("returns handoff scaffolding for sprint steps", () => {
    const step = makeStep({ type: "sprint" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("## Output Requirements");
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });

  it("returns handoff scaffolding for verify steps", () => {
    const step = makeStep({ type: "verify" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
    expect(result).toContain("verification_script_path");
  });
});

// ---------------------------------------------------------------------------
// Gate steps — no scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — gate steps", () => {
  it("returns empty string for gate steps", () => {
    const step = makeStep({ type: "gate", title: "Approve plan" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Delimiter format
// ---------------------------------------------------------------------------

describe("buildScaffolding — delimiter format", () => {
  it("starts with --- delimiter for non-gate steps", () => {
    const step = makeStep({ type: "work" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toMatch(/^---\n/);
  });

  it("contains ## Output Requirements heading", () => {
    const step = makeStep({ type: "work" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("## Output Requirements");
  });
});

// ---------------------------------------------------------------------------
// Ship step scaffolding
// ---------------------------------------------------------------------------

describe("buildScaffolding — ship steps", () => {
  it("returns handoff scaffolding for ship steps", () => {
    const step = makeStep({ type: "ship" });
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
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
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
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
    const result = buildScaffolding(step, HANDOFF_PATH, PROJECT_CWD);
    expect(result).toContain("Handoff Instructions");
    expect(result).toContain(HANDOFF_PATH);
  });
});
