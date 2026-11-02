import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

/** Qualify the catalog, public preparation and fresh native capture boundary.
 * Controls do not call models. Evidence goes outside the immutable fixture. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "psf__requests-6028");
  assert.ok(task?.kind === "native");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  const tmp = join(output, "owned-tmp");
  await mkdir(tmp, { recursive: true });
  const inheritedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const ledger: Record<string, { sha256: string; bytes: number }> = await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  for (const [name, expected] of Object.entries(ledger)) {
    const bytes: Uint8Array<ArrayBuffer> = await Bun.file(join(task.taskDir, name)).bytes();
    assert.equal(hash(bytes), expected.sha256);
    assert.equal(bytes.length, expected.bytes);
  }
  const row = await Bun.file(join(task.taskDir, "original/row.json")).json();
  const groups = { FAIL_TO_PASS: JSON.parse(row.FAIL_TO_PASS), PASS_TO_PASS: JSON.parse(row.PASS_TO_PASS) };
  const selected: string[] = [...groups.FAIL_TO_PASS, ...groups.PASS_TO_PASS];
  assert.equal(task.instruction, row.problem_statement);
  assert.equal(task.timeoutMs, 1500000);
  assert.equal(task.native.timeoutMs, 2520000);
  assert.equal(selected.length, 187);
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
        assert.equal(snapshot.packages.pytest, "7.4.4");
        assert.equal(snapshot.packages.requests, undefined);
        assert.equal(Object.keys(snapshot.packages).length, 12);
        for (const hidden of ["original", "gold.patch", "test.patch"]) assert.equal(await Bun.file(join(workspace, hidden)).exists(), false);
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name === "reference") {
          await runCheckedSandboxCommand(run, ["git", "apply", join(task.taskDir, "original/gold.patch")], options);
          await runCheckedSandboxCommand(run, ["git", "add", "requests/utils.py"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          const ignore = await Bun.file(join(workspace, ".gitignore")).text();
          await Bun.write(join(workspace, ".gitignore"), ignore + "candidate-output/\n");
        }
        if (name === "grading-tamper") {
          await Bun.write(join(workspace, "pytest.py"), selected.map(id => `print(${JSON.stringify(`PASSED ${id}`)})`).join("\n") + "\n");
          await Bun.write(join(workspace, "pip.py"), "raise AssertionError('candidate pip authority')\n");
          await Bun.write(join(workspace, "pytest_mock.py"), "raise AssertionError('candidate plugin authority')\n");
          await Bun.write(join(workspace, "setup.cfg"), "[tool:pytest]\naddopts = --collect-only\n");
          await Bun.write(join(workspace, "conftest.py"), "raise AssertionError('candidate authority')\n");
          await Bun.write(join(workspace, "tests/conftest.py"), "raise AssertionError('candidate fixture')\n");
          await Bun.write(join(workspace, "tests/pytest.ini"), "[pytest]\naddopts = --collect-only\n");
          await Bun.write(join(workspace, "tests/test_utils.py"), "def test_fake():\n    pass\n");
        }
        if (name === "compile-failure") await Bun.write(join(workspace, "requests/utils.py"), "this is not valid Python !\n");
        const captured = await captureImplementation(task, workspace, run);
        const grade = JSON.parse(captured.nativeGrade!);
        const evidence = grade.evidence;
        assert.deepEqual(evidence.expected, groups);
        assert.equal(evidence.sourceIdentity.files, 97);
        assert.equal(evidence.acquired.length, 14);
        assert.equal(evidence.commands.pytest.timedOut, false);
        assert.equal(evidence.gradingOwnerIdentities["tests/test_utils.py"], "ee75e15b6d5338db46eaa56fde5e2e34ab21fe5c97ccb6d3d7ce9c1a50a126cf");
        assert.deepEqual(evidence.commands.pytest.command.slice(-2), ["-rA", "tests/test_utils.py"]);
        assert.equal(evidence.limits.evaluationMs, 1800000);
        if (name === "compile-failure") {
          assert.deepEqual(captured.acceptance, { passed: 0, failed: 187, total: 187 });
          assert.equal(evidence.original_output_found, false);
          assert.equal(evidence.missing.length, 187);
          assert.match(evidence.commands.pytest.stdout + evidence.commands.pytest.stderr, /SyntaxError/);
        } else {
          assert.equal(evidence.candidateImports.collected, 214);
          assert.equal(Object.keys(evidence.statuses).length, 195);
          assert.equal(evidence.candidateImports.modules.requests, resolve(evidence.snapshot.prefix, "../../requests/__init__.py"));
          assert.equal(evidence.candidateImports.modules["requests.utils"], resolve(evidence.snapshot.prefix, "../../requests/utils.py"));
          assert.ok(evidence.candidateImports.pytest.startsWith(evidence.snapshot.prefix + "/"));
          assert.ok(evidence.candidateImports.plugins.every((path: string) => path.startsWith(evidence.snapshot.prefix + "/")));
          assert.ok(evidence.candidateImports.tmpdir.endsWith("/.bench-home/pytest-tmp"));
          assert.deepEqual(evidence.missing, []);
          assert.deepEqual(evidence.errors, []);
          assert.deepEqual(evidence.original_report.PASS_TO_PASS.success.toSorted(), groups.PASS_TO_PASS.toSorted());
          assert.deepEqual(evidence.original_report.FAIL_TO_PASS[name === "reference" ? "success" : "failure"].toSorted(), groups.FAIL_TO_PASS.toSorted());
          assert.deepEqual(captured.acceptance, { passed: name === "reference" ? 187 : 185, failed: name === "reference" ? 0 : 2, total: 187 });
          assert.match(evidence.commands.pytest.stdout, name === "reference" ? /203 passed, 11 skipped/ : /2 failed, 201 passed, 11 skipped/);
          if (name !== "reference") assert.match(evidence.commands.pytest.stdout, /http:\/\/example.com\/path\?query/);
        }
        assert.equal(evidence.original_resolution, name === "reference" ? "RESOLVED_FULL" : "RESOLVED_NO");
        if (name === "reference") {
          assert.match(captured.diff, /requests\/utils\.py/);
          assert.match(captured.diff, /untracked\.txt/);
          assert.match(captured.diff, /candidate-output\//);
        }
        if (name === "grading-tamper") {
          assert.match(captured.diff, /candidate authority/);
          assert.ok(evidence.restoration.removed.includes("conftest.py"));
          assert.ok(evidence.restoration.removed.includes("setup.cfg"));
          assert.equal(evidence.gradingOwnerIdentities["tests/conftest.py"], evidence.restoration.owners["tests/conftest.py"]);
        }
        const full = new TextEncoder().encode(JSON.stringify({ grade, patch: captured.diff }, null, 2) + "\n");
        const compressed = Bun.gzipSync(full);
        const file = `${name}-grade.json.gz`;
        await Bun.write(join(output, file), compressed);
        controls.push({ name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          acceptance: captured.acceptance, resolution: evidence.original_resolution, classification: evidence.classification,
          collected: evidence.candidateImports.collected, parsedKeys: Object.keys(evidence.statuses).length,
          missing: evidence.missing, pytestMs: evidence.commands.pytest.durationMs,
          evidence: { file, bytes: compressed.length, sha256: hash(compressed), decompressedBytes: full.length, decompressedSha256: hash(full) } });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    assert.deepEqual(await readdir(tmp), []);
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
    await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
      platform: process.platform, arch: process.arch, controls, tmpClean: true,
      taskIdentity: task.contentIdentity, modelCalls: 0,
      semanticFault: "The original base loses URL credentials. No artificial mutant or extra network task.",
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
