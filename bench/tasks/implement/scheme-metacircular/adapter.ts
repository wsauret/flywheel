import { $ } from "bun";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
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

/** Prepare only the original candidate context, or reconstruct and grade captured code.
 * Infrastructure failures throw. The original pytest status and reward own acceptance;
 * program and subprocess observations do not impose extra admission criteria. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Scheme native qualification requires macOS arm64");
  }
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  const runtime = join(home, "runtime");
  const wheels = join(home, "wheels");
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
  let metaAliasDirectory: string | undefined;
  async function execute(label: string, command: readonly string[], timeoutMs = 600000, requireSuccess = true) {
    const started = performance.now();
    const result = await runSandboxCommand(
      (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
      command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
    );
    const { stdoutBytes: _stdoutBytes, ...captured } = result;
    commands[label] = { ...captured, command, durationMs: Math.round(performance.now() - started) };
    if (result.stdoutTruncated || result.stderrTruncated || (requireSuccess && (result.timedOut || result.exitCode !== 0))) {
      throw new Error(`Scheme ${label} failed: exit ${result.exitCode}, timeout ${result.timedOut}, output must be complete`);
    }
    return commands[label]!;
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
    // This hash-pinned archive has only regular files and eight confined relative symlinks.
    await execute("extract", ["tar", "-xzf", join(home, inputs[0]!.filename), "-C", runtime]);
    await execute("venv", [join(runtime, "python/bin/python3"), "-I", "-m", "venv", "--symlinks", join(home, "python")]);
    await execute("packages", [python, "-I", "-m", "pip", "install", "--no-index", "--no-deps",
      ...inputs.slice(1).map(input => join(wheels, input.filename))]);
    await execute("versions", [python, "-I", "-c",
      "import sys,json,importlib.metadata as m; print(json.dumps({'python':sys.version,'packages':{n:m.version(n) for n in sys.argv[1:]}}))",
      ...inputs.slice(1).map(input => input.name!)]);
    await copyFile(join(task, "original/environment/tests/interp.py"), join(workspace, "interp.py"));
    await cp(join(task, "original/environment/tests/test"), join(workspace, "test"), { recursive: true });
    await copyFile(join(task, "LICENSE"), join(workspace, "LICENSE"));
    await Bun.write(join(home, "provision.json"), JSON.stringify({ acquired, commands }, null, 2));
    if (action === "prepare") return;
    await execute("git-init", ["git", "init", "-q"]);
    if ((await stat(artifacts[0]!)).size) {
      await execute("candidate-patch", ["git", "apply", "--verbose", resolve(artifacts[0]!)]);
    }
    await copyFile(join(task, "original/environment/tests/interp.py"), join(workspace, "interp.py"));
    await rm(join(workspace, "test"), { recursive: true, force: true });
    await cp(join(task, "original/environment/tests/test"), join(workspace, "test"), { recursive: true });
    const tests = join(home, "verifier/tests");
    const logs = join(home, "verifier/logs");
    await cp(join(task, "original/tests"), tests, { recursive: true });
    await mkdir(logs, { recursive: true });
    // Pytest discovers configuration and conftest files through the selected test's ancestors.
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
    const replacements: { file: string; original: string; native: string; occurrences: number }[] = [];
    function replace(file: string, text: string, original: string, native: string) {
      const occurrences = text.split(original).length - 1;
      if (!occurrences) throw new Error(`original replacement absent in ${file}`);
      replacements.push({ file, original, native, occurrences });
      return text.replaceAll(original, native);
    }
    let test = await readFile(join(task, "original/tests/test_outputs.py"), "utf8");
    let metaEvaluator = join(workspace, "eval.scm");
    if (/[\s()';"]/.test(metaEvaluator)) {
      // Upstream feeds the bare line "/app/eval.scm", which both (read) and a line read take whole.
      // A path that a Scheme reader would split gets a scoped macOS alias with the same file authority.
      metaAliasDirectory = await mkdtemp("/private/tmp/scheme-meta-");
      metaEvaluator = join(metaAliasDirectory, "eval.scm");
      await symlink(join(workspace, "eval.scm"), metaEvaluator);
    }
    test = replace("test_outputs.py", test, '"/app/eval.scm\\n"', JSON.stringify(`${metaEvaluator}\n`));
    test = replace("test_outputs.py", test, '"/app/eval.scm"', JSON.stringify(join(workspace, "eval.scm")));
    test = replace("test_outputs.py", test, '"/tests/test"', JSON.stringify(join(tests, "test")));
    test = replace("test_outputs.py", test, '"/tests/shadow_test"', JSON.stringify(join(tests, "shadow_test")));
    await Bun.write(join(tests, "test_outputs.py"), test);
    const originalShell = await readFile(join(task, "original/tests/test.sh"), "utf8");
    const marker = "uvx \\\n  -p 3.13 \\\n  -w pytest==8.4.1 \\\n  -w pytest-json-ctrf==0.3.5 \\\n  pytest";
    const prefixEnd = originalShell.indexOf(marker);
    if (prefixEnd < 0) throw new Error("original verifier command absent");
    replacements.push({ file: "test.sh", original: originalShell.slice(0, prefixEnd), native: "", occurrences: 1 });
    let shell = originalShell.slice(prefixEnd);
    shell = replace("test.sh", shell, marker, `${$.escape(python)} -I ${$.escape(join(home, "python/bin/pytest"))}`);
    shell = replace("test.sh", shell, "/logs/verifier/ctrf.json", $.escape(join(logs, "ctrf.json")));
    shell = replace("test.sh", shell, "/logs/verifier/reward.txt", $.escape(join(logs, "reward.txt")));
    shell = replace("test.sh", shell, "/tests/test_outputs.py", $.escape(join(tests, "test_outputs.py")));
    await Bun.write(join(tests, "native-test.sh"), shell);
    const instrumentation = (await readFile(join(task, "observe.py"), "utf8"))
      .replace("__OBSERVATIONS__", JSON.stringify(join(logs, "subprocess-records.jsonl")));
    await Bun.write(join(tests, "conftest.py"), instrumentation);
    const grader = await execute("verifier", ["/bin/bash", "-x", join(tests, "native-test.sh")], 2400000, false);
    const checks = [...grader.stderr.matchAll(/^\+ '\[' (\d+) -eq 0 '\]'$/gm)];
    const pytestExitCode = checks.length === 1 ? Number(checks[0]![1]) : null;
    const reward = await Bun.file(join(logs, "reward.txt")).exists()
      ? (await Bun.file(join(logs, "reward.txt")).text()).trim() : null;
    if (grader.timedOut || grader.exitCode !== 0 || pytestExitCode === null ||
      (reward !== "0" && reward !== "1") || reward !== (pytestExitCode === 0 ? "1" : "0")) {
      throw new Error("Scheme verifier did not settle with consistent original pytest status and reward");
    }
    const programs = [];
    for (const match of grader.stdout.matchAll(/Testing: ([^\n]+)\n-{40}\n(.*?)(?=\nTesting:|\n={50})/gs)) {
      const status = [...match[2]!.matchAll(/^(PASSED|FAILED): /gm)].at(-1)?.[1] ?? "unobserved";
      programs.push({ id: match[1]!.replace(tests, "/tests"), status, output: match[2] });
    }
    const observations = await Bun.file(join(logs, "subprocess-records.jsonl")).exists()
      ? (await Bun.file(join(logs, "subprocess-records.jsonl")).text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      : [];
    const ctrf = await Bun.file(join(logs, "ctrf.json")).exists() ? await Bun.file(join(logs, "ctrf.json")).json() : null;
    if (!ctrf || !Array.isArray(ctrf.results?.tests) || !ctrf.results?.summary ||
      ctrf.results?.tool?.name !== "pytest") {
      throw new Error("Scheme verifier did not produce its original CTRF artifact");
    }
    const restored: Record<string, string> = {};
    for (const name of ["interp.py", "test_outputs.py", "native-test.sh"]) {
      const path = name === "interp.py" ? join(workspace, name) : join(tests, name);
      Object.assign(restored, { [name]: Bun.CryptoHasher.hash("sha256", await Bun.file(path).arrayBuffer(), "hex") });
    }
    const copied: Record<string, { sha256: string }> = await Bun.file(join(task, "copy-ledger.json")).json();
    for (const source of Object.keys(copied)) {
      const candidatePrefix = "original/environment/tests/";
      const graderPrefix = "original/tests/";
      const relative = source.startsWith(candidatePrefix) ? source.slice(candidatePrefix.length)
        : source.startsWith(graderPrefix) ? source.slice(graderPrefix.length) : null;
      if (relative !== null && (relative === "interp.py" || relative.startsWith("test/") || relative.startsWith("shadow_test/"))) {
        const path = join(source.startsWith(candidatePrefix) ? workspace : tests, relative);
        // The image supplies only visible programs; its unused shadow directory is not candidate context.
        if (source.startsWith(candidatePrefix) && relative.startsWith("shadow_test/")) continue;
        restored[source] = Bun.CryptoHasher.hash("sha256", await Bun.file(path).arrayBuffer(), "hex");
      }
    }
    const passed = Number(pytestExitCode === 0 && reward === "1");
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed, failed: 1 - passed, total: 1,
      evidence: { criterion: "original pytest status and reward.txt", pytestExitCode, reward,
        programs, observations, ctrf, restored, removed, replacements, acquired, commands, metaAliasDirectory,
        limits: { directSeconds: 10, metacircularSeconds: 60, verifierMs: 2400000, adapterMs: 2700000 },
        equivalence: "native macOS arm64, not original container or cross-platform equivalence" },
    }, null, 2) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter process ownership did not settle: ${closure.reason}`);
    } finally {
      try { await supervisor.dispose(); } finally {
        if (metaAliasDirectory) await rm(metaAliasDirectory, { recursive: true, force: true });
      }
    }
  }
}

if (import.meta.main) await main();
