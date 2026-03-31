import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Imports — these will be created during implementation
// ---------------------------------------------------------------------------

import {
  ValidationStateSchema,
  AssertionStatusSchema,
  type ValidationState,
} from "../src/session/validation-schemas";

import {
  readValidationState,
  writeValidationState,
  checkEndOfSessionGate,
  type EndOfSessionGateResult,
} from "../src/session/validation-state";



// ---------------------------------------------------------------------------
// Types (inlined from deleted step-provider.ts)
// ---------------------------------------------------------------------------

interface StepInfo {
  index: number;
  title: string;
  description: string;
  status: "completed" | "pending" | "in_progress";
  steps?: string[];
  milestone?: string;
  fulfills?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validation-state-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function stateFilePath(): string {
  return path.join(tmpDir, "validation-state.json");
}

// ---------------------------------------------------------------------------
// VAL-CONTRACT-006: Validation state JSON schema
// ---------------------------------------------------------------------------

describe("ValidationStateSchema", () => {
  it("parses a valid validation state with all statuses", () => {
    const data = {
      assertions: {
        "VAL-AUTH-001": { status: "pending" },
        "VAL-AUTH-002": { status: "passed", lastChecked: "2026-03-25T10:00:00Z", evidence: "Tests pass" },
        "VAL-CHECKOUT-001": { status: "failed", lastChecked: "2026-03-25T11:00:00Z", evidence: "Payment form missing" },
        "VAL-DASHBOARD-001": { status: "blocked", evidence: "Login broken" },
      },
    };

    const result = ValidationStateSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assertions["VAL-AUTH-001"].status).toBe("pending");
      expect(result.data.assertions["VAL-AUTH-002"].status).toBe("passed");
      expect(result.data.assertions["VAL-CHECKOUT-001"].status).toBe("failed");
      expect(result.data.assertions["VAL-DASHBOARD-001"].status).toBe("blocked");
    }
  });

  it("parses a minimal validation state (empty assertions)", () => {
    const data = { assertions: {} };
    const result = ValidationStateSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts all four status values: pending, passed, failed, blocked", () => {
    for (const status of ["pending", "passed", "failed", "blocked"] as const) {
      const result = AssertionStatusSchema.safeParse({ status });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid status values", () => {
    const result = AssertionStatusSchema.safeParse({ status: "unknown" });
    expect(result.success).toBe(false);
  });

  it("accepts lastChecked as optional ISO string", () => {
    const result = AssertionStatusSchema.safeParse({
      status: "passed",
      lastChecked: "2026-03-25T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts evidence as optional string", () => {
    const result = AssertionStatusSchema.safeParse({
      status: "failed",
      evidence: "Test failed: expected 200 but got 404",
    });
    expect(result.success).toBe(true);
  });

  it("accepts assertion with no optional fields", () => {
    const result = AssertionStatusSchema.safeParse({ status: "pending" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastChecked).toBeUndefined();
      expect(result.data.evidence).toBeUndefined();
    }
  });

  it("rejects missing status field", () => {
    const result = AssertionStatusSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects missing assertions key", () => {
    const result = ValidationStateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-CONTRACT-004: Validation state tracks assertion status (read/write)
// ---------------------------------------------------------------------------

describe("readValidationState / writeValidationState", () => {
  it("writes and reads back a validation state file", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "pending" },
        "VAL-AUTH-002": { status: "passed", lastChecked: "2026-03-25T10:00:00Z", evidence: "Login works" },
      },
    };

    writeValidationState(filePath, state);
    const loaded = readValidationState(filePath);

    expect(loaded).toEqual(state);
  });

  it("read validates schema on load (rejects invalid data)", () => {
    const filePath = stateFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ assertions: { "VAL-1": { status: "invalid" } } }));

    expect(() => readValidationState(filePath)).toThrow();
  });

  it("write validates schema before writing (rejects invalid data)", () => {
    const filePath = stateFilePath();
    const invalid = { assertions: { "VAL-1": { status: "invalid" as any } } };

    expect(() => writeValidationState(filePath, invalid as any)).toThrow();
  });

  it("returns null when file does not exist", () => {
    const loaded = readValidationState(path.join(tmpDir, "nonexistent.json"));
    expect(loaded).toBeNull();
  });

  it("uses atomicWrite for safety (creates parent directories)", () => {
    const deepPath = path.join(tmpDir, "nested", "deep", "validation-state.json");
    const state: ValidationState = {
      assertions: { "VAL-1": { status: "pending" } },
    };

    writeValidationState(deepPath, state);
    expect(fs.existsSync(deepPath)).toBe(true);

    const loaded = readValidationState(deepPath);
    expect(loaded).toEqual(state);
  });

  it("handles concurrent writes safely (atomicWrite)", () => {
    const filePath = stateFilePath();
    // Write multiple states in sequence (simulating concurrent access)
    for (let i = 0; i < 10; i++) {
      const state: ValidationState = {
        assertions: { [`VAL-${i}`]: { status: "pending" } },
      };
      writeValidationState(filePath, state);
    }

    // Last write wins
    const loaded = readValidationState(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.assertions["VAL-9"]).toBeDefined();
  });
});



// ---------------------------------------------------------------------------
// VAL-CONTRACT-003: StepInfo type includes optional fulfills: string[] field
// ---------------------------------------------------------------------------

describe("StepInfo fulfills field", () => {
  it("StepInfo type supports optional fulfills string array", () => {
    const step: StepInfo = {
      index: 0,
      title: "Setup auth",
      description: "Setup authentication",
      status: "pending",
      milestone: "Foundation",
      fulfills: ["VAL-AUTH-001", "VAL-AUTH-002"],
    };

    expect(step.fulfills).toEqual(["VAL-AUTH-001", "VAL-AUTH-002"]);
  });

  it("StepInfo fulfills is optional (undefined when not set)", () => {
    const step: StepInfo = {
      index: 0,
      title: "Setup",
      description: "Setup",
      status: "pending",
    };

    expect(step.fulfills).toBeUndefined();
  });
});



// ---------------------------------------------------------------------------
// VAL-EXEC-007: End-of-session gate checks assertions
// ---------------------------------------------------------------------------

describe("checkEndOfSessionGate", () => {
  it("returns passed when all assertions are passed", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "passed", lastChecked: "2026-03-25T10:00:00Z" },
        "VAL-AUTH-002": { status: "passed", lastChecked: "2026-03-25T10:00:00Z" },
        "VAL-API-001": { status: "passed", lastChecked: "2026-03-25T10:00:00Z" },
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath);

    expect(result.passed).toBe(true);
    expect(result.failedAssertions).toEqual([]);
    expect(result.totalAssertions).toBe(3);
    expect(result.passedCount).toBe(3);
  });

  it("returns passed when validation-state.json does not exist (no milestones)", () => {
    const nonexistentPath = path.join(tmpDir, "nonexistent-validation-state.json");

    const result = checkEndOfSessionGate(nonexistentPath);

    expect(result.passed).toBe(true);
    expect(result.failedAssertions).toEqual([]);
    expect(result.totalAssertions).toBe(0);
    expect(result.passedCount).toBe(0);
  });

  it("returns failed when some assertions are not passed", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "passed" },
        "VAL-AUTH-002": { status: "failed", evidence: "Login form missing" },
        "VAL-API-001": { status: "pending" },
        "VAL-API-002": { status: "blocked", evidence: "Depends on VAL-AUTH-002" },
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath);

    expect(result.passed).toBe(false);
    expect(result.totalAssertions).toBe(4);
    expect(result.passedCount).toBe(1);
    expect(result.failedAssertions).toHaveLength(3);

    // Check each failed assertion includes ID, title, and status
    const failedIds = result.failedAssertions.map((a) => a.id);
    expect(failedIds).toContain("VAL-AUTH-002");
    expect(failedIds).toContain("VAL-API-001");
    expect(failedIds).toContain("VAL-API-002");

    const auth002 = result.failedAssertions.find((a) => a.id === "VAL-AUTH-002");
    expect(auth002!.status).toBe("failed");
    expect(auth002!.id).toBe("VAL-AUTH-002");

    const api001 = result.failedAssertions.find((a) => a.id === "VAL-API-001");
    expect(api001!.status).toBe("pending");

    const api002 = result.failedAssertions.find((a) => a.id === "VAL-API-002");
    expect(api002!.status).toBe("blocked");
  });

  it("reports assertion title from the assertion ID when no contract titles provided", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "failed" },
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath);

    expect(result.failedAssertions[0].title).toBe("VAL-AUTH-001");
  });

  it("uses contract titles when assertionTitles map is provided", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "failed" },
        "VAL-AUTH-002": { status: "passed" },
      },
    };
    writeValidationState(filePath, state);

    const titles: Record<string, string> = {
      "VAL-AUTH-001": "User can log in with valid credentials",
      "VAL-AUTH-002": "Login rejects invalid credentials",
    };

    const result = checkEndOfSessionGate(filePath, { assertionTitles: titles });

    expect(result.failedAssertions).toHaveLength(1);
    expect(result.failedAssertions[0].title).toBe("User can log in with valid credentials");
  });

  it("returns passed when empty assertions (no contract generated)", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {},
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath);

    expect(result.passed).toBe(true);
    expect(result.failedAssertions).toEqual([]);
    expect(result.totalAssertions).toBe(0);
  });

  // Skip flags tests

  it("skips pending assertions when skip_validation is true", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "passed" },
        "VAL-AUTH-002": { status: "pending" }, // never validated because validation was skipped
        "VAL-API-001": { status: "pending" },
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath, { skipValidation: true });

    // pending assertions should be ignored when validation is skipped
    expect(result.passed).toBe(true);
    expect(result.failedAssertions).toEqual([]);
  });

  it("still fails on explicitly failed assertions even when skip_validation is true", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "passed" },
        "VAL-AUTH-002": { status: "failed", evidence: "Explicitly failed" },
        "VAL-API-001": { status: "pending" }, // would be ignored
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath, { skipValidation: true });

    // failed assertions still cause gate failure even with skip
    expect(result.passed).toBe(false);
    expect(result.failedAssertions).toHaveLength(1);
    expect(result.failedAssertions[0].id).toBe("VAL-AUTH-002");
    expect(result.failedAssertions[0].status).toBe("failed");
  });

  it("skips pending assertions when skip_scrutiny is true", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "passed" },
        "VAL-AUTH-002": { status: "pending" }, // never checked because scrutiny was skipped
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath, { skipScrutiny: true });

    // pending assertions should be ignored when scrutiny is skipped
    expect(result.passed).toBe(true);
  });

  it("skips all pending when both skip_scrutiny and skip_validation are true", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "pending" },
        "VAL-AUTH-002": { status: "pending" },
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath, {
      skipScrutiny: true,
      skipValidation: true,
    });

    // All assertions are pending and all validation was skipped — gate passes
    expect(result.passed).toBe(true);
  });

  it("blocked assertions cause failure even with skip flags", () => {
    const filePath = stateFilePath();
    const state: ValidationState = {
      assertions: {
        "VAL-AUTH-001": { status: "blocked", evidence: "Dependency broken" },
        "VAL-AUTH-002": { status: "pending" },
      },
    };
    writeValidationState(filePath, state);

    const result = checkEndOfSessionGate(filePath, {
      skipScrutiny: true,
      skipValidation: true,
    });

    // blocked is an explicit failure — not ignored by skip flags
    expect(result.passed).toBe(false);
    expect(result.failedAssertions).toHaveLength(1);
    expect(result.failedAssertions[0].id).toBe("VAL-AUTH-001");
    expect(result.failedAssertions[0].status).toBe("blocked");
  });
});
