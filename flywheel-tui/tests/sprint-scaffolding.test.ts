import { describe, it, expect } from "bun:test";
import { buildScaffolding, variantKey } from "../src/workflows/queue/shared/scaffolding";
import type { Step } from "../src/workflows/queue/types";
import type { ScaffoldingPaths } from "../src/workflows/queue/shared/scaffolding";
import { SPRINT_HINT } from "../src/workflows/queue/steps/sprint/types";

// Side-effect import — triggers registration so buildScaffolding can find it
import "../src/workflows/queue/steps/sprint/scaffolding";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeSprintStep(overrides: Partial<Step> = {}): Step {
  return {
    id: "test-sprint-step-001",
    type: "work",
    title: "Implement feature X",
    status: "running",
    dispatcherHint: SPRINT_HINT,
    ...overrides,
  } as Step;
}

const PATHS: ScaffoldingPaths = {
  handoffPath: "/tmp/.flywheel/handoffs/sprint-001.json",
};

// ---------------------------------------------------------------------------
// 1. variantKey helper
// ---------------------------------------------------------------------------

describe("sprint-scaffolding: variantKey", () => {
  it("produces 'work:sprint' from type and SPRINT_HINT constant", () => {
    expect(variantKey("work", SPRINT_HINT)).toBe("work:sprint");
  });

  it("SPRINT_HINT is the literal string 'sprint'", () => {
    expect(SPRINT_HINT).toBe("sprint");
  });
});

// ---------------------------------------------------------------------------
// 2. Preamble content
// ---------------------------------------------------------------------------

describe("sprint-scaffolding: preamble", () => {
  it("returns a non-empty preamble for sprint-hinted work step", () => {
    const result = buildScaffolding(makeSprintStep(), PATHS);
    expect(result.preamble.length).toBeGreaterThan(0);
  });

  it("preamble contains the five sprint disciplines", () => {
    const { preamble } = buildScaffolding(makeSprintStep(), PATHS);
    expect(preamble).toContain("RESEARCH");
    expect(preamble).toContain("PLAN");
    expect(preamble).toContain("EXECUTE");
    expect(preamble).toContain("SELF-VERIFY");
    expect(preamble).toContain("HANDOFF");
  });

  it("preamble mentions TDD", () => {
    const { preamble } = buildScaffolding(makeSprintStep(), PATHS);
    expect(preamble).toContain("TDD");
  });

  it("preamble includes scope discipline", () => {
    const { preamble } = buildScaffolding(makeSprintStep(), PATHS);
    expect(preamble).toContain("SCOPE DISCIPLINE");
  });

  it("preamble includes the three-strike wall protocol", () => {
    const { preamble } = buildScaffolding(makeSprintStep(), PATHS);
    expect(preamble).toContain("3 times");
  });
});

// ---------------------------------------------------------------------------
// 3. Postamble / handoff output requirements
// ---------------------------------------------------------------------------

describe("sprint-scaffolding: postamble", () => {
  it("postamble contains output requirements heading", () => {
    const { postamble } = buildScaffolding(makeSprintStep(), PATHS);
    expect(postamble).toContain("Output Requirements");
  });

  it("postamble contains handoff instruction with the correct path", () => {
    const { postamble } = buildScaffolding(makeSprintStep(), PATHS);
    expect(postamble).toContain(PATHS.handoffPath);
  });

  it("postamble mentions the summary field (required)", () => {
    const { postamble } = buildScaffolding(makeSprintStep(), PATHS);
    expect(postamble).toContain("summary");
    expect(postamble).toContain("REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// 4. Fallback — plain work step should NOT get sprint preamble
// ---------------------------------------------------------------------------

describe("sprint-scaffolding: fallback isolation", () => {
  it("plain work step (no hint) does not get sprint preamble", () => {
    const plainStep = makeSprintStep({ dispatcherHint: undefined });
    const result = buildScaffolding(plainStep, PATHS);
    // Plain work step should use the generic work scaffolding (empty preamble)
    expect(result.preamble).not.toContain("Sprint Mode");
  });
});
