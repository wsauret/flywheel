import { describe, it, expect } from "bun:test";
import type { WorkflowStepContext } from "../src/prompts/index";
import {
  buildPlanDraftPrompt,
  buildPlanConsolidatePrompt,
} from "../src/prompts/index";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseCtx: WorkflowStepContext = {
  planContent: "Implement user authentication with JWT tokens",
  keyDecisions: ["Using bcrypt for password hashing", "JWT expiry set to 24h"],
  fileReferences: ["src/auth/handler.ts", "src/middleware/jwt.ts"],
  projectCwd: "/home/user/project",
};

// ---------------------------------------------------------------------------
// Plan Draft Prompt — Validation Contract Instructions
// ---------------------------------------------------------------------------

describe("buildPlanDraftPrompt — validation contract instructions", () => {
  it("instructs planner to generate validation-contract.md", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("validation-contract.md");
  });

  it("includes the assertion ID format VAL-AREA-NNN", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("VAL-");
    // Should reference the format convention like VAL-AREA-NNN or VAL-<AREA>-NNN
    expect(result).toMatch(/VAL-[A-Z]+-\d{3}/);
  });

  it("includes the assertion structure (ID, title, behavioral description, evidence)", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    // The prompt must explain the assertion structure with these fields
    expect(result).toContain("Behavioral description");
    expect(result).toContain("Evidence");
  });

  it("instructs inclusion of cross-area flow assertions", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("Cross-Area");
  });

  it("instructs generation of milestone markers in the plan", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("## Milestone:");
  });

  it("instructs adding fulfills annotations to plan phases", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("fulfills");
    // Should reference the HTML comment format for fulfills
    expect(result).toContain("<!-- fulfills:");
  });

  it("includes per-area assertion grouping instructions", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("## Area:");
  });

  it("includes complete validation contract template example", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    // Should have a template or example showing the contract format
    expect(result).toContain("# Validation Contract");
  });
});

// ---------------------------------------------------------------------------
// Plan Consolidate Prompt — Validation Contract Instructions
// ---------------------------------------------------------------------------

describe("buildPlanConsolidatePrompt — validation contract instructions", () => {
  it("instructs planner to generate validation-contract.md alongside plan", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toContain("validation-contract.md");
  });

  it("includes milestone marker format instructions", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toContain("## Milestone:");
  });

  it("includes fulfills annotation format in consolidated plan template", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toContain("fulfills");
    expect(result).toContain("<!-- fulfills:");
  });

  it("includes assertion ID format in contract instructions", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toMatch(/VAL-[A-Z]+-\d{3}/);
  });
});
