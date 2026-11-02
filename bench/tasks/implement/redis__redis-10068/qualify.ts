import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";
import { executeRedisCommand } from "./adapter.js";

/** Prove public provision, ordinary candidate tooling, capture, original grading
 * and owned cleanup without a model. The evidence directory is caller-owned. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "redis__redis-10068");
  assert.ok(task?.kind === "native");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  await mkdir(output, { recursive: true });
  const temporary = join(output, "owned tmp $ ' \"");
  await mkdir(temporary);
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const copies: Record<string, { bytes: number; sha256: string }> = await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  for (const [file, identity] of Object.entries(copies)) {
    const bytes: Uint8Array = await Bun.file(join(task.taskDir, file)).bytes();
    assert.equal(bytes.length, identity.bytes);
    assert.equal(hash(bytes), identity.sha256);
  }
  const row = await Bun.file(join(task.taskDir, "original/row.json")).json();
  assert.equal(task.instruction, row.problem_statement);
  assert.equal(row.hints_text, "");
  assert.equal(task.timeoutMs, 1500000);
  assert.equal(row.FAIL_TO_PASS.length, 1);
  assert.equal(row.PASS_TO_PASS.length, 7);
  const manifest: { files: { path: string; sha256: string }[] } = await Bun.file(join(task.taskDir, "source-manifest.json")).json();
  const supervisor = createProcessSupervisor();
  const scope = createLauncherScope(supervisor);
  let adapterWriters: { stdout: ReturnType<ReturnType<typeof Bun.file>["writer"]>; stderr: ReturnType<ReturnType<typeof Bun.file>["writer"]> } | undefined;
  let captureProof: { reportBytes: number; completeLogBytes: number; testRegionBytes: number; identitiesVerified: boolean } | undefined;
  const ownedRun = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, options);
      const tee = (output: NodeJS.WriteStream, writer?: ReturnType<ReturnType<typeof Bun.file>["writer"]>) => new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { writer?.write(chunk); output.write(chunk); controller.enqueue(chunk); },
      });
      return { ...owned, stdout: owned.stdout?.pipeThrough(tee(process.stdout, adapterWriters?.stdout)),
        stderr: owned.stderr?.pipeThrough(tee(process.stderr, adapterWriters?.stderr)) };
    },
  });
  const run: typeof ownedRun = async (command, options) => {
    if (command[task.native.command.length] !== "grade") return ownedRun(command, options);
    const workspace = command[task.native.command.length + 2]!;
    const home = join(workspace, ".bench-home");
    await mkdir(home, { recursive: true });
    const stdoutPath = join(home, "qualification-adapter.stdout");
    const stderrPath = join(home, "qualification-adapter.stderr");
    adapterWriters = { stdout: Bun.file(stdoutPath).writer(), stderr: Bun.file(stderrPath).writer() };
    let result;
    try { result = await ownedRun(command, options); }
    finally {
      await Promise.all([adapterWriters.stdout.end(), adapterWriters.stderr.end()]);
      adapterWriters = undefined;
    }
    const reportBytes = await Bun.file(command[task.native.command.length + 4]!).bytes();
    const evidence = JSON.parse(new TextDecoder().decode(reportBytes)).evidence;
    const logBytes = await Bun.file(join(home, "evaluation.log")).bytes();
    assert.deepEqual(evidence.completeEvaluationLog, { bytes: logBytes.length, sha256: hash(logBytes) });
    const log = new TextDecoder().decode(logBytes);
    const scorerLogBytes = await Bun.file(join(home, "evaluation.utf8.log")).bytes();
    assert.deepEqual(evidence.scorerInputLog, { bytes: scorerLogBytes.length, sha256: hash(scorerLogBytes) });
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(scorerLogBytes), log);
    const start = log.indexOf(">>>>> Start Test Output");
    const end = log.indexOf(">>>>> End Test Output", start);
    assert.ok(start >= 0 && end > start);
    assert.equal(evidence.evaluationLog, log.slice(start, end + ">>>>> End Test Output".length));
    assert.deepEqual(evidence.parsed, await Bun.file(join(home, "parsed.json")).json());
    const evaluation = evidence.commands.evaluation;
    assert.equal("stdout" in evaluation, false);
    assert.equal("stderr" in evaluation, false);
    assert.deepEqual(evaluation, await Bun.file(join(home, "evaluation.command.json")).json());
    assert.equal(logBytes.length, evaluation.stdoutIdentity.bytes + evaluation.stderrIdentity.bytes);
    // The adapter forwards setup, evaluation, then diagnostics on each pipe.
    // Remove only the exact non-evaluation output to check the raw pipe identities.
    const commands = Object.entries(evidence.commands) as [string, { stdout?: string; stderr?: string }][];
    const evaluationIndex = commands.findIndex(([label]) => label === "evaluation");
    for (const pipe of ["stdout", "stderr"] as const) {
      const forwarded = await Bun.file(pipe === "stdout" ? stdoutPath : stderrPath).bytes();
      const prefix = new TextEncoder().encode(commands.slice(0, evaluationIndex).map(([, record]) => record[pipe] ?? "").join(""));
      const suffix = new TextEncoder().encode(commands.slice(evaluationIndex + 1).map(([, record]) => record[pipe] ?? "").join(""));
      assert.deepEqual(forwarded.subarray(0, prefix.length), prefix);
      assert.deepEqual(forwarded.subarray(forwarded.length - suffix.length), suffix);
      const raw = forwarded.subarray(prefix.length, forwarded.length - suffix.length);
      assert.deepEqual(evaluation[`${pipe}Identity`], { bytes: raw.length, sha256: hash(raw) });
    }
    assert.ok(reportBytes.length < 100000, `production report is ${reportBytes.length} bytes`);
    captureProof = { reportBytes: reportBytes.length, completeLogBytes: logBytes.length,
      testRegionBytes: new TextEncoder().encode(evidence.evaluationLog).length, identitiesVerified: true };
    return result;
  };
  const controls = [];
  let candidateToolProof;
  let deadlineProof;
  async function closedPort(port: number) {
    await new Promise<void>((done, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); reject(new Error(`port ${port} remains open`)); });
      socket.once("error", error => {
        assert.equal((error as NodeJS.ErrnoException).code, "ECONNREFUSED");
        socket.destroy(); done();
      });
    });
  }
  try {
    for (const name of ["base", "reference"]) {
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const setup = await Bun.file(join(workspace, ".bench-home/setup.json")).json();
        assert.equal(setup.sourceFiles, 1357);
        for (const file of manifest.files.filter(file => file.path !== ".gitignore")) {
          assert.equal(hash(await Bun.file(join(workspace, file.path)).bytes()), file.sha256);
        }
        // Only the shared provisioner adds these owned-state exclusions.
        const originalIgnore = manifest.files.find(file => file.path === ".gitignore")!;
        assert.equal(hash(new TextEncoder().encode((await Bun.file(join(workspace, ".gitignore")).text())
          .replace(/\n\.flywheel\/\n\.bench-home\/\n$/, ""))), originalIgnore.sha256);
        const baselineTest = await Bun.file(join(workspace, "tests/unit/type/stream.tcl")).text();
        assert.ok(!baselineTest.includes(row.FAIL_TO_PASS[0]));
        for (const file of ["original", "solution", "patch.patch", "test_patch.patch", "grade.py",
          ".bench-home/eval.sh", ".bench-home/evaluation.log", ".bench-home/parsed.json", ".bench-home/python", ".bench-home/inputs/redis.tar.gz"]) {
          assert.equal(await Bun.file(join(workspace, file)).exists(), false);
        }
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name === "base") {
          const build = await executeRedisCommand(run, workspace, "candidate-build", [join(workspace, ".bench-home/bin/build")], 1800000);
          const version = await executeRedisCommand(run, workspace, "candidate-version", [join(workspace, "src/redis-server"), "--version"], 60000);
          candidateToolProof = { build, version, environment: "usual sandbox environment only; no adapter overlays" };
          const program = 'process.on("SIGTERM",()=>{}); const child=Bun.spawn([process.execPath,"-e",\'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)\'],{windowsHide:true,stdout:"ignore",stderr:"ignore"});console.log(process.pid+" "+child.pid);setInterval(()=>{},1000);';
          await assert.rejects(executeRedisCommand(run, workspace, "deadline-proof", [process.execPath, "-e", program], 1500), /timed out/);
          const expiry = await Bun.file(join(workspace, ".bench-home/deadline-proof.command.json")).json();
          const pids = expiry.stdout.trim().split(/\s+/).map(Number);
          assert.equal(pids.length, 2);
          for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "ESRCH");
          deadlineProof = { ...expiry, pids, childTreeGone: true };
        } else {
          await runCheckedSandboxCommand(run, ["/usr/bin/git", "apply", join(task.taskDir, "original/patch.patch")], options);
          await runCheckedSandboxCommand(run, ["/usr/bin/git", "add", "-A"], options);
          await runCheckedSandboxCommand(run, ["/usr/bin/git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, ".gitignore"), await Bun.file(join(workspace, ".gitignore")).text() + "\n# candidate ignore edit\n");
          await Bun.write(join(workspace, "tests/unit/type/stream.tcl"), "error {candidate test replacement}\n");
        }
        const captured = await captureImplementation(task, workspace, run);
        assert.ok(captured.nativeGrade);
        assert.ok(captureProof);
        const grade = JSON.parse(captured.nativeGrade);
        const reward = Number(name === "reference");
        assert.deepEqual(captured.acceptance, { passed: reward, failed: 1 - reward, total: 1 });
        const evidence = grade.evidence;
        assert.equal(evidence.originalEvalSha256, copies["original/eval.sh"]!.sha256);
        assert.equal(evidence.sourceFiles, 1357);
        assert.equal(evidence.limits.wholeEvaluationMs, 1800000);
        assert.equal(evidence.evaluationExit, 0);
        assert.equal(evidence.parsed.found, true);
        assert.equal(evidence.parsed.resolution, reward ? "RESOLVED_FULL" : "RESOLVED_NO");
        assert.equal(Object.keys(evidence.parsed.selected_statuses).length, 8);
        for (const id of row.PASS_TO_PASS) assert.equal(evidence.parsed.selected_statuses[id], "PASSED");
        assert.equal(evidence.parsed.selected_statuses[row.FAIL_TO_PASS[0]], reward ? "PASSED" : "FAILED");
        if (!reward) assert.ok(evidence.evaluationLog.includes("Expected '' to be equal to"));
        if (reward) {
          for (const text of ["src/t_stream.c", "untracked.txt", "candidate ignore edit", "candidate test replacement"]) assert.ok(captured.diff.includes(text));
          const testOutput = evidence.evaluationLog.split(">>>>> Start Test Output")[1]!.split(">>>>> End Test Output")[0]!;
          assert.ok(!testOutput.includes("candidate test replacement"));
        }
        const pids = [...evidence.evaluationLog.matchAll(/\[ready\]: (\d+)|\(pid (\d+)\)/g)]
          .map(match => Number(match[1] ?? match[2]));
        assert.ok(pids.length > 16);
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "ESRCH");
        const ports = [...new Set<number>([21079, 21111, ...[...evidence.evaluationLog.matchAll(/Starting test server at port (\d+)/g)].map(match => Number(match[1]))])];
        for (const port of ports) await closedPort(port);
        const bytes = new TextEncoder().encode(JSON.stringify({ grade, patch: captured.diff, setup }, null, 2) + "\n");
        const compressed = Bun.gzipSync(bytes);
        const file = `${name}-grade.json.gz`;
        await Bun.write(join(output, file), compressed);
        controls.push({ name, acceptance: captured.acceptance, selectedStatuses: evidence.parsed.selected_statuses,
          resolution: evidence.parsed.resolution, productionCapture: captureProof, cleanup: { pids, ports, surviving: [], listeners: [] },
          evidence: { file, bytes: compressed.length, sha256: hash(compressed), decompressedBytes: bytes.length, decompressedSha256: hash(bytes) } });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    assert.deepEqual(await readdir(temporary), []);
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
    await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
      task: task.id, testedContentIdentity: task.contentIdentity,
      testedContentIdentityScope: "whole fixture before retaining these results; retained evidence changes the current fixture hash",
      observedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
      controls, candidateToolProof, deadlineProof, cleanup: { tmpClean: true },
      modelCalls: 0, empiricalModelDifficulty: "not measured", empiricalModelCost: "not measured",
    }, null, 2) + "\n");
    console.log(JSON.stringify({ controls, tmpClean: true }));
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`qualification ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); await rm(temporary, { recursive: true, force: true }); }
  }
}

if (import.meta.main) await main();
