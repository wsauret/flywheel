import { $ } from "bun";
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandResult } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput {
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
  name?: string;
  version?: string;
}

/** Prepare the original candidate context or grade a captured patch in a fresh workspace.
 * Infrastructure failures throw; original pytest status and reward jointly own acceptance. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Chess native qualification requires macOS arm64");
  }
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  const runtime = join(home, "runtime");
  const wheels = join(home, "inputs");
  await mkdir(runtime, { recursive: true });
  await mkdir(wheels, { recursive: true });
  const python = join(home, "python/bin/python");
  const env = {
    PATH: `${join(home, "python/bin")}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONNOUSERSITE: "1", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_CACHE_DIR: join(home, "pip-cache"),
  };
  const supervisor = createProcessSupervisor();
  const scope = createLauncherScope(supervisor);
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, { ...options, env: { ...options?.env, ...env } });
      return { ...owned,
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
  async function execute(label: string, command: readonly string[], timeoutMs = 600000, requireSuccess = true) {
    const started = performance.now();
    const result = await runSandboxCommand(
      (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
      command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
    );
    const { stdoutBytes: _stdoutBytes, ...captured } = result;
    commands[label] = { ...captured, command, durationMs: Math.round(performance.now() - started) };
    if (result.stdoutTruncated || result.stderrTruncated || (requireSuccess && (result.timedOut || result.exitCode !== 0))) {
      throw new Error(`Chess ${label} failed: exit ${result.exitCode}, timeout ${result.timedOut}, output must be complete`);
    }
    return commands[label]!;
  }
  const replacements: { file: string; original: string; native: string; occurrences: number }[] = [];
  function replace(file: string, text: string, original: string, native: string) {
    const occurrences = text.split(original).length - 1;
    if (!occurrences) throw new Error(`original replacement absent in ${file}`);
    replacements.push({ file, original, native, occurrences });
    return text.replaceAll(original, native);
  }
  try {
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    for (const [index, input] of inputs.entries()) {
      const response = await fetch(input.url);
      if (!response.ok || !response.body) throw new Error(`Public input acquisition failed: HTTP ${response.status}`);
      const writer = Bun.file(join(index === 0 ? home : wheels, input.filename)).writer();
      const hasher = new Bun.CryptoHasher("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          writer.write(chunk);
          hasher.update(chunk);
          bytes += chunk.byteLength;
        }
      } finally {
        await writer.end();
      }
      const sha256 = hasher.digest("hex");
      if (bytes !== input.bytes || sha256 !== input.sha256) throw new Error(`Public input identity mismatch: ${input.filename}`);
      acquired.push({ ...input, status: response.status, sha256, bytes });
    }
    // The pinned archive was inspected: only regular files and confined relative symlinks.
    await execute("extract", ["tar", "-xzf", join(home, inputs[0]!.filename), "-C", runtime]);
    await execute("venv", [join(runtime, "python/bin/python3"), "-I", "-m", "venv", "--symlinks", join(home, "python")]);
    await execute("packages", [python, "-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-cache-dir", "--no-deps",
      ...inputs.slice(1, 7).map(input => join(wheels, input.filename))]);
    // Setuptools expands the venv prefix as variables; wheel staging needs only a relative prefix.
    await execute("chess", [python, "-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-cache-dir",
      "--config-settings=--build-option=install", "--config-settings=--build-option=--prefix=.",
      "--find-links", wheels, join(wheels, inputs[7]!.filename)]);
    await execute("package-check", [python, "-I", "-m", "pip", "--isolated", "check"]);
    await execute("versions", [python, "-I", "-c",
      "import sys,json,importlib.metadata as m; print(json.dumps({'python':sys.version,'packages':{n:m.version(n) for n in sys.argv[1:]}}))",
      ...inputs.slice(1, 8).map(input => input.name!)]);
    const checker = replace("check.py", await readFile(join(task, "original/environment/check.py"), "utf8"),
      '"/app/re.json"', JSON.stringify(join(workspace, "re.json")));
    await Bun.write(join(workspace, "check.py"), checker);
    await Bun.write(join(home, "provision.json"), JSON.stringify({ acquired, commands, replacements }, null, 2));
    if (action === "prepare") return;
    await execute("git-init", ["git", "init", "-q"]);
    if ((await stat(artifacts[0]!)).size) {
      // The supplied checker's absolute path differs in the fresh grade workspace.
      // It is grading authority, so candidate changes to it are not applied.
      await execute("candidate-patch", ["git", "apply", "--verbose", "--exclude=check.py", resolve(artifacts[0]!)]);
    }
    await Bun.write(join(workspace, "check.py"), checker);
    const tests = join(home, "verifier/tests");
    const logs = join(home, "verifier/logs");
    await cp(join(task, "original/tests"), tests, { recursive: true });
    await mkdir(logs, { recursive: true });
    // Pytest reads discovery configuration through the selected test's ancestors.
    const removed = [];
    for (const directory of [workspace, home, join(home, "verifier")]) {
      for (const name of ["conftest.py", "pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"]) {
        const path = join(directory, name);
        if (await Bun.file(path).exists()) {
          removed.push(path);
          await rm(path);
        }
      }
    }
    const test = replace("test_outputs.py", await readFile(join(task, "original/tests/test_outputs.py"), "utf8"),
      '"/app/re.json"', JSON.stringify(join(workspace, "re.json")));
    await Bun.write(join(tests, "test_outputs.py"), test);
    const originalShell = await readFile(join(task, "original/tests/test.sh"), "utf8");
    const marker = "uvx \\\n  -p 3.13 \\\n  -w pytest==8.4.1 \\\n  -w chess==1.11.2 \\\n  -w pytest-json-ctrf==0.3.5 \\\n  pytest";
    const prefixEnd = originalShell.indexOf(marker);
    if (prefixEnd < 0) throw new Error("original verifier command absent");
    replacements.push({ file: "test.sh", original: originalShell.slice(0, prefixEnd), native: "", occurrences: 1 });
    let shell = originalShell.slice(prefixEnd);
    shell = replace("test.sh", shell, marker, `${$.escape(python)} -I ${$.escape(join(home, "python/bin/pytest"))}`);
    shell = replace("test.sh", shell, "/logs/verifier/ctrf.json", $.escape(join(logs, "ctrf.json")));
    shell = replace("test.sh", shell, "/logs/verifier/reward.txt", $.escape(join(logs, "reward.txt")));
    shell = replace("test.sh", shell, "/tests/test_outputs.py", $.escape(join(tests, "test_outputs.py")));
    await Bun.write(join(tests, "native-test.sh"), shell);
    const grader = await execute("verifier", ["/bin/bash", "-x", join(tests, "native-test.sh")], 3600000, false);
    const checks = [...grader.stderr.matchAll(/^\+ '\[' (\d+) -eq 0 '\]'$/gm)];
    const pytestExitCode = checks.length === 1 ? Number(checks[0]![1]) : null;
    const reward = await Bun.file(join(logs, "reward.txt")).exists()
      ? (await Bun.file(join(logs, "reward.txt")).text()).trim() : null;
    if (grader.timedOut || grader.exitCode !== 0 || pytestExitCode === null ||
      (reward !== "0" && reward !== "1") || reward !== (pytestExitCode === 0 ? "1" : "0")) {
      throw new Error("Chess verifier did not settle with consistent original pytest status and reward");
    }
    const ctrf = await Bun.file(join(logs, "ctrf.json")).exists() ? await Bun.file(join(logs, "ctrf.json")).json() : null;
    if (!ctrf || !Array.isArray(ctrf.results?.tests) || !ctrf.results?.summary || ctrf.results?.tool?.name !== "pytest") {
      throw new Error("Chess verifier did not produce its original CTRF artifact");
    }
    const positions = [...grader.stdout.matchAll(/^Position: (.*), Our moves: (\d+), Python-chess moves: (\d+)$/gm)]
      .map(match => ({ fen: match[1], generated: Number(match[2]), oracle: Number(match[3]) }));
    const groups = [...grader.stdout.matchAll(/^Successfully tested (\d+) positions from (.*) \((\d+) moves\)$/gm)]
      .map(match => ({ positions: Number(match[1]), game: match[2], moves: Number(match[3]) }));
    const statuses = [...grader.stdout.matchAll(/^(PASSED|FAILED) .*test_outputs.py::([^\s]+)/gm)]
      .map(match => ({ id: match[2], status: match[1] }));
    const restored = {
      "check.py": Bun.CryptoHasher.hash("sha256", await Bun.file(join(workspace, "check.py")).arrayBuffer(), "hex"),
      "test_outputs.py": Bun.CryptoHasher.hash("sha256", await Bun.file(join(tests, "test_outputs.py")).arrayBuffer(), "hex"),
      "native-test.sh": Bun.CryptoHasher.hash("sha256", await Bun.file(join(tests, "native-test.sh")).arrayBuffer(), "hex"),
    };
    const passed = Number(pytestExitCode === 0 && reward === "1");
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed, failed: 1 - passed, total: 1,
      evidence: { criterion: "original pytest status and reward.txt", pytestExitCode, reward,
        statuses, positions, groups, ctrf, restored, removed, replacements, acquired, commands,
        limits: { verifierMs: 3600000, adapterMs: 3900000 },
        equivalence: "native macOS arm64 only; no original environment or cross-platform equivalence claim" },
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
