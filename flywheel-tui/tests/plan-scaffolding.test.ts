import { describe, it, expect } from "bun:test";
import { buildScaffolding } from "../src/workflows/queue/shared/scaffolding";
import type { Step } from "../src/workflows/queue/types";
import type { ScaffoldingPaths } from "../src/workflows/queue/shared/scaffolding";

// Side-effect import — triggers registration so buildScaffolding can find it
import "../src/workflows/queue/steps/plan/scaffolding";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makePlanStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "test-plan-step-001",
    type: "plan",
    title: "Create implementation plan",
    status: "running",
    ...overrides,
  } as Step;
}

const PATHS: ScaffoldingPaths = {
  handoffPath: "/tmp/.flywheel/handoffs/plan-001.json",
};

// ---------------------------------------------------------------------------
// 1. Preamble content
// ---------------------------------------------------------------------------

describe("plan-scaffolding: preamble", () => {
  it("returns a non-empty preamble for plan step", () => {
    const result = buildScaffolding(makePlanStep(), PATHS);
    expect(result.preamble.length).toBeGreaterThan(0);
  });

  it("preamble contains the five planning disciplines", () => {
    const { preamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(preamble).toContain("DISCOVER");
    expect(preamble).toContain("ANALYZE");
    expect(preamble).toContain("PLAN");
    expect(preamble).toContain("ORDER");
    expect(preamble).toContain("SCOPE");
  });

  it("preamble instructs structured numbered output", () => {
    const { preamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(preamble).toContain("Step 1:");
    expect(preamble).toContain("Title");
    expect(preamble).toContain("Description");
    expect(preamble).toContain("Acceptance Criteria");
  });

  it("preamble emphasizes planning over code writing", () => {
    const { preamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(preamble).toContain("not to write code");
  });

  it("preamble includes planning principles", () => {
    const { preamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(preamble).toContain("PLANNING PRINCIPLES");
    expect(preamble).toContain("objectively verifiable");
  });
});

// ---------------------------------------------------------------------------
// 2. Postamble / handoff output requirements
// ---------------------------------------------------------------------------

describe("plan-scaffolding: postamble", () => {
  it("postamble contains output requirements heading", () => {
    const { postamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(postamble).toContain("Output Requirements");
  });

  it("postamble contains handoff instruction with the correct path", () => {
    const { postamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(postamble).toContain(PATHS.handoffPath);
  });

  it("postamble mentions the summary field (required)", () => {
    const { postamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(postamble).toContain("summary");
    expect(postamble).toContain("REQUIRED");
  });

  it("postamble includes plan-specific fields", () => {
    const { postamble } = buildScaffolding(makePlanStep(), PATHS);
    expect(postamble).toContain("decisions");
    expect(postamble).toContain("warnings");
    expect(postamble).toContain("artifacts");
  });
});

// ---------------------------------------------------------------------------
// 3. Isolation — plan scaffolding does not leak to work steps
// ---------------------------------------------------------------------------

describe("plan-scaffolding: isolation", () => {
  it("work step (type 'work') does not get plan preamble", () => {
    const workStep = { ...makePlanStep(), type: "work" as const };
    const result = buildScaffolding(workStep, PATHS);
    expect(result.preamble).not.toContain("Plan Mode");
  });
});
