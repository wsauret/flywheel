import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

interface GrepResult { readonly matches: readonly { readonly path: string }[]; readonly traversalIssues: number }
interface RipgrepAddon { readonly grep: (options: { readonly pattern: string; readonly path: string; readonly mode: string; readonly protectedTraversalRoots: readonly string[]; readonly cpuLimitMs: number; readonly timeoutMs: number }) => Promise<GrepResult> }
interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
interface StringEditProbePlan { readonly content: string; readonly matchKinds: readonly string[] }
type StringEditPlanner = (source: string, edits: readonly { readonly oldString: string; readonly newString: string }[]) => StringEditProbePlan;
interface StringEditProbeCase {
  readonly name: string;
  readonly source: string;
  readonly oldString: string;
  readonly newString: string;
  readonly expectedContent: string;
  readonly expectedMatchKind: string;
}
interface Environment { readonly [name: string]: string }
interface UnknownDictionary { readonly [name: string]: unknown }
export interface PackageSmokeWorkspace { readonly root: string; readonly extracted: string; readonly home: string; readonly bin: string; readonly project: string }
export interface PackageSmokeDependencies {
  readonly createWorkspace: () => PackageSmokeWorkspace;
  readonly probeRipgrepAddon: (addonPath: string, root: string) => Promise<number>;
  readonly probeTokenizerAsset: (assetPath: string, manifestPath?: string) => Promise<string>;
  readonly probeStringEditPlanner: () => Promise<string>;
  readonly run: (command: readonly string[], cwd: string, env: Environment) => CommandResult;
  readonly readText: (path: string) => string;
  readonly cleanup: (root: string) => void;
  readonly findPowerShell: () => string;
  readonly environment: Environment;
}

interface TokenizerManifest {
  readonly abi: { readonly imports: readonly unknown[]; readonly exports: readonly string[] };
  readonly artifact: { readonly compressedSha256: string; readonly compressedBytes: number; readonly wasmSha256: string; readonly wasmBytes: number };
}

function parseTokenizerManifest(value: unknown): TokenizerManifest {
  const manifest = record(value, "tokenizer manifest");
  const abi = record(manifest["abi"], "tokenizer manifest abi");
  const artifact = record(manifest["artifact"], "tokenizer manifest artifact");
  const imports = abi["imports"];
  const exports = abi["exports"];
  if (!Array.isArray(imports) || !Array.isArray(exports)) throw new Error("tokenizer manifest ABI entries must be arrays");
  return {
    abi: {
      imports,
      exports: exports.map((entry) => {
        const descriptor = record(entry, "tokenizer manifest abi export");
        return `${stringField(descriptor, "name")}:${stringField(descriptor, "kind")}`;
      }),
    },
    artifact: {
      compressedSha256: stringField(artifact, "compressedSha256"),
      compressedBytes: numberField(artifact, "compressedBytes"),
      wasmSha256: stringField(artifact, "wasmSha256"),
      wasmBytes: numberField(artifact, "wasmBytes"),
    },
  };
}

function record(value: unknown, name: string): UnknownDictionary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: UnknownDictionary, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new Error(`tokenizer manifest ${name} must be a string`);
  return field;
}

function numberField(value: UnknownDictionary, name: string): number {
  const field = value[name];
  if (typeof field !== "number") throw new Error(`tokenizer manifest ${name} must be a number`);
  return field;
}

type TokenizerExports = {
  readonly memory: WebAssembly.Memory;
  readonly allocate: (length: number) => number;
  readonly count: (encoding: number, pointer: number, length: number) => number;
  readonly release: (pointer: number, length: number) => void;
};

function tokenizerExports(exports: WebAssembly.Exports): TokenizerExports {
  const memory = exports["memory"];
  const allocate = exports["allocate"];
  const count = exports["count"];
  const release = exports["release"];
  if (!(memory instanceof WebAssembly.Memory) || memory.buffer.byteLength !== 49 * 65_536 || typeof allocate !== "function" || allocate.length !== 1 || typeof count !== "function" || count.length !== 3 || typeof release !== "function" || release.length !== 2) {
    throw new Error("packaged tokenizer ABI mismatch");
  }
  return {
    memory,
    allocate: (length) => requireNumericAbiResult(allocate(length)),
    count: (encoding, pointer, length) => requireNumericAbiResult(count(encoding, pointer, length)),
    release: (pointer, length) => { release(pointer, length); },
  };
}

function requireNumericAbiResult(value: unknown): number {
  if (typeof value !== "number") throw new Error("packaged tokenizer ABI returned an invalid value");
  return value;
}

const TOKENIZER_FIXTURES = [
  { text: "Café é 中文 日本語 مرحبا 👩🏽‍💻", counts: [16, 26, 26, 26, 26] },
  { text: "\ud800", counts: [1, 2, 2, 1, 1] },
] as const;
const TOKENIZER_ENCODINGS = ["O200kBase", "ClaudeV3", "ClaudeV47", "ClaudeV5", "ClaudeV5Sonnet"] as const;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verifies and executes the packaged tokenizer without loading the target executable. */
export async function verifyPackagedTokenizer(assetPath: string, manifestPath = resolve(import.meta.dir, "../crates/tokenizer/tokenizer-prebuilt.json")): Promise<string> {
  const manifest = parseTokenizerManifest(JSON.parse(await readFile(manifestPath, "utf-8")));
  const compressed = await readFile(assetPath);
  if (compressed.byteLength !== manifest.artifact.compressedBytes || sha256(compressed) !== manifest.artifact.compressedSha256) throw new Error("packaged tokenizer compressed artifact mismatch");
  const wasm = zstdDecompressSync(compressed);
  if (wasm.byteLength !== manifest.artifact.wasmBytes || sha256(wasm) !== manifest.artifact.wasmSha256) throw new Error("packaged tokenizer wasm artifact mismatch");
  const module = await WebAssembly.compile(wasm);
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module).map(({ name, kind }) => `${name}:${kind}`);
  if (
    imports.length !== 0 || manifest.abi.imports.length !== 0 ||
    exports.join(",") !== manifest.abi.exports.join(",")
  ) throw new Error("packaged tokenizer ABI mismatch");
  const instance = await WebAssembly.instantiate(module, {});
  const candidate = tokenizerExports(instance.exports);
  for (const fixture of TOKENIZER_FIXTURES) {
    const length = fixture.text.length;
    const pointer = candidate.allocate(length);
    try {
      const memory = new Uint16Array(candidate.memory.buffer, pointer, length);
      for (let index = 0; index < length; index += 1) memory[index] = fixture.text.charCodeAt(index);
      for (let encoding = 0; encoding < TOKENIZER_ENCODINGS.length; encoding += 1) {
        const actual = candidate.count(encoding, pointer, length);
        if (actual !== fixture.counts[encoding]) throw new Error(`packaged tokenizer fixture failed ${TOKENIZER_ENCODINGS[encoding]}: ${actual}`);
      }
    } finally {
      candidate.release(pointer, length);
    }
  }
  return TOKENIZER_ENCODINGS.join(",");
}
/** The tar this host can drive.
 *
 *  `tar` on PATH under Windows can be the GNU build a POSIX shell brings, which
 *  reads no Windows path: it takes the drive colon of an archive for a
 *  `host:path` separator and the backslashes of a directory for literal name
 *  bytes. Windows ships bsdtar in System32, which reads both. Every other host,
 *  and the Linux containers, keep the tar on PATH. */
export function tarExecutable(platform: string = process.platform): string {
  return platform === "win32" ? join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", "tar.exe") : "tar";
}

export interface PackageSmokeOptions { readonly target: string; readonly archive?: string; readonly addon?: string; readonly planners?: boolean; readonly expectedVersion?: string; readonly tokenizerManifest?: string }

function requireSuccess(name: string, result: CommandResult): void {
  if (result.exitCode !== 0) throw new Error(`${name} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
}

async function probeRipgrepAddon(addonPath: string, root: string): Promise<number> {
  const searchRoot = join(root, "search");
  const protectedRoot = join(root, "protected");
  mkdirSync(searchRoot, { recursive: true });
  mkdirSync(protectedRoot, { recursive: true });
  writeFileSync(join(searchRoot, "plain.txt"), "needle\n");
  writeFileSync(join(protectedRoot, "secret.txt"), "needle\n");
  symlinkSync(protectedRoot, join(searchRoot, "protected-link"), process.platform === "win32" ? "junction" : "dir");
  const addon: RipgrepAddon = createRequire(import.meta.url)(addonPath);
  const result = await addon.grep({ pattern: "needle", path: searchRoot, mode: "content", protectedTraversalRoots: [protectedRoot], cpuLimitMs: 30_000, timeoutMs: 120_000 });
  if (!result.matches.some((match) => match.path.includes("plain.txt"))) throw new Error("packaged addon did not search the ordinary file");
  if (result.traversalIssues <= 0) throw new Error(`packaged addon did not report the protected linked directory: ${JSON.stringify({ searchRoot, protectedRoot, canonicalProtectedRoot: realpathSync.native(protectedRoot), matches: result.matches.map(({ path }) => path), traversalIssues: result.traversalIssues })}`);
  return result.traversalIssues;
}

async function probeRipgrepAddonInSubprocess(addonPath: string, root: string, environment: Environment): Promise<number> {
  const result = runCommand([
    process.execPath,
    import.meta.path,
    "--probe-ripgrep-addon",
    resolve(addonPath),
    "--probe-root",
    resolve(root),
  ], root, environment);
  requireSuccess("packaged ripgrep addon probe", result);
  const output: unknown = JSON.parse(result.stdout);
  const recordOutput = record(output, "packaged ripgrep addon probe output");
  return numberField(recordOutput, "traversalIssues");
}

const STRING_EDIT_PROBE_CASES: readonly StringEditProbeCase[] = [
  { name: "exact", source: "one two", oldString: "two", newString: "three", expectedContent: "one three", expectedMatchKind: "exact" },
  { name: "CRLF", source: "one\r\ntwo\r\n", oldString: "one\ntwo\n", newString: "uno\ndos\n", expectedContent: "uno\r\ndos\r\n", expectedMatchKind: "line-ending" },
  { name: "tab indentation", source: "fn main() {\n\tone\n\ttwo\n}\n", oldString: "one\ntwo", newString: "uno\ndos", expectedContent: "fn main() {\n\tuno\n\tdos\n}\n", expectedMatchKind: "uniform-indent" },
];

/** Exercise the string edit planner behaviors whose loss would corrupt user text. */
export function verifyStringEditPlanner(planStringEdits: StringEditPlanner): string {
  const matchKinds: string[] = [];
  for (const probe of STRING_EDIT_PROBE_CASES) {
    const plan = planStringEdits(probe.source, [{ oldString: probe.oldString, newString: probe.newString }]);
    if (plan.content !== probe.expectedContent || plan.matchKinds.join(",") !== probe.expectedMatchKind) {
      throw new Error(`string edit planner failed ${probe.name} probe: ${JSON.stringify(plan)}`);
    }
    matchKinds.push(probe.expectedMatchKind);
  }
  return matchKinds.join(",");
}

/** The planners are TypeScript compiled into every binary; this probe runs them from source. The import
 *  is resolved only here, so the harness stays self-contained when a container mounts it alone. */
async function probeStringEditPlanner(): Promise<string> {
  const { planStringEdits } = await import("../src/infra/file-edit/string-edit.js");
  return verifyStringEditPlanner(planStringEdits);
}

/** Exercise one staged addon or complete release archive through its installed public commands. */
export async function runPackageSmoke(options: PackageSmokeOptions, dependencies: PackageSmokeDependencies): Promise<void> {
  const workspace = dependencies.createWorkspace();
  try {
    const env = { ...dependencies.environment, HOME: workspace.home, USERPROFILE: workspace.home, FLYWHEEL_INSTALL_DIR: workspace.bin, FLYWHEEL_NO_MODIFY_PATH: "1" };
    if (options.planners) {
      const matchKinds = await dependencies.probeStringEditPlanner();
      console.log(`package-smoke: ${options.target} string edit planner passed (matchKinds=${matchKinds})`);
      return;
    }
    if (options.addon) {
      const issues = await dependencies.probeRipgrepAddon(resolve(options.addon), workspace.root);
      console.log(`package-smoke: ${options.target} staged ripgrep addon passed (traversalIssues=${issues})`);
      return;
    }
    if (!options.archive) throw new Error("--archive requires a value");
    if (!options.expectedVersion) throw new Error("--expected-version requires a value");
    const archive = resolve(options.archive);
    const isWindows = options.target.startsWith("win32-");
    // The platform's own tar, by path on Windows. `tar` on PATH there can be
    // the GNU build a POSIX shell brings, which reads no Windows path: it takes
    // the drive colon of the archive for a `host:path` separator and the
    // backslashes of the extraction directory for literal name bytes. Windows
    // ships bsdtar in System32, which reads both, and every other host and the
    // Linux containers keep the tar on PATH.
    requireSuccess("archive extraction", dependencies.run([tarExecutable(), "-xzf", archive, "-C", workspace.extracted], workspace.root, env));
    const stage = join(workspace.extracted, `flywheel-${options.target}`);
    const payload = join(stage, "build");
    const nativeDir = join(payload, "native", options.target);
    const issues = await dependencies.probeRipgrepAddon(join(nativeDir, `flywheel-ripgrep.${options.target}.node`), workspace.root);
    const tokenizerEncodings = await dependencies.probeTokenizerAsset(join(nativeDir, "flywheel-tokenizer.wasm.zst"), options.tokenizerManifest);
    const startupEnv = { ...env, FLYWHEEL_NATIVE_DIR: nativeDir };
    const installer = isWindows ? [dependencies.findPowerShell(), "-NoProfile", "-File", join(stage, "install.ps1")] : ["sh", join(stage, "install.sh")];
    requireSuccess("archive installer", dependencies.run(installer, stage, env));
    const installed = join(workspace.bin, isWindows ? "flywheel.exe" : "flywheel");
    // An installed build names its build identity from the metadata beside
    // it, which is the answer every update's run proof requires (ARCH-DISTRIBUTION-016).
    const expectedLine = `flywheel ${options.expectedVersion} (build ${archiveBuildId(dependencies.readText(join(payload, "build.json")))})`;
    const version = dependencies.run([installed, "--version"], workspace.project, startupEnv);
    requireSuccess("installed --version", version);
    if (version.stdout !== expectedLine) throw new Error(`installed version was ${JSON.stringify(version.stdout)}, not ${JSON.stringify(expectedLine)}`);
    requireSuccess("installed auth status", dependencies.run([installed, "auth", "status"], workspace.project, startupEnv));
    const missingStore = dependencies.run([installed, "--project-root", workspace.project, "events", "search", "--list-types"], workspace.project, startupEnv);
    const expectedStore = join(workspace.project, ".flywheel", "flywheel.sqlite");
    if (missingStore.exitCode === 0 || !`${missingStore.stdout}\n${missingStore.stderr}`.includes(expectedStore)) throw new Error(`missing-store behavior did not name ${expectedStore}: ${missingStore.stderr || missingStore.stdout}`);
    console.log(`package-smoke: ${options.target} passed (${basename(archive)}; traversalIssues=${issues}; tokenizer=${tokenizerEncodings})`);
  } finally {
    dependencies.cleanup(workspace.root);
  }
}

/** The build identity an archive's `build.json` states. */
function archiveBuildId(metadata: string): string {
  const parsed: unknown = JSON.parse(metadata);
  const buildId = typeof parsed === "object" && parsed !== null && "buildId" in parsed ? parsed.buildId : undefined;
  if (typeof buildId !== "string" || !/^[0-9a-f]{64}$/.test(buildId)) throw new Error(`the archive's build.json states no build identity: ${metadata}`);
  return buildId;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const SUBPROCESS_TIMEOUT_MS = 60_000;

function runCommand(command: readonly string[], cwd: string, env: Environment): CommandResult {
  const result = Bun.spawnSync([...command], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: SUBPROCESS_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  const timedOut = result.signalCode === "SIGKILL" && result.exitCode === null;
  return { exitCode: result.exitCode ?? 1, stdout, stderr: timedOut ? `${stderr}${stderr ? "\n" : ""}command timed out after ${SUBPROCESS_TIMEOUT_MS / 1_000}s` : stderr };
}

if (import.meta.main) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const probeAddon = argument("--probe-ripgrep-addon");
  if (probeAddon) {
    const probeRoot = argument("--probe-root") ?? (() => { throw new Error("--probe-root requires a value"); })();
    const traversalIssues = await probeRipgrepAddon(resolve(probeAddon), resolve(probeRoot));
    process.stdout.write(JSON.stringify({ traversalIssues }));
  } else {
    const createWorkspace = () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "flywheel-readiness-package-"));
      const workspace = { root: workspaceRoot, extracted: join(workspaceRoot, "extracted"), home: join(workspaceRoot, "home"), bin: join(workspaceRoot, "bin"), project: join(workspaceRoot, "project") };
      for (const path of Object.values(workspace)) mkdirSync(path, { recursive: true });
      return workspace;
    };
    await runPackageSmoke({ target: argument("--target") ?? (() => { throw new Error("--target requires a value"); })(), archive: argument("--archive"), addon: argument("--addon"), planners: process.argv.includes("--planners"), expectedVersion: argument("--expected-version"), tokenizerManifest: argument("--tokenizer-manifest") }, {
      createWorkspace,
      probeRipgrepAddon: (addonPath, root) => probeRipgrepAddonInSubprocess(addonPath, root, inherited),
      probeTokenizerAsset: verifyPackagedTokenizer,
      probeStringEditPlanner,
      run: runCommand,
      readText: (path) => readFileSync(path, "utf8"),
      cleanup: (path) => rmSync(path, { recursive: true, force: true }),
      findPowerShell: () => Bun.which("powershell") ?? Bun.which("pwsh") ?? "powershell",
      environment: inherited,
    });
  }
}
