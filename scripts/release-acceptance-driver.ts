/** Runs the update acceptance of one served client against a staged release,
 *  offline, from that client's own tagged source.
 *
 *  A client's refusals are frozen in its source, so this driver does not
 *  restate them: it imports that source and makes the calls its account
 *  service makes. Everything the run depends on comes from the client too:
 *  the targets it updates on (`scripts/release-contract.ts`
 *  `RELEASE_TARGET_MATRIX`), the repository it trusts
 *  (`src/protocol/installation.ts` `RELEASE_REPOSITORY` before its release
 *  builds compiled the repository in, and the publishing one after), and its version
 *  (`package.json`). The same driver therefore serves every tag from v0.1.0
 *  on.
 *
 *  For each of the client's targets, a scratch account is first seeded with
 *  the client's own published release, installed by the client's own
 *  installer: its build is `current`, and its wrapper or Windows launchers
 *  and install record are in place. Then the client checks `release.json`
 *  through `checkForUpdate` and installs the staged release through
 *  `createUpdateInstaller().install` over that installation, so its
 *  forward-version, wrapper, and launcher checks all run. Every network
 *  request goes to a local fetch that serves the staged files, and every
 *  command the install runs is answered here. The one real command is the run
 *  proof of the host's own target: that archive's executable is asked its
 *  version, as the client asks it. A target of another platform cannot run
 *  here, so its run proof is answered with the line the client's own
 *  `versionLine` states, and the driver says so.
 *
 *  The seed is read from `--seed`, a directory that holds the client's
 *  published `release.json` and archives. A file that is missing or does not
 *  digest to the published one is downloaded once from the client's own
 *  release and kept there.
 *
 *  Usage (the release gate runs it; `scripts/release-acceptance.ts`):
 *    bun run scripts/release-acceptance-driver.ts --source <tagged checkout> \
 *      --manifest <release.json> --dist <dir> --repository <owner/repo> \
 *      --seed <dir> --work <scratch> --host <platformArch>
 *
 *  Prints one `accepted <target>` or `refused <target>: <rule>` line for each
 *  target, or one `refused repository: <rule>` line, and exits 1 when anything
 *  is refused. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { SHIPPED_ENTRY_POINTS as entry } from "./release-acceptance-entries.js";

/** The calls this driver makes of a served client's source, and the fakes it
 *  hands them. The source is a frozen external program, typed here at the one
 *  place it is loaded. */
interface ShippedVersion { readonly canonical: string }
interface ShippedRepository { readonly owner: string; readonly repo: string }
interface ShippedRelease { readonly version: ShippedVersion; readonly asset: { readonly name: string } }
type ShippedCheck = { readonly kind: "candidate"; readonly release: ShippedRelease } | { readonly kind: "current" } | { readonly kind: "unavailable"; readonly reason: string };
type FetchLike = (input: string | URL | Request) => Promise<Response>;
interface ShippedScheduler { nowMs(): number; setTimer(fire: () => void, delayMs: number): () => void }
interface ShippedPolicy { readonly persisted: boolean; readonly forcedOff: boolean; readonly effective: boolean }
interface ShippedExit { readonly code: number; readonly signal: null; readonly statusOf: "payload"; readonly ownership: "surrendered" }
interface ShippedProcess {
  readonly pid: number;
  readonly token: string;
  readonly stdin: undefined;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<ShippedExit>;
  terminate(): Promise<ShippedExit>;
}
interface ShippedLaunchOptions { readonly cwd?: string; readonly env?: { readonly [name: string]: string | undefined } }
interface ShippedLauncherScope {
  spawnOwned(command: readonly string[], options?: ShippedLaunchOptions): Promise<ShippedProcess>;
  adoptOwned(): Promise<never>;
  open(): ShippedLauncherScope;
  close(): Promise<{ readonly settled: true }>;
}
interface ShippedAuthority {
  claim(): { readonly kind: "won"; readonly fence: number; readonly leaseExpiresAtMs: number };
  renew(): "held";
  commitCheck(): true;
  commitActivation(request: { readonly activate: () => void }): true;
  dispose(): void;
}
interface ShippedInstallerDeps {
  readonly userDataRoot: string;
  readonly wrapperDir: string;
  readonly platform: string;
  readonly platformArch: string;
  readonly scheduler: ShippedScheduler;
  readonly policy: { read(): ShippedPolicy; revalidate<T>(decide: (policy: ShippedPolicy) => T): Promise<T> };
  readonly launcher: ShippedLauncherScope;
  readonly openAuthority: () => ShippedAuthority;
  readonly fetch: FetchLike;
}
interface ShippedCheckModule {
  checkForUpdate(request: { readonly repository: ShippedRepository; readonly assetName: string; readonly currentVersion: ShippedVersion; readonly fetch: FetchLike; readonly scheduler: ShippedScheduler }): Promise<ShippedCheck>;
}
interface ShippedManifestModule {
  parseRepositoryIdentity(value: string): ShippedRepository;
  platformAssetName(platformArch: string): string | undefined;
  /** v0.1.0 also takes `repository`; later clients ignore it. */
  selectReleaseAsset(raw: string, options: { readonly repository: ShippedRepository; readonly assetName: string }): ShippedRelease;
}
/** v0.1.0 reads its own version strictly; later clients read every release
 *  version through `parseReleaseVersion`. */
interface ShippedVersionModule {
  parseReleaseVersion?(value: string): ShippedVersion | undefined;
  parseSemanticVersion?(value: string): ShippedVersion | undefined;
}
interface ShippedIdentityModule { versionLine?(version: string, buildId: string | undefined): string }
interface ShippedInstallModule {
  createUpdateInstaller(deps: ShippedInstallerDeps): { install(request: { readonly release: ShippedRelease; readonly fence: number; readonly signal: AbortSignal }): Promise<{ readonly kind: string }> };
}
interface ShippedTarget { readonly platformArch: string; readonly platform: string }
interface ShippedContractModule { readonly RELEASE_TARGET_MATRIX: readonly ShippedTarget[] }
/** A client before ARCH-DISTRIBUTION-034 states its repository in source. A
 *  later one has it compiled in by its release build, from the repository
 *  that release published to, so its source states none. */
interface ShippedInstallationModule { readonly RELEASE_REPOSITORY?: string }

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    source: { type: "string" }, manifest: { type: "string" }, dist: { type: "string" }, repository: { type: "string" },
    seed: { type: "string" }, work: { type: "string" }, host: { type: "string" },
  },
});
const { source, manifest, dist, repository: publishing, seed, work, host } = values;
if (!source || !manifest || !dist || !publishing || !seed || !work || !host) throw new Error("--source, --manifest, --dist, --repository, --seed, --work, and --host are required");

// A dynamic import of a computed path is untyped, so each module takes the
// interface of the calls this driver makes, and a missing call fails at its
// first use with the module's own error.
const shippedModule = (file: string) => import(join(source, file));
const check: ShippedCheckModule = await shippedModule(entry.check);
const releaseManifest: ShippedManifestModule = await shippedModule(entry.manifest);
const versionOrder: ShippedVersionModule = await shippedModule(entry.version);
const buildIdentity: ShippedIdentityModule = await shippedModule(entry.identity);
const updateInstall: ShippedInstallModule = await shippedModule(entry.install);
const { RELEASE_TARGET_MATRIX: targets }: ShippedContractModule = await shippedModule(entry.contract);
const { RELEASE_REPOSITORY: stated }: ShippedInstallationModule = await shippedModule(entry.installation);
// A served client is one the publishing repository lists, and a client whose
// source states no repository trusts the one its release published to.
const trusted = stated ?? publishing;

const packageVersion: unknown = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const statedVersion = typeof packageVersion === "object" && packageVersion !== null && "version" in packageVersion && typeof packageVersion.version === "string" ? packageVersion.version : undefined;
const parseVersion = versionOrder.parseReleaseVersion ?? versionOrder.parseSemanticVersion;
const clientVersion = statedVersion === undefined ? undefined : parseVersion?.(statedVersion);
if (!clientVersion) throw new Error("the served source states no release version");
const client = `v${clientVersion.canonical}`;
const seedDir: string = seed;

// The client asks only the repository it was built to trust, so a release
// published anywhere else is one it never sees.
if (publishing !== trusted) {
  console.log(`refused repository: the release publishes to ${publishing}, but ${client} checks and downloads only from ${trusted}`);
  process.exit(1);
}
const repositoryIdentity = releaseManifest.parseRepositoryIdentity(trusted);

/** One release, offline: the manifest at the release channel's URL, and
 *  every archive at any URL that names it. */
function publisher(manifestText: string, archives: string): FetchLike {
  const manifestUrl = `https://github.com/${trusted}/releases/latest/download/release.json`;
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === manifestUrl) return new Response(manifestText, { headers: { "content-length": String(Buffer.byteLength(manifestText)) } });
    const file = join(archives, basename(new URL(url).pathname));
    if (!existsSync(file)) return new Response(null, { status: 404 });
    return new Response(Bun.file(file).stream(), { headers: { "content-length": String(Bun.file(file).size) } });
  };
}

const scheduler: ShippedScheduler = {
  nowMs: () => Date.now(),
  setTimer: (fire, delayMs) => {
    const timer = setTimeout(fire, delayMs);
    timer.unref();
    return () => { clearTimeout(timer); };
  },
};

/** What the host target's executable answered the last time it was asked its
 *  version. */
let ranAnswer = "";

/** Every command the client's install engine runs, answered: the host
 *  target's run proof runs for real, with a scratch home, and every other
 *  command succeeds, because it acts on the host rather than on the release. */
function launcherFor(platformArch: string, home: string): ShippedLauncherScope {
  const exitWith = (code: number): ShippedExit => ({ code, signal: null, statusOf: "payload", ownership: "surrendered" });
  const stream = (text: string): ReadableStream<Uint8Array> => new ReadableStream({
    start(controller) {
      if (text !== "") controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const finished = (code: number, stdout = ""): ShippedProcess => ({
    pid: 0, token: "release-acceptance", stdin: undefined, stdout: stream(stdout), stderr: stream(""),
    exited: Promise.resolve(exitWith(code)), terminate: () => Promise.resolve(exitWith(code)),
  });
  const scope: ShippedLauncherScope = {
    async spawnOwned(command, options = {}) {
      const [executable, argument] = command;
      if (argument !== "--version" || executable === undefined) return finished(0);
      if (platformArch !== host) return finished(0, `${expectedVersionLine(options.cwd ?? "")}\n`);
      const child = Bun.spawn([...command], { cwd: options.cwd, env: { ...options.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "inherit", windowsHide: true });
      const [answer, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      ranAnswer = answer.trim();
      return finished(code, answer);
    },
    adoptOwned: () => Promise.reject(new Error("the acceptance run adopts nothing")),
    open: () => scope,
    close: () => Promise.resolve({ settled: true }),
  };
  return scope;
}

/** The line the client expects the build at `buildDir` to print, from its
 *  own metadata, or nothing for a client that reads no line. */
function expectedVersionLine(buildDir: string): string {
  const metadata: unknown = JSON.parse(readFileSync(join(buildDir, "build.json"), "utf8"));
  if (typeof metadata !== "object" || metadata === null || !("version" in metadata) || !("buildId" in metadata) || typeof metadata.version !== "string" || typeof metadata.buildId !== "string") {
    throw new Error(`the build at ${buildDir} states no version and build id`);
  }
  return buildIdentity.versionLine?.(metadata.version, metadata.buildId) ?? "";
}

function authority(): ShippedAuthority {
  return {
    claim: () => ({ kind: "won", fence: 1, leaseExpiresAtMs: Date.now() + 60_000 }),
    renew: () => "held",
    commitCheck: () => true,
    commitActivation: ({ activate }) => { activate(); return true; },
    dispose: () => undefined,
  };
}

/** The client's own published release, read from the seed directory and
 *  completed from the client's release where a file is missing or is not
 *  the published one. */
async function publishedRelease(): Promise<string> {
  const tagUrl = `https://github.com/${trusted}/releases/download/${client}`;
  mkdirSync(seedDir, { recursive: true });
  const manifestFile = join(seedDir, "release.json");
  if (!existsSync(manifestFile)) keep(manifestFile, await download(`${tagUrl}/release.json`));
  return readFileSync(manifestFile, "utf8");
}

async function seedArchive(manifestText: string, assetName: string): Promise<void> {
  const parsed: unknown = JSON.parse(manifestText);
  const assets = typeof parsed === "object" && parsed !== null && "assets" in parsed && Array.isArray(parsed.assets) ? parsed.assets : [];
  const listed: unknown = assets.find((asset: unknown) => typeof asset === "object" && asset !== null && "name" in asset && asset.name === assetName);
  if (typeof listed !== "object" || listed === null || !("sha256" in listed) || !("url" in listed) || typeof listed.sha256 !== "string" || typeof listed.url !== "string") {
    throw new Error(`the published ${client} release lists no ${assetName}`);
  }
  const file = join(seedDir, assetName);
  if (existsSync(file) && sha256(readFileSync(file)) === listed.sha256) return;
  const bytes = await download(listed.url);
  if (sha256(bytes) !== listed.sha256) throw new Error(`the published ${assetName} of ${client} does not digest to the ${listed.sha256} its release states`);
  keep(file, bytes);
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function keep(file: string, bytes: Uint8Array): void {
  writeFileSync(`${file}.partial`, bytes);
  renameSync(`${file}.partial`, file);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Install one release into the scratch account through the client's own
 *  installer, and refuse unless it installs. */
async function installThroughClient(account: { readonly root: string; readonly platformArch: string; readonly platform: string }, release: ShippedRelease, fetchRelease: FetchLike): Promise<void> {
  const policy: ShippedPolicy = { persisted: true, forcedOff: false, effective: true };
  const installer = updateInstall.createUpdateInstaller({
    userDataRoot: join(account.root, "home", ".flywheel"),
    wrapperDir: join(account.root, "bin"),
    platform: account.platform,
    platformArch: account.platformArch,
    scheduler,
    policy: { read: () => policy, revalidate: async (decide) => decide(policy) },
    launcher: launcherFor(account.platformArch, join(account.root, "home")),
    openAuthority: authority,
    fetch: fetchRelease,
  });
  const outcome = await installer.install({ release, fence: 1, signal: new AbortController().signal });
  if (outcome.kind !== "installed") throw new Error(`the install answered ${outcome.kind}`);
}

const candidateManifest = readFileSync(manifest, "utf8");
const candidates = publisher(candidateManifest, dist);
let refused = 0;
let seedManifest: string;
try {
  seedManifest = await publishedRelease();
} catch (error) {
  console.log(`refused seed: the published ${client} release could not be read: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const seeds = publisher(seedManifest, seedDir);

for (const { platformArch, platform } of targets) {
  const account = { root: join(work, platformArch), platformArch, platform };
  rmSync(account.root, { recursive: true, force: true });
  mkdirSync(join(account.root, "home", ".flywheel"), { recursive: true });
  try {
    const assetName = releaseManifest.platformAssetName(platformArch);
    if (assetName === undefined) throw new Error(`${client} names no archive for its own target`);
    await seedArchive(seedManifest, assetName).catch((error: unknown) => {
      throw new Error(`the published ${client} build could not be seeded: ${error instanceof Error ? error.message : String(error)}`);
    });
    await installThroughClient(account, releaseManifest.selectReleaseAsset(seedManifest, { repository: repositoryIdentity, assetName }), seeds).catch((error: unknown) => {
      throw new Error(`the published ${client} build could not be seeded: ${error instanceof Error ? error.message : String(error)}`);
    });
    const seededAnswer = ranAnswer;

    const found = await check.checkForUpdate({ repository: repositoryIdentity, assetName, currentVersion: clientVersion, fetch: candidates, scheduler });
    let release: ShippedRelease;
    if (found.kind === "candidate") {
      release = found.release;
    } else if (found.kind === "unavailable") {
      throw new Error(found.reason);
    } else {
      // The client's own release is the one case it does not move to: the
      // proof against an already published release still admits every byte.
      release = releaseManifest.selectReleaseAsset(candidateManifest, { repository: repositoryIdentity, assetName });
      if (release.version.canonical !== clientVersion.canonical) throw new Error(`${client} orders ${release.version.canonical} as no newer than itself, so it never installs it`);
    }
    await installThroughClient(account, release, candidates);
    const ran = platformArch === host ? ` (the seeded build answered ${JSON.stringify(seededAnswer)}, the staged one ${JSON.stringify(ranAnswer)})` : " (run proof answered here: not this host's target)";
    console.log(`accepted ${platformArch} over ${client}${ran}`);
  } catch (error) {
    refused += 1;
    console.log(`refused ${platformArch}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(account.root, { recursive: true, force: true });
  }
}
process.exit(refused === 0 ? 0 : 1);
