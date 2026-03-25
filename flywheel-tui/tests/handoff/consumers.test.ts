import { describe, it, expect } from "bun:test";
import { buildLastWorkerResult, buildPreviousResultFromHandoff } from "../../src/handoff/consumers";
import type { WorkerHandoff } from "../../src/schemas/handoff";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function minimalHandoff(overrides?: Partial<WorkerHandoff>): WorkerHandoff {
  return {
    summary: "Implemented the initial project structure with configuration files and directory layout.",
    ...overrides,
  } as WorkerHandoff;
}

function fullHandoff(overrides?: Partial<WorkerHandoff>): WorkerHandoff {
  return {
    summary: "Implemented authentication module with JWT tokens, rate limiting, and session management. All tests pass.",
    artifacts: {
      files_created: ["src/auth/jwt.ts", "src/auth/session.ts"],
      files_modified: ["src/index.ts", "src/config.ts"],
      commands_run: ["bun test", "bun run build"],
    },
    decisions: [
      "Used RS256 for JWT signing instead of HS256 for better security",
      "Added rate limiting middleware at the router level",
    ],
    warnings: [
      "JWT secret should be rotated in production",
    ],
    verification: {
      tests_passed: true,
      test_output_summary: "42 tests passed, 0 failed",
    },
    files_to_review: ["src/auth/jwt.ts"],
    ...overrides,
  } as WorkerHandoff;
}

// ---------------------------------------------------------------------------
// buildLastWorkerResult
// ---------------------------------------------------------------------------

describe("buildLastWorkerResult", () => {
  it("maps summary to output_summary", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.output_summary).toBe(handoff.summary);
  });

  it("combines files_created + files_modified into artifacts_produced", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 1, 45000);

    expect(result.artifacts_produced).toEqual([
      "src/auth/jwt.ts",
      "src/auth/session.ts",
      "src/index.ts",
      "src/config.ts",
    ]);
  });

  it("returns empty artifacts_produced when no artifacts", () => {
    const handoff = minimalHandoff(); // no artifacts field
    const result = buildLastWorkerResult(handoff, 0, 10000);

    expect(result.artifacts_produced).toEqual([]);
  });

  it("maps verification.tests_passed", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.tests_passed).toBe(true);
  });

  it("returns tests_passed=null when verification is missing", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.tests_passed).toBeNull();
  });

  it("returns tests_passed=null when tests_passed is null in verification", () => {
    const handoff = minimalHandoff({
      verification: { tests_passed: null },
    });
    const result = buildLastWorkerResult(handoff, 0, 30000);

    expect(result.tests_passed).toBeNull();
  });

  it("sets step from phaseIndex", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 3, 10000);

    expect(result.step).toBe(3);
  });

  it("sets status to 'completed'", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 0, 10000);

    expect(result.status).toBe("completed");
  });

  it("converts durationMs to duration_seconds", () => {
    const handoff = minimalHandoff();
    const result = buildLastWorkerResult(handoff, 0, 45500);

    expect(result.duration_seconds).toBe(45.5);
  });

  it("produces a valid LastWorkerResult shape", () => {
    const handoff = fullHandoff();
    const result = buildLastWorkerResult(handoff, 2, 120000);

    expect(result).toEqual({
      step: 2,
      status: "completed",
      output_summary: handoff.summary,
      artifacts_produced: [
        "src/auth/jwt.ts",
        "src/auth/session.ts",
        "src/index.ts",
        "src/config.ts",
      ],
      tests_passed: true,
      duration_seconds: 120,
      decisions: [
        "Used RS256 for JWT signing instead of HS256 for better security",
        "Added rate limiting middleware at the router level",
      ],
      warnings: [
        "JWT secret should be rotated in production",
      ],
      commands_run: ["bun test", "bun run build"],
      files_to_review: ["src/auth/jwt.ts"],
    });
  });
});

// ---------------------------------------------------------------------------
// buildPreviousResultFromHandoff
// ---------------------------------------------------------------------------

describe("buildPreviousResultFromHandoff", () => {
  it("always includes summary section", () => {
    const handoff = minimalHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).toContain("## Previous Phase Summary");
    expect(result).toContain(handoff.summary);
  });

  it("includes decisions when present", () => {
    const handoff = fullHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).toContain("### Decisions");
    expect(result).toContain("- Used RS256 for JWT signing");
    expect(result).toContain("- Added rate limiting middleware");
  });

  it("omits decisions section when not present", () => {
    const handoff = minimalHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).not.toContain("### Decisions");
  });

  it("includes artifacts when present", () => {
    const handoff = fullHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).toContain("### Artifacts");
    expect(result).toContain("Files created: src/auth/jwt.ts, src/auth/session.ts");
    expect(result).toContain("Files modified: src/index.ts, src/config.ts");
    expect(result).toContain("Commands run: bun test, bun run build");
  });

  it("omits artifacts section when not present", () => {
    const handoff = minimalHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).not.toContain("### Artifacts");
  });

  it("omits artifacts section when all arrays are empty", () => {
    const handoff = minimalHandoff({
      artifacts: { files_created: [], files_modified: [], commands_run: [] },
    });
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).not.toContain("### Artifacts");
  });

  it("includes verification when present", () => {
    const handoff = fullHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).toContain("### Verification");
    expect(result).toContain("Tests passed: yes");
    expect(result).toContain("42 tests passed, 0 failed");
  });

  it("shows 'Tests passed: no' for failed tests", () => {
    const handoff = minimalHandoff({
      verification: { tests_passed: false, test_output_summary: "3 tests failed" },
    });
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).toContain("Tests passed: no");
    expect(result).toContain("3 tests failed");
  });

  it("includes warnings when present", () => {
    const handoff = fullHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).toContain("### Warnings");
    expect(result).toContain("- JWT secret should be rotated");
  });

  it("omits warnings section when not present", () => {
    const handoff = minimalHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    expect(result).not.toContain("### Warnings");
  });

  it("produces compact output for minimal handoff", () => {
    const handoff = minimalHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    // Should only have the summary section
    const lines = result.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2); // header + summary
  });

  it("produces comprehensive output for full handoff", () => {
    const handoff = fullHandoff();
    const result = buildPreviousResultFromHandoff(handoff);

    // Should have all sections
    expect(result).toContain("## Previous Phase Summary");
    expect(result).toContain("### Decisions");
    expect(result).toContain("### Artifacts");
    expect(result).toContain("### Verification");
    expect(result).toContain("### Warnings");
  });
});
