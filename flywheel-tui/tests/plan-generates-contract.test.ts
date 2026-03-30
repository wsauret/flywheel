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
// Plan Consolidate Prompt — JSON consolidation (replaces validation contract)
// ---------------------------------------------------------------------------

describe("buildPlanConsolidatePrompt — JSON consolidation instructions", () => {
  it("instructs producing clean JSON plan (no separate validation-contract.md)", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toContain("plan.json");
    // No separate validation contract file — behavioral contract is embedded in JSON
    expect(result).not.toContain("validation-contract.md");
  });

  it("instructs merging review findings into step content", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toContain("Merge findings INTO steps");
    expect(result).toContain("P1 findings are mandatory");
  });

  it("includes fulfills field for linking steps to behavioral contract", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toContain("fulfills");
    expect(result).toContain("behavioralContract");
  });

  it("includes behavioral contract assertion format (BC-AREA-NNN)", () => {
    const result = buildPlanConsolidatePrompt(baseCtx);
    expect(result).toMatch(/BC-[A-Z]+-\d{3}/);
  });
});
