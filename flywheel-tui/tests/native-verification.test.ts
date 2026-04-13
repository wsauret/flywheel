// ---------------------------------------------------------------------------
// Phase 3: Trust-But-Verify — Native Verification Tests
// ---------------------------------------------------------------------------
//
// Tests for re-running commands the worker reported running, with deny-list
// filtering, concurrent execution, and discrepancy detection.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "bun:test";

import {
  isDeniedCommand,
  runNativeVerification,
  type DeclaredCommand,
} from "../src/workflows/shared/native-verification.js";
import { extractDeclaredCommands } from "../src/workflows/queue/shared/command-extraction.js";

// ---------------------------------------------------------------------------
// extractDeclaredCommands
// ---------------------------------------------------------------------------

describe("extractDeclaredCommands", () => {
  it("returns empty array for null handoff", () => {
    const result = extractDeclaredCommands(null);
    expect(result).toEqual([]);
  });

  it("returns empty array when no artifacts or commands_run", () => {
    const result = extractDeclaredCommands({ summary: "did stuff" });
    expect(result).toEqual([]);
  });

  it("handles string entries in commands_run", () => {
    const result = extractDeclaredCommands({
      summary: "ran tests",
      artifacts: {
        commands_run: ["bun run test", "bun run build"],
      },
    });
    expect(result).toEqual([
      { command: "bun run test" },
      { command: "bun run build" },
    ]);
  });

  it("handles structured entries in commands_run", () => {
    const result = extractDeclaredCommands({
      summary: "ran tests",
      artifacts: {
        commands_run: [
          { command: "bun run test", exitCode: 0, observation: "all passed" },
          { command: "bun run build", exitCode: 1 },
        ],
      },
    });
    expect(result).toEqual([
      { command: "bun run test", reportedExitCode: 0, observation: "all passed" },
      { command: "bun run build", reportedExitCode: 1 },
    ]);
  });

  it("handles mixed string and structured entries", () => {
    const result = extractDeclaredCommands({
      summary: "did things",
      artifacts: {
        commands_run: [
          "echo hello",
          { command: "bun run test", exitCode: 0 },
        ],
      },
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ command: "echo hello" });
    expect(result[1]).toEqual({ command: "bun run test", reportedExitCode: 0 });
  });

  it("skips malformed entries", () => {
    const result = extractDeclaredCommands({
      summary: "did things",
      artifacts: {
        commands_run: [
          42,
          null,
          undefined,
          { notACommand: true },
          { command: "valid one" },
        ],
      },
    });
    expect(result).toEqual([{ command: "valid one" }]);
  });
});

// ---------------------------------------------------------------------------
// isDeniedCommand
// ---------------------------------------------------------------------------

describe("isDeniedCommand", () => {
  it("denies filesystem destructive commands", () => {
    expect(isDeniedCommand("rm -rf /tmp/foo")).toBe(true);
    expect(isDeniedCommand("rmdir /tmp/foo")).toBe(true);
    expect(isDeniedCommand("mv a b")).toBe(true);
    expect(isDeniedCommand("chmod 777 file")).toBe(true);
    expect(isDeniedCommand("shred file")).toBe(true);
  });

  it("denies network commands", () => {
    expect(isDeniedCommand("curl https://example.com")).toBe(true);
    expect(isDeniedCommand("wget https://example.com")).toBe(true);
    expect(isDeniedCommand("ssh user@host")).toBe(true);
    expect(isDeniedCommand("scp file host:")).toBe(true);
    expect(isDeniedCommand("rsync -av a b")).toBe(true);
  });

  it("denies process management commands", () => {
    expect(isDeniedCommand("kill -9 1234")).toBe(true);
    expect(isDeniedCommand("pkill node")).toBe(true);
    expect(isDeniedCommand("killall node")).toBe(true);
  });

  it("denies shell builtins", () => {
    expect(isDeniedCommand("cd /tmp")).toBe(true);
    expect(isDeniedCommand("echo hello")).toBe(true);
    expect(isDeniedCommand("cat file")).toBe(true);
    expect(isDeniedCommand("export FOO=bar")).toBe(true);
    expect(isDeniedCommand("eval 'bad things'")).toBe(true);
    expect(isDeniedCommand("exec /bin/sh")).toBe(true);
  });

  it("denies publishing commands", () => {
    expect(isDeniedCommand("npm publish")).toBe(true);
    expect(isDeniedCommand("cargo publish")).toBe(true);
    expect(isDeniedCommand("twine upload dist/*")).toBe(true);
    expect(isDeniedCommand("gem push pkg.gem")).toBe(true);
  });

  it("denies cloud CLI commands", () => {
    expect(isDeniedCommand("aws s3 ls")).toBe(true);
    expect(isDeniedCommand("gcloud compute instances list")).toBe(true);
    expect(isDeniedCommand("az vm list")).toBe(true);
    expect(isDeniedCommand("kubectl get pods")).toBe(true);
  });

  it("denies destructive docker commands", () => {
    expect(isDeniedCommand("docker rm container")).toBe(true);
    expect(isDeniedCommand("docker stop container")).toBe(true);
    expect(isDeniedCommand("docker push image")).toBe(true);
    expect(isDeniedCommand("docker rmi image")).toBe(true);
  });

  it("denies dangerous git subcommands", () => {
    expect(isDeniedCommand("git push origin main")).toBe(true);
    expect(isDeniedCommand("git commit -m 'foo'")).toBe(true);
    expect(isDeniedCommand("git add .")).toBe(true);
    expect(isDeniedCommand("git reset --hard")).toBe(true);
    expect(isDeniedCommand("git checkout -- .")).toBe(true);
    expect(isDeniedCommand("git rebase main")).toBe(true);
    expect(isDeniedCommand("git branch -D feature")).toBe(true);
    expect(isDeniedCommand("git merge feature")).toBe(true);
    expect(isDeniedCommand("git stash pop")).toBe(true);
  });

  it("allows safe commands", () => {
    expect(isDeniedCommand("bun run test")).toBe(false);
    expect(isDeniedCommand("bun run build")).toBe(false);
    expect(isDeniedCommand("npm run lint")).toBe(false);
    expect(isDeniedCommand("tsc --noEmit")).toBe(false);
    expect(isDeniedCommand("eslint .")).toBe(false);
    expect(isDeniedCommand("git diff --stat")).toBe(false);
    expect(isDeniedCommand("git status")).toBe(false);
    expect(isDeniedCommand("git log --oneline")).toBe(false);
  });

  it("handles empty and whitespace-only commands", () => {
    expect(isDeniedCommand("")).toBe(true);
    expect(isDeniedCommand("   ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runNativeVerification — command execution
// ---------------------------------------------------------------------------

describe("runNativeVerification", () => {
  it("returns empty results when no commands and no has-changes check", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [],
      nativeCheckTypes: [],
    });
    expect(result.allPassed).toBe(true);
    expect(result.checks).toEqual([]);
    expect(result.discrepancies).toEqual([]);
    expect(result.hasChanges).toBe(false);
  });

  it("runs a simple command and captures output", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [{ command: "true" }],
      nativeCheckTypes: [],
    });
    expect(result.allPassed).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[0].exitCode).toBe(0);
    expect(typeof result.checks[0].durationMs).toBe("number");
    expect(result.checks[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("detects a failing command", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [{ command: "false" }],
      nativeCheckTypes: [],
    });
    expect(result.allPassed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[0].exitCode).not.toBe(0);
  });

  it("skips denied commands with reason", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [
        { command: "rm -rf /tmp/foo" },
        { command: "curl https://example.com" },
        { command: "git push origin main" },
      ],
      nativeCheckTypes: [],
    });
    expect(result.allPassed).toBe(true);
    expect(result.checks).toHaveLength(3);
    for (const check of result.checks) {
      expect(check.kind).toBe("skipped");
      if (check.kind === "skipped") expect(check.skipReason).toMatch(/^denied:/);
    }
  });

  it("detects discrepancy: worker claims exit 0 but re-run gets exit 1", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [{ command: "false", reportedExitCode: 0 }],
      nativeCheckTypes: [],
    });
    expect(result.allPassed).toBe(false);
    expect(result.checks[0].kind).toBe("discrepancy");
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].command).toBe("false");
  });

  it("no discrepancy when reported exit code matches", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [{ command: "true", reportedExitCode: 0 }],
      nativeCheckTypes: [],
    });
    expect(result.allPassed).toBe(true);
    expect(result.checks[0].kind).toBe("ran");
    expect(result.discrepancies).toHaveLength(0);
  });

  it("handles missing command binary gracefully", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [{ command: "nonexistent_binary_xyzzy_12345" }],
      nativeCheckTypes: [],
    });
    // Should not crash; either skipped or failed
    expect(result.checks).toHaveLength(1);
    const check = result.checks[0];
    expect(check.kind === "skipped" || (check.kind !== "skipped" && check.passed === false)).toBe(true);
  });

  it("runs multiple checks concurrently", async () => {
    const start = Date.now();
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [
        { command: "true" },
        { command: "true" },
        { command: "true" },
      ],
      nativeCheckTypes: [],
    });
    const elapsed = Date.now() - start;
    expect(result.allPassed).toBe(true);
    expect(result.checks).toHaveLength(3);
    // All ran concurrently so total time should be small
    expect(elapsed).toBeLessThan(5000);
  });

  it("enforces per-command timeout", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [{ command: "sleep 30" }],
      nativeCheckTypes: [],
      timeoutMs: 100,
      deadlineMs: 500,
    });
    expect(result.allPassed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].kind).toBe("ran");
    if (result.checks[0].kind === "ran") expect(result.checks[0].passed).toBe(false);
  }, 10_000);

  it("git diff --stat only runs when has-changes is in nativeCheckTypes", async () => {
    // Without has-changes: no git diff check
    const result1 = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [],
      nativeCheckTypes: ["build", "test"],
    });
    expect(result1.hasChanges).toBe(false);
    const gitChecks1 = result1.checks.filter((c) => c.command.includes("git diff"));
    expect(gitChecks1).toHaveLength(0);

    // With has-changes: git diff check runs
    const result2 = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [],
      nativeCheckTypes: ["has-changes"],
    });
    const gitChecks2 = result2.checks.filter((c) => c.command.includes("git diff"));
    expect(gitChecks2).toHaveLength(1);
  });

  it("handles single-commit repo gracefully for git diff --stat HEAD~1", async () => {
    // Running in the actual repo, HEAD~1 should exist, but the function
    // should handle the error case gracefully (not throw)
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [],
      nativeCheckTypes: ["has-changes"],
    });
    // Should not throw, checks should contain the git diff result
    const gitCheck = result.checks.find((c) => c.command.includes("git diff"));
    expect(gitCheck).toBeDefined();
    // Either it passed or was skipped (for single-commit repos), but did not throw
    expect(gitCheck!.kind === "skipped" || gitCheck!.kind === "ran").toBe(true);
  });

  it("skipped commands do not affect allPassed", async () => {
    const result = await runNativeVerification({
      projectCwd: process.cwd(),
      declaredCommands: [
        { command: "rm -rf /tmp/foo" },  // denied -> skipped
        { command: "true" },              // passes
      ],
      nativeCheckTypes: [],
    });
    expect(result.allPassed).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].kind).toBe("skipped");
    expect(result.checks[1].kind).toBe("ran");
    if (result.checks[1].kind === "ran") expect(result.checks[1].passed).toBe(true);
  });
});
