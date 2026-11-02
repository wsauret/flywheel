import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandResult } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput {
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** Prepare visible context or grade a captured patch in a fresh owned workspace.
 * Invalid infrastructure throws; the original API Boolean alone owns the score. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("DS-1000 native qualification requires macOS arm64");
  }
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  const runtime = join(home, "runtime");
  const wheels = join(home, "wheels");
  const python = join(home, "python/bin/python");
  const tmp = join(home, "tmp");
  for (const directory of [runtime, wheels, tmp]) await mkdir(directory, { recursive: true });
  const env = {
    PATH: `${join(home, "python/bin")}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    PIP_NO_INDEX: "1", PIP_NO_CACHE_DIR: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1",
    TMPDIR: tmp,
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
  async function execute(label: string, command: readonly string[], timeoutMs = 600000) {
    const started = performance.now();
    const result = await runSandboxCommand(
      (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
      command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
    );
    const { stdoutBytes: _stdoutBytes, ...captured } = result;
    commands[label] = { ...captured, command, durationMs: Math.round(performance.now() - started) };
    if (result.stdoutTruncated || result.stderrTruncated || result.timedOut || result.exitCode !== 0) {
      throw new Error(`DS-1000 ${label} failed: exit ${result.exitCode}, timeout ${result.timedOut}; output must be complete`);
    }
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
      acquired.push({ ...input, status: response.status, bytes, sha256 });
    }
    await execute("extract", ["tar", "-xzf", join(home, inputs[0]!.filename), "-C", runtime]);
    await execute("venv", [join(runtime, "python/bin/python3.10"), "-I", "-m", "venv", join(home, "python")]);
    await execute("packages", [python, "-I", "-m", "pip", "install", "--no-index", "--no-cache-dir", "--no-deps",
      ...inputs.slice(1).map(input => join(wheels, input.filename))]);
    await execute("versions", [python, "-I", "-c",
      "import sys,numpy,json; print(json.dumps({'python':sys.version,'numpy':numpy.__version__,'executable':sys.executable,'numpyPath':numpy.__file__}))"]);
    await Bun.write(join(workspace, "prompt.txt"), Bun.gunzipSync(await Bun.file(join(task, "original/prompt.txt.gz")).bytes()));
    for (const name of ["LICENSE", "NOTICE.txt", "cc-by-sa-3.0.txt", "cc-by-sa-4.0.txt"]) {
      await copyFile(join(task, "licenses", name), join(workspace, name));
    }
    await Bun.write(join(home, "provision.json"), JSON.stringify({ acquired, commands }, null, 2) + "\n");
    if (action === "prepare") return;
    await execute("git-init", ["git", "init", "-q"]);
    if ((await stat(artifacts[0]!)).size) {
      await execute("candidate-patch", ["git", "apply", "--verbose", resolve(artifacts[0]!)]);
    }
    // Capture excludes .bench-home. Restore all grading authorities after patch application.
    const grader = join(home, "grader");
    await rm(grader, { recursive: true, force: true });
    await mkdir(grader, { recursive: true });
    for (const name of ["execution.py", "test_ds1000.py"]) {
      await copyFile(join(task, "original", name), join(grader, name));
    }
    for (const name of ["record.json", "code_context.py"]) {
      await Bun.write(join(grader, name), Bun.gunzipSync(await Bun.file(join(task, "original", `${name}.gz`)).bytes()));
    }
    await copyFile(join(task, "grade.py"), join(grader, "grade.py"));
    const resultPath = join(grader, "result.json");
    const spec = join(grader, "spec.json");
    await Bun.write(spec, JSON.stringify({ workspace, resultPath }));
    await execute("verifier", [python, "-I", join(grader, "grade.py"), spec], 150000);
    const official = await Bun.file(resultPath).json();
    if (typeof official.official?.passed !== "boolean" || official.official.completion_id !== 298) {
      throw new Error("Invalid original API report");
    }
    const ledger: Record<string, { decompressedSha256: string; sha256: string }> = await Bun.file(join(task, "copy-ledger.json")).json();
    for (const name of ["execution.py", "test_ds1000.py", "record.json", "code_context.py"]) {
      const key = `original/${name}${name === "record.json" || name === "code_context.py" ? ".gz" : ""}`;
      const expected = ledger[key]!;
      if (official.authority[name] !== (expected.decompressedSha256 ?? expected.sha256)) {
        throw new Error(`Grading authority changed: ${name}`);
      }
    }
    const passed = Number(official.official.passed);
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed, failed: 1 - passed, total: 1,
      evidence: { criterion: "execution.check_correctness(...).passed", official, acquired, commands,
        limits: { modelMs: 1500000, originalSeconds: 120, graderOuterMs: 150000, adapterMs: 900000 },
        equivalence: "native macOS arm64 only; no OS confinement or leaderboard equivalence claim" },
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
