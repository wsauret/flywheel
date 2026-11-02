import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

/** Qualify original controls through the real native catalog and patch capture.
 * Full evidence remains gzip-compressed outside this fixture. No model is called. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "ds1000-298");
  assert.ok(task?.kind === "native");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  const tmp = join(output, "owned tmp $ ' \"");
  await mkdir(tmp, { recursive: true });
  const inheritedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const ledger: Record<string, { sha256: string; bytes: number; decompressedSha256?: string; decompressedBytes?: number }> =
    await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  for (const [name, expected] of Object.entries(ledger)) {
    const bytes: Uint8Array<ArrayBuffer> = await Bun.file(join(task.taskDir, name)).bytes();
    assert.equal(hash(bytes), expected.sha256);
    assert.equal(bytes.length, expected.bytes);
    if (name.endsWith(".gz")) {
      const expanded = Bun.gunzipSync(bytes);
      assert.equal(hash(expanded), expected.decompressedSha256);
      assert.equal(expanded.length, expected.decompressedBytes);
    }
  }
  const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    Bun.gunzipSync(await Bun.file(join(task.taskDir, "original/record.json.gz")).bytes()),
  ));
  assert.equal(Buffer.byteLength(task.instruction), 550);
  assert.equal(task.instruction, record.prompt);
  const supervisor = createProcessSupervisor();
  const scope = createLauncherScope(supervisor);
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, options);
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
  const controls = [];
  try {
    for (const name of ["base", "reference", "fault"]) {
      const started = performance.now();
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const preparedMs = Math.round(performance.now() - started);
        assert.equal(await Bun.file(join(workspace, "prompt.txt")).text(), task.instruction);
        for (const hidden of ["solution.py", "record.json", "reference_code.py", "code_context.py", "execution.py", "test_ds1000.py", ".bench-home/grader"]) {
          assert.equal((await readdir(workspace)).includes(hidden), false);
          assert.equal(await Bun.file(join(workspace, hidden)).exists(), false);
        }
        const provision = await Bun.file(join(workspace, ".bench-home/provision.json")).json();
        assert.equal(provision.acquired.length, 2);
        if (name !== "base") {
          const source = name === "reference" ? "original/reference_code.py.gz" : "controls/semantic-fault.py.gz";
          await Bun.write(join(workspace, "solution.py"), Bun.gunzipSync(await Bun.file(join(task.taskDir, source)).bytes()));
        }
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name === "reference") {
          await runCheckedSandboxCommand(run, ["git", "add", "solution.py"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, "execution.py"), "raise AssertionError('candidate module must not replace authority')\n");
          await Bun.write(join(workspace, "test_ds1000.py"), "raise AssertionError('candidate module must not replace assembly')\n");
          await Bun.write(join(workspace, "numpy.py"), "raise AssertionError('candidate module must not replace NumPy')\n");
        }
        const captured = await captureImplementation(task, workspace, run);
        const grade = JSON.parse(captured.nativeGrade!);
        assert.deepEqual(captured.acceptance, { passed: Number(name === "reference"), failed: Number(name !== "reference"), total: 1 });
        const official = grade.evidence.official;
        assert.equal(official.official.passed, name === "reference");
        assert.equal(official.factoryRestored, true);
        assert.equal(official.noActiveChildren, true);
        assert.equal(official.ownedTmpUnchanged, true);
        assert.equal(official.managerLifecycle.length, 1);
        for (const manager of official.managerLifecycle) {
          assert.equal(manager.listenerClosed, true);
          assert.equal(manager.aliveAfterShutdown, false);
          assert.equal(manager.exitcode, 0);
          assert.equal(manager.inheritedAuthkey, true);
          assert.equal(manager.address[0], "127.0.0.1");
        }
        for (const [authority, identity] of Object.entries(official.authority)) {
          const compressed = authority === "record.json" || authority === "code_context.py";
          const expected = ledger[`original/${authority}${compressed ? ".gz" : ""}`]!;
          assert.equal(identity, compressed ? expected.decompressedSha256 : expected.sha256);
        }
        if (name === "reference") {
          assert.match(captured.diff, /solution.py/);
          assert.match(captured.diff, /untracked.txt/);
          assert.match(captured.diff, /execution.py/);
        }
        const full = new TextEncoder().encode(JSON.stringify({ grade, patch: captured.diff }, null, 2) + "\n");
        const compressed = Bun.gzipSync(full);
        const evidenceFile = `${name}-grade.json.gz`;
        await Bun.write(join(output, evidenceFile), compressed);
        controls.push({
          name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          acceptance: captured.acceptance, originalResult: official.official,
          graderSeconds: official.seconds, originalCaseIds: official.originalCaseIds,
          caseObservation: official.caseObservation, managerLifecycle: official.managerLifecycle,
          factoryRestored: official.factoryRestored, noActiveChildren: official.noActiveChildren,
          ownedTmpUnchanged: official.ownedTmpUnchanged,
          acquired: grade.evidence.acquired, versions: JSON.parse(grade.evidence.commands.versions.stdout),
          evidence: { file: evidenceFile, bytes: compressed.length, sha256: hash(compressed),
            decompressedBytes: full.length, decompressedSha256: hash(full) },
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    assert.deepEqual(await readdir(tmp), []);
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
    await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
      platform: process.platform, arch: process.arch, controls, tmpClean: true,
      loaderInstructionBytes: Buffer.byteLength(task.instruction), taskIdentity: task.contentIdentity,
      modelCalls: 0, historicalModelAccounting: "calibration.json is separate from these control runs",
    }, null, 2) + "\n");
    console.log(JSON.stringify({ controls: controls.map(row => ({ name: row.name, ...row.acceptance })), tmpClean: true }));
  } finally {
    try {
      const closure = await scope.close();
      assert.equal(closure.settled, true);
    } finally {
      await supervisor.dispose();
      if (inheritedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = inheritedTmp;
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await main();
