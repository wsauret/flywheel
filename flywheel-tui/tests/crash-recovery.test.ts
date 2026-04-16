/**
 * Tests for crash-after-success recovery.
 *
 * When a subprocess exits with a non-zero code BUT the CompletionDetector
 * has already seen a success event, the crash is incidental — the worker
 * finished its work. categorizeFailure should return undefined (success).
 */

import { describe, it, expect } from "bun:test";
import { categorizeFailure } from "../src/orchestration/engines/providers/claude/subprocess/errors.js";

// ---------------------------------------------------------------------------
// Helper — default opts for categorizeFailure
// ---------------------------------------------------------------------------

function baseOpts(overrides: Partial<Parameters<typeof categorizeFailure>[0]> = {}) {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    timeoutMs: 30_000,
    completionDetected: false,
    interrupted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Crash-after-success recovery
// ---------------------------------------------------------------------------

describe("crash-after-success recovery", () => {
  it("returns undefined (success) when completionDetected + non-zero exit", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 1, completionDetected: true }),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for signal exit codes when completionDetected", () => {
    // Exit code 130 = SIGINT (128 + 2), common crash-after-success scenario
    const result = categorizeFailure(
      baseOpts({ exitCode: 130, completionDetected: true }),
    );
    expect(result).toBeUndefined();
  });

  it("still returns exit_code failure when completionDetected is false", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 1, completionDetected: false }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("exit_code");
  });

  it("still returns interrupted when interrupted + completionDetected", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 1, completionDetected: true, interrupted: true }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("interrupted");
  });

  it("still returns timeout when timedOut + completionDetected", () => {
    const result = categorizeFailure(
      baseOpts({
        exitCode: 1,
        completionDetected: true,
        timedOut: true,
        timeoutMs: 5000,
      }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("timeout");
  });

  it("returns undefined for clean exit (code 0) regardless of completionDetected", () => {
    const withCompletion = categorizeFailure(
      baseOpts({ exitCode: 0, completionDetected: true }),
    );
    const withoutCompletion = categorizeFailure(
      baseOpts({ exitCode: 0, completionDetected: false }),
    );
    expect(withCompletion).toBeUndefined();
    expect(withoutCompletion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Normal failure classification still works
// ---------------------------------------------------------------------------

describe("normal failure classification unaffected", () => {
  it("classifies non-zero exit without completion as exit_code", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 1 }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("exit_code");
  });

  it("classifies rate-limited stderr", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 1, stderr: "Error: rate limit exceeded" }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("rate_limited");
  });

  it("classifies transient errors", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 1, stderr: "ECONNRESET" }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("transient");
  });

  it("classifies interrupted", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 1, interrupted: true }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("interrupted");
  });

  it("classifies timeout", () => {
    const result = categorizeFailure(
      baseOpts({ exitCode: 0, timedOut: true, timeoutMs: 5000 }),
    );
    expect(result).toBeDefined();
    expect(result!.kind).toBe("timeout");
  });
});
