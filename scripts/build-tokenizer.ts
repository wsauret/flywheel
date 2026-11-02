import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { Schema } from "effect";
import { checkedExports } from "../src/infra/local-tokenizer.js";

export const TOKENIZER_TOOLCHAIN = "nightly-2026-07-28";
export const TOKENIZER_TARGET = "wasm32-unknown-unknown";
export const TOKENIZER_RUSTC_COMMIT = "09ee43b2d6055539771bee8ac30a6e56eb4db773";
export const TOKENIZER_TARGET_ARCHIVE_URL = "https://static.rust-lang.org/dist/2026-07-28/rust-std-nightly-wasm32-unknown-unknown.tar.xz";
export const TOKENIZER_TARGET_ARCHIVE_SHA256 = "b96f9154922368d06628eb2dba683a027e58ea328ff8ff3bbdd6d056780f5bbc";
export const TOKENIZER_ARTIFACT = "crates/tokenizer/flywheel-tokenizer.wasm.zst";
export const TOKENIZER_FINGERPRINT = "crates/tokenizer/tokenizer-prebuilt.json";
export const TOKENIZER_RUSTFLAGS = "-Zremap-cwd-prefix=/flywheel-tokenizer";

const FINGERPRINT_VERSION = 2;
const OMP_REVISION = "a1b254047d12e143b7c6011536e918c6c35c5906";
const CTOK_REVISION = "df3b59b5e645289a5eadc8e24036b99d39c333c4";
const CORPUS_PATH = "fixtures/corpus.json";
const CLAUDE_FIXTURES_PATH = "src/utok/claude/testdata/fixtures.json";
const SONNET_FIXTURES_PATH = "src/utok/claude/testdata/sonnet5_live.json";
const ENCODINGS = ["O200kBase", "ClaudeV3", "ClaudeV47", "ClaudeV5", "ClaudeV5Sonnet"] as const;
const CLAUDE_OFFSETS = { ClaudeV3: 7, ClaudeV47: 11, ClaudeV5: 6 } as const;
const WASM_MAGIC = Uint8Array.from([0, 97, 115, 109]);

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface TokenizerBuildEnvironment {
  readonly [name: string]: string;
}

export interface TokenizerFileSystem {
  readonly cp: typeof cp;
  readonly lstat: typeof lstat;
  readonly mkdir: typeof mkdir;
  readonly mkdtemp: typeof mkdtemp;
  readonly readFile: typeof readFile;
  readonly readdir: typeof readdir;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly writeFile: typeof writeFile;
}

export interface BuildTokenizerOptions {
  readonly root?: string;
  readonly verify?: boolean;
  readonly run?: (argv: readonly string[], cwd?: string, environment?: TokenizerBuildEnvironment) => Promise<CommandResult>;
  readonly fs?: TokenizerFileSystem;
  readonly onTrackedWrite?: (path: string) => void;
}

interface TokenizerFingerprint {
  readonly version: typeof FINGERPRINT_VERSION;
  readonly toolchain: typeof TOKENIZER_TOOLCHAIN;
  readonly target: typeof TOKENIZER_TARGET;
  readonly rustcCommit: typeof TOKENIZER_RUSTC_COMMIT;
  readonly targetArchive: { readonly url: typeof TOKENIZER_TARGET_ARCHIVE_URL; readonly sha256: typeof TOKENIZER_TARGET_ARCHIVE_SHA256 };
  readonly upstream: { readonly revision: typeof OMP_REVISION };
  readonly ctok: { readonly revision: typeof CTOK_REVISION };
  readonly sourceSha256: string;
  readonly cargo: { readonly tomlSha256: string; readonly lockSha256: string };
  readonly vocabularies: {
    readonly "ctok_v3.bin.zst": string;
    readonly "ctok_v4_7.bin.zst": string;
    readonly "o200k_base.bin.zst": string;
  };
  readonly fixtureInventory: {
    readonly corpus: { readonly rows: 6; readonly checks: 30; readonly sha256: string };
    readonly claude: { readonly rows: 493; readonly checks: 1479; readonly offsets: typeof CLAUDE_OFFSETS; readonly sha256: string };
    readonly sonnet: { readonly rows: 63; readonly checks: 63; readonly offset: 6; readonly sha256: string };
    readonly totalChecks: 1572;
  };
  readonly abi: {
    readonly imports: readonly [];
    readonly exports: readonly [
      { readonly name: "memory"; readonly kind: "memory"; readonly type: { readonly minimum: 49; readonly shared: false; readonly address: "i32" } },
      { readonly name: "allocate"; readonly kind: "function"; readonly type: { readonly parameters: readonly ["i32"]; readonly results: readonly ["i32"] } },
      { readonly name: "count"; readonly kind: "function"; readonly type: { readonly parameters: readonly ["i32", "i32", "i32"]; readonly results: readonly ["i32"] } },
      { readonly name: "release"; readonly kind: "function"; readonly type: { readonly parameters: readonly ["i32", "i32"]; readonly results: readonly [] } },
    ];
  };
  readonly artifact: { readonly compressedSha256: string; readonly compressedBytes: number; readonly wasmSha256: string; readonly wasmBytes: number };
}

const FingerprintSchema = Schema.Struct({
  version: Schema.Literal(FINGERPRINT_VERSION),
  toolchain: Schema.Literal(TOKENIZER_TOOLCHAIN),
  target: Schema.Literal(TOKENIZER_TARGET),
  rustcCommit: Schema.Literal(TOKENIZER_RUSTC_COMMIT),
  targetArchive: Schema.Struct({ url: Schema.Literal(TOKENIZER_TARGET_ARCHIVE_URL), sha256: Schema.Literal(TOKENIZER_TARGET_ARCHIVE_SHA256) }),
  upstream: Schema.Struct({ revision: Schema.Literal(OMP_REVISION) }),
  ctok: Schema.Struct({ revision: Schema.Literal(CTOK_REVISION) }),
  sourceSha256: Schema.String,
  cargo: Schema.Struct({ tomlSha256: Schema.String, lockSha256: Schema.String }),
  vocabularies: Schema.Struct({
    "ctok_v3.bin.zst": Schema.String,
    "ctok_v4_7.bin.zst": Schema.String,
    "o200k_base.bin.zst": Schema.String,
  }),
  fixtureInventory: Schema.Struct({
    corpus: Schema.Struct({ rows: Schema.Literal(6), checks: Schema.Literal(30), sha256: Schema.String }),
    claude: Schema.Struct({
      rows: Schema.Literal(493),
      checks: Schema.Literal(1479),
      offsets: Schema.Struct({ ClaudeV3: Schema.Literal(7), ClaudeV47: Schema.Literal(11), ClaudeV5: Schema.Literal(6) }),
      sha256: Schema.String,
    }),
    sonnet: Schema.Struct({ rows: Schema.Literal(63), checks: Schema.Literal(63), offset: Schema.Literal(6), sha256: Schema.String }),
    totalChecks: Schema.Literal(1572),
  }),
  abi: Schema.Struct({
    imports: Schema.Tuple([]),
    exports: Schema.Tuple([
      Schema.Struct({ name: Schema.Literal("memory"), kind: Schema.Literal("memory"), type: Schema.Struct({ minimum: Schema.Literal(49), shared: Schema.Literal(false), address: Schema.Literal("i32") }) }),
      Schema.Struct({ name: Schema.Literal("allocate"), kind: Schema.Literal("function"), type: Schema.Struct({ parameters: Schema.Tuple([Schema.Literal("i32")]), results: Schema.Tuple([Schema.Literal("i32")]) }) }),
      Schema.Struct({ name: Schema.Literal("count"), kind: Schema.Literal("function"), type: Schema.Struct({ parameters: Schema.Tuple([Schema.Literal("i32"), Schema.Literal("i32"), Schema.Literal("i32")]), results: Schema.Tuple([Schema.Literal("i32")]) }) }),
      Schema.Struct({ name: Schema.Literal("release"), kind: Schema.Literal("function"), type: Schema.Struct({ parameters: Schema.Tuple([Schema.Literal("i32"), Schema.Literal("i32")]), results: Schema.Tuple([]) }) }),
    ]),
  }),
  artifact: Schema.Struct({ compressedSha256: Schema.String, compressedBytes: Schema.Number, wasmSha256: Schema.String, wasmBytes: Schema.Number }),
});
const CorpusRowsSchema = Schema.Array(Schema.Struct({
  text: Schema.String,
  counts: Schema.Struct({
    O200kBase: Schema.Number,
    ClaudeV3: Schema.Number,
    ClaudeV47: Schema.Number,
    ClaudeV5: Schema.Number,
    ClaudeV5Sonnet: Schema.Number,
  }),
}));
const ClaudeRowsSchema = Schema.Array(Schema.Struct({ text: Schema.String, v3: Schema.Number, v4_7: Schema.Number, v5: Schema.Number }));
const SonnetRowsSchema = Schema.Array(Schema.Struct({ text: Schema.String, count: Schema.Number }));

const nodeFileSystem: TokenizerFileSystem = { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile };

async function defaultRun(argv: readonly string[], cwd?: string, environment?: TokenizerBuildEnvironment): Promise<CommandResult> {
  const subprocess = Bun.spawn([...argv], { cwd, env: environment === undefined ? undefined : { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourcePaths(fs: TokenizerFileSystem, crateDir: string): Promise<string[]> {
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(crateDir, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name !== "target") await walk(absolute);
      } else if (relativePath !== basename(TOKENIZER_ARTIFACT) && relativePath !== basename(TOKENIZER_FINGERPRINT)) {
        paths.push(relativePath);
      }
    }
  }
  await walk(crateDir);
  return paths.sort();
}

/** Hash every tracked input needed to reproduce the portable tokenizer. */
export async function tokenizerSourceSha256(root: string, fs: TokenizerFileSystem = nodeFileSystem): Promise<string> {
  const crateDir = join(root, "crates", "tokenizer");
  const hash = createHash("sha256");
  const inputs = (await sourcePaths(fs, crateDir)).map((path) => ({
    path: `crates/tokenizer/${path}`,
    absolute: join(crateDir, path),
  }));
  inputs.push({ path: "scripts/build-tokenizer.ts", absolute: join(root, "scripts", "build-tokenizer.ts") });
  for (const input of inputs) {
    const pathBytes = Buffer.from(input.path);
    const content = await fs.readFile(input.absolute);
    hash.update(`${pathBytes.byteLength}:`).update(pathBytes).update(`${content.byteLength}:`).update(content);
  }
  return hash.digest("hex");
}

function parseFingerprint(bytes: Uint8Array): TokenizerFingerprint {
  return Schema.decodeUnknownSync(FingerprintSchema)(JSON.parse(new TextDecoder().decode(bytes)), { onExcessProperty: "error" });
}

function decompressWasm(compressed: Uint8Array): Uint8Array {
  let wasm: Uint8Array;
  try {
    wasm = Bun.zstdDecompressSync(compressed);
  } catch (cause) {
    throw new Error("Tokenizer artifact is not valid zstd", { cause });
  }
  if (!WASM_MAGIC.every((byte, index) => wasm[index] === byte)) throw new Error("Tokenizer artifact does not contain WebAssembly");
  return wasm;
}

function parseRows<Value>(bytes: Uint8Array, path: string, schema: Schema.Decoder<Value, never>): Value {
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(new TextDecoder().decode(bytes)), { onExcessProperty: "error" });
  } catch (cause) {
    throw new Error(`Tokenizer fixture ${path} is invalid`, { cause });
  }
}

type TokenizerExports = ReturnType<typeof checkedExports>;

function countText(tokenizer: TokenizerExports, encoding: number, text: string): number {
  const pointer = tokenizer.allocate(text.length);
  try {
    const units = new Uint16Array(tokenizer.memory.buffer, pointer, text.length);
    for (let index = 0; index < text.length; index += 1) units[index] = text.charCodeAt(index);
    return tokenizer.count(encoding, pointer, text.length);
  } finally {
    tokenizer.release(pointer, text.length);
  }
}

async function inspectArtifact(compressed: Uint8Array): Promise<{ readonly wasm: Uint8Array; readonly tokenizer: TokenizerExports }> {
  const wasm = decompressWasm(compressed);
  const module = await WebAssembly.compile(wasm);
  return { wasm, tokenizer: checkedExports(module, await WebAssembly.instantiate(module, {})) };
}

async function fixtureInputs(root: string, fs: TokenizerFileSystem): Promise<{
  readonly corpusBytes: Uint8Array;
  readonly claudeBytes: Uint8Array;
  readonly sonnetBytes: Uint8Array;
}> {
  const crate = join(root, "crates", "tokenizer");
  const [corpusBytes, claudeBytes, sonnetBytes] = await Promise.all([
    fs.readFile(join(crate, CORPUS_PATH)),
    fs.readFile(join(crate, CLAUDE_FIXTURES_PATH)),
    fs.readFile(join(crate, SONNET_FIXTURES_PATH)),
  ]);
  return { corpusBytes, claudeBytes, sonnetBytes };
}

async function proveFixtures(root: string, fs: TokenizerFileSystem, compressed: Uint8Array): Promise<{
  readonly wasm: Uint8Array;
  readonly inputs: Awaited<ReturnType<typeof fixtureInputs>>;
}> {
  const [{ wasm, tokenizer }, inputs] = await Promise.all([inspectArtifact(compressed), fixtureInputs(root, fs)]);
  const corpus = parseRows(inputs.corpusBytes, CORPUS_PATH, CorpusRowsSchema);
  const claude = parseRows(inputs.claudeBytes, CLAUDE_FIXTURES_PATH, ClaudeRowsSchema);
  const sonnet = parseRows(inputs.sonnetBytes, SONNET_FIXTURES_PATH, SonnetRowsSchema);
  if (corpus.length !== 6 || claude.length !== 493 || sonnet.length !== 63) throw new Error("Tokenizer fixture inventory is invalid");

  let checks = 0;
  for (const row of corpus) {
    for (const [encoding, name] of ENCODINGS.entries()) {
      const expected = row.counts[name];
      if (countText(tokenizer, encoding, row.text) !== expected) {
        throw new Error(`Tokenizer corpus mismatch at check ${checks + 1}`);
      }
      checks += 1;
    }
  }
  for (const row of claude) {
    for (const [encoding, key, name] of [[1, "v3", "ClaudeV3"], [2, "v4_7", "ClaudeV47"], [3, "v5", "ClaudeV5"]] as const) {
      const expected = row[key];
      if (countText(tokenizer, encoding, row.text) + CLAUDE_OFFSETS[name] !== expected) {
        throw new Error(`Tokenizer Claude fixture mismatch at check ${checks + 1}`);
      }
      checks += 1;
    }
  }
  for (const row of sonnet) {
    if (countText(tokenizer, 4, row.text) + 6 !== row.count) {
      throw new Error(`Tokenizer Sonnet fixture mismatch at check ${checks + 1}`);
    }
    checks += 1;
  }
  if (checks !== 1572) throw new Error("Tokenizer fixture check count is invalid");
  return { wasm, inputs };
}

async function createFingerprint(
  root: string,
  fs: TokenizerFileSystem,
  compressed: Uint8Array,
): Promise<TokenizerFingerprint> {
  const { wasm, inputs } = await proveFixtures(root, fs, compressed);
  const crate = join(root, "crates", "tokenizer");
  const vocabularies = {
    "ctok_v3.bin.zst": sha256(await fs.readFile(join(crate, "data", "ctok_v3.bin.zst"))),
    "ctok_v4_7.bin.zst": sha256(await fs.readFile(join(crate, "data", "ctok_v4_7.bin.zst"))),
    "o200k_base.bin.zst": sha256(await fs.readFile(join(crate, "data", "o200k_base.bin.zst"))),
  };
  return {
    version: FINGERPRINT_VERSION,
    toolchain: TOKENIZER_TOOLCHAIN,
    target: TOKENIZER_TARGET,
    rustcCommit: TOKENIZER_RUSTC_COMMIT,
    targetArchive: { url: TOKENIZER_TARGET_ARCHIVE_URL, sha256: TOKENIZER_TARGET_ARCHIVE_SHA256 },
    upstream: { revision: OMP_REVISION },
    ctok: { revision: CTOK_REVISION },
    sourceSha256: await tokenizerSourceSha256(root, fs),
    cargo: {
      tomlSha256: sha256(await fs.readFile(join(crate, "Cargo.toml"))),
      lockSha256: sha256(await fs.readFile(join(crate, "Cargo.lock"))),
    },
    vocabularies,
    fixtureInventory: {
      corpus: { rows: 6, checks: 30, sha256: sha256(inputs.corpusBytes) },
      claude: { rows: 493, checks: 1479, offsets: CLAUDE_OFFSETS, sha256: sha256(inputs.claudeBytes) },
      sonnet: { rows: 63, checks: 63, offset: 6, sha256: sha256(inputs.sonnetBytes) },
      totalChecks: 1572,
    },
    abi: {
      imports: [],
      exports: [
        { name: "memory", kind: "memory", type: { minimum: 49, shared: false, address: "i32" } },
        { name: "allocate", kind: "function", type: { parameters: ["i32"], results: ["i32"] } },
        { name: "count", kind: "function", type: { parameters: ["i32", "i32", "i32"], results: ["i32"] } },
        { name: "release", kind: "function", type: { parameters: ["i32", "i32"], results: [] } },
      ],
    },
    artifact: {
      compressedSha256: sha256(compressed),
      compressedBytes: compressed.byteLength,
      wasmSha256: sha256(wasm),
      wasmBytes: wasm.byteLength,
    },
  };
}

async function verifyCommitted(root: string, fs: TokenizerFileSystem): Promise<void> {
  const artifact = await fs.readFile(join(root, TOKENIZER_ARTIFACT));
  const recorded = parseFingerprint(await fs.readFile(join(root, TOKENIZER_FINGERPRINT)));
  const expected = await createFingerprint(root, fs, artifact);
  const canonicalExpected = Schema.decodeUnknownSync(FingerprintSchema)(expected);
  if (JSON.stringify(recorded) !== JSON.stringify(canonicalExpected)) throw new Error("Tokenizer fingerprint does not match committed inputs");
}

async function requireCommand(
  run: NonNullable<BuildTokenizerOptions["run"]>,
  argv: readonly string[],
  expected: string,
): Promise<void> {
  const result = await run(argv);
  if (result.exitCode !== 0 || !result.stdout.includes(expected)) {
    throw new Error(`Required ${expected} is not installed`);
  }
}

async function prepareCrate(fs: TokenizerFileSystem, source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, { recursive: true });
  for (const path of await sourcePaths(fs, destination)) {
    if (!path.startsWith(`data/`) || !path.endsWith(".zst")) continue;
    const compressedPath = join(destination, path);
    const uncompressedPath = compressedPath.slice(0, -".zst".length);
    await fs.writeFile(uncompressedPath, Bun.zstdDecompressSync(await fs.readFile(compressedPath)));
    await fs.rm(compressedPath);
  }
}

/** Build or offline-verify the repository-owned portable tokenizer artifact. */
export async function buildTokenizer(options: BuildTokenizerOptions = {}): Promise<void> {
  const root = options.root ?? join(import.meta.dir, "..");
  const fs = options.fs ?? nodeFileSystem;
  if (options.verify) {
    await verifyCommitted(root, fs);
    return;
  }

  const crateDir = join(root, "crates", "tokenizer");
  try {
    if (!(await fs.lstat(join(crateDir, "Cargo.toml"))).isFile()) throw new Error("Tokenizer Cargo manifest is not a file");
  } catch {
    throw new Error("Tokenizer crate is missing");
  }

  const run = options.run ?? defaultRun;
  await requireCommand(run, ["rustup", "toolchain", "list"], TOKENIZER_TOOLCHAIN);
  await requireCommand(run, ["rustup", "target", "list", "--installed", "--toolchain", TOKENIZER_TOOLCHAIN], TOKENIZER_TARGET);
  const compiler = await run(["rustup", "which", "--toolchain", TOKENIZER_TOOLCHAIN, "rustc"]);
  if (compiler.exitCode !== 0) throw new Error(`Tokenizer compiler lookup failed${compiler.stderr ? `: ${compiler.stderr}` : ""}`);
  const rustc = compiler.stdout.trim();
  await requireCommand(run, [rustc, "--version", "--verbose"], TOKENIZER_RUSTC_COMMIT);

  const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "flywheel-tokenizer-"));
  try {
    const temporaryCrate = join(temporaryRoot, "crate");
    const targetDir = join(temporaryRoot, "target");
    await prepareCrate(fs, crateDir, temporaryCrate);
    const argv = [
      "rustup", "run", TOKENIZER_TOOLCHAIN, "cargo", "build", "--release", "--locked", "--target", TOKENIZER_TARGET,
      "--manifest-path", join(temporaryCrate, "Cargo.toml"), "--target-dir", targetDir,
    ];
    const result = await run(argv, temporaryCrate, { RUSTC: rustc, RUSTFLAGS: TOKENIZER_RUSTFLAGS });
    if (result.exitCode !== 0) throw new Error(`Tokenizer Cargo build failed${result.stderr ? `: ${result.stderr}` : ""}`);

    const wasm = await fs.readFile(join(targetDir, TOKENIZER_TARGET, "release", "flywheel_tokenizer.wasm"));
    if (!WASM_MAGIC.every((byte, index) => wasm[index] === byte)) throw new Error("Cargo output is not WebAssembly");
    const artifact = Bun.zstdCompressSync(wasm);
    const fingerprint = await createFingerprint(root, fs, artifact);

    const artifactPath = join(root, TOKENIZER_ARTIFACT);
    const fingerprintPath = join(root, TOKENIZER_FINGERPRINT);
    const stagedArtifact = join(temporaryRoot, basename(artifactPath));
    const stagedFingerprint = join(temporaryRoot, basename(fingerprintPath));
    await fs.writeFile(stagedArtifact, artifact);
    await fs.writeFile(stagedFingerprint, `${JSON.stringify(fingerprint, null, 2)}\n`);
    await fs.mkdir(dirname(artifactPath), { recursive: true });
    options.onTrackedWrite?.(artifactPath);
    await fs.rename(stagedArtifact, artifactPath);
    options.onTrackedWrite?.(fingerprintPath);
    await fs.rename(stagedFingerprint, fingerprintPath);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--verify")) throw new Error("Usage: bun run build:tokenizer [--verify]");
  await buildTokenizer({ verify: args.includes("--verify") });
}
