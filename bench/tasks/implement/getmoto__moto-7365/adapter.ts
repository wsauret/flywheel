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

/** Capture one owned command. Only the original pytest lifecycle treats timeout
 * as a candidate outcome; acquisition and setup failures remain infrastructure. */
export async function executeMotoCommand(
  run: OwnedCommandRunner, workspace: string, label: string, command: readonly string[],
  timeoutMs = 600000, allowed = [0],
) {
  const start = performance.now();
  const result = await runSandboxCommand(
    (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
    command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
  );
  const { stdoutBytes: _bytes, ...captured } = result;
  const record = { ...captured, command, durationMs: Math.round(performance.now() - start) };
  await Bun.write(join(workspace, ".bench-home", `${label}.command.json`), JSON.stringify(record, null, 2));
  if ((label !== "pytest" && result.timedOut) ||
      (!result.timedOut && !allowed.includes(result.exitCode ?? -1)) ||
      result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`Moto ${label} failed: exit ${result.exitCode}, timeout ${result.timedOut}, output must be complete`);
  }
  return record;
}

/** Reconstruct pinned public source and runtime. Grade captured code only after
 * restoring original grading authority. Candidate import failures reach the
 * unchanged selected-test grader; provisioning failures remain infrastructure. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This public runtime and wheel set requires macOS arm64");
  }
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  await mkdir(join(home, "wheels"), { recursive: true });
  await mkdir(join(home, "inputs"), { recursive: true });
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1",
    PIP_CONFIG_FILE: "/dev/null", PIP_NO_CACHE_DIR: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    MOTO_TEST_ALLOW_AWS_REQUEST: "false", TEST_SERVER_MODE: "false", AWS_EC2_METADATA_DISABLED: "true",
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
  async function execute(label: string, command: readonly string[], timeoutMs = 600000, allowed = [0]): Promise<void> {
    commands[label] = await executeMotoCommand(run, workspace, label, command, timeoutMs, allowed);
  }
  try {
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    for (const input of inputs) {
      if (action === "prepare" && ["inputs/constants.py", "inputs/log_parsers.py", "inputs/grading.py"].includes(input.file)) continue;
      const response = await fetch(input.url);
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
      if (["inputs/constants.py", "inputs/log_parsers.py", "inputs/grading.py"].includes(input.file)) {
        const original = await Bun.file(join(task, "original", input.file.slice("inputs/".length))).bytes();
        if (Bun.CryptoHasher.hash("sha256", original, "hex") !== sha256) throw new Error("Original grader identity mismatch");
      }
      acquired.push({ ...input, status: response.status, bytes, sha256 });
    }
    // The exact pinned archive was inspected, including its relative runtime links.
    await execute("runtime-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/python.tar.gz"), "-C", home]);
    const runtime = join(home, "python/bin/python3.12");
    const python = join(home, "venv/bin/python");
    const helper = join(task, "native-support.py");
    await execute("extract", [runtime, "-I", helper, "extract", task, workspace]);
    if (action === "grade") {
      await execute("git-init", ["/usr/bin/git", "init", "-q"]);
      const patch = artifacts[0]!;
      if ((await stat(patch)).size) await execute("candidate-patch", ["/usr/bin/git", "apply", "--verbose", resolve(patch)]);
      await execute("restore", [runtime, "-I", helper, "restore", task, workspace]);
    }
    await execute("venv", [runtime, "-I", "-m", "venv", join(home, "venv")]);
    await execute("packages", [python, "-I", "-m", "pip", "install", "--no-index", "--find-links", join(home, "wheels"),
      "--require-hashes", "-r", join(task, "requirements-hashed.txt")]);
    await execute("pip-check", [python, "-I", "-m", "pip", "check"]);
    await execute("snapshot", [python, "-I", helper, "snapshot", task, workspace]);
    if (action === "prepare") return;
    await execute("test-patch", ["/usr/bin/git", "apply", "--verbose", join(task, "original/test.patch")]);
    await execute("grading-identities", [runtime, "-I", helper, "grading-snapshot", task, workspace]);
    await execute("pytest", [python, "-I", helper, "pytest", task, workspace, "-n0", "-rA",
      "tests/test_dynamodb/test_dynamodb_update_expressions.py"], 300000, [0, 1, 2, 3, 4, 5]);
    await execute("score", [runtime, "-I", helper, "score", task, workspace]);
    const { passed, failed, total, ...evidence } = await Bun.file(join(home, "grade.json")).json();
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed, failed, total,
      evidence: { ...evidence, acquired, commands, limits: { pytestMs: 300000, outputBytesPerPipe: 16_000_000 },
        equivalence: "native macOS arm64 only; no original container, leaderboard, or OS network confinement claim" },
    }, null, 2) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter process ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
