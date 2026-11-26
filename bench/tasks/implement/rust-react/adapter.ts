import { copyFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

const CARGO_TIMEOUT_MS = 180000;
const CARGO_OUTPUT_BYTES = 1_000_000;

/** Prepare original candidate files, or grade a captured patch with restored tests.
 * Setup failures produce no report. Each hidden test in tests/react.rs is one check; a test
 * that did not report a status, as after a build failure, is absent and fails.
 * The owned command waits for descendants and drains both pipes before reporting. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  const cargoEnv = {
    CARGO_HOME: join(home, "cargo"),
    CARGO_TARGET_DIR: join(home, "target"),
    CARGO_NET_OFFLINE: "true",
  };
  await Promise.all(Object.entries(cargoEnv)
    .filter(([key]) => key !== "CARGO_NET_OFFLINE")
    .map(([, directory]) => mkdir(directory, { recursive: true })));
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
  const scope = createLauncherScope(supervisor);
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, { ...options, env: { ...options?.env, ...cargoEnv } });
      return {
        ...owned,
        stdout: owned.stdout?.pipeThrough(new TransformStream({
          transform(chunk, controller) { process.stdout.write(chunk); controller.enqueue(chunk); },
        })),
        stderr: owned.stderr?.pipeThrough(new TransformStream({
          transform(chunk, controller) { process.stderr.write(chunk); controller.enqueue(chunk); },
        })),
      };
    },
  });
  const options = { cwd: workspace, sandboxDir: workspace };
  try {
    const toolVersions: Record<string, string> = {};
    for (const name of ["cargo", "rustc", "rustdoc"]) {
      const result = await runSandboxCommand(run, [name, "--version"], options);
      if (result.exitCode !== 0 || result.timedOut || result.stdoutTruncated || result.stderrTruncated) {
        throw new Error(`${name} must be available on PATH`);
      }
      toolVersions[name] = result.stdout.trim();
    }
    for (const relative of ["Cargo.toml", "src/lib.rs"]) {
      const destination = join(workspace, relative);
      await mkdir(resolve(destination, ".."), { recursive: true });
      await copyFile(join(task, "candidate", relative), destination);
    }
    for (const name of ["rust-LICENSE", "problem-specifications-LICENSE"]) {
      await copyFile(join(task, "licenses", name), join(workspace, name));
    }
    if (action === "prepare") return;
    const [patch, report] = artifacts as [string, string];
    const commands = [["git", "init", "-q"]];
    if ((await stat(patch)).size) commands.push(["git", "apply", "--whitespace=nowarn", resolve(patch)]);
    for (const command of commands) {
      const result = await runSandboxCommand(run, command, options);
      if (result.exitCode !== 0 || result.timedOut) throw new Error("grade source setup failed");
    }
    await mkdir(join(workspace, "tests"), { recursive: true });
    await copyFile(join(task, "tests/react.rs"), join(workspace, "tests/react.rs"));
    // Only the restored hidden test target runs, so candidate unit tests and doctests can neither share a hidden
    // test's name nor fail the build of the hidden tests.
    const command = ["cargo", "test", "--test", "react", "--", "--include-ignored"];
    const started = performance.now();
    const result = await runSandboxCommand(
      (argv, opts) => run(argv, { ...opts, maxOutputBytes: CARGO_OUTPUT_BYTES }),
      command, { ...options, timeoutMs: CARGO_TIMEOUT_MS },
    );
    const originalSourceSha256: Record<string, string> = {};
    for (const relative of ["candidate/Cargo.toml", "candidate/src/lib.rs", "tests/react.rs"]) {
      originalSourceSha256[relative] = Bun.CryptoHasher.hash("sha256", await Bun.file(join(task, relative)).arrayBuffer(), "hex");
    }
    const testObservations = [...result.stdout.matchAll(/^test (.+?) \.\.\. (ok|FAILED|ignored)$/gm)]
      .map(match => ({ id: match[1]!, status: match[2]! }));
    const roster = new Set(Object.keys(await Bun.file(join(task, "checks.json")).json()));
    const checks = Object.fromEntries(testObservations.filter(row => roster.has(row.id)).map(row => [row.id, row.status === "ok"]));
    const evidence = {
      command, exitCode: result.exitCode, timedOut: result.timedOut,
      timeoutMs: CARGO_TIMEOUT_MS, durationMs: Math.round(performance.now() - started),
      stdout: result.stdout, stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated ?? false, stderrTruncated: result.stderrTruncated ?? false,
      outputLimitBytesPerPipe: CARGO_OUTPUT_BYTES,
      testObservations, toolVersions, originalSourceSha256,
    };
    await Bun.write(report, JSON.stringify({ checks, evidence }) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter process ownership did not settle: ${closure.reason}`);
    } finally {
      await supervisor.dispose();
    }
  }
}

if (import.meta.main) await main();
