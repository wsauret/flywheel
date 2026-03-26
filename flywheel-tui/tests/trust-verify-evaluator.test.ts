// ---------------------------------------------------------------------------
// Trust-but-Verify Evaluator — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for the trust-but-verify evaluator that:
//   - Re-runs worker's claimed test commands (VAL-EVAL-001)
//   - Checks file existence for claimed files (VAL-EVAL-002)
//   - Confirms reported counts match reality (VAL-EVAL-003)
//   - Judges pass/fail/revise-with-feedback (VAL-EVAL-004)
//   - Degrades gracefully on transport error (VAL-EVAL-005)
//   - Receives evaluation criteria and handoff (VAL-EVAL-006)
//   - Returns structured verification results alongside verdict (VAL-EVAL-007)
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createTrustVerifyEvaluator,
  type TrustVerifyEvaluatorOptions,
  type TrustVerifyHandoff,
  type TrustVerifyAssessment,
  type CommandRunResult,
  type FileCheckResult,
  type CountComparisonResult,
  type CommandRunner,
  type FileChecker,
} from "../src/evaluator/trust-verify";
import { createTrustVerifyEvaluatorFn } from "../src/evaluator/create-trust-verify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-verify-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeHandoff(overrides: Partial<TrustVerifyHandoff> = {}): TrustVerifyHandoff {
  return {
    commandsRun: [],
    filesCreated: [],
    filesModified: [],
    testsAdded: 0,
    filesChangedCount: 0,
    ...overrides,
  };
}

function makeEvalCriteria(overrides: Partial<{ acceptance_criteria: string[]; required_tests: boolean }> = {}) {
  return {
    acceptance_criteria: [],
    required_tests: false,
    custom_checks: [] as string[],
    required_outputs: [] as string[],
    ...overrides,
  };
}

/** Command runner that succeeds for all commands */
function successRunner(): CommandRunner {
  return async (cmd: string) => ({
    command: cmd,
    exitCode: 0,
    stdout: "All tests passed",
    stderr: "",
    timedOut: false,
  });
}

/** Command runner that fails for all commands */
function failingRunner(exitCode = 1): CommandRunner {
  return async (cmd: string) => ({
    command: cmd,
    exitCode,
    stdout: "",
    stderr: "Tests failed",
    timedOut: false,
  });
}

/** Command runner that times out */
function timeoutRunner(): CommandRunner {
  return async (cmd: string) => ({
    command: cmd,
    exitCode: -1,
    stdout: "",
    stderr: "",
    timedOut: true,
  });
}

/** Command runner that throws (transport error) */
function crashingRunner(): CommandRunner {
  return async () => {
    throw new Error("binary not found");
  };
}

/** File checker that says all files exist */
function allExistChecker(): FileChecker {
  return async (filePath: string) => true;
}

/** File checker that says no files exist */
function noneExistChecker(): FileChecker {
  return async (filePath: string) => false;
}

/** File checker that only marks specific files as existing */
function selectiveChecker(existingFiles: string[]): FileChecker {
  return async (filePath: string) => existingFiles.includes(filePath);
}

// ---------------------------------------------------------------------------
// VAL-EVAL-001: Evaluator re-runs worker's claimed test commands
// ---------------------------------------------------------------------------

describe("VAL-EVAL-001: Re-run worker's claimed test commands", () => {
  test("re-executes specific commands from handoff commandsRun", async () => {
    const commandsExecuted: string[] = [];
    const runner: CommandRunner = async (cmd: string) => {
      commandsExecuted.push(cmd);
      return { command: cmd, exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: runner,
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "passed" },
        { command: "bun test bar.test.ts", exitCode: 0, observation: "passed" },
      ],
    });

    await evaluator(handoff, makeEvalCriteria());

    expect(commandsExecuted).toEqual([
      "bun test foo.test.ts",
      "bun test bar.test.ts",
    ]);
  });

  test("does NOT run full test suite — only claimed commands", async () => {
    const commandsExecuted: string[] = [];
    const runner: CommandRunner = async (cmd: string) => {
      commandsExecuted.push(cmd);
      return { command: cmd, exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: runner,
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test specific.test.ts", exitCode: 0, observation: "passed" },
      ],
    });

    await evaluator(handoff, makeEvalCriteria());

    // Only the claimed command was executed, not "bun test" (full suite)
    expect(commandsExecuted).toHaveLength(1);
    expect(commandsExecuted[0]).toBe("bun test specific.test.ts");
  });

  test("marks verdict as fail when re-run command fails", async () => {
    const runner: CommandRunner = async (cmd: string) => ({
      command: cmd,
      exitCode: 1,
      stdout: "",
      stderr: "FAIL: 2 tests failed",
      timedOut: false,
    });

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: runner,
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "all passed" },
      ],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("fail");
    expect(assessment.verificationResults.commandResults).toHaveLength(1);
    expect(assessment.verificationResults.commandResults[0].actualExitCode).toBe(1);
    expect(assessment.verificationResults.commandResults[0].matched).toBe(false);
  });

  test("handles empty commandsRun gracefully", async () => {
    const commandsExecuted: string[] = [];
    const runner: CommandRunner = async (cmd: string) => {
      commandsExecuted.push(cmd);
      return { command: cmd, exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: runner,
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({ commandsRun: [] });
    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(commandsExecuted).toHaveLength(0);
    expect(assessment.verificationResults.commandResults).toHaveLength(0);
    expect(assessment.verdict).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-002: Evaluator checks file existence claims
// ---------------------------------------------------------------------------

describe("VAL-EVAL-002: Check file existence for claimed files", () => {
  test("verifies files worker claims to have created exist on disk", async () => {
    const checkedFiles: string[] = [];
    const checker: FileChecker = async (filePath: string) => {
      checkedFiles.push(filePath);
      return true;
    };

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: checker,
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/new-file.ts", "tests/new-file.test.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(checkedFiles).toContain("src/new-file.ts");
    expect(checkedFiles).toContain("tests/new-file.test.ts");
    expect(assessment.verificationResults.fileResults).toHaveLength(2);
    expect(assessment.verificationResults.fileResults.every((r) => r.exists)).toBe(true);
  });

  test("verifies files worker claims to have modified exist on disk", async () => {
    const checkedFiles: string[] = [];
    const checker: FileChecker = async (filePath: string) => {
      checkedFiles.push(filePath);
      return true;
    };

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: checker,
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesModified: ["src/existing.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(checkedFiles).toContain("src/existing.ts");
    expect(assessment.verificationResults.fileResults).toHaveLength(1);
  });

  test("flags missing files — verdict revise-with-feedback", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: noneExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/does-not-exist.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("revise-with-feedback");
    expect(assessment.verificationResults.fileResults[0].exists).toBe(false);
    expect(assessment.feedback).toContain("does-not-exist.ts");
  });

  test("handles empty file lists gracefully", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: [],
      filesModified: [],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verificationResults.fileResults).toHaveLength(0);
    expect(assessment.verdict).toBe("pass");
  });

  test("checks both created and modified files in one pass", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: selectiveChecker(["src/new.ts", "src/modified.ts"]),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/new.ts"],
      filesModified: ["src/modified.ts", "src/missing.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verificationResults.fileResults).toHaveLength(3);
    const newFile = assessment.verificationResults.fileResults.find((r) => r.path === "src/new.ts");
    const modifiedFile = assessment.verificationResults.fileResults.find((r) => r.path === "src/modified.ts");
    const missingFile = assessment.verificationResults.fileResults.find((r) => r.path === "src/missing.ts");

    expect(newFile?.exists).toBe(true);
    expect(modifiedFile?.exists).toBe(true);
    expect(missingFile?.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-003: Evaluator confirms reported counts
// ---------------------------------------------------------------------------

describe("VAL-EVAL-003: Confirm reported counts match reality", () => {
  test("detects mismatch when worker claims N files but different count exists", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: selectiveChecker(["src/a.ts"]),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/a.ts", "src/b.ts", "src/c.ts"],
      filesChangedCount: 3,
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    // 3 files claimed, only 1 exists
    const countResults = assessment.verificationResults.countResults;
    const fileCountCheck = countResults.find((r) => r.metric === "files_created");
    expect(fileCountCheck).toBeDefined();
    expect(fileCountCheck!.claimed).toBe(3);
    expect(fileCountCheck!.actual).toBe(1);
    expect(fileCountCheck!.matched).toBe(false);
  });

  test("passes when claimed counts match reality", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/a.ts", "src/b.ts"],
      filesChangedCount: 2,
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    const countResults = assessment.verificationResults.countResults;
    const fileCountCheck = countResults.find((r) => r.metric === "files_created");
    expect(fileCountCheck).toBeDefined();
    expect(fileCountCheck!.claimed).toBe(2);
    expect(fileCountCheck!.actual).toBe(2);
    expect(fileCountCheck!.matched).toBe(true);
  });

  test("checks tests_added count against reality", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    // Worker claims 5 tests added
    const handoff = makeHandoff({
      testsAdded: 5,
      commandsRun: [
        { command: "bun test tests/new.test.ts", exitCode: 0, observation: "5 tests passed" },
      ],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    // Count comparison should be present
    const countResults = assessment.verificationResults.countResults;
    const testsCheck = countResults.find((r) => r.metric === "tests_added");
    expect(testsCheck).toBeDefined();
  });

  test("handles zero counts gracefully", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: [],
      filesModified: [],
      testsAdded: 0,
      filesChangedCount: 0,
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("pass");
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-004: Evaluator judges pass/fail/revise-with-feedback
// ---------------------------------------------------------------------------

describe("VAL-EVAL-004: Verdict — pass/fail/revise-with-feedback", () => {
  test("returns pass when all verifications succeed", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "passed" },
      ],
      filesCreated: ["src/foo.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("pass");
  });

  test("returns fail when command re-run fails (hard evidence)", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: failingRunner(1),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "all passed" },
      ],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("fail");
  });

  test("returns revise-with-feedback when files missing", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: noneExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/missing.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("revise-with-feedback");
    expect(assessment.feedback).toBeDefined();
    expect(assessment.feedback!.length).toBeGreaterThan(0);
  });

  test("returns revise-with-feedback when count mismatch detected", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: selectiveChecker(["src/a.ts"]),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/a.ts", "src/b.ts"],
      filesChangedCount: 2,
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    // Not all files exist, so revise
    expect(assessment.verdict).toBe("revise-with-feedback");
  });

  test("fail takes priority over revise when commands fail AND files missing", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: failingRunner(1),
      fileChecker: noneExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "passed" },
      ],
      filesCreated: ["src/missing.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    // Command failure is hard evidence → fail
    expect(assessment.verdict).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-005: Transport error degrades gracefully
// ---------------------------------------------------------------------------

describe("VAL-EVAL-005: Graceful degradation on transport error", () => {
  test("command runner crash → step proceeds as pass with warning", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: crashingRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "passed" },
      ],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("pass");
    expect(assessment.transportError).toBe(true);
    expect(assessment.warnings).toBeDefined();
    expect(assessment.warnings!.length).toBeGreaterThan(0);
  });

  test("command timeout → marks command as timed out, degrades gracefully", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: timeoutRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "passed" },
      ],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    // Timeout is not a hard failure — trust the worker's claim
    const cmdResult = assessment.verificationResults.commandResults[0];
    expect(cmdResult.timedOut).toBe(true);
    // Should still pass (graceful degradation)
    expect(assessment.verdict).toBe("pass");
  });

  test("file checker crash → degrades gracefully with warning", async () => {
    const crashChecker: FileChecker = async () => {
      throw new Error("filesystem error");
    };

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: crashChecker,
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/file.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verdict).toBe("pass");
    expect(assessment.transportError).toBe(true);
    expect(assessment.warnings!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-006: Evaluator receives evaluation criteria and handoff
// ---------------------------------------------------------------------------

describe("VAL-EVAL-006: Receives evaluation criteria and handoff", () => {
  test("evaluator function receives both criteria and handoff", async () => {
    let receivedHandoff: TrustVerifyHandoff | null = null;
    let receivedCriteria: unknown = null;

    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
      onEvaluate: (handoff, criteria) => {
        receivedHandoff = handoff;
        receivedCriteria = criteria;
      },
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test", exitCode: 0, observation: "ok" },
      ],
      filesCreated: ["src/new.ts"],
    });

    const criteria = makeEvalCriteria({
      acceptance_criteria: ["must create new file"],
      required_tests: true,
    });

    await evaluator(handoff, criteria);

    expect(receivedHandoff).toBeDefined();
    expect(receivedHandoff!.commandsRun).toHaveLength(1);
    expect(receivedCriteria).toBeDefined();
    expect((receivedCriteria as any).acceptance_criteria).toContain("must create new file");
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-007: Assessment includes structured verification results
// ---------------------------------------------------------------------------

describe("VAL-EVAL-007: Structured verification results in assessment", () => {
  test("assessment includes command re-run results", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test foo.test.ts", exitCode: 0, observation: "passed" },
      ],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verificationResults).toBeDefined();
    expect(assessment.verificationResults.commandResults).toHaveLength(1);

    const cmdResult = assessment.verificationResults.commandResults[0];
    expect(cmdResult.command).toBe("bun test foo.test.ts");
    expect(cmdResult.claimedExitCode).toBe(0);
    expect(cmdResult.actualExitCode).toBe(0);
    expect(cmdResult.matched).toBe(true);
    expect(typeof cmdResult.stdout).toBe("string");
    expect(typeof cmdResult.stderr).toBe("string");
  });

  test("assessment includes file existence check results", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: selectiveChecker(["src/exists.ts"]),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/exists.ts", "src/missing.ts"],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verificationResults.fileResults).toHaveLength(2);

    const exists = assessment.verificationResults.fileResults.find((r) => r.path === "src/exists.ts");
    const missing = assessment.verificationResults.fileResults.find((r) => r.path === "src/missing.ts");

    expect(exists?.exists).toBe(true);
    expect(exists?.type).toBe("created");
    expect(missing?.exists).toBe(false);
    expect(missing?.type).toBe("created");
  });

  test("assessment includes count comparison results", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: selectiveChecker(["src/a.ts"]),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      filesCreated: ["src/a.ts", "src/b.ts"],
      filesChangedCount: 2,
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verificationResults.countResults).toBeDefined();
    expect(assessment.verificationResults.countResults.length).toBeGreaterThan(0);

    const fileCountCheck = assessment.verificationResults.countResults.find(
      (r) => r.metric === "files_created",
    );
    expect(fileCountCheck).toBeDefined();
    expect(fileCountCheck!.claimed).toBe(2);
    expect(fileCountCheck!.actual).toBe(1);
    expect(fileCountCheck!.matched).toBe(false);
  });

  test("assessment includes timedOut flag on timed out commands", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: timeoutRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test slow.test.ts", exitCode: 0, observation: "passed" },
      ],
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    expect(assessment.verificationResults.commandResults).toHaveLength(1);
    expect(assessment.verificationResults.commandResults[0].timedOut).toBe(true);
    expect(assessment.verificationResults.commandResults[0].command).toBe("bun test slow.test.ts");
  });

  test("verdict is NOT just a pass/fail label — includes full results", async () => {
    const evaluator = createTrustVerifyEvaluator({
      commandRunner: successRunner(),
      fileChecker: allExistChecker(),
      cwd: tmpDir,
    });

    const handoff = makeHandoff({
      commandsRun: [
        { command: "bun test", exitCode: 0, observation: "15 pass" },
      ],
      filesCreated: ["src/new.ts"],
      filesModified: ["src/old.ts"],
      testsAdded: 3,
      filesChangedCount: 2,
    });

    const assessment = await evaluator(handoff, makeEvalCriteria());

    // Assessment has all three result categories
    expect(assessment.verificationResults.commandResults).toHaveLength(1);
    expect(assessment.verificationResults.fileResults).toHaveLength(2);
    expect(assessment.verificationResults.countResults.length).toBeGreaterThan(0);

    // Plus the verdict and optional feedback
    expect(["pass", "fail", "revise-with-feedback"]).toContain(assessment.verdict);
  });
});

// ---------------------------------------------------------------------------
// Integration: EvaluatorFn bridge (create-trust-verify.ts)
// ---------------------------------------------------------------------------

describe("createTrustVerifyEvaluatorFn — bridge to executor", () => {
  test("creates a valid EvaluatorFn that accepts step + output + criteria + handoff", async () => {
    // Create the bridge function — uses real file checker against tmpDir
    const evaluatorFn = createTrustVerifyEvaluatorFn({ cwd: tmpDir });

    // Create a test file that the handoff claims exists
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "new.ts"), "export const x = 1;");

    const step = { id: "step-1", type: "work" as const, title: "Implement feature", status: "running" as const };
    const handoffData = {
      summary: "Implemented feature",
      artifacts: {
        files_created: ["src/new.ts"],
        files_modified: [],
        commands_run: [],
      },
      verification: {
        tests_passed: true,
        test_output_summary: "All tests passed",
      },
    };
    const criteria = {
      acceptance_criteria: ["must create new file"],
      required_tests: false,
      custom_checks: [],
      required_outputs: [],
    };

    const result = await evaluatorFn(step, "worker output", criteria, handoffData);

    expect(result.passed).toBe(true);
    expect(result.transportError).toBe(false);
    expect(result.verificationResults).toBeDefined();
  });

  test("handles null handoff gracefully — passes with empty checks", async () => {
    const evaluatorFn = createTrustVerifyEvaluatorFn({ cwd: tmpDir });

    const step = { id: "step-1", type: "work" as const, title: "Test", status: "running" as const };

    const result = await evaluatorFn(step, "output", null, null);

    expect(result.passed).toBe(true);
    expect(result.verificationResults?.commandResults).toHaveLength(0);
    expect(result.verificationResults?.fileResults).toHaveLength(0);
  });

  test("handles undefined handoff gracefully", async () => {
    const evaluatorFn = createTrustVerifyEvaluatorFn({ cwd: tmpDir });

    const step = { id: "step-1", type: "work" as const, title: "Test", status: "running" as const };

    const result = await evaluatorFn(step, "output", null, undefined);

    expect(result.passed).toBe(true);
  });

  test("detects missing files via real file checker", async () => {
    const evaluatorFn = createTrustVerifyEvaluatorFn({ cwd: tmpDir });

    const step = { id: "step-1", type: "work" as const, title: "Test", status: "running" as const };
    const handoffData = {
      artifacts: {
        files_created: ["src/nonexistent.ts"],
      },
    };

    const result = await evaluatorFn(step, "output", null, handoffData);

    // File doesn't exist → revise-with-feedback
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain("nonexistent.ts");
    expect(result.verificationResults?.fileResults[0].exists).toBe(false);
  });

  test("maps revise-with-feedback verdict to passed:false with feedback", async () => {
    const evaluatorFn = createTrustVerifyEvaluatorFn({ cwd: tmpDir });

    const step = { id: "step-1", type: "work" as const, title: "Test", status: "running" as const };
    const handoffData = {
      artifacts: {
        files_created: ["missing.ts"],
      },
    };

    const result = await evaluatorFn(step, "output", null, handoffData);

    expect(result.passed).toBe(false);
    expect(result.feedback).toBeDefined();
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  test("extracts commandsRun from handoff artifacts.commands_run (string array)", async () => {
    const evaluatorFn = createTrustVerifyEvaluatorFn({ cwd: tmpDir });

    const step = { id: "step-1", type: "work" as const, title: "Test", status: "running" as const };
    const handoffData = {
      artifacts: {
        commands_run: ["echo hello"],
        files_created: [],
      },
    };

    const result = await evaluatorFn(step, "output", null, handoffData);

    // The echo command should succeed
    expect(result.verificationResults?.commandResults).toHaveLength(1);
    expect(result.verificationResults?.commandResults[0].command).toBe("echo hello");
    expect(result.verificationResults?.commandResults[0].actualExitCode).toBe(0);
  });
});
