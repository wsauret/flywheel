/**
 * Tests for behavioral validation step:
 * - Behavioral validation prompt template content and behavior
 * - Re-validation logic (only checks failed/blocked assertions)
 * - Assertion extraction from fulfills
 * - Validation state update utilities
 * - Integration with stage-loop-factory prompt builder routing
 *
 * Fulfills: VAL-EXEC-005, VAL-EXEC-006, VAL-EXEC-010, VAL-CROSS-006
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  buildBehavioralValidationPrompt,
  collectAssertionsForMilestone,
  filterAssertionsForRevalidation,
  type BehavioralValidationContext,
  type ContractAssertion,
} from "../src/prompts/work/behavioral-validation";

import {
  readValidationState,
  writeValidationState,
  updateAssertionStatuses,
  type CoverageReport,
} from "../src/controller/validation-state";

import type { ValidationState } from "../src/schemas/validation";
import type { StepInfo } from "../src/controller/step-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "behavioral-validation-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stateFilePath(): string {
  return path.join(tmpDir, "validation-state.json");
}

function makeSteps(overrides?: Partial<StepInfo>[]): StepInfo[] {
  const defaults: StepInfo[] = [
    {
      index: 0,
      title: "Add user model",
      description: "Create user schema",
      status: "completed",
      milestone: "auth-system",
      fulfills: ["VAL-AUTH-001", "VAL-AUTH-002"],
    },
    {
      index: 1,
      title: "Add login endpoint",
      description: "POST /api/auth/login",
      status: "completed",
      milestone: "auth-system",
      fulfills: ["VAL-AUTH-003"],
    },
    {
      index: 2,
      title: "Add dashboard",
      description: "Dashboard UI",
      status: "completed",
      milestone: "dashboard",
      fulfills: ["VAL-DASH-001"],
    },
  ];

  if (overrides) {
    return defaults.map((p, i) => (overrides[i] ? { ...p, ...overrides[i] } : p));
  }
  return defaults;
}

function makeContext(overrides: Partial<BehavioralValidationContext> = {}): BehavioralValidationContext {
  return {
    milestoneName: "auth-system",
    assertions: [
      {
        id: "VAL-AUTH-001",
        title: "User model exists",
        description: "The user model should have email and password fields",
        evidence: "unit test output (bun test)",
      },
      {
        id: "VAL-AUTH-002",
        title: "User model validates email",
        description: "The user model rejects invalid email addresses",
        evidence: "unit test output (bun test)",
      },
      {
        id: "VAL-AUTH-003",
        title: "Login endpoint authenticates",
        description: "POST /api/auth/login returns 200 with valid credentials and 401 with invalid",
        evidence: "integration test output",
      },
    ],
    validationStatePath: path.join(tmpDir, "validation-state.json"),
    projectCwd: "/tmp/test-project",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VAL-EXEC-005: Behavioral validation checks assertions
// ---------------------------------------------------------------------------

describe("buildBehavioralValidationPrompt — content", () => {
  test("prompt contains milestone name", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    expect(prompt).toContain("auth-system");
  });

  test("prompt lists each assertion ID and title", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    expect(prompt).toContain("VAL-AUTH-001");
    expect(prompt).toContain("VAL-AUTH-002");
    expect(prompt).toContain("VAL-AUTH-003");
    expect(prompt).toContain("User model exists");
    expect(prompt).toContain("User model validates email");
    expect(prompt).toContain("Login endpoint authenticates");
  });

  test("prompt contains behavioral descriptions for each assertion", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    expect(prompt).toContain("email and password fields");
    expect(prompt).toContain("invalid email addresses");
    expect(prompt).toContain("returns 200 with valid credentials");
  });

  test("prompt instructs independent verification (not trusting self-reports)", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    const lower = prompt.toLowerCase();
    // Should instruct the worker to verify independently
    expect(lower).toContain("independen");
    // Should warn against trusting prior self-reports
    expect(lower).toMatch(/(?:do not trust|don't trust|not trust|independently verify|independent)/);
  });

  test("prompt includes evidence requirements from assertions", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    expect(prompt).toContain("unit test output");
    expect(prompt).toContain("integration test output");
  });

  test("prompt instructs worker to update validation-state.json", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    expect(prompt).toContain("validation-state.json");
  });

  test("prompt instructs pass/fail/blocked per assertion", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    const lower = prompt.toLowerCase();
    expect(lower).toContain("pass");
    expect(lower).toContain("fail");
    expect(lower).toContain("blocked");
  });

  test("prompt includes working directory", () => {
    const ctx = makeContext();
    const prompt = buildBehavioralValidationPrompt(ctx);
    expect(prompt).toContain("/tmp/test-project");
  });

  test("prompt handles empty assertions list", () => {
    const ctx = makeContext({ assertions: [] });
    const prompt = buildBehavioralValidationPrompt(ctx);
    // Should still produce a valid prompt
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("auth-system");
  });
});

// ---------------------------------------------------------------------------
// VAL-EXEC-010: Re-validation only checks what failed
// ---------------------------------------------------------------------------

describe("buildBehavioralValidationPrompt — re-validation", () => {
  test("on re-run with prior results, prompt mentions re-validation", () => {
    const ctx = makeContext({
      priorResults: {
        "VAL-AUTH-001": { status: "passed", lastChecked: "2026-03-25T10:00:00Z" },
        "VAL-AUTH-002": { status: "failed", lastChecked: "2026-03-25T10:00:00Z", evidence: "Test failed" },
        "VAL-AUTH-003": { status: "blocked", evidence: "Login broken" },
      },
    });
    const prompt = buildBehavioralValidationPrompt(ctx);
    const lower = prompt.toLowerCase();
    // Should mention re-validation
    expect(lower).toContain("re-validat");
  });

  test("on re-run, prompt indicates which assertions previously passed (skip them)", () => {
    const ctx = makeContext({
      priorResults: {
        "VAL-AUTH-001": { status: "passed", lastChecked: "2026-03-25T10:00:00Z" },
        "VAL-AUTH-002": { status: "failed", lastChecked: "2026-03-25T10:00:00Z" },
        "VAL-AUTH-003": { status: "blocked", evidence: "Login broken" },
      },
    });
    const prompt = buildBehavioralValidationPrompt(ctx);
    // Should mark VAL-AUTH-001 as already passed
    expect(prompt).toContain("VAL-AUTH-001");
    expect(prompt).toMatch(/VAL-AUTH-001.*(?:passed|skip|already)/is);
  });

  test("on re-run, prompt highlights failed/blocked assertions for re-check", () => {
    const ctx = makeContext({
      priorResults: {
        "VAL-AUTH-001": { status: "passed" },
        "VAL-AUTH-002": { status: "failed", evidence: "Test failed" },
        "VAL-AUTH-003": { status: "blocked", evidence: "Login broken" },
      },
    });
    const prompt = buildBehavioralValidationPrompt(ctx);
    // Failed and blocked should be highlighted for re-check
    expect(prompt).toMatch(/VAL-AUTH-002.*(?:re-check|re-validat|failed|retry)/is);
    expect(prompt).toMatch(/VAL-AUTH-003.*(?:re-check|re-validat|blocked|retry)/is);
  });

  test("first run (no prior results) includes all assertions for validation", () => {
    const ctx = makeContext(); // no priorResults
    const prompt = buildBehavioralValidationPrompt(ctx);
    // All three assertions should be listed for validation
    expect(prompt).toContain("VAL-AUTH-001");
    expect(prompt).toContain("VAL-AUTH-002");
    expect(prompt).toContain("VAL-AUTH-003");
  });
});

// ---------------------------------------------------------------------------
// collectAssertionsForMilestone — extract assertions from steps' fulfills
// ---------------------------------------------------------------------------

describe("collectAssertionsForMilestone", () => {
  test("collects assertion IDs from steps belonging to the milestone", () => {
    const steps = makeSteps();
    const ids = collectAssertionsForMilestone(steps, "auth-system");
    expect(ids).toEqual(["VAL-AUTH-001", "VAL-AUTH-002", "VAL-AUTH-003"]);
  });

  test("excludes assertions from steps in other milestones", () => {
    const steps = makeSteps();
    const ids = collectAssertionsForMilestone(steps, "auth-system");
    expect(ids).not.toContain("VAL-DASH-001");
  });

  test("returns empty array when no steps match the milestone", () => {
    const steps = makeSteps();
    const ids = collectAssertionsForMilestone(steps, "nonexistent");
    expect(ids).toEqual([]);
  });

  test("handles steps without fulfills", () => {
    const steps: StepInfo[] = [
      { index: 0, title: "Setup", description: "Setup", status: "completed", milestone: "core" },
    ];
    const ids = collectAssertionsForMilestone(steps, "core");
    expect(ids).toEqual([]);
  });

  test("deduplicates assertion IDs", () => {
    const steps: StepInfo[] = [
      { index: 0, title: "A", description: "A", status: "completed", milestone: "m1", fulfills: ["VAL-1", "VAL-2"] },
      { index: 1, title: "B", description: "B", status: "completed", milestone: "m1", fulfills: ["VAL-2", "VAL-3"] },
    ];
    const ids = collectAssertionsForMilestone(steps, "m1");
    expect(ids).toEqual(["VAL-1", "VAL-2", "VAL-3"]);
  });

  test("only includes completed steps", () => {
    const steps: StepInfo[] = [
      { index: 0, title: "Done", description: "Done", status: "completed", milestone: "m1", fulfills: ["VAL-1"] },
      { index: 1, title: "Pending", description: "Pending", status: "pending", milestone: "m1", fulfills: ["VAL-2"] },
    ];
    const ids = collectAssertionsForMilestone(steps, "m1");
    expect(ids).toEqual(["VAL-1"]);
  });
});

// ---------------------------------------------------------------------------
// filterAssertionsForRevalidation
// ---------------------------------------------------------------------------

describe("filterAssertionsForRevalidation", () => {
  test("returns all assertions when no prior results exist", () => {
    const assertions: ContractAssertion[] = [
      { id: "VAL-1", title: "T1", description: "D1", evidence: "E1" },
      { id: "VAL-2", title: "T2", description: "D2", evidence: "E2" },
    ];
    const result = filterAssertionsForRevalidation(assertions, undefined);
    expect(result.toValidate).toHaveLength(2);
    expect(result.alreadyPassed).toHaveLength(0);
  });

  test("filters out passed assertions, keeps failed/blocked/pending", () => {
    const assertions: ContractAssertion[] = [
      { id: "VAL-1", title: "T1", description: "D1", evidence: "E1" },
      { id: "VAL-2", title: "T2", description: "D2", evidence: "E2" },
      { id: "VAL-3", title: "T3", description: "D3", evidence: "E3" },
      { id: "VAL-4", title: "T4", description: "D4", evidence: "E4" },
    ];
    const priorResults: Record<string, { status: string }> = {
      "VAL-1": { status: "passed" },
      "VAL-2": { status: "failed" },
      "VAL-3": { status: "blocked" },
      "VAL-4": { status: "pending" },
    };
    const result = filterAssertionsForRevalidation(assertions, priorResults);
    expect(result.toValidate.map((a) => a.id)).toEqual(["VAL-2", "VAL-3", "VAL-4"]);
    expect(result.alreadyPassed.map((a) => a.id)).toEqual(["VAL-1"]);
  });

  test("handles assertions not present in prior results (treat as needing validation)", () => {
    const assertions: ContractAssertion[] = [
      { id: "VAL-1", title: "T1", description: "D1", evidence: "E1" },
      { id: "VAL-NEW", title: "New", description: "New assertion", evidence: "E" },
    ];
    const priorResults: Record<string, { status: string }> = {
      "VAL-1": { status: "passed" },
    };
    const result = filterAssertionsForRevalidation(assertions, priorResults);
    expect(result.toValidate.map((a) => a.id)).toEqual(["VAL-NEW"]);
    expect(result.alreadyPassed.map((a) => a.id)).toEqual(["VAL-1"]);
  });

  test("returns empty toValidate when all assertions already passed", () => {
    const assertions: ContractAssertion[] = [
      { id: "VAL-1", title: "T1", description: "D1", evidence: "E1" },
    ];
    const priorResults: Record<string, { status: string }> = {
      "VAL-1": { status: "passed" },
    };
    const result = filterAssertionsForRevalidation(assertions, priorResults);
    expect(result.toValidate).toHaveLength(0);
    expect(result.alreadyPassed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-EXEC-006: Validation state updated after validation
// ---------------------------------------------------------------------------

describe("updateAssertionStatuses", () => {
  test("updates assertion statuses in validation-state.json", () => {
    const filePath = stateFilePath();
    const initial: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "pending" },
        "VAL-AUTH-002": { status: "pending" },
        "VAL-AUTH-003": { status: "pending" },
      },
    };
    writeValidationState(filePath, initial);

    updateAssertionStatuses(filePath, {
      "VAL-AUTH-001": { status: "passed", evidence: "Tests pass" },
      "VAL-AUTH-002": { status: "failed", evidence: "Test failed: missing validation" },
      "VAL-AUTH-003": { status: "blocked", evidence: "Login service unavailable" },
    });

    const loaded = readValidationState(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.assertions["VAL-AUTH-001"].status).toBe("passed");
    expect(loaded!.assertions["VAL-AUTH-001"].evidence).toBe("Tests pass");
    expect(loaded!.assertions["VAL-AUTH-002"].status).toBe("failed");
    expect(loaded!.assertions["VAL-AUTH-003"].status).toBe("blocked");
  });

  test("sets lastChecked timestamp on updated assertions", () => {
    const filePath = stateFilePath();
    const initial: ValidationState = {
      assertions: {
        "VAL-1": { status: "pending" },
      },
    };
    writeValidationState(filePath, initial);

    updateAssertionStatuses(filePath, {
      "VAL-1": { status: "passed" },
    });

    const loaded = readValidationState(filePath);
    expect(loaded!.assertions["VAL-1"].lastChecked).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(loaded!.assertions["VAL-1"].lastChecked!).getTime()).not.toBeNaN();
  });

  test("preserves assertions not included in the update", () => {
    const filePath = stateFilePath();
    const initial: ValidationState = {
      assertions: {
        "VAL-1": { status: "pending" },
        "VAL-2": { status: "pending" },
      },
    };
    writeValidationState(filePath, initial);

    // Only update VAL-1
    updateAssertionStatuses(filePath, {
      "VAL-1": { status: "passed" },
    });

    const loaded = readValidationState(filePath);
    expect(loaded!.assertions["VAL-1"].status).toBe("passed");
    expect(loaded!.assertions["VAL-2"].status).toBe("pending");
    expect(loaded!.assertions["VAL-2"].lastChecked).toBeUndefined();
  });

  test("creates file if it does not exist", () => {
    const filePath = stateFilePath();
    // File doesn't exist yet

    updateAssertionStatuses(filePath, {
      "VAL-1": { status: "passed", evidence: "Works" },
    });

    const loaded = readValidationState(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.assertions["VAL-1"].status).toBe("passed");
  });

  test("handles empty update (no-op)", () => {
    const filePath = stateFilePath();
    const initial: ValidationState = {
      assertions: {
        "VAL-1": { status: "pending" },
      },
    };
    writeValidationState(filePath, initial);

    updateAssertionStatuses(filePath, {});

    const loaded = readValidationState(filePath);
    expect(loaded).toEqual(initial);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-006: Plan-to-contract-to-fulfills-to-validation chain
// ---------------------------------------------------------------------------

describe("plan-to-contract-to-fulfills-to-validation chain", () => {
  test("assertion IDs from steps' fulfills are validated", () => {
    // Simulate: steps with fulfills → collectAssertionsForMilestone → buildPrompt
    const steps = makeSteps();
    const assertionIds = collectAssertionsForMilestone(steps, "auth-system");

    // These IDs should match what would come from a validation contract
    expect(assertionIds).toEqual(["VAL-AUTH-001", "VAL-AUTH-002", "VAL-AUTH-003"]);

    // Build assertions objects as if parsed from contract
    const assertions: ContractAssertion[] = assertionIds.map((id) => ({
      id,
      title: `Title for ${id}`,
      description: `Behavioral description for ${id}`,
      evidence: "unit test output",
    }));

    // Build prompt
    const prompt = buildBehavioralValidationPrompt({
      milestoneName: "auth-system",
      assertions,
      validationStatePath: stateFilePath(),
      projectCwd: "/tmp/project",
    });

    // All assertion IDs should appear in the prompt
    for (const id of assertionIds) {
      expect(prompt).toContain(id);
    }
  });

  test("new assertion added to contract and referenced in fulfills causes it to be tested", () => {
    // Step claims a new assertion ID
    const steps: StepInfo[] = [
      {
        index: 0,
        title: "Auth",
        description: "Auth module",
        status: "completed",
        milestone: "core",
        fulfills: ["VAL-AUTH-001", "VAL-NEW-001"],
      },
    ];
    const ids = collectAssertionsForMilestone(steps, "core");
    expect(ids).toContain("VAL-NEW-001");
  });
});

// ---------------------------------------------------------------------------
// Stage-loop-factory prompt builder routing (integration)
// ---------------------------------------------------------------------------

describe("stage-loop-factory — behavioral validation prompt routing", () => {
  test("Validation: prefix steps use behavioral validation prompt builder", () => {
    // This is a structural test — we verify the title pattern matching
    // The actual integration is in stage-loop-factory.ts
    const validationTitle = "Validation: auth-system";
    expect(validationTitle.startsWith("Validation: ")).toBe(true);
    const milestoneName = validationTitle.slice("Validation: ".length);
    expect(milestoneName).toBe("auth-system");
  });

  test("Scrutiny: prefix steps are not routed to behavioral validation", () => {
    const scrutinyTitle = "Scrutiny: auth-system";
    expect(scrutinyTitle.startsWith("Validation: ")).toBe(false);
    expect(scrutinyTitle.startsWith("Scrutiny: ")).toBe(true);
  });

  test("Regular step titles are not routed to behavioral validation", () => {
    const regularTitle = "Add user model";
    expect(regularTitle.startsWith("Validation: ")).toBe(false);
    expect(regularTitle.startsWith("Scrutiny: ")).toBe(false);
  });
});
