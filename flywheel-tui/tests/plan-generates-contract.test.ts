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
// Plan Draft Prompt — Behavioral Contract Instructions (JSON)
// ---------------------------------------------------------------------------

describe("buildPlanDraftPrompt — behavioral contract instructions (JSON)", () => {
  it("instructs planner to embed behavioralContract in JSON plan", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("behavioralContract");
  });

  it("includes the assertion ID format BC-AREA-NNN", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("BC-");
    // Should reference the format convention like BC-AREA-NNN or BC-{AREA}-{NNN}
    expect(result).toMatch(/BC-[A-Z]+-\d{3}/);
  });

  it("includes the assertion structure fields (id, title, description, evidence, area)", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    // JSON schema rules describe each field
    expect(result).toContain('"id"');
    expect(result).toContain('"title"');
    expect(result).toContain('"description"');
    expect(result).toContain('"evidence"');
    expect(result).toContain('"area"');
  });

  it("includes behavioral not structural principle", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("Behavioral, not structural");
  });

  it("instructs fulfills field links steps to assertions", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain("fulfills");
    // JSON fulfills field, not HTML comment annotation
    expect(result).toContain('"fulfills"');
  });

  it("includes area field for assertion grouping", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    expect(result).toContain('"area"');
    expect(result).toContain("Area grouping");
  });

  it("includes complete behavioral contract example in JSON", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    // Should have a JSON example showing the contract format
    expect(result).toContain('"behavioralContract"');
    expect(result).toContain("BC-SERVER-001");
  });

  it("does NOT instruct generating a separate validation-contract.md file", () => {
    const result = buildPlanDraftPrompt(baseCtx);
    // The contract is embedded in JSON, not a separate markdown file
    expect(result).not.toContain("## Validation Contract Output");
    expect(result).not.toContain("# Validation Contract");
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
