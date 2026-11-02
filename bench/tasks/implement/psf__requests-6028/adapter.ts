import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** Capture an owned command. A timeout ends evaluation without a grade, as the
 * pinned original run_instance does. Pytest exit codes are parsed, not vetoes. */
export async function executeRequestsCommand(
  run: OwnedCommandRunner, workspace: string, label: string,
  command: readonly string[], timeoutMs: number, allowed?: readonly number[],
) {
  const started = performance.now();
  const result = await runSandboxCommand(
    (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
    command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
  );
  const { stdoutBytes: _bytes, ...captured } = result;
  const record = { ...captured, command, durationMs: Math.round(performance.now() - started) };
  await Bun.write(join(workspace, ".bench-home", `${label}.command.json`), JSON.stringify(record, null, 2));
  if (result.timedOut) throw new Error(`Requests ${label} timed out; original evaluation produces no report`);
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`Requests ${label} output is incomplete`);
  if (allowed && !allowed.includes(result.exitCode ?? -1)) throw new Error(`Requests ${label} failed: exit ${result.exitCode}`);
  return record;
}

/** Provision from public pinned bytes, or grade a captured patch in a fresh tree.
 * The evaluation ceiling covers restoration, test patching and the pytest
 * lifecycle. Setup and scoring have separate allowances, not candidate time. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The pinned public runtime requires macOS arm64");
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  await mkdir(join(home, "wheels"), { recursive: true });
  await mkdir(join(home, "inputs"), { recursive: true });
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1",
    PIP_CONFIG_FILE: "/dev/null", PIP_NO_CACHE_DIR: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
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
  const commands: Record<string, unknown> = {};
  const setupDeadline = performance.now() + 600000;
  const execute = async (label: string, command: readonly string[], deadline: number, allowed?: readonly number[]) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error(`Requests ${label} deadline expired; no evaluation report`);
    const record = await executeRequestsCommand(run, workspace, label, command, remaining, allowed);
    commands[label] = record;
    return record;
  };
  try {
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    for (const input of inputs) {
      const remaining = Math.ceil(setupDeadline - performance.now());
      if (remaining <= 0) throw new Error("Requests public acquisition setup allowance expired");
      const response = await fetch(input.url, { signal: AbortSignal.timeout(remaining) });
      if (!response.ok || !response.body) throw new Error(`Public acquisition failed: HTTP ${response.status}`);
      const writer = Bun.file(join(home, input.file)).writer();
      const hasher = new Bun.CryptoHasher("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          hasher.update(chunk);
          writer.write(chunk);
          bytes += chunk.byteLength;
        }
      } finally { await writer.end(); }
      const sha256 = hasher.digest("hex");
      if (bytes !== input.bytes || sha256 !== input.sha256) throw new Error(`Public identity mismatch: ${input.file}`);
      acquired.push({ ...input, status: response.status, bytes, sha256 });
    }
    await execute("runtime-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/python.tar.gz"), "-C", home], setupDeadline, [0]);
    const runtime = join(home, "python/bin/python3.12");
    const python = join(home, "venv/bin/python");
    const helper = join(task, "native-support.py");
    await execute("extract", [runtime, "-I", helper, "extract", task, workspace], setupDeadline, [0]);
    if (action === "grade") {
      // provisionTaskSandbox appends these entries before its baseline commit.
      // Captured .gitignore edits must apply against that same baseline.
      const ignore = join(workspace, ".gitignore");
      await Bun.write(ignore, (await Bun.file(ignore).text()) + "\n.flywheel/\n.bench-home/\n");
      await execute("git-init", ["/usr/bin/git", "init", "-q"], setupDeadline, [0]);
      const patch = artifacts[0]!;
      if ((await stat(patch)).size) await execute("candidate-patch", ["/usr/bin/git", "apply", "--verbose", resolve(patch)], setupDeadline, [0]);
    }
    await execute("venv", [runtime, "-I", "-m", "venv", join(home, "venv")], setupDeadline, [0]);
    await execute("packages", [python, "-I", "-m", "pip", "install", "--no-index", "--no-deps",
      "--find-links", join(home, "wheels"), "--require-hashes", "-r", join(task, "requirements-hashed.txt")], setupDeadline, [0]);
    await execute("pip-check", [python, "-I", "-m", "pip", "check"], setupDeadline, [0]);
    await execute("snapshot", [python, "-I", helper, "snapshot", task, workspace], setupDeadline, [0]);
    if (action === "prepare") return;
    const evaluationDeadline = performance.now() + 1800000;
    await execute("restore", [runtime, "-I", helper, "restore", task, workspace], evaluationDeadline, [0]);
    await execute("test-patch", ["/usr/bin/git", "apply", "--verbose", join(task, "original/test.patch")], evaluationDeadline, [0]);
    await execute("grading-identities", [runtime, "-I", helper, "grading-snapshot", task, workspace], evaluationDeadline, [0]);
    await execute("pytest", [python, "-I", helper, "pytest", task, workspace, "-rA", "tests/test_utils.py"], evaluationDeadline);
    await execute("score", [runtime, "-I", helper, "score", task, workspace], performance.now() + 120000, [0]);
    const { passed, failed, total, ...evidence } = await Bun.file(join(home, "grade.json")).json();
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed, failed, total,
      evidence: { ...evidence, acquired, commands,
        limits: { evaluationMs: 1800000, setupMs: 600000, scoringMs: 120000, adapterMs: 2520000, outputBytesPerPipe: 16_000_000 },
        equivalence: "native macOS arm64 criterion only; no original installation, container, historical deadline, Python 3.8, Linux, TLS, paid-proxy or OS network confinement equivalence" },
    }, null, 2) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter process ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
