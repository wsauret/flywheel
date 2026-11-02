import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

/** Exercise public provision, original grading, capture and authority restoration.
 * Evidence is written outside the task. This command never calls a model. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "getmoto__moto-7365");
  assert.ok(task?.kind === "native");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  const tmp = join(output, "owned tmp $ ' \"");
  await mkdir(tmp, { recursive: true });
  const inheritedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const ledger: Record<string, { sha256: string; bytes: number }> =
    await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  for (const [name, expected] of Object.entries(ledger)) {
    const bytes: Uint8Array<ArrayBuffer> = await Bun.file(join(task.taskDir, name)).bytes();
    assert.equal(hash(bytes), expected.sha256);
    assert.equal(bytes.length, expected.bytes);
  }
  const row = await Bun.file(join(task.taskDir, "original/task-row.json")).json();
  assert.equal(task.instruction, row.problem_statement);
  assert.equal(task.timeoutMs, 1500000);
  const selected = [...row.FAIL_TO_PASS, ...row.PASS_TO_PASS];
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
    for (const name of ["base", "reference", "grading-tamper", "compile-failure"]) {
      const started = performance.now();
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const preparedMs = Math.round(performance.now() - started);
        const snapshot = await Bun.file(join(workspace, ".bench-home/snapshot.json")).json();
        assert.equal(snapshot.packages.pytest, "8.0.0");
        for (const hidden of ["original", "gold.patch", "test.patch", ".bench-home/inputs/constants.py",
          ".bench-home/inputs/log_parsers.py", ".bench-home/inputs/grading.py"]) {
          assert.equal(await Bun.file(join(workspace, hidden)).exists(), false);
        }
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name === "reference") {
          await runCheckedSandboxCommand(run, ["git", "apply", join(task.taskDir, "original/gold.patch")], options);
          await runCheckedSandboxCommand(run, ["git", "add", "moto/dynamodb/models/dynamo_type.py"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid",
            "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
        }
        if (name === "grading-tamper") {
          await Bun.write(join(workspace, "pytest.py"), selected.map(id => `print(${JSON.stringify(`PASSED ${id}`)})`).join("\n") + "\n");
          await Bun.write(join(workspace, "pip.py"), "raise AssertionError('candidate pip authority')\n");
          await Bun.write(join(workspace, "setup.cfg"), "[tool:pytest]\naddopts = --collect-only\n");
          await Bun.write(join(workspace, "conftest.py"), "raise AssertionError('candidate authority')\n");
          await Bun.write(join(workspace, "tests/test_dynamodb/conftest.py"), "raise AssertionError('candidate fixture')\n");
          await Bun.write(join(workspace, "tests/test_dynamodb/pytest.ini"), "[pytest]\naddopts = --collect-only\n");
          await Bun.write(join(workspace, "tests/test_dynamodb/test_dynamodb_update_expressions.py"), "def test_fake():\n    pass\n");
        }
        if (name === "compile-failure") {
          await Bun.write(join(workspace, "moto/dynamodb/models/dynamo_type.py"), "this is not valid Python !\n");
        }
        const captured = await captureImplementation(task, workspace, run);
        const grade = JSON.parse(captured.nativeGrade!);
        const evidence = grade.evidence;
        assert.deepEqual(evidence.expected, { FAIL_TO_PASS: row.FAIL_TO_PASS, PASS_TO_PASS: row.PASS_TO_PASS });
        assert.equal(evidence.sourceIdentity.files, 2170);
        assert.equal(evidence.acquired.length, 31);
        assert.equal(evidence.commands.pytest.timedOut, false);
        assert.equal(evidence.commands.pytest.stdoutTruncated ?? false, false);
        assert.equal(evidence.commands.pytest.stderrTruncated ?? false, false);
        const originalTest = "tests/test_dynamodb/test_dynamodb_update_expressions.py";
        assert.equal(evidence.gradingOwnerIdentities[originalTest], "cc215a8d8c51bc0d7a6b720c7133c15e2f2e34739d2f4f87b8167d53a2152a98");
        assert.equal(evidence.commands.pytest.command.includes("-n0"), true);
        assert.equal(evidence.commands.pytest.command.includes(originalTest), true);
        if (name === "compile-failure") {
          assert.equal(evidence.original_resolution, "RESOLVED_NO");
          assert.equal(evidence.classification, "missing-or-runtime-error");
          assert.equal(evidence.missing.length, 2);
          assert.deepEqual(captured.acceptance, { passed: 0, failed: 2, total: 2 });
          assert.match(evidence.commands.pytest.stdout + evidence.commands.pytest.stderr, /SyntaxError/);
        } else {
          assert.equal(evidence.candidateImports.moto, resolve(evidence.snapshot.prefix, "../../moto/__init__.py"));
          assert.equal(evidence.candidateImports["moto.dynamodb.models.dynamo_type"],
            resolve(evidence.snapshot.prefix, "../../moto/dynamodb/models/dynamo_type.py"));
          assert.deepEqual(evidence.missing, []);
          assert.deepEqual(evidence.errors, []);
          assert.deepEqual(Object.keys(evidence.statuses).sort(), selected.toSorted());
          assert.equal(evidence.statuses[row.PASS_TO_PASS[0]], "PASSED");
          assert.equal(evidence.statuses[row.FAIL_TO_PASS[0]], name === "reference" ? "PASSED" : "FAILED");
          assert.equal(evidence.original_resolution, name === "reference" ? "RESOLVED_FULL" : "RESOLVED_NO");
          assert.deepEqual(captured.acceptance, { passed: name === "reference" ? 2 : 1, failed: name === "reference" ? 0 : 1, total: 2 });
          if (name !== "reference") {
            assert.match(evidence.commands.pytest.stdout, /11\.700000000000003/);
            assert.equal(evidence.classification, "semantic-failure");
          }
        }
        if (name === "reference") {
          assert.match(captured.diff, /moto\/dynamodb\/models\/dynamo_type\.py/);
          assert.match(captured.diff, /untracked\.txt/);
        }
        if (name === "grading-tamper") {
          assert.match(captured.diff, /candidate authority/);
          assert.ok(evidence.restoration.removed.includes("conftest.py"));
          assert.ok(evidence.restoration.removed.includes("setup.cfg"));
          assert.equal(evidence.gradingOwnerIdentities["tests/test_dynamodb/conftest.py"],
            evidence.restoration.owners["tests/test_dynamodb/conftest.py"]);
        }
        const full = new TextEncoder().encode(JSON.stringify({ grade, patch: captured.diff }, null, 2) + "\n");
        const compressed = Bun.gzipSync(full);
        const file = `${name}-grade.json.gz`;
        await Bun.write(join(output, file), compressed);
        controls.push({
          name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          acceptance: captured.acceptance, resolution: evidence.original_resolution,
          classification: evidence.classification, statuses: evidence.statuses, missing: evidence.missing, errors: evidence.errors,
          pytestMs: evidence.commands.pytest.durationMs, sourceIdentity: evidence.sourceIdentity,
          acquired: evidence.acquired, snapshot: evidence.snapshot,
          evidence: { file, bytes: compressed.length, sha256: hash(compressed),
            decompressedBytes: full.length, decompressedSha256: hash(full) },
        });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    assert.deepEqual(await readdir(tmp), []);
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
    await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
      platform: process.platform, arch: process.arch, controls, tmpClean: true,
      loaderInstructionBytes: Buffer.byteLength(task.instruction), taskIdentity: task.contentIdentity,
      modelCalls: 0, semanticFault: "The original base is the decimal-conversion fault; no invented mutant.",
      historicalModelAccounting: "calibration.json contains historical runs only",
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
