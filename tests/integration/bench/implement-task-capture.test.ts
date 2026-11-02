import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import {
  captureImplementation,
  loadImplementTasks,
  provisionTaskSandbox,
} from "../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";

const run: OwnedCommandRunner = async (command, options = {}) => {
  if (options.stdin !== undefined) throw new Error("integration runner does not accept stdin");
  const subprocess = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return {
    exitCode,
    timedOut: false,
    stdoutBytes: new TextEncoder().encode(stdout),
    stdout,
    stderr,
  };
};

async function checked(command: readonly string[], cwd: string): Promise<void> {
  const result = await run(command, { cwd });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr}`);
}

test("captures the final candidate tree after commits and rejects a missing baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "bench-capture-integration-"));
  const taskDir = join(root, "tasks", "committed");
  await mkdir(join(taskDir, "project"), { recursive: true });
  await mkdir(join(taskDir, "acceptance"), { recursive: true });
  await Bun.write(join(taskDir, "task.json"), JSON.stringify({ id: "committed", stratum: "small" }));
  await Bun.write(join(taskDir, "manifest.json"), JSON.stringify({ traps: [], judgment: [] }));
  await Bun.write(join(taskDir, "plan.json"), JSON.stringify(MINIMAL_IMPLEMENTATION_PLAN));
  await Bun.write(join(taskDir, "project", "value.ts"), "export const value = 1;\n");
  await Bun.write(join(taskDir, "project", "removed.ts"), "export const removed = true;\n");
  await Bun.write(join(taskDir, "acceptance", "value.test.ts"), "test('acceptance', () => {});\n");

  const [task] = await loadImplementTasks(join(root, "tasks"));
  if (!task) throw new Error("expected committed task");
  const sandbox = await provisionTaskSandbox(process.cwd(), task, run);
  try {
    await Bun.write(join(sandbox, "value.ts"), "export const value = 2;\n");
    await checked(["git", "add", "value.ts"], sandbox);
    await checked(["git", "-c", "user.email=bench@flywheel.dev", "-c", "user.name=bench", "commit", "-qm", "candidate"], sandbox);
    await Bun.write(join(sandbox, "added.ts"), "export const added = true;\n");
    await rm(join(sandbox, "removed.ts"));
    await mkdir(join(sandbox, ".flywheel"), { recursive: true });
    await Bun.write(join(sandbox, ".flywheel", "state"), "excluded\n");
    await mkdir(join(sandbox, ".bench-home"), { recursive: true });
    await Bun.write(join(sandbox, ".bench-home", "state"), "excluded\n");
    await Bun.write(join(sandbox, ".bench-plan.json"), "excluded\n");
    await mkdir(join(sandbox, "acceptance"), { recursive: true });
    await Bun.write(join(sandbox, "acceptance", "candidate.test.ts"), "excluded\n");

    const captured = await captureImplementation(task, sandbox, run);
    expect(captured.diff).toContain("diff --git a/value.ts b/value.ts");
    expect(captured.diff).toContain("diff --git a/added.ts b/added.ts");
    expect(captured.diff).toContain("diff --git a/removed.ts b/removed.ts");
    expect(captured.diff).not.toContain("excluded");
    expect(captured.diffStats).toEqual({ linesAdded: 2, linesRemoved: 2, filesTouched: 3 });

    await checked(["git", "update-ref", "-d", "refs/flywheel/benchmark-baseline"], sandbox);
    await expect(captureImplementation(task, sandbox, run)).rejects.toThrow("exit code 128");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
