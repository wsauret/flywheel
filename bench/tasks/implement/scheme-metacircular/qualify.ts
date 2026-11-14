import assert from "node:assert/strict";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

/** Reproduce original controls through the shared loader, provisioner, and capturer.
 * Write full grading evidence outside the task tree. No Agent or provider is started. */
async function main(): Promise<void> {
  const outputArg = process.argv[2];
  if (!outputArg) throw new Error("expected an evidence directory outside the task tree");
  const output = resolve(outputArg);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "scheme-metacircular")!;
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  await mkdir(join(output, "tmp"), { recursive: true });
  process.env.TMPDIR = join(output, "tmp");
  const supervisor = createProcessSupervisor();
  const scope = createLauncherScope(supervisor);
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, options);
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
  const ledger: Record<string, { sha256: string }> = await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  const replacements: { file: string; original: string; occurrences: number }[] = await Bun.file(join(task.taskDir, "replacement-ledger.json")).json();
  const controls = [];
  try {
    for (const [name, expected] of Object.entries(ledger)) {
      assert.equal(Bun.CryptoHasher.hash("sha256", await Bun.file(join(task.taskDir, name)).arrayBuffer(), "hex"), expected.sha256);
    }
    for (const name of ["base", "reference", "fault"]) {
      const started = performance.now();
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const preparedMs = Math.round(performance.now() - started);
        for (const hidden of ["eval.scm", "test_outputs.py", "shadow_test"]) {
          assert.equal(await Bun.file(join(workspace, hidden)).exists(), false);
        }
        const provision = await Bun.file(join(workspace, ".bench-home/provision.json")).json();
        assert.equal(provision.acquired.length, 7);
        const options = { cwd: workspace, sandboxDir: workspace };
        await runCheckedSandboxCommand(run, [
          join(workspace, ".bench-home/python/bin/python3"), "interp.py", "test/05-simple-io.scm",
        ], options);
        if (name !== "base") {
          await Bun.write(join(workspace, "eval.scm"), await Bun.file(join(task.taskDir, `controls/${name}-eval.scm`)).arrayBuffer());
        }
        if (name === "reference") {
          await runCheckedSandboxCommand(run, ["git", "add", "eval.scm"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, "interp.py"), "raise AssertionError('restore supplied interpreter')\n");
          await Bun.write(join(workspace, "test/05-simple-io.scm"), "(+ 999 999)\n");
          await Bun.write(join(workspace, "pytest.ini"), "[pytest]\naddopts = --collect-only\n");
          await Bun.write(join(workspace, "conftest.py"), "raise AssertionError('restore grading authority')\n");
          await Bun.write(join(workspace, "pytest.py"), "raise AssertionError('do not shadow pytest')\n");
        }
        const captured = await captureImplementation(task, workspace, run);
        const grade = JSON.parse(captured.nativeGrade!);
        assert.deepEqual(grade.evidence.replacements.map(({ file, original, occurrences }: typeof replacements[number]) =>
          ({ file, original, occurrences })), replacements.map(({ file, original, occurrences }) => ({ file, original, occurrences })));
        await Bun.write(join(output, `${name}-grade.json`), captured.nativeGrade!);
        assert.deepEqual(captured.acceptance, { passed: Number(name === "reference"), failed: Number(name !== "reference"), total: 1 });
        assert.equal(grade.evidence.programs.length, 63);
        assert.equal(grade.evidence.observations.length, 131);
        assert.equal(grade.evidence.observations.filter((row: { timeout: number }) => row.timeout === 10).length, 63);
        assert.equal(grade.evidence.observations.filter((row: { timeout: number }) => row.timeout === 60).length, 68);
        assert.equal(grade.evidence.restored["interp.py"], ledger["original/environment/tests/interp.py"]!.sha256);
        for (const [source, hash] of Object.entries(grade.evidence.restored)) {
          if (source.startsWith("original/")) assert.equal(hash, ledger[source]!.sha256);
        }
        const meta = grade.evidence.observations.filter((row: { input?: string }) => row.input?.split("\n")[0]?.endsWith("/eval.scm"));
        assert.equal(meta.length, 5);
        if (grade.evidence.metaAliasDirectory) {
          await assert.rejects(stat(grade.evidence.metaAliasDirectory), { code: "ENOENT" });
        }
        if (name === "reference") {
          assert.match(captured.diff, /untracked.txt/);
          assert.match(captured.diff, /eval.scm/);
          assert.equal(grade.evidence.removed.length, 2);
        }
        controls.push({ name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          acceptance: captured.acceptance, pytestExitCode: grade.evidence.pytestExitCode, reward: grade.evidence.reward,
          shellExitCode: grade.evidence.commands.verifier.exitCode,
          programs: grade.evidence.programs.map((row: { id: string; status: string }) => ({ id: row.id, status: row.status })),
          meta: meta.map((row: { input: string; returncode?: number; timed_out: boolean }) => ({
            program: row.input.split("\n")[1], returncode: row.returncode ?? null, timedOut: row.timed_out,
          })),
          versions: JSON.parse(grade.evidence.commands.versions.stdout),
        });
        await Bun.write(join(output, "qualification-record.json"), JSON.stringify({ platform: process.platform, arch: process.arch, controls }, null, 2) + "\n");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
  } finally {
    try { await scope.close(); } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
