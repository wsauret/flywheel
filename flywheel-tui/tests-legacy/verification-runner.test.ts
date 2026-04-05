import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  runVerificationScript,
  type VerificationResult,
  type VerificationRunnerOptions,
  VERIFY_DIR,
  MAX_OUTPUT_BYTES,
} from "../src/workflows/queue/steps/sprint-work/verification-runner";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a .ts script that exits with the given code. */
async function createTsScript(dir: string, name: string, code: string): Promise<string> {
  const scriptPath = join(dir, name);
  await writeFile(scriptPath, code, "utf-8");
  return scriptPath;
}

/** Create a .sh script. */
async function createShScript(dir: string, name: string, code: string): Promise<string> {
  const scriptPath = join(dir, name);
  await writeFile(scriptPath, code, "utf-8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VerificationRunner", () => {
  let projectDir: string;
  let verifyDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "verify-runner-"));
    verifyDir = join(projectDir, VERIFY_DIR);
    // Don't create verifyDir — runner should auto-create it
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-001: Interpreter selection by file extension
  // -----------------------------------------------------------------------

  describe("Interpreter selection (VAL-VERIFY-001)", () => {
    it(".ts scripts executed via 'bun run'", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "test.ts",
        'console.log("hello from ts"); process.exit(0);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      expect(result.stdout).toContain("hello from ts");
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it(".sh scripts executed via 'bash'", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createShScript(
        verifyDir,
        "test.sh",
        '#!/bin/bash\necho "hello from sh"\nexit 0',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      expect(result.stdout).toContain("hello from sh");
      expect(result.exitCode).toBe(0);
      expect(result.error).toBeUndefined();
    });

    it("unsupported extension (.py) rejected with error result", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = join(verifyDir, "test.py");
      await writeFile(script, "print('hello')", "utf-8");

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain("Unsupported");
      expect(result.exitCode).toBeUndefined();
    });

    it("unsupported extension (.rb) rejected with error result", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = join(verifyDir, "test.rb");
      await writeFile(script, "puts 'hello'", "utf-8");

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain("Unsupported");
    });

    it("file with no extension rejected with error result", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = join(verifyDir, "testfile");
      await writeFile(script, "echo hello", "utf-8");

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain("Unsupported");
    });
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-002: Missing script file returns error result
  // -----------------------------------------------------------------------

  describe("Missing script file (VAL-VERIFY-002)", () => {
    it("returns error result for non-existent file", async () => {
      const result = await runVerificationScript(
        join(projectDir, ".flywheel/verify/nonexistent.ts"),
        { projectCwd: projectDir, timeoutMs: 10_000 },
      );

      expect(result.passed).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/not found|does not exist/i);
      expect(result.exitCode).toBeUndefined();
    });

    it("does not throw an exception for missing file", async () => {
      // Must return a result, not throw
      const result = await runVerificationScript(
        join(projectDir, "missing.ts"),
        { projectCwd: projectDir, timeoutMs: 10_000 },
      );
      expect(result).toBeDefined();
      expect(result.passed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-003: Path traversal outside project rejected
  // -----------------------------------------------------------------------

  describe("Path traversal rejection (VAL-VERIFY-003)", () => {
    it("rejects ../../etc/passwd.sh traversal", async () => {
      const result = await runVerificationScript(
        join(projectDir, "../../etc/passwd.sh"),
        { projectCwd: projectDir, timeoutMs: 10_000 },
      );

      expect(result.passed).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/security|outside|boundary|traversal/i);
      expect(result.exitCode).toBeUndefined();
    });

    it("rejects absolute path outside project", async () => {
      const result = await runVerificationScript(
        "/etc/passwd",
        { projectCwd: projectDir, timeoutMs: 10_000 },
      );

      expect(result.passed).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/security|outside|boundary|traversal/i);
    });

    it("accepts path within project boundary", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "ok.ts",
        'console.log("ok"); process.exit(0);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      // Should proceed (not rejected by security check)
      // error is undefined on success — that means no security rejection
      expect(result.error ?? "").not.toMatch(/security|outside|boundary|traversal/i);
    });
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-004: Timeout enforcement kills script
  // -----------------------------------------------------------------------

  describe("Timeout enforcement (VAL-VERIFY-004)", () => {
    it("kills script that exceeds timeout and returns timed_out result", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "slow.ts",
        `
console.log("starting");
await Bun.sleep(30_000);
console.log("should not reach here");
`,
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 1_000, // 1 second timeout
      });

      expect(result.passed).toBe(false);
      expect(result.timedOut).toBe(true);
      // Should capture partial output before timeout
      expect(result.stdout).toContain("starting");
    }, 15_000);

    it("returns partial stderr on timeout", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "slow-stderr.ts",
        `
process.stderr.write("stderr before\\n");
await Bun.sleep(30_000);
process.stderr.write("should not reach here\\n");
`,
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 1_500,
      });

      expect(result.passed).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.stderr).toContain("stderr before");
    }, 15_000);
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-005: Output capture with truncation
  // -----------------------------------------------------------------------

  describe("Output capture and truncation (VAL-VERIFY-005)", () => {
    it("captures stdout and stderr from script", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "output.ts",
        `
console.log("stdout line");
console.error("stderr line");
process.exit(0);
`,
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.stdout).toContain("stdout line");
      expect(result.stderr).toContain("stderr line");
    });

    it("truncates stdout when exceeding max size", async () => {
      await mkdir(verifyDir, { recursive: true });
      // Generate a script that outputs more than MAX_OUTPUT_BYTES
      const bigChunk = "x".repeat(1024);
      const iterations = Math.ceil((MAX_OUTPUT_BYTES + 10_000) / 1024);
      const script = await createTsScript(
        verifyDir,
        "big-output.ts",
        `
for (let i = 0; i < ${iterations}; i++) {
  console.log("${bigChunk}");
}
process.exit(0);
`,
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 30_000,
      });

      expect(result.passed).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 500); // small buffer for truncation marker
      expect(result.stdout).toContain("[output truncated");
    }, 30_000);

    it("truncates stderr when exceeding max size", async () => {
      await mkdir(verifyDir, { recursive: true });
      const bigChunk = "x".repeat(1024);
      const iterations = Math.ceil((MAX_OUTPUT_BYTES + 10_000) / 1024);
      const script = await createTsScript(
        verifyDir,
        "big-stderr.ts",
        `
for (let i = 0; i < ${iterations}; i++) {
  console.error("${bigChunk}");
}
process.exit(0);
`,
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 30_000,
      });

      expect(result.passed).toBe(true);
      expect(result.stderr.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 500);
      expect(result.stderr).toContain("[output truncated");
    }, 30_000);
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-006: Exit code mapping
  // -----------------------------------------------------------------------

  describe("Exit code mapping (VAL-VERIFY-006)", () => {
    it("exit code 0 maps to passed: true", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "pass.ts",
        'console.log("pass"); process.exit(0);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("exit code 1 maps to passed: false", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "fail.ts",
        'console.log("fail"); process.exit(1);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it("exit code 2 maps to passed: false with preserved code", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "fail2.ts",
        'process.exit(2);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(2);
    });

    it("exit code 42 maps to passed: false with preserved code", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createShScript(
        verifyDir,
        "fail42.sh",
        '#!/bin/bash\nexit 42',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(false);
      expect(result.exitCode).toBe(42);
    });
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-007: Script CWD is project directory and verify dir auto-created
  // -----------------------------------------------------------------------

  describe("Script CWD and verify dir (VAL-VERIFY-007)", () => {
    it("script CWD is project directory", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "pwd.ts",
        'console.log(process.cwd()); process.exit(0);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      // On macOS /tmp → /private/tmp, so normalize
      const normalizedCwd = result.stdout.trim();
      const normalizedProject = projectDir;
      // Both should resolve to the same real path
      const realCwd = await Bun.file(normalizedCwd).exists()
        ? normalizedCwd
        : normalizedCwd;
      expect(
        normalizedCwd === normalizedProject ||
        normalizedCwd.endsWith(normalizedProject.split("/").pop()!)
      ).toBe(true);
    });

    it("auto-creates .flywheel/verify/ directory when missing", async () => {
      // Don't create verifyDir — runner should create it
      expect(existsSync(verifyDir)).toBe(false);

      // We need to create the file somehow for the test — create it after runner creates dir
      // Instead, create a script in the project root and reference it
      const script = await createTsScript(
        projectDir,
        "verify-test.ts",
        'console.log("verify dir test"); process.exit(0);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      // The .flywheel/verify/ directory should now exist
      expect(existsSync(verifyDir)).toBe(true);
      expect(result.passed).toBe(true);
    });

    it("scripts persist after completion", async () => {
      await mkdir(verifyDir, { recursive: true });
      const scriptPath = await createTsScript(
        verifyDir,
        "persist.ts",
        'console.log("persist"); process.exit(0);',
      );

      await runVerificationScript(scriptPath, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      // Script still exists after run
      expect(existsSync(scriptPath)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // VAL-VERIFY-008: Unique script naming prevents cross-sprint collision
  // -----------------------------------------------------------------------

  describe("Cross-sprint collision prevention (VAL-VERIFY-008)", () => {
    it("scripts from different sessions have distinct names in .flywheel/verify/", async () => {
      await mkdir(verifyDir, { recursive: true });

      // Create two scripts with session-based unique names
      const script1 = await createTsScript(
        verifyDir,
        "sprint-session-aaa-verify.ts",
        'console.log("session a"); process.exit(0);',
      );
      const script2 = await createTsScript(
        verifyDir,
        "sprint-session-bbb-verify.ts",
        'console.log("session b"); process.exit(0);',
      );

      // Run both
      const result1 = await runVerificationScript(script1, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });
      const result2 = await runVerificationScript(script2, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result1.passed).toBe(true);
      expect(result2.passed).toBe(true);

      // Both scripts still exist (not overwritten)
      expect(existsSync(script1)).toBe(true);
      expect(existsSync(script2)).toBe(true);

      // Verify directory contains both scripts
      const files = await readdir(verifyDir);
      expect(files).toContain("sprint-session-aaa-verify.ts");
      expect(files).toContain("sprint-session-bbb-verify.ts");
    });
  });

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------

  describe("Edge cases", () => {
    it("handles script that produces no output", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "quiet.ts",
        'process.exit(0);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("handles script with mixed stdout and stderr", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createShScript(
        verifyDir,
        "mixed.sh",
        '#!/bin/bash\necho "out1"\necho "err1" >&2\necho "out2"\necho "err2" >&2\nexit 0',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(result.passed).toBe(true);
      expect(result.stdout).toContain("out1");
      expect(result.stdout).toContain("out2");
      expect(result.stderr).toContain("err1");
      expect(result.stderr).toContain("err2");
    });

    it("result includes durationMs", async () => {
      await mkdir(verifyDir, { recursive: true });
      const script = await createTsScript(
        verifyDir,
        "duration.ts",
        'process.exit(0);',
      );

      const result = await runVerificationScript(script, {
        projectCwd: projectDir,
        timeoutMs: 10_000,
      });

      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
