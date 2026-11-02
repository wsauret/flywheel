import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput { file: string; url: string; bytes: number; sha256: string }
interface SourceManifest { files: { path: string; sha256: string }[] }
interface Replacement { original: string; adapted: string; count: number }
const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

/** Capture complete owned output. Original evaluation expiry produces no report;
 * completed nonzero evaluation exits remain input to the original scorer. */
export async function executeRedisCommand(
  run: OwnedCommandRunner, workspace: string, label: string,
  command: readonly string[], timeoutMs: number, policy: "setup" | "evaluation" | "diagnostic" = "setup",
) {
  const started = performance.now();
  const result = await runSandboxCommand(
    (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
    command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
  );
  const { stdoutBytes: _bytes, ...captured } = result;
  const record = { ...captured, command, durationMs: Math.round(performance.now() - started) };
  // Evaluation output stays in its workspace log until the original scorer finishes.
  if (policy !== "evaluation") await Bun.write(join(workspace, ".bench-home", `${label}.command.json`), JSON.stringify(record, null, 2));
  if (policy !== "diagnostic" && result.timedOut) throw new Error(`${label} timed out; original evaluation produces no report`);
  if (policy !== "diagnostic" && (result.stdoutTruncated || result.stderrTruncated)) throw new Error(`${label} output is incomplete`);
  if (policy === "setup" && result.exitCode !== 0) throw new Error(`${label} failed: exit ${result.exitCode}`);
  return record;
}

/** Prepare public BASE without Git history or hidden tests. Grade captured edits
 * in fresh BASE under the whole original evaluation's one 1800-second ceiling. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This fixture requires native macOS arm64");
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  for (const path of ["inputs", "bin", "tmp"]) await mkdir(join(home, path), { recursive: true });
  const supervisor = createProcessSupervisor();
  const scope = createLauncherScope(supervisor);
  let evaluationWriter: ReturnType<ReturnType<typeof Bun.file>["writer"]> | undefined;
  const evaluationOutput = {
    stdoutIdentity: { bytes: 0, sha256: "" },
    stderrIdentity: { bytes: 0, sha256: "" },
  };
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, options);
      const tee = (output: NodeJS.WriteStream, identity: { bytes: number; sha256: string }) => {
        const writer = evaluationWriter;
        const hasher = new Bun.CryptoHasher("sha256");
        return new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (writer) {
              writer.write(chunk);
              hasher.update(chunk);
              identity.bytes += chunk.byteLength;
            }
            output.write(chunk);
            controller.enqueue(chunk);
          },
          flush() { if (writer) identity.sha256 = hasher.digest("hex"); },
        });
      };
      return { ...owned, stdout: owned.stdout?.pipeThrough(tee(process.stdout, evaluationOutput.stdoutIdentity)),
        stderr: owned.stderr?.pipeThrough(tee(process.stderr, evaluationOutput.stderrIdentity)) };
    },
  });
  const commands: Record<string, unknown> = {};
  const setupDeadline = performance.now() + 600000;
  const execute = async (label: string, command: readonly string[], deadline = setupDeadline, policy: "setup" | "evaluation" | "diagnostic" = "setup") => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error(`${label} allowance expired`);
    const record = await executeRedisCommand(run, workspace, label, command, remaining, policy);
    if (policy !== "evaluation") commands[label] = record;
    return record;
  };
  try {
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    for (const input of inputs.filter(row => action === "grade" || row.file === "inputs/redis.tar.gz")) {
      const remaining = Math.ceil(setupDeadline - performance.now());
      if (remaining <= 0) throw new Error("public acquisition allowance expired");
      const response = await fetch(input.url, { signal: AbortSignal.timeout(remaining) });
      if (!response.ok || !response.body) throw new Error(`public acquisition failed: HTTP ${response.status}`);
      const writer = Bun.file(join(home, input.file)).writer();
      const hasher = new Bun.CryptoHasher("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          hasher.update(chunk); writer.write(chunk); bytes += chunk.byteLength;
        }
      } finally { await writer.end(); }
      const sha256 = hasher.digest("hex");
      if (bytes !== input.bytes || sha256 !== input.sha256) throw new Error(`public identity mismatch: ${input.file}`);
      acquired.push({ ...input, status: response.status });
    }
    await execute("source-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/redis.tar.gz"), "--strip-components=1", "-C", workspace]);
    const manifest: SourceManifest = await Bun.file(join(task, "source-manifest.json")).json();
    for (const file of manifest.files) {
      if (hash(await Bun.file(join(workspace, file.path)).bytes()) !== file.sha256) throw new Error(`source identity mismatch: ${file.path}`);
    }
    await rm(join(home, "inputs/redis.tar.gz"));
    await execute("compiler-version", ["/usr/bin/clang", "--version"]);
    await execute("make-version", ["/usr/bin/make", "--version"]);
    await execute("tcl-version", ["/bin/bash", "-c", "/usr/bin/tclsh8.5 <<< 'puts [info patchlevel]'"]);
    await execute("git-version", ["/usr/bin/git", "--version"]);
    const build = join(home, "bin/build");
    await Bun.write(build, await Bun.file(join(task, "native-build.sh")).bytes());
    await chmod(build, 0o755);
    await Bun.write(join(home, "setup.json"), JSON.stringify({ acquired, commands, sourceFiles: manifest.files.length,
      sourceManifestSha256: hash(await Bun.file(join(task, "source-manifest.json")).bytes()), nativeBuildSha256: hash(await Bun.file(build).bytes()) }, null, 2));
    if (action === "prepare") return;
    const pythonRoot = join(home, "python");
    await mkdir(pythonRoot);
    await execute("python-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/python.tar.gz"), "--strip-components=1", "-C", pythonRoot]);
    await rm(join(home, "inputs/python.tar.gz"));
    const python = join(pythonRoot, "bin/python3");
    await execute("python-version", [python, "--version"]);
    // Match the provisioner's baseline before applying captured .gitignore edits.
    const ignore = join(workspace, ".gitignore");
    await Bun.write(ignore, (await Bun.file(ignore).text()) + "\n.flywheel/\n.bench-home/\n");
    await execute("git-init", ["/usr/bin/git", "init", "-q"]);
    await execute("git-add", ["/usr/bin/git", "add", "-A"]);
    await execute("git-baseline", ["/usr/bin/git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "fixture"]);
    const base = (await execute("git-base", ["/usr/bin/git", "rev-parse", "HEAD"])).stdout.trim();
    if ((await stat(artifacts[0]!)).size) await execute("candidate-patch", ["/usr/bin/git", "apply", resolve(artifacts[0]!)]);
    const original = await Bun.file(join(task, "original/eval.sh")).text();
    const replacementLedger: { shell: Replacement[]; scorerInput: { change: string; evidence: string; policy: string } } =
      await Bun.file(join(task, "replacement-ledger.json")).json();
    let adapted = original;
    const applied = [];
    for (const row of replacementLedger.shell) {
      const count = adapted.split(row.original).length - 1;
      if (count !== row.count) throw new Error("evaluation replacement count mismatch");
      const replacement = row.adapted.replaceAll("$BASE", base);
      adapted = adapted.replaceAll(row.original, replacement);
      applied.push({ ...row, adapted: replacement, replacements: count });
    }
    const evalPath = join(home, "eval.sh");
    await Bun.write(evalPath, adapted);
    const logPath = join(home, "evaluation.log");
    evaluationWriter = Bun.file(logPath).writer();
    let evaluation;
    try {
      evaluation = await execute("evaluation", ["/bin/bash", evalPath], performance.now() + 1800000, "evaluation");
    } finally {
      await evaluationWriter.end();
      evaluationWriter = undefined;
    }
    const { stdout: _stdout, stderr: _stderr, ...evaluationMetadata } = evaluation;
    const evaluationDiagnostics = { ...evaluationMetadata, ...evaluationOutput };
    commands.evaluation = evaluationDiagnostics;
    await Bun.write(join(home, "evaluation.command.json"), JSON.stringify(evaluationDiagnostics, null, 2));
    const scorerLogPath = join(home, "evaluation.utf8.log");
    const scorerWriter = Bun.file(scorerLogPath).writer();
    const decoder = new TextDecoder();
    const scorerHasher = new Bun.CryptoHasher("sha256");
    let scorerBytes = 0;
    const writeScorerText = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      scorerWriter.write(bytes);
      scorerHasher.update(bytes);
      scorerBytes += bytes.length;
    };
    try {
      for await (const chunk of Bun.file(logPath).stream()) writeScorerText(decoder.decode(chunk, { stream: true }));
      writeScorerText(decoder.decode());
    } finally { await scorerWriter.end(); }
    const scorerInputLog = { bytes: scorerBytes, sha256: scorerHasher.digest("hex") };
    const parsedPath = join(home, "parsed.json");
    await execute("score", [python, join(task, "grade.py"), task, scorerLogPath, resolve(artifacts[0]!), parsedPath], performance.now() + 60000);
    const parsed = await Bun.file(parsedPath).json();
    const reward = Number(parsed.report["redis__redis-10068"].resolved);
    const logBytes = await Bun.file(logPath).bytes();
    const completeEvaluationLog = { bytes: logBytes.length, sha256: hash(logBytes) };
    const completeLog = new TextDecoder().decode(logBytes);
    const start = completeLog.indexOf(">>>>> Start Test Output");
    const end = completeLog.indexOf(">>>>> End Test Output", start);
    const evaluationLog = start >= 0 && end >= start
      ? completeLog.slice(start, end + ">>>>> End Test Output".length) : "";
    // A completed failed source build can leave no binary. Diagnostics do not
    // override the original scorer's unresolved result for that execution.
    const binaryPath = join(workspace, "src/redis-server");
    let binaryVersion: string | null = null;
    let binaryDiagnosticError: string | null = null;
    try {
      if (await Bun.file(binaryPath).exists()) {
        binaryVersion = (await execute("redis-version", [binaryPath, "--version"], performance.now() + 60000, "diagnostic")).stdout;
      }
    } catch (error) { binaryDiagnosticError = error instanceof Error ? error.name : "diagnostic unavailable"; }
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed: reward, failed: 1 - reward, total: 1,
      evidence: { acquired, commands, parsed, evaluationExit: evaluation.exitCode, sourceFiles: manifest.files.length,
        originalEvalSha256: hash(new TextEncoder().encode(original)), adaptedEvalSha256: hash(new TextEncoder().encode(adapted)),
        replacements: applied, mappedBase: base, binaryVersion, binaryDiagnosticError,
        evaluationLog, completeEvaluationLog, scorerInputLog, logRepresentation: replacementLedger.scorerInput,
        limits: { setupMs: 600000, wholeEvaluationMs: 1800000, scoringMs: 60000, diagnosticsMs: 60000, settlementMs: 60000, adapterMs: 2580000, candidateMs: 1500000 },
        equivalence: "native macOS arm64 and pinned current official scorer only; no original Docker image, historical harness, resource limits, leaderboard or OS network confinement claim" },
    }, null, 2) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
