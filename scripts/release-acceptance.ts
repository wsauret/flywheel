/** The release gate that keeps every served client able to update.
 *
 *  An installed client refuses only what a correct release can never fail
 *  (ARCH-DISTRIBUTION-008). Every other restriction belongs here, on the release side,
 *  before a tag exists: the release refuses to publish anything that a
 *  client it still serves would refuse.
 *
 *  The gate has three parts, run in this order.
 *
 *  - The release's own bounds (`RELEASE_BOUNDS`) are numbers this project
 *    chooses for what one release may hold. They are the limits of the
 *    oldest served client that an offline gate can test.
 *  - The release contracts (`release-contract-checks.ts`) are what every
 *    client from the first integrity-only one on still depends on, checked
 *    against the staged files directly.
 *  - The served acceptance runs, for each updater generation among the
 *    served clients, the update code of that generation's oldest release
 *    from its tagged source against the staged files, over an installation
 *    of that release (`release-acceptance-driver.ts`). A rule a served client
 *    applies is therefore enforced exactly as that client applies it, and no
 *    copy of the rule can drift.
 *
 *  Usage:
 *    bun run scripts/release-acceptance.ts --dist dist [--manifest dist/release.json] [--repo owner/name]
 *
 *  Exits 1 and names each violated rule when the staged release is refused. */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createGunzip } from "node:zlib";
import { SHIPPED_ENTRY_POINTS } from "./release-acceptance-entries.js";
import { releaseContractViolations } from "./release-contract-checks.js";
import { PUBLIC_REPO, publishedReleaseTags } from "./release-repo.js";
import { compareSemanticVersions, parseSemanticVersion, type SemanticVersion } from "./release-version.js";

const MIB = 1024 * 1024;

/** What one release may hold. Each bound is a limit the v0.1.0 updater
 *  enforces on what a release holds, so the gate names it before any client
 *  runs. v0.1.0 also has limits on how the release is served that no release
 *  can lift and no offline gate can test (ARCH-DISTRIBUTION-008). Once no served client
 *  enforces a bound, the project may raise it here, and no installed client
 *  needs to change. */
export const RELEASE_BOUNDS = {
  /** `release.json` (v0.1.0 `RELEASE_MANIFEST_MAX_BYTES`). */
  manifestBytes: 64 * 1024,
  /** One compressed archive (v0.1.0 `MAX_RELEASE_ASSET_BYTES`). */
  archiveBytes: 512 * MIB,
  /** Entries one archive lists, extended headers excluded (v0.1.0 `MAX_ARCHIVE_ENTRIES`). */
  archiveEntries: 4096,
  /** One file of an archive (v0.1.0 `MAX_ARCHIVE_FILE_BYTES`). */
  fileBytes: 512 * MIB,
  /** The stated sizes of one archive's files together, and its whole
   *  decompressed stream (v0.1.0 `MAX_ARCHIVE_TOTAL_BYTES`). */
  extractedBytes: 1024 * MIB,
  /** One extended header (v0.1.0 `TAR_PAX_MAX_BYTES`). */
  extendedHeaderBytes: 8 * 1024,
  /** One build's `build.json` (v0.1.0 `METADATA_MAX_BYTES`). */
  metadataBytes: 8 * 1024,
} as const;

/** The first served release. A v0.0.x client is out of support: it
 *  reinstalls by hand, so the gate does not serve it. */
const FIRST_SERVED = { major: 0, minor: 1, patch: 0, canonical: "0.1.0" } as const satisfies SemanticVersion;

/** The served clients, oldest first: every release the public repository has
 *  published from v0.1.0 on, because an installation of any of them can
 *  still be running, unopened for months, and must update to the next
 *  release when it next checks. What is published is the one record of what
 *  was shipped, so a dry run, an aborted run, or a deleted draft never adds
 *  a client. A client is not served the release it is. */
function servedClients(published: readonly string[], own: string): readonly string[] {
  return published
    .flatMap((tag) => {
      const version = parseSemanticVersion(tag);
      return version !== undefined && tag !== own && compareSemanticVersions(version, FIRST_SERVED) >= 0 ? [{ tag, version }] : [];
    })
    .sort((a, b) => compareSemanticVersions(a.version, b.version))
    .map(({ tag }) => tag);
}

/** The served releases whose public tags do not name their source, and the
 *  repository that holds the source each was built from. Going public replaced
 *  the public repository's history with one snapshot commit and moved every tag
 *  onto it. The snapshot is the source of the last release cut before it, so
 *  only the earlier releases are listed here. The archived development
 *  repository keeps their original tags. */
interface PrePublicReleases {
  readonly tags: ReadonlySet<string>;
  readonly source: string;
}

export const PRE_PUBLIC_RELEASES: PrePublicReleases = {
  tags: new Set(["v0.1.0", "v0.1.1", "v0.1.2"]),
  source: "https://github.com/wsauret/flywheel-dev.git",
};

/** The files that lock every package a client's update code imports. */
const LOCKFILES = ["package.json", "bun.lock"] as const;

/** The updater generation of `tag`: a digest of the git blob id of every
 *  file in the import closure of the driven files (`SHIPPED_ENTRY_POINTS`)
 *  at that tag, and of `LOCKFILES`. The closure follows every relative static
 *  and dynamic import. A blob id is a digest of the file's content, so two
 *  tags of one generation run the same update code on the same packages and
 *  refuse and accept the same releases. */
export function updaterGeneration(tag: string, repository = ROOT, prePublic = PRE_PUBLIC_RELEASES): string {
  const shipped = shippedSource(tag, repository, prePublic);
  const blobs = tagBlobs(shipped.ref, shipped.repository);
  const reached = new Set<string>(Object.values(SHIPPED_ENTRY_POINTS));
  // Each round reads the files the last round reached in one git process.
  // The closure holds over a thousand files, and one process per file would
  // take most of a minute for each tag.
  for (let frontier = [...reached]; frontier.length > 0;) {
    const next: string[] = [];
    for (const [file, code] of readBlobs(shipped.repository, frontier.filter((path) => blobs.has(path)), blobs)) {
      for (const specifier of relativeImports(file, code)) {
        const target = resolveImport(file, specifier, blobs);
        if (reached.has(target)) continue;
        reached.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  const digest = createHash("sha256");
  for (const file of [...LOCKFILES, ...[...reached].sort()]) digest.update(`${file} ${blobs.get(file) ?? "absent"}\n`);
  return digest.digest("hex");
}

/** The content of each of `files`, read from its blob in one
 *  `git cat-file --batch` run, which answers each id with a
 *  `<id> blob <size>` line, the content, and a newline. */
function readBlobs(repository: string, files: readonly string[], blobs: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const contents = new Map<string, string>();
  if (files.length === 0) return contents;
  const ids = files.map((file) => blobs.get(file) ?? "");
  const result = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: repository, stdin: Buffer.from(`${ids.join("\n")}\n`), stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`\`git cat-file --batch\` failed in ${repository}: ${result.stderr.toString().trim()}`);
  const output = result.stdout;
  let offset = 0;
  for (const [index, file] of files.entries()) {
    const headerEnd = output.indexOf(0x0a, offset);
    const header = output.subarray(offset, headerEnd).toString();
    const size = /^[0-9a-f]+ blob (\d+)$/u.exec(header)?.[1];
    if (size === undefined) throw new Error(`\`git cat-file --batch\` answered "${header}" for ${file} (${ids[index]})`);
    const start = headerEnd + 1;
    contents.set(file, output.subarray(start, start + Number(size)).toString());
    offset = start + Number(size) + 1;
  }
  return contents;
}

/** The blob id of every file `ref` holds, by its path. */
function tagBlobs(ref: string, repository: string): ReadonlyMap<string, string> {
  const blobs = new Map<string, string>();
  for (const record of gitOutput(repository, ["git", "ls-tree", "-r", "-z", "--full-tree", ref]).split("\0")) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/su.exec(record);
    if (match?.[1] !== undefined && match[2] !== undefined) blobs.set(match[2], match[1]);
  }
  return blobs;
}

const SCANNED_LOADERS = new Map<string, Bun.JavaScriptLoader>([["ts", "ts"], ["mts", "ts"], ["tsx", "tsx"], ["js", "js"], ["mjs", "js"], ["jsx", "jsx"]]);

/** The relative specifiers `code` imports at run time, statically or
 *  dynamically. A type-only import runs no code, so it is left out. */
function relativeImports(file: string, code: string): readonly string[] {
  const loader = SCANNED_LOADERS.get(file.slice(file.lastIndexOf(".") + 1));
  if (loader === undefined) return [];
  return new Bun.Transpiler({ loader }).scanImports(code).flatMap(({ path }) => (path.startsWith("./") || path.startsWith("../") ? [path] : []));
}

/** The file a relative `specifier` of `file` loads, as Bun resolves it:
 *  the path itself, a `.js` written for its `.ts` or `.tsx` source, or the
 *  path with an extension or an `index` added. A specifier that names no file
 *  the tag holds keeps its own path, which digests as absent. */
function resolveImport(file: string, specifier: string, blobs: ReadonlyMap<string, string>): string {
  const base = posix.normalize(posix.join(posix.dirname(file), specifier));
  const stem = base.replace(/\.[cm]?js$/u, "");
  const candidates = [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => blobs.has(candidate)) ?? base;
}

function gitOutput(repository: string, command: readonly string[]): string {
  const result = Bun.spawnSync([...command], { cwd: repository, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`\`${command.join(" ")}\` failed in ${repository}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** The oldest tag of each updater generation among `served`, oldest first.
 *  The oldest is the one whose seeded installation has lived longest, and
 *  every later tag of the generation applies the same rules. */
function generationRepresentatives(served: readonly string[], generationOf: (tag: string) => string): readonly string[] {
  const oldest = new Map<string, string>();
  for (const tag of served) {
    const generation = generationOf(tag);
    if (!oldest.has(generation)) oldest.set(generation, tag);
  }
  return [...oldest.values()];
}

export interface StagedRelease {
  /** The directory that holds the staged archives. */
  readonly dist: string;
  /** The staged `release.json`. */
  readonly manifest: string;
  /** The repository the release is published to. */
  readonly repository: string;
}

/** The outcome of one served client's acceptance run: the lines it printed,
 *  and whether it accepted every target. */
export interface ShippedRun {
  readonly accepted: boolean;
  readonly lines: readonly string[];
}

export type ShippedRunner = (tag: string, release: StagedRelease) => Promise<ShippedRun>;

export interface GateOptions {
  readonly runShipped?: ShippedRunner;
  readonly checkContracts?: (release: StagedRelease) => Promise<readonly string[]>;
  /** Reads the release repository's published releases. */
  readonly fetch?: typeof globalThis.fetch;
  /** The updater generation of a served tag (`updaterGeneration`). */
  readonly generationOf?: (tag: string) => string;
}

export interface GateResult {
  /** Every rule the staged release breaks, each naming its rule. */
  readonly violations: readonly string[];
  /** The served clients, oldest first, once the bounds and contracts hold. */
  readonly served: readonly string[];
  /** The served clients whose driver ran, one for each updater generation. */
  readonly driven: readonly string[];
}

/** Every rule the staged release breaks: its own bounds first, then the
 *  release contracts, then every served client. Each earlier part is the
 *  cheaper proof and names its rule, so a release it refuses runs no client.
 *  The served clients run once per updater generation, on the oldest tag of
 *  each, so the gate's cost grows with the times the updater changed, not
 *  with the releases cut. */
export async function gateRelease(release: StagedRelease, options: GateOptions = {}): Promise<GateResult> {
  const bounds = await releaseBoundViolations(release);
  if (bounds.length > 0) return { violations: bounds, served: [], driven: [] };
  const contracts = await (options.checkContracts ?? releaseContractViolations)(release);
  if (contracts.length > 0) return { violations: contracts, served: [], driven: [] };
  const served = servedClients(await publishedReleaseTags(release.repository, options.fetch), `v${stagedVersion(release)}`);
  const driven = generationRepresentatives(served, options.generationOf ?? updaterGeneration);
  const runShipped = options.runShipped ?? runShippedAcceptance;
  const violations: string[] = [];
  for (const tag of driven) {
    const run = await runShipped(tag, release);
    if (run.accepted) continue;
    const refused = run.lines.filter((line) => line.startsWith("refused"));
    const named = refused.length > 0 ? refused : [`refused the release without naming a rule: ${run.lines.join(" / ") || "no output"}`];
    violations.push(...named.map((line) => `${tag} client ${line}`));
  }
  return { violations, served, driven };
}

function stagedVersion(release: StagedRelease): string {
  const parsed: unknown = JSON.parse(readFileSync(release.manifest, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") throw new Error("release.json states no version");
  return parsed.version;
}

interface ManifestAsset {
  readonly name: string;
  readonly size: number;
}

function manifestAssets(raw: string): readonly ManifestAsset[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || !("assets" in parsed) || !Array.isArray(parsed.assets)) throw new Error("release.json lists no assets");
  return parsed.assets.map((asset: unknown) => {
    if (typeof asset !== "object" || asset === null || !("name" in asset) || !("size" in asset) || typeof asset.name !== "string" || typeof asset.size !== "number") throw new Error(`release.json lists an asset with no name and size: ${JSON.stringify(asset)}`);
    return { name: asset.name, size: asset.size };
  });
}

/** Each release-side bound the staged files break. */
export async function releaseBoundViolations(release: StagedRelease): Promise<readonly string[]> {
  const violations: string[] = [];
  const raw = readFileSync(release.manifest, "utf8");
  const manifestBytes = Buffer.byteLength(raw);
  if (manifestBytes > RELEASE_BOUNDS.manifestBytes) violations.push(`release.json is ${manifestBytes} bytes; the release bound is ${RELEASE_BOUNDS.manifestBytes}`);
  for (const asset of manifestAssets(raw)) {
    if (asset.size > RELEASE_BOUNDS.archiveBytes) {
      violations.push(`${asset.name} states ${asset.size} bytes; the release bound for one archive is ${RELEASE_BOUNDS.archiveBytes}`);
      continue;
    }
    const file = join(release.dist, asset.name);
    if (!existsSync(file)) {
      violations.push(`${asset.name} is listed in release.json but not staged`);
      continue;
    }
    const size = statSync(file).size;
    if (size !== asset.size) {
      violations.push(`${asset.name} is ${size} bytes, not the ${asset.size} release.json states`);
      continue;
    }
    violations.push(...archiveBoundViolations(asset.name, await surveyArchive(file)));
  }
  return violations;
}

/** What one archive holds, in the units the bounds are stated in. */
export interface ArchiveSurvey {
  readonly entries: number;
  readonly largestFileBytes: number;
  readonly statedBytes: number;
  readonly decompressedBytes: number;
  readonly largestExtendedHeaderBytes: number;
  readonly largestMetadataBytes: number;
}

export function archiveBoundViolations(name: string, survey: ArchiveSurvey): readonly string[] {
  const violations: string[] = [];
  const over = (actual: number, bound: number, what: string): void => {
    if (actual > bound) violations.push(`${name} ${what} ${actual}; the release bound is ${bound}`);
  };
  over(survey.entries, RELEASE_BOUNDS.archiveEntries, "lists entries:");
  over(survey.largestFileBytes, RELEASE_BOUNDS.fileBytes, "holds a file of bytes:");
  over(survey.statedBytes, RELEASE_BOUNDS.extractedBytes, "states file bytes in total:");
  over(survey.decompressedBytes, RELEASE_BOUNDS.extractedBytes, "decompresses to bytes:");
  over(survey.largestExtendedHeaderBytes, RELEASE_BOUNDS.extendedHeaderBytes, "holds an extended header of bytes:");
  over(survey.largestMetadataBytes, RELEASE_BOUNDS.metadataBytes, "holds a build.json of bytes:");
  return violations;
}

/** Read one gzip tar archive's headers as a stream, and count what the
 *  bounds measure. Nothing is extracted. */
export async function surveyArchive(file: string): Promise<ArchiveSurvey> {
  let pending = Buffer.alloc(0);
  let skip = 0;
  let decompressedBytes = 0;
  let entries = 0;
  let largestFileBytes = 0;
  let statedBytes = 0;
  let largestExtendedHeaderBytes = 0;
  let largestMetadataBytes = 0;
  let ended = false;
  for await (const chunk of createReadStream(file).pipe(createGunzip())) {
    if (!Buffer.isBuffer(chunk)) throw new Error(`${file} did not decompress to bytes`);
    decompressedBytes += chunk.byteLength;
    if (ended) continue;
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (skip > 0) {
        const dropped = Math.min(skip, pending.byteLength);
        pending = pending.subarray(dropped);
        skip -= dropped;
        if (skip > 0) break;
      }
      if (pending.byteLength < 512) break;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every((byte) => byte === 0)) {
        ended = true;
        break;
      }
      const size = Number.parseInt(nulTerminated(header.subarray(124, 136)).trim() || "0", 8);
      const typeflag = String.fromCharCode(header[156] ?? 0);
      const name = nulTerminated(header.subarray(0, 100));
      skip = Math.ceil(size / 512) * 512;
      if (typeflag === "x" || typeflag === "g") {
        largestExtendedHeaderBytes = Math.max(largestExtendedHeaderBytes, size);
        continue;
      }
      entries += 1;
      if (typeflag === "0" || typeflag === "\0") {
        largestFileBytes = Math.max(largestFileBytes, size);
        if (name.endsWith("/build.json") || name === "build.json") largestMetadataBytes = Math.max(largestMetadataBytes, size);
      }
      statedBytes += size;
    }
  }
  return { entries, largestFileBytes, statedBytes, decompressedBytes, largestExtendedHeaderBytes, largestMetadataBytes };
}

function nulTerminated(field: Buffer): string {
  return field.toString("utf8").split("\0", 1)[0] ?? "";
}

/** Where shipped sources are kept: beside the perf gate's published
 *  baselines, under the same gate home. */
function gateHome(): string {
  return process.env.FLYWHEEL_PERF_GATE_HOME ?? join(homedir(), ".cache", "flywheel", "perf-gate");
}

const ROOT = join(import.meta.dir, "..");
const DRIVER = join(import.meta.dir, "release-acceptance-driver.ts");

function runIn(cwd: string, command: readonly string[], cause: string, env: { readonly [name: string]: string | undefined } = process.env): void {
  const result = Bun.spawnSync([...command], { cwd, env, stdout: "inherit", stderr: "inherit", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`${cause}: \`${command.join(" ")}\` failed in ${cwd}`);
}

/** The tagged source of one served client with its locked dependencies,
 *  exported once with `git archive` from where `shippedSource` finds it, so
 *  it holds exactly the tag's tracked files. A marker written last tells a finished export from an interrupted one,
 *  which is removed and redone. */
export function materializeShippedSource(tag: string, repository = ROOT, prePublic = PRE_PUBLIC_RELEASES): string {
  const root = join(gateHome(), "acceptance", tag);
  const source = join(root, "source");
  const marker = join(root, "materialized");
  if (existsSync(marker)) return source;
  const shipped = shippedSource(tag, repository, prePublic);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  const archive = join(root, "source.tar");
  runIn(shipped.repository, ["git", "archive", "--format=tar", `--output=${archive}`, shipped.ref], `the source of ${tag} could not be exported`);
  runIn(root, ["tar", "-xf", archive, "-C", source], `the source of ${tag} could not be unpacked`);
  rmSync(archive);
  // The install's own temporary files stay under the gate root and go with
  // it, so the gate leaves nothing in the machine's temporary directory.
  const installTemp = join(root, "tmp");
  mkdirSync(installTemp);
  try {
    runIn(source, ["bun", "install", "--frozen-lockfile"], `the locked dependencies of ${tag} could not be installed`, { ...process.env, TMPDIR: installTemp, TEMP: installTemp, TMP: installTemp });
  } finally {
    rmSync(installTemp, { recursive: true, force: true });
  }
  writeFileSync(marker, `${new Date().toISOString()}\n`);
  return source;
}

/** The repository and ref that hold the source `tag` was built from. A
 *  pre-public release resolves from its source repository, fetched into a bare
 *  repository under the gate home, so the public checkout never holds the
 *  development history. Any other tag resolves in `repository`, fetched from
 *  its `origin` first when the checkout does not hold it. */
function shippedSource(tag: string, repository: string, prePublic: PrePublicReleases) {
  const ref = `refs/tags/${tag}`;
  const fromSource = prePublic.tags.has(tag);
  const holder = fromSource ? join(gateHome(), "pre-public-source.git") : repository;
  if (fromSource && !existsSync(holder)) {
    mkdirSync(holder, { recursive: true });
    runIn(holder, ["git", "init", "--quiet", "--bare"], "the pre-public source repository could not be created");
  }
  if (Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: holder, stdout: "ignore", stderr: "ignore", windowsHide: true }).exitCode !== 0) {
    const remote = fromSource ? prePublic.source : "origin";
    // A machine without access to the private source fails here instead of waiting at a credential prompt.
    runIn(holder, ["git", "fetch", "--no-tags", remote, `${ref}:${ref}`], `the served client ${tag} is not tagged in this checkout, and ${remote} did not provide the tag`, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
  }
  return { repository: holder, ref };
}

/** Run one served client's driver against the staged release, in its own
 *  process, its own scratch directory, and its own home. The client's own
 *  published release is kept beside its source, where the driver seeds each
 *  account from. */
export async function runShippedAcceptance(tag: string, release: StagedRelease): Promise<ShippedRun> {
  const source = materializeShippedSource(tag);
  const work = join(tmpdir(), `flywheel-release-acceptance-${tag}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const child = Bun.spawn([
      "bun", "run", DRIVER,
      "--source", source, "--manifest", release.manifest, "--dist", release.dist, "--repository", release.repository,
      "--seed", join(gateHome(), "acceptance", tag, "published"), "--work", work, "--host", `${process.platform}-${process.arch}`,
    ], { cwd: ROOT, env: { ...process.env, HOME: work, USERPROFILE: work, FLYWHEEL_LOG_LEVEL: "error" }, stdout: "pipe", stderr: "inherit", windowsHide: true });
    const output = await new Response(child.stdout).text();
    const code = await child.exited;
    const lines = output.split("\n").filter((line) => line.trim() !== "");
    for (const line of lines) console.log(`release-acceptance: ${tag} ${line}`);
    return { accepted: code === 0, lines };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const option = (name: string): string | undefined => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const dist = option("dist") ?? "dist";
  const release = { dist, manifest: option("manifest") ?? join(dist, "release.json"), repository: option("repo") ?? PUBLIC_REPO };
  const gate = await gateRelease(release);
  if (gate.violations.length > 0) {
    console.error(`release-acceptance: a served client would refuse this release:\n${gate.violations.map((line) => `  ${line}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`release-acceptance: the release contracts hold, and ${gate.served.length === 0 ? "no served client is older than this release" : `every served client (${gate.served.join(", ")}) accepts the staged release, driven once per updater generation (${gate.driven.join(", ")})`}`);
}
