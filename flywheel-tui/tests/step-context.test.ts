import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  StepContextSchema,
  createEmptyStepContext,
  accumulateStepIntoContext,
  persistStepContext,
  loadStepContext,
  STEP_CONTEXT_FILE,
  type StepContext,
  type StepHandoffSummary,
} from "../src/workflows/queue/step-context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStepHandoff(overrides?: Partial<StepHandoffSummary>): StepHandoffSummary {
  return {
    step_index: 0,
    step_title: "Setup project structure",
    decisions: ["Used TDD approach"],
    warnings: [],
    artifacts: ["src/index.ts"],
    issues: [],
    skill_feedback: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// StepContext type and schema
// ---------------------------------------------------------------------------

describe("StepContext schema", () => {
  it("validates a complete step context", () => {
    const ctx: StepContext = {
      cumulative_decisions: [{ step_index: 0, step_title: "Setup", decisions: ["Used TDD"] }],
      cumulative_warnings: [{ step_index: 1, step_title: "Impl", warnings: ["Slow tests"] }],
      cumulative_artifacts: [{ step_index: 0, step_title: "Setup", artifacts: ["src/index.ts"] }],
      cumulative_issues: [],
      skill_feedback: [],
      step_count: 2,
    };
    const parsed = StepContextSchema.parse(ctx);
    expect(parsed.step_count).toBe(2);
    expect(parsed.cumulative_decisions).toHaveLength(1);
    expect(parsed.cumulative_warnings).toHaveLength(1);
    expect(parsed.cumulative_artifacts).toHaveLength(1);
  });

  it("validates an empty step context", () => {
    const ctx = createEmptyStepContext();
    const parsed = StepContextSchema.parse(ctx);
    expect(parsed.step_count).toBe(0);
    expect(parsed.cumulative_decisions).toHaveLength(0);
    expect(parsed.cumulative_warnings).toHaveLength(0);
    expect(parsed.cumulative_artifacts).toHaveLength(0);
    expect(parsed.cumulative_issues).toHaveLength(0);
    expect(parsed.skill_feedback).toHaveLength(0);
  });

  it("rejects invalid schema (missing step_count)", () => {
    expect(() => StepContextSchema.parse({ cumulative_decisions: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createEmptyStepContext
// ---------------------------------------------------------------------------

describe("createEmptyStepContext", () => {
  it("returns a valid empty context", () => {
    const ctx = createEmptyStepContext();
    expect(ctx.step_count).toBe(0);
    expect(ctx.cumulative_decisions).toEqual([]);
    expect(ctx.cumulative_warnings).toEqual([]);
    expect(ctx.cumulative_artifacts).toEqual([]);
    expect(ctx.cumulative_issues).toEqual([]);
    expect(ctx.skill_feedback).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// accumulateStepIntoContext
// ---------------------------------------------------------------------------

describe("accumulateStepIntoContext", () => {
  it("accumulates decisions from a step", () => {
    const ctx = createEmptyStepContext();
    const handoff = makeStepHandoff({
      step_index: 0,
      step_title: "Setup",
      decisions: ["Used TDD approach", "Chose Zod for validation"],
    });
    const updated = accumulateStepIntoContext(ctx, handoff);
    expect(updated.step_count).toBe(1);
    expect(updated.cumulative_decisions).toHaveLength(1);
    expect(updated.cumulative_decisions[0].step_index).toBe(0);
    expect(updated.cumulative_decisions[0].decisions).toEqual(["Used TDD approach", "Chose Zod for validation"]);
  });

  it("accumulates warnings from a step", () => {
    const ctx = createEmptyStepContext();
    const handoff = makeStepHandoff({
      step_index: 1,
      step_title: "Implementation",
      warnings: ["Tests are slow", "Dependency deprecated"],
    });
    const updated = accumulateStepIntoContext(ctx, handoff);
    expect(updated.cumulative_warnings).toHaveLength(1);
    expect(updated.cumulative_warnings[0].warnings).toEqual(["Tests are slow", "Dependency deprecated"]);
  });

  it("accumulates artifacts from a step", () => {
    const ctx = createEmptyStepContext();
    const handoff = makeStepHandoff({
      artifacts: ["src/index.ts", "tests/index.test.ts"],
    });
    const updated = accumulateStepIntoContext(ctx, handoff);
    expect(updated.cumulative_artifacts).toHaveLength(1);
    expect(updated.cumulative_artifacts[0].artifacts).toEqual(["src/index.ts", "tests/index.test.ts"]);
  });

  it("accumulates issues from a step", () => {
    const ctx = createEmptyStepContext();
    const handoff = makeStepHandoff({
      issues: ["Missing error handling in route handler"],
    });
    const updated = accumulateStepIntoContext(ctx, handoff);
    expect(updated.cumulative_issues).toHaveLength(1);
    expect(updated.cumulative_issues[0].issues).toEqual(["Missing error handling in route handler"]);
  });

  it("accumulates skill_feedback from a step", () => {
    const ctx = createEmptyStepContext();
    const handoff = makeStepHandoff({
      skill_feedback: {
        followedProcedure: true,
        deviations: [],
        suggestedChanges: ["Add more examples to prompt"],
      },
    });
    const updated = accumulateStepIntoContext(ctx, handoff);
    expect(updated.skill_feedback).toHaveLength(1);
    expect(updated.skill_feedback[0].followedProcedure).toBe(true);
    expect(updated.skill_feedback[0].suggestedChanges).toEqual(["Add more examples to prompt"]);
  });

  it("skips empty decisions/warnings/artifacts (no entry added)", () => {
    const ctx = createEmptyStepContext();
    const handoff = makeStepHandoff({
      decisions: [],
      warnings: [],
      artifacts: [],
      issues: [],
    });
    const updated = accumulateStepIntoContext(ctx, handoff);
    // step_count increments even if data is empty
    expect(updated.step_count).toBe(1);
    // But no entries should be accumulated for empty arrays
    expect(updated.cumulative_decisions).toHaveLength(0);
    expect(updated.cumulative_warnings).toHaveLength(0);
    expect(updated.cumulative_artifacts).toHaveLength(0);
    expect(updated.cumulative_issues).toHaveLength(0);
  });

  it("accumulates across multiple steps", () => {
    let ctx = createEmptyStepContext();

    ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
      step_index: 0,
      step_title: "Setup",
      decisions: ["Decision A"],
      warnings: ["Warning 1"],
      artifacts: [],
    }));

    ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
      step_index: 1,
      step_title: "Implement",
      decisions: ["Decision B"],
      warnings: ["Warning 2"],
      artifacts: ["src/core.ts"],
    }));

    ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
      step_index: 2,
      step_title: "Test",
      decisions: ["Decision C"],
      artifacts: [],
    }));

    expect(ctx.step_count).toBe(3);
    expect(ctx.cumulative_decisions).toHaveLength(3);
    expect(ctx.cumulative_warnings).toHaveLength(2);
    expect(ctx.cumulative_artifacts).toHaveLength(1);
    expect(ctx.cumulative_decisions[0].step_title).toBe("Setup");
    expect(ctx.cumulative_decisions[1].step_title).toBe("Implement");
    expect(ctx.cumulative_decisions[2].step_title).toBe("Test");
  });

  it("does not mutate the original context (returns new object)", () => {
    const ctx = createEmptyStepContext();
    const updated = accumulateStepIntoContext(ctx, makeStepHandoff({
      decisions: ["Decision A"],
    }));
    expect(ctx.step_count).toBe(0);
    expect(ctx.cumulative_decisions).toHaveLength(0);
    expect(updated.step_count).toBe(1);
    expect(updated.cumulative_decisions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Handles 50+ steps without errors (VAL-CONTEXT-006)
// ---------------------------------------------------------------------------

describe("step context with 50+ steps", () => {
  it("accumulates 50 steps without errors", () => {
    let ctx = createEmptyStepContext();
    for (let i = 0; i < 50; i++) {
      ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
        step_index: i,
        step_title: `Step ${i + 1}`,
        decisions: [`Decision from step ${i}`],
        warnings: i % 5 === 0 ? [`Warning from step ${i}`] : [],
        artifacts: [`file-${i}.ts`],
      }));
    }
    expect(ctx.step_count).toBe(50);
    expect(ctx.cumulative_decisions).toHaveLength(50);
    expect(ctx.cumulative_warnings).toHaveLength(10); // steps 0,5,10,...,45
    expect(ctx.cumulative_artifacts).toHaveLength(50);
    // Verify data integrity
    expect(ctx.cumulative_decisions[49].step_title).toBe("Step 50");
    expect(ctx.cumulative_decisions[49].decisions).toEqual(["Decision from step 49"]);
  });

  it("accumulates 100 steps without errors", () => {
    let ctx = createEmptyStepContext();
    for (let i = 0; i < 100; i++) {
      ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
        step_index: i,
        step_title: `Step ${i + 1}`,
        decisions: [`Decision ${i}`],
      }));
    }
    expect(ctx.step_count).toBe(100);
    expect(ctx.cumulative_decisions).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// Persistence (VAL-CONTEXT-007)
// ---------------------------------------------------------------------------

describe("step context persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "stage-ctx-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists step context to disk", () => {
    let ctx = createEmptyStepContext();
    ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
      step_index: 0,
      step_title: "Setup",
      decisions: ["Used TDD"],
    }));

    persistStepContext(ctx, tmpDir);

    const filePath = path.join(tmpDir, STEP_CONTEXT_FILE);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.step_count).toBe(1);
    expect(content.cumulative_decisions).toHaveLength(1);
  });

  it("loads step context from disk", () => {
    let ctx = createEmptyStepContext();
    ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
      step_index: 0,
      step_title: "Setup",
      decisions: ["Decision A", "Decision B"],
      warnings: ["Warning 1"],
    }));

    persistStepContext(ctx, tmpDir);
    const loaded = loadStepContext(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.step_count).toBe(1);
    expect(loaded!.cumulative_decisions).toHaveLength(1);
    expect(loaded!.cumulative_decisions[0].decisions).toEqual(["Decision A", "Decision B"]);
    expect(loaded!.cumulative_warnings).toHaveLength(1);
  });

  it("returns null when no step context file exists", () => {
    const loaded = loadStepContext(tmpDir);
    expect(loaded).toBeNull();
  });

  it("returns null when step context file is invalid JSON", () => {
    const filePath = path.join(tmpDir, STEP_CONTEXT_FILE);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json", "utf-8");

    const loaded = loadStepContext(tmpDir);
    expect(loaded).toBeNull();
  });

  it("returns null when step context file fails schema validation", () => {
    const filePath = path.join(tmpDir, STEP_CONTEXT_FILE);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ bad: "data" }), "utf-8");

    const loaded = loadStepContext(tmpDir);
    expect(loaded).toBeNull();
  });

  it("overwrites existing step context on persist", () => {
    let ctx = createEmptyStepContext();
    ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
      step_index: 0,
      step_title: "Step 1",
      decisions: ["First"],
    }));
    persistStepContext(ctx, tmpDir);

    // Accumulate another step and persist again
    ctx = accumulateStepIntoContext(ctx, makeStepHandoff({
      step_index: 1,
      step_title: "Step 2",
      decisions: ["Second"],
    }));
    persistStepContext(ctx, tmpDir);

    const loaded = loadStepContext(tmpDir);
    expect(loaded!.step_count).toBe(2);
    expect(loaded!.cumulative_decisions).toHaveLength(2);
  });

  it("creates parent directories if they don't exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "deep");
    // nestedDir doesn't exist yet

    const ctx = createEmptyStepContext();
    persistStepContext(ctx, nestedDir);

    const filePath = path.join(nestedDir, STEP_CONTEXT_FILE);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step context reset (VAL-CONTEXT-005) — verified by construction:
// Each new ExecutionLoop starts with createEmptyStepContext() in its
// constructor, so step context resets automatically between pipeline stages.
// The standalone resetStepContext() function was removed as dead code.
// ---------------------------------------------------------------------------
