import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  StageContextSchema,
  createEmptyStageContext,
  accumulatePhaseIntoContext,
  persistStageContext,
  loadStageContext,
  STAGE_CONTEXT_FILE,
  type StageContext,
  type PhaseHandoffSummary,
} from "../src/controller/stage-context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhaseHandoff(overrides?: Partial<PhaseHandoffSummary>): PhaseHandoffSummary {
  return {
    phase_index: 0,
    phase_title: "Setup project structure",
    decisions: ["Used TDD approach"],
    warnings: [],
    artifacts: ["src/index.ts"],
    issues: [],
    skill_feedback: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// StageContext type and schema
// ---------------------------------------------------------------------------

describe("StageContext schema", () => {
  it("validates a complete stage context", () => {
    const ctx: StageContext = {
      cumulative_decisions: [{ phase_index: 0, phase_title: "Setup", decisions: ["Used TDD"] }],
      cumulative_warnings: [{ phase_index: 1, phase_title: "Impl", warnings: ["Slow tests"] }],
      cumulative_artifacts: [{ phase_index: 0, phase_title: "Setup", artifacts: ["src/index.ts"] }],
      cumulative_issues: [],
      skill_feedback: [],
      phase_count: 2,
    };
    const parsed = StageContextSchema.parse(ctx);
    expect(parsed.phase_count).toBe(2);
    expect(parsed.cumulative_decisions).toHaveLength(1);
    expect(parsed.cumulative_warnings).toHaveLength(1);
    expect(parsed.cumulative_artifacts).toHaveLength(1);
  });

  it("validates an empty stage context", () => {
    const ctx = createEmptyStageContext();
    const parsed = StageContextSchema.parse(ctx);
    expect(parsed.phase_count).toBe(0);
    expect(parsed.cumulative_decisions).toHaveLength(0);
    expect(parsed.cumulative_warnings).toHaveLength(0);
    expect(parsed.cumulative_artifacts).toHaveLength(0);
    expect(parsed.cumulative_issues).toHaveLength(0);
    expect(parsed.skill_feedback).toHaveLength(0);
  });

  it("rejects invalid schema (missing phase_count)", () => {
    expect(() => StageContextSchema.parse({ cumulative_decisions: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createEmptyStageContext
// ---------------------------------------------------------------------------

describe("createEmptyStageContext", () => {
  it("returns a valid empty context", () => {
    const ctx = createEmptyStageContext();
    expect(ctx.phase_count).toBe(0);
    expect(ctx.cumulative_decisions).toEqual([]);
    expect(ctx.cumulative_warnings).toEqual([]);
    expect(ctx.cumulative_artifacts).toEqual([]);
    expect(ctx.cumulative_issues).toEqual([]);
    expect(ctx.skill_feedback).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// accumulatePhaseIntoContext
// ---------------------------------------------------------------------------

describe("accumulatePhaseIntoContext", () => {
  it("accumulates decisions from a phase", () => {
    const ctx = createEmptyStageContext();
    const handoff = makePhaseHandoff({
      phase_index: 0,
      phase_title: "Setup",
      decisions: ["Used TDD approach", "Chose Zod for validation"],
    });
    const updated = accumulatePhaseIntoContext(ctx, handoff);
    expect(updated.phase_count).toBe(1);
    expect(updated.cumulative_decisions).toHaveLength(1);
    expect(updated.cumulative_decisions[0].phase_index).toBe(0);
    expect(updated.cumulative_decisions[0].decisions).toEqual(["Used TDD approach", "Chose Zod for validation"]);
  });

  it("accumulates warnings from a phase", () => {
    const ctx = createEmptyStageContext();
    const handoff = makePhaseHandoff({
      phase_index: 1,
      phase_title: "Implementation",
      warnings: ["Tests are slow", "Dependency deprecated"],
    });
    const updated = accumulatePhaseIntoContext(ctx, handoff);
    expect(updated.cumulative_warnings).toHaveLength(1);
    expect(updated.cumulative_warnings[0].warnings).toEqual(["Tests are slow", "Dependency deprecated"]);
  });

  it("accumulates artifacts from a phase", () => {
    const ctx = createEmptyStageContext();
    const handoff = makePhaseHandoff({
      artifacts: ["src/index.ts", "tests/index.test.ts"],
    });
    const updated = accumulatePhaseIntoContext(ctx, handoff);
    expect(updated.cumulative_artifacts).toHaveLength(1);
    expect(updated.cumulative_artifacts[0].artifacts).toEqual(["src/index.ts", "tests/index.test.ts"]);
  });

  it("accumulates issues from a phase", () => {
    const ctx = createEmptyStageContext();
    const handoff = makePhaseHandoff({
      issues: ["Missing error handling in route handler"],
    });
    const updated = accumulatePhaseIntoContext(ctx, handoff);
    expect(updated.cumulative_issues).toHaveLength(1);
    expect(updated.cumulative_issues[0].issues).toEqual(["Missing error handling in route handler"]);
  });

  it("accumulates skill_feedback from a phase", () => {
    const ctx = createEmptyStageContext();
    const handoff = makePhaseHandoff({
      skill_feedback: {
        followedProcedure: true,
        deviations: [],
        suggestedChanges: ["Add more examples to prompt"],
      },
    });
    const updated = accumulatePhaseIntoContext(ctx, handoff);
    expect(updated.skill_feedback).toHaveLength(1);
    expect(updated.skill_feedback[0].followedProcedure).toBe(true);
    expect(updated.skill_feedback[0].suggestedChanges).toEqual(["Add more examples to prompt"]);
  });

  it("skips empty decisions/warnings/artifacts (no entry added)", () => {
    const ctx = createEmptyStageContext();
    const handoff = makePhaseHandoff({
      decisions: [],
      warnings: [],
      artifacts: [],
      issues: [],
    });
    const updated = accumulatePhaseIntoContext(ctx, handoff);
    // phase_count increments even if data is empty
    expect(updated.phase_count).toBe(1);
    // But no entries should be accumulated for empty arrays
    expect(updated.cumulative_decisions).toHaveLength(0);
    expect(updated.cumulative_warnings).toHaveLength(0);
    expect(updated.cumulative_artifacts).toHaveLength(0);
    expect(updated.cumulative_issues).toHaveLength(0);
  });

  it("accumulates across multiple phases", () => {
    let ctx = createEmptyStageContext();

    ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      phase_index: 0,
      phase_title: "Setup",
      decisions: ["Decision A"],
      warnings: ["Warning 1"],
      artifacts: [],
    }));

    ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      phase_index: 1,
      phase_title: "Implement",
      decisions: ["Decision B"],
      warnings: ["Warning 2"],
      artifacts: ["src/core.ts"],
    }));

    ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      phase_index: 2,
      phase_title: "Test",
      decisions: ["Decision C"],
      artifacts: [],
    }));

    expect(ctx.phase_count).toBe(3);
    expect(ctx.cumulative_decisions).toHaveLength(3);
    expect(ctx.cumulative_warnings).toHaveLength(2);
    expect(ctx.cumulative_artifacts).toHaveLength(1);
    expect(ctx.cumulative_decisions[0].phase_title).toBe("Setup");
    expect(ctx.cumulative_decisions[1].phase_title).toBe("Implement");
    expect(ctx.cumulative_decisions[2].phase_title).toBe("Test");
  });

  it("does not mutate the original context (returns new object)", () => {
    const ctx = createEmptyStageContext();
    const updated = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      decisions: ["Decision A"],
    }));
    expect(ctx.phase_count).toBe(0);
    expect(ctx.cumulative_decisions).toHaveLength(0);
    expect(updated.phase_count).toBe(1);
    expect(updated.cumulative_decisions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Handles 50+ phases without errors (VAL-CONTEXT-006)
// ---------------------------------------------------------------------------

describe("stage context with 50+ phases", () => {
  it("accumulates 50 phases without errors", () => {
    let ctx = createEmptyStageContext();
    for (let i = 0; i < 50; i++) {
      ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
        phase_index: i,
        phase_title: `Phase ${i + 1}`,
        decisions: [`Decision from phase ${i}`],
        warnings: i % 5 === 0 ? [`Warning from phase ${i}`] : [],
        artifacts: [`file-${i}.ts`],
      }));
    }
    expect(ctx.phase_count).toBe(50);
    expect(ctx.cumulative_decisions).toHaveLength(50);
    expect(ctx.cumulative_warnings).toHaveLength(10); // phases 0,5,10,...,45
    expect(ctx.cumulative_artifacts).toHaveLength(50);
    // Verify data integrity
    expect(ctx.cumulative_decisions[49].phase_title).toBe("Phase 50");
    expect(ctx.cumulative_decisions[49].decisions).toEqual(["Decision from phase 49"]);
  });

  it("accumulates 100 phases without errors", () => {
    let ctx = createEmptyStageContext();
    for (let i = 0; i < 100; i++) {
      ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
        phase_index: i,
        phase_title: `Phase ${i + 1}`,
        decisions: [`Decision ${i}`],
      }));
    }
    expect(ctx.phase_count).toBe(100);
    expect(ctx.cumulative_decisions).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------
// Persistence (VAL-CONTEXT-007)
// ---------------------------------------------------------------------------

describe("stage context persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "stage-ctx-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists stage context to disk", () => {
    let ctx = createEmptyStageContext();
    ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      phase_index: 0,
      phase_title: "Setup",
      decisions: ["Used TDD"],
    }));

    persistStageContext(ctx, tmpDir);

    const filePath = path.join(tmpDir, STAGE_CONTEXT_FILE);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.phase_count).toBe(1);
    expect(content.cumulative_decisions).toHaveLength(1);
  });

  it("loads stage context from disk", () => {
    let ctx = createEmptyStageContext();
    ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      phase_index: 0,
      phase_title: "Setup",
      decisions: ["Decision A", "Decision B"],
      warnings: ["Warning 1"],
    }));

    persistStageContext(ctx, tmpDir);
    const loaded = loadStageContext(tmpDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.phase_count).toBe(1);
    expect(loaded!.cumulative_decisions).toHaveLength(1);
    expect(loaded!.cumulative_decisions[0].decisions).toEqual(["Decision A", "Decision B"]);
    expect(loaded!.cumulative_warnings).toHaveLength(1);
  });

  it("returns null when no stage context file exists", () => {
    const loaded = loadStageContext(tmpDir);
    expect(loaded).toBeNull();
  });

  it("returns null when stage context file is invalid JSON", () => {
    const filePath = path.join(tmpDir, STAGE_CONTEXT_FILE);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json", "utf-8");

    const loaded = loadStageContext(tmpDir);
    expect(loaded).toBeNull();
  });

  it("returns null when stage context file fails schema validation", () => {
    const filePath = path.join(tmpDir, STAGE_CONTEXT_FILE);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ bad: "data" }), "utf-8");

    const loaded = loadStageContext(tmpDir);
    expect(loaded).toBeNull();
  });

  it("overwrites existing stage context on persist", () => {
    let ctx = createEmptyStageContext();
    ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      phase_index: 0,
      phase_title: "Phase 1",
      decisions: ["First"],
    }));
    persistStageContext(ctx, tmpDir);

    // Accumulate another phase and persist again
    ctx = accumulatePhaseIntoContext(ctx, makePhaseHandoff({
      phase_index: 1,
      phase_title: "Phase 2",
      decisions: ["Second"],
    }));
    persistStageContext(ctx, tmpDir);

    const loaded = loadStageContext(tmpDir);
    expect(loaded!.phase_count).toBe(2);
    expect(loaded!.cumulative_decisions).toHaveLength(2);
  });

  it("creates parent directories if they don't exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "deep");
    // nestedDir doesn't exist yet

    const ctx = createEmptyStageContext();
    persistStageContext(ctx, nestedDir);

    const filePath = path.join(nestedDir, STAGE_CONTEXT_FILE);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage context reset (VAL-CONTEXT-005) — verified by construction:
// Each new ExecutionLoop starts with createEmptyStageContext() in its
// constructor, so stage context resets automatically between pipeline stages.
// The standalone resetStageContext() function was removed as dead code.
// ---------------------------------------------------------------------------
