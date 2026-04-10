import { describe, it, expect } from "bun:test";
import {
  StepContextSchema,
  createEmptyStepContext,
  type StepContext,
} from "../src/workflows/queue/step-context";

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

