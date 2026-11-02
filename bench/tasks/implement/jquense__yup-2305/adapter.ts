import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ownedCommandRunner, type OwnedCommandRunner } from "../../../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../src/infra/process-supervisor.js";
import { runSandboxCommand } from "../../../../src/orchestration/modules/development/benchmark/sandbox-command.js";

interface PublicInput { file: string; url: string; bytes: number; sha256: string }
interface Identity { bytes: number; sha256: string }
const hash = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

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

/** Acquire only public setup inputs. Prepare BASE before capture; grade a
 * captured patch against fresh BASE and the unchanged original shell policy. */
async function main(): Promise<void> {
  const [action, taskArg, workspaceArg, ...artifacts] = process.argv.slice(2);
  if (!taskArg || !workspaceArg || !(
    (action === "prepare" && artifacts.length === 0) ||
    (action === "grade" && artifacts.length === 2)
  )) throw new Error("expected prepare task workspace, or grade task workspace patch report");
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The pinned runtime requires macOS arm64");
  const task = resolve(taskArg);
  const workspace = resolve(workspaceArg);
  const home = join(workspace, ".bench-home");
  const tooling = join(home, "tooling");
  for (const path of ["inputs", "tooling/runtime", "tooling/bootstrap", "bin", "tmp", "cache"]) {
    await mkdir(join(home, path), { recursive: true });
  }
  // The repository's ancestor package is ESM; the bootstrap bundle is CommonJS.
  await Bun.write(join(tooling, "package.json"), '{"type":"commonjs"}\n');
  const node = join(tooling, "runtime/bin/node");
  const bootstrap = join(tooling, "bootstrap/package/dist/corepack.js");
  const env: Record<string, string> = {
    PATH: `${join(home, "bin")}:${join(tooling, "runtime/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home, TMPDIR: join(home, "tmp"), COREPACK_HOME: join(home, "cache/bootstrap"),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_DEFAULT_TO_LATEST: "0",
    YARN_ENABLE_GLOBAL_CACHE: "false", YARN_CACHE_FOLDER: join(home, "cache/packages"),
    YARN_GLOBAL_FOLDER: join(home, "cache/global"), YARN_INSTALL_STATE_PATH: join(home, "install-state.gz"),
  };
  const supervisor = createProcessSupervisor();
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
    const acquisitionDeadline = performance.now() + 600000;
    const inputs: PublicInput[] = await Bun.file(join(task, "public-inputs.json")).json();
    const acquired = [];
    for (const input of inputs) {
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
    await execute("runtime-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/node.tar.gz"), "--strip-components=1", "-C", join(tooling, "runtime")], acquisitionDeadline);
    await execute("bootstrap-extract", ["/usr/bin/tar", "-xzf", join(home, "inputs/corepack.tgz"), "-C", join(tooling, "bootstrap")], acquisitionDeadline);
    const extractSource = ["/usr/bin/tar", "-xzf", join(home, "inputs/yup.tar.gz"), "--strip-components=1", "-C", workspace];
    await execute("source-extract", extractSource, acquisitionDeadline);
    const sourceManifest: Record<string, Identity> = await Bun.file(join(task, "source-manifest.json")).json();
    for (const [path, identity] of Object.entries(sourceManifest)) {
      const bytes = await Bun.file(join(workspace, path)).bytes();
      if (bytes.length !== identity.bytes || hash(bytes) !== identity.sha256) throw new Error(`source identity mismatch: ${path}`);
    }
    const buildDeadline = performance.now() + 600000;
    await execute("runtime-version", [node, "--version"], buildDeadline);
    await execute("bootstrap-version", [node, bootstrap, "--version"], buildDeadline);
    await execute("package-manager-version", [node, bootstrap, "yarn", "--version"], buildDeadline);
    const managerBytes = await Bun.file(join(home, "cache/bootstrap/v1/yarn/4.5.3/yarn.js")).bytes();
    const managerIdentity = inputs.find(row => row.file === "inputs/yarn-4.5.3.js")!;
    if (managerBytes.length !== managerIdentity.bytes || hash(managerBytes) !== managerIdentity.sha256) throw new Error("package manager identity mismatch");
    const manager = new TextDecoder().decode(managerBytes);
    const launcherLedger: { original: string; adapted: string } = await Bun.file(join(task, "launcher-replacement.json")).json();
    if (manager.split(launcherLedger.original).length !== 2) throw new Error("launcher replacement must match exactly once");
    const adaptedManager = new TextEncoder().encode(manager.replace(launcherLedger.original, launcherLedger.adapted));
    const adaptedManagerPath = join(tooling, "manager.js");
    await Bun.write(adaptedManagerPath, adaptedManager);
    // The pinned bundle emits an unescaped double-quoted executable path.
    // Use its existing argument-quoting rule for that one executable instead.
    env.YARN_YARN_PATH = adaptedManagerPath;
    // Candidate commands receive only the sandbox environment. Materialize the
    // adapter's prepared environment here so all later Yarn paths share it.
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const launcher = "#!/bin/bash\n" +
      Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}\n`).join("") +
      `exec ${quote(node)} ${quote(bootstrap)} yarn "$@"\n`;
    const yarn = [join(home, "bin/yarn")];
    await Bun.write(yarn[0]!, launcher);
    await chmod(yarn[0]!, 0o755);
    const launcherAdaptation = { ...launcherLedger, originalSha256: hash(managerBytes), adaptedSha256: hash(adaptedManager), replacements: 1 };
    await execute("install", [...yarn, "install", "--frozen-lockfile"], buildDeadline);
    const originalConfig = await Bun.file(join(workspace, "tsconfig.json")).text();
    let ancestor = dirname(workspace);
    let isolatedTypesFrom: string | null = null;
    while (dirname(ancestor) !== ancestor) {
      if (await Bun.file(join(ancestor, "node_modules/@types/bun/package.json")).exists()) {
        isolatedTypesFrom = ancestor;
        break;
      }
      ancestor = dirname(ancestor);
    }
    const isolateTypes = async () => {
      if (isolatedTypesFrom) {
        const config = JSON.parse(originalConfig);
        config.compilerOptions.typeRoots = ["./node_modules/@types"];
        await Bun.write(join(workspace, "tsconfig.json"), JSON.stringify(config, null, 2) + "\n");
      }
    };
    await isolateTypes();
    await execute("fixed-build", [...yarn, "build"], buildDeadline);
    const fixedBuildSha256 = hash(await Bun.file(join(workspace, "lib/index.js")).bytes());
    // This restores all tracked archive bytes, as the container reset does.
    await execute("restore-tracked", extractSource, buildDeadline);
    await isolateTypes();
    await execute("bug-patch", ["/usr/bin/patch", "-p1", "-i", join(task, "original/environment/bug.patch")], buildDeadline);
    await execute("base-build", [...yarn, "build"], buildDeadline);
    // The public HEAD archive includes fixed source and added tests.
    await rm(join(home, "inputs/yup.tar.gz"));
    const identities: Record<string, string> = {};
    for (const path of ["src/array.ts", "src/tuple.ts", "src/schema.ts", "src/object.ts", "src/types.ts", "tsconfig.json", "yarn.lock", "lib/index.js", "dts/index.d.ts"]) {
      identities[path] = hash(await Bun.file(join(workspace, path)).bytes());
    }
    if (identities["yarn.lock"] !== sourceManifest["yarn.lock"]!.sha256) throw new Error("frozen lock changed");
    const cache = await readdir(join(home, "cache/packages"));
    await Bun.write(join(home, "setup.json"), JSON.stringify({
      acquired, commands, identities, fixedBuildSha256, isolatedTypesFrom, launcherAdaptation, sourceFiles: Object.keys(sourceManifest).length,
      packages: { cacheEntries: cache.length, node: "22.23.3", bootstrap: "0.36.0", manager: "4.5.3" },
    }, null, 2));
    if (action === "prepare") return;
    // The shared provisioner appends these entries before capture's baseline.
    const ignore = join(workspace, ".gitignore");
    await Bun.write(ignore, (await Bun.file(ignore).text()) + "\n.flywheel/\n.bench-home/\n");
    await execute("git-init", ["/usr/bin/git", "init", "-q"], buildDeadline);
    if ((await stat(artifacts[0]!)).size) await execute("candidate-patch", ["/usr/bin/git", "apply", resolve(artifacts[0]!)], buildDeadline);
    const verifierDir = join(home, "verifier");
    const testsDir = join(home, "tests");
    await mkdir(verifierDir, { recursive: true });
    await mkdir(testsDir, { recursive: true });
    for (const file of ["array.ts", "tuple.ts"]) await Bun.write(join(testsDir, file), await Bun.file(join(task, "original/tests", file)).bytes());
    const originalShell = await Bun.file(join(task, "original/tests/test.sh")).text();
    const nativeShell = originalShell.replaceAll("/app/src", "${APP_DIR}").replaceAll("/tests/", "${TESTS_DIR}/").replaceAll("/logs/verifier/", "${VERIFIER_DIR}/")
      .replace("cd ${APP_DIR}", 'cd "$APP_DIR"').replaceAll("> ${VERIFIER_DIR}/reward.txt", '> "$VERIFIER_DIR/reward.txt"');
    await Bun.write(join(testsDir, "test.sh"), nativeShell);
    Object.assign(env, { APP_DIR: workspace, TESTS_DIR: testsDir, VERIFIER_DIR: verifierDir });
    const verifier = await execute("verifier", ["/bin/bash", join(testsDir, "test.sh")], performance.now() + 600000, "verifier");
    const rewardText = await Bun.file(join(verifierDir, "reward.txt")).text();
    const reward = Number(rewardText.trim());
    if ((reward !== 0 && reward !== 1) || reward !== Number(verifier.exitCode === 0)) throw new Error("original shell reward disagrees with its exit");
    // The separate inventory invocation cannot change the shell reward.
    const candidateIdentities: Record<string, string | null> = {};
    const candidateIdentityErrors: Record<string, string> = {};
    for (const path of Object.keys(identities)) {
      try { candidateIdentities[path] = hash(await Bun.file(join(workspace, path)).bytes()); }
      catch (error) {
        candidateIdentities[path] = null;
        candidateIdentityErrors[path] = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
      }
    }
    const inventory = await execute("inventory", [...yarn, "testonly", "test/array.ts", "test/tuple.ts", "--json", "--outputFile", join(verifierDir, "inventory.json")], performance.now() + 120000, "diagnostic");
    let reports: unknown = null;
    let reportError: string | null = null;
    try { reports = await Bun.file(join(verifierDir, "inventory.json")).json(); }
    catch (error) { reportError = error instanceof Error ? error.message : "inventory unavailable"; }
    await Bun.write(artifacts[1]!, JSON.stringify({
      passed: reward, failed: 1 - reward, total: 1,
      evidence: { acquired, commands, identities, fixedBuildSha256, candidateIdentities, candidateIdentityErrors, isolatedTypesFrom, launcherAdaptation,
        reward: { reward, text: rewardText, exit: verifier.exitCode },
        originalShellSha256: hash(new TextEncoder().encode(originalShell)),
        nativeShellSha256: hash(new TextEncoder().encode(nativeShell)), inventoryExit: inventory.exitCode,
        reports, reportError, sourceFiles: Object.keys(sourceManifest).length,
        packages: { cacheEntries: cache.length, node: "22.23.3", bootstrap: "0.36.0", manager: "4.5.3" },
        limits: { acquisitionMs: 600000, buildMs: 600000, verifierMs: 600000, inventoryMs: 120000, adapterMs: 1920000, candidateMs: 1500000 },
        equivalence: "native macOS arm64 criterion only; no original container resources, floating Node patch, original 600-second agent budget, leaderboard or OS network confinement equivalence" },
    }, null, 2) + "\n");
  } finally {
    try {
      const closure = await scope.close();
      if (!closure.settled) throw new Error(`adapter ownership did not settle: ${closure.reason}`);
    } finally { await supervisor.dispose(); }
  }
}

if (import.meta.main) await main();
