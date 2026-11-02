import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";
import { executeCommand } from "./adapter.js";

interface Identity { bytes: number; sha256: string }
interface TestId { file: string; id: string }
interface Inventory {
  testResults: { name: string; assertionResults: { fullName: string; status: string }[] }[];
}

/** Exercise the real native catalog, capture and original grade with no model.
 * Evidence remains outside the fixture until the parent retains it. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "jquense__yup-2305");
  assert.ok(task?.kind === "native");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  await mkdir(output, { recursive: true });
  const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const ledger: Record<string, Identity> = await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  for (const [file, identity] of Object.entries(ledger)) {
    const bytes: Uint8Array = await Bun.file(join(task.taskDir, file)).bytes();
    assert.equal(bytes.length, identity.bytes);
    assert.equal(hash(bytes), identity.sha256);
  }
  assert.equal(task.instruction, await Bun.file(join(task.taskDir, "original/instruction.md")).text());
  assert.equal(task.timeoutMs, 1500000);
  const expected: TestId[] = await Bun.file(join(task.taskDir, "qualification/expected-tests.json")).json();
  assert.equal(expected.length, 44);
  const sourceManifest: Record<string, Identity> = await Bun.file(join(task.taskDir, "source-manifest.json")).json();
  const previousTmp = process.env.TMPDIR;
  // Exercise quoted paths without an ancestor repository's automatic type roots.
  const tempRoot = await mkdtemp(join(tmpdir(), "native-fixture-"));
  const temp = join(tempRoot, "owned tmp $ ' \"");
  await mkdir(temp);
  process.env.TMPDIR = temp;
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
  let deadlineProof;
  let candidateToolProof;
  try {
    for (const name of ["base", "reference", "index-fault"]) {
      const started = performance.now();
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const preparedMs = Math.round(performance.now() - started);
        const setup = await Bun.file(join(workspace, ".bench-home/setup.json")).json();
        assert.equal(setup.launcherAdaptation.replacements, 1);
        assert.equal(setup.launcherAdaptation.originalSha256, "dddc0b96ad2dca8d56a5302b56bf3cbf8210654474a6bf88877da61e866f3d46");
        assert.notEqual(setup.fixedBuildSha256, setup.identities["lib/index.js"]);
        const plain = await Bun.file(join(task.taskDir, "qualification/original-plain-setup.json")).json();
        for (const path of ["src/array.ts", "src/tuple.ts", "src/types.ts", "yarn.lock", "lib/index.js", "dts/index.d.ts"]) {
          assert.equal(setup.identities[path], plain.identities[path]);
        }
        assert.equal(setup.isolatedTypesFrom, null);
        assert.equal(await Bun.file(join(workspace, "tsconfig.json")).text(), await Bun.file(join(task.taskDir, "original/tsconfig.json")).text());
        assert.equal(setup.identities["yarn.lock"], sourceManifest["yarn.lock"]!.sha256);
        for (const file of ["original", "solution", "controls", ".bench-home/tests/test.sh",
          ".bench-home/verifier/reward.txt", ".bench-home/inputs/yup.tar.gz", "fix.patch"]) {
          assert.equal(await Bun.file(join(workspace, file)).exists(), false);
        }
        for (const file of ["array.ts", "tuple.ts"]) {
          const baseline = await Bun.file(join(workspace, "test", file)).text();
          assert.notEqual(baseline, await Bun.file(join(task.taskDir, "original/tests", file)).text());
          assert.ok(!baseline.includes("should pass array options to descendants when casting"));
        }
        const options = { cwd: workspace, sandboxDir: workspace };
        if (name === "base") {
          const yarn = join(workspace, ".bench-home/bin/yarn");
          const version = await executeCommand(run, workspace, "candidate-node-version", [yarn, "exec", "node", "--version"], 120000);
          assert.equal(version.stdout.trim(), "v22.23.3");
          const paths: Record<string, unknown> = {};
          for (const [key, path] of Object.entries({
            cacheFolder: ".bench-home/cache/packages",
            globalFolder: ".bench-home/cache/global",
            installStatePath: ".bench-home/install-state.gz",
            yarnPath: ".bench-home/tooling/manager.js",
          })) {
            const result = await executeCommand(run, workspace, `candidate-${key}`, [yarn, "config", "get", key, "--json"], 120000);
            assert.equal(JSON.parse(result.stdout), join(workspace, path));
            paths[key] = result;
          }
          candidateToolProof = { version, paths, environment: "usual sandbox environment only; no adapter overlays" };
        }
        if (name !== "base") {
          await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn", join(task.taskDir, "original/solution/fix.patch")], options);
        }
        if (name === "index-fault") {
          await runCheckedSandboxCommand(run, ["git", "apply", "--whitespace=nowarn", join(task.taskDir, "controls/index-fault.patch")], options);
        }
        if (name === "reference") {
          await runCheckedSandboxCommand(run, ["git", "add", "--all"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, ".gitignore"), await Bun.file(join(workspace, ".gitignore")).text() + "\n# candidate ignore edit\n");
          for (const file of ["array.ts", "tuple.ts"]) await Bun.write(join(workspace, "test", file), "throw new Error('candidate test replacement');\n");
        }
        if (name === "base") {
          const node = join(workspace, ".bench-home/tooling/runtime/bin/node");
          const program = "const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{});" +
            "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{windowsHide:true,stdio:'ignore'});" +
            "console.log(process.pid+' '+child.pid);setInterval(()=>{},1000);";
          const expiry = await executeCommand(run, workspace, "deadline-proof", [node, "-e", program], 1500, "diagnostic");
          assert.equal(expiry.timedOut, true);
          const pids = expiry.stdout.trim().split(/\s+/).map(Number);
          assert.equal(pids.length, 2);
          for (const pid of pids) {
            assert.ok(Number.isSafeInteger(pid) && pid > 0);
            assert.throws(() => process.kill(pid, 0), (error: unknown) =>
              error instanceof Error && "code" in error && error.code === "ESRCH");
          }
          deadlineProof = { ...expiry, pids, childTreeGone: true };
        }
        // Capture reads source and Git only. Grade installs in its own workspace.
        for (const path of ["node_modules", ".bench-home/cache", ".bench-home/tooling", ".bench-home/inputs"]) {
          await rm(join(workspace, path), { recursive: true, force: true });
        }
        const captured = await captureImplementation(task, workspace, run);
        assert.ok(captured.nativeGrade);
        const grade = JSON.parse(captured.nativeGrade);
        const evidence = grade.evidence;
        const reward = name === "reference" ? 1 : 0;
        assert.deepEqual(captured.acceptance, { passed: reward, failed: 1 - reward, total: 1 });
        assert.equal(evidence.reward.exit, reward ? 0 : 1);
        assert.equal(evidence.reward.reward, reward);
        assert.equal(evidence.originalShellSha256, ledger["original/tests/test.sh"]!.sha256);
        assert.equal(evidence.isolatedTypesFrom, null);
        assert.equal(evidence.reportError, null);
        const inventory = evidence.reports as Inventory;
        const rows = inventory.testResults.flatMap(file => file.assertionResults.map(row => ({
          file: `test/${file.name.split("/").at(-1)}`, id: row.fullName, status: row.status,
        })));
        assert.deepEqual(rows.map(({ file, id }) => ({ file, id })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          [...expected].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
        const passed = rows.filter(row => row.status === "passed").length;
        assert.equal(passed, name === "base" ? 42 : name === "reference" ? 44 : 43);
        assert.equal(evidence.identities["tsconfig.json"], ledger["original/tsconfig.json"]!.sha256);
        assert.equal(evidence.candidateIdentities["lib/index.js"], setup.identities["lib/index.js"]);
        if (name === "reference") {
          for (const path of ["src/array.ts", "src/tuple.ts", "src/schema.ts", "src/object.ts"]) {
            assert.equal(evidence.candidateIdentities[path], sourceManifest[path]!.sha256);
            assert.notEqual(evidence.candidateIdentities[path], evidence.identities[path]);
          }
          for (const text of ["src/schema.ts", "untracked.txt", "candidate test replacement", "candidate ignore edit"]) assert.ok(captured.diff.includes(text));
          assert.ok(!evidence.commands.verifier.stderr.includes("candidate test replacement"));
        }
        const bytes = new TextEncoder().encode(JSON.stringify({ grade, patch: captured.diff, rows, setup }, null, 2) + "\n");
        const compressed = Bun.gzipSync(bytes);
        const file = `${name}-grade.json.gz`;
        await Bun.write(join(output, file), compressed);
        controls.push({ name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          acceptance: captured.acceptance, passed, tests: rows.length,
          failedIds: rows.filter(row => row.status !== "passed"),
          evidence: { file, bytes: compressed.length, sha256: hash(compressed),
            decompressedBytes: bytes.length, decompressedSha256: hash(bytes) } });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    assert.deepEqual(await readdir(temp), []);
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
    await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
      task: task.id, testedContentIdentity: task.contentIdentity,
      testedContentIdentityScope: "Whole fixture before retaining these results; retained evidence changes the current fixture hash.",
      observedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
      controls, deadlineProof, candidateToolProof, cleanup: { tmpClean: true }, modelCalls: 0,
      empiricalModelDifficulty: "not measured", empiricalModelCost: "not measured",
      caveat: "The unchanged 44-test grader covers less than the original prompt's full API contract.",
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
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) await main();
