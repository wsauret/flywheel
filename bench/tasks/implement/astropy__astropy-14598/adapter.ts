import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandResult } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput {
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** Prepare pinned source and a cell-owned CPython runtime, or grade a captured patch.
 * The original source build stays isolated. Original grading owners are restored
 * before the build. Candidate build and test failures reach the original grader,
 * whose missing-ID semantics decide the result; preparation remains strict. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  await mkdir(join(home, "wheels"), { recursive: true });
  const env = {
    PYTHONNOUSERSITE: "1", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_FIND_LINKS: join(home, "wheels"), PIP_CONSTRAINT: join(task, "build-constraints.txt"),
    PIP_CACHE_DIR: join(home, "pip-cache"),
    SETUPTOOLS_SCM_PRETEND_VERSION_FOR_ASTROPY: "5.3.dev0+g80c3854a5",
  };
  const supervisor = createProcessSupervisor();
  const scope = createLauncherScope(supervisor);
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, { ...options, env: { ...options?.env, ...env } });
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
  const commands: Record<string, Omit<OwnedCommandResult, "stdoutBytes"> & { command: readonly string[]; durationMs: number }> = {};
  async function execute(label: string, command: readonly string[], timeoutMs = 600000, allowed = [0]): Promise<void> {
    const started = performance.now();
    const result = await runSandboxCommand(
      (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
      command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
    );
    const { stdoutBytes: _stdoutBytes, ...captured } = result;
    commands[label] = { ...captured, command, durationMs: Math.round(performance.now() - started) };
    await Bun.write(join(home, `${label}.command.json`), JSON.stringify(commands[label], null, 2));
    if (result.timedOut || !allowed.includes(result.exitCode ?? -1) || result.stdoutTruncated || result.stderrTruncated) {
      throw new Error(`FITS ${label} failed: exit ${result.exitCode}, timeout ${result.timedOut}, output must be complete`);
    }
  }
  const helper = join(task, "native-support.py");
  const python = join(home, "python/bin/python");
  try {
    await execute("preflight", ["python3", helper, "preflight", task, workspace]);
    await execute("compiler", ["clang", "--version"]);
    const source: PublicInput = await Bun.file(join(task, "source.json")).json();
    const wheels: PublicInput[] = await Bun.file(join(task, "wheel-index.json")).json();
    const acquired = [];
    for (const input of [source, ...wheels]) {
      const response = await fetch(input.url);
      if (!response.ok || !response.body) throw new Error(`Public input acquisition failed: HTTP ${response.status}`);
      const path = join(home, input === source ? input.filename : join("wheels", input.filename));
      const writer = Bun.file(path).writer();
      const hasher = new Bun.CryptoHasher("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          hasher.update(chunk);
          writer.write(chunk);
          bytes += chunk.byteLength;
        }
      } finally {
        await writer.end();
      }
      const sha256 = hasher.digest("hex");
      if (bytes !== input.bytes || sha256 !== input.sha256) throw new Error(`Public input identity mismatch: ${input.filename}`);
      acquired.push({ ...input, status: response.status, bytes, sha256 });
    }
    await execute("extract", ["python3", helper, "extract", task, workspace]);
    if (action === "grade") {
      await execute("git-init", ["git", "init", "-q"]);
      const patch = artifacts[0]!;
      if ((await stat(patch)).size) await execute("candidate-patch", ["git", "apply", "--verbose", resolve(patch)]);
      await execute("restore", ["python3", helper, "restore", task, workspace]);
    }
    await execute("venv", ["python3", "-m", "venv", "--symlinks", join(home, "python")]);
    await execute("packages", [python, "-m", "pip", "install", "--no-index", "--find-links", join(home, "wheels"),
      "-r", join(task, "environment-pins.txt"), "pip==23.2.1"]);
    await execute("build", [python, "-m", "pip", "install", "-e", ".[test]", "--verbose"], 600000, action === "prepare" ? [0] : [0, 1]);
    await execute("snapshot", [python, helper, "snapshot", task, workspace], 600000, action === "prepare" ? [0] : [0, 1]);
    if (action === "prepare") return;
    await execute("test-patch", ["git", "apply", "--verbose", join(task, "original/test.patch")]);
    await execute("grading-identities", [python, helper, "grading-snapshot", task, workspace]);
    // The absolute console script avoids a captured pytest.py shadowing pytest.
    await execute("pytest", [python, join(home, "python/bin/pytest"), "-rA", "astropy/io/fits/tests/test_header.py"], 300000, [0, 1, 2, 3, 4, 5]);
    await execute("api", [python, join(task, "api-runner.py"), join(task, "api-probe.py"), join(home, "api.json")], 300000, [0, 1]);
    await execute("score", [python, helper, "score", task, workspace]);
    const { passed, failed, total, ...originalEvidence } = await Bun.file(join(home, "grade.json")).json();
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed, failed, total,
      evidence: { ...originalEvidence, acquired, commands, outputLimitBytesPerPipe: 16_000_000,
        limits: { buildMs: 600000, pytestMs: 300000 }, equivalence: "native macOS arm64, not original Linux or leaderboard equivalence" },
    }, null, 2) + "\n");
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
