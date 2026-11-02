import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

/** Exercise original controls through the actual catalog, provisioner, and patch capturer.
 * Evidence goes outside the fixture. No model, provider, judge, or Agent is started. */
async function main(): Promise<void> {
  const outputArg = process.argv[2];
  if (!outputArg) throw new Error("expected an evidence directory outside the task tree");
  const output = resolve(outputArg);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "regex-chess")!;
  assert.equal(task.kind, "native");
  if (task.kind !== "native") throw new Error("expected native task");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  await mkdir(join(output, "tmp"), { recursive: true });
  process.env.TMPDIR = join(output, "tmp");
  assert.equal(task.instruction, await Bun.file(join(task.taskDir, "instruction.txt")).text());
  assert.equal(task.prompt, task.instruction + "\n\n## Native environment context\n" + await Bun.file(join(task.taskDir, "environment.txt")).text());
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
  const hash = (text: string | ArrayBuffer) => Bun.CryptoHasher.hash("sha256", text, "hex");
  const controls = [];
  try {
    for (const [name, expected] of Object.entries(ledger)) {
      assert.equal(hash(await Bun.file(join(task.taskDir, name)).arrayBuffer()), expected.sha256);
    }
    for (const name of ["base", "reference", "fault"]) {
      const started = performance.now();
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const preparedMs = Math.round(performance.now() - started);
        for (const hidden of ["re.json", "test_outputs.py", "tests", "controls", "solve.sh"]) {
          assert.equal(await Bun.file(join(workspace, hidden)).exists(), false);
        }
        const provision = await Bun.file(join(workspace, ".bench-home/provision.json")).json();
        assert.equal(provision.acquired.length, 9);
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name !== "base") {
          await Bun.write(join(workspace, "re.json"), await Bun.file(join(task.taskDir, `controls/${name}-re.json`)).arrayBuffer());
        }
        if (name === "reference") {
          await runCheckedSandboxCommand(run, ["git", "add", "re.json"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, "check.py"), "raise AssertionError('restore supplied checker')\n");
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
        assert.deepEqual(Object.fromEntries(grade.evidence.statuses.map((row: { id: string; status: string }) => [row.id, row.status])), {
          test_immortal_game: name === "reference" ? "PASSED" : "FAILED",
          test_game_of_century: name === "reference" ? "PASSED" : "FAILED",
          test_naroditsky_ivanchuk: name === "reference" ? "PASSED" : "FAILED",
          test_not_long: name === "base" ? "FAILED" : "PASSED",
        });
        for (const [file, original] of [["check.py", "original/environment/check.py"], ["test_outputs.py", "original/tests/test_outputs.py"]] as const) {
          const mapped = grade.evidence.replacements.find((row: { file: string }) => row.file === file);
          const restored: string = (await Bun.file(join(task.taskDir, original)).text()).replaceAll(mapped.original, mapped.native);
          assert.equal(grade.evidence.restored[file], hash(restored));
        }
        if (name === "reference") {
          assert.match(captured.diff, /untracked.txt/);
          assert.match(captured.diff, /re.json/);
          assert.equal(grade.evidence.removed.length, 2);
        }
        controls.push({ name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          acceptance: captured.acceptance, pytestExitCode: grade.evidence.pytestExitCode, reward: grade.evidence.reward,
          shellExitCode: grade.evidence.commands.verifier.exitCode, statuses: grade.evidence.statuses,
          positions: grade.evidence.positions, groups: grade.evidence.groups,
          versions: JSON.parse(grade.evidence.commands.versions.stdout),
        });
        await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
          platform: process.platform, arch: process.arch, originalInstructionExact: true, environmentPromptExact: true,
          controls,
        }, null, 2) + "\n");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`qualification process ownership did not settle: ${closure.reason}`);
    } finally {
      await supervisor.dispose();
    }
  }
}

if (import.meta.main) await main();
