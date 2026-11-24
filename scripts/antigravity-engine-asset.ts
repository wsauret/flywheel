import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { antigravityEngineFile, buildPlatformArch, checkoutAntigravityEngine } from "../src/infra/native-assets.js";
import { isRecord, type UnknownRecord } from "../src/infra/record.js";
import { renameThroughSharing } from "../src/infra/windows-file-replacement.js";
import { requireDigestMatch, requireExecutable, type EngineDigest } from "./engine-asset-verify.js";
import { RELEASE_TARGETS, type ReleaseTargetName } from "./release-contract.js";

/**
 * The Antigravity CLI (`agy`) that every release archive carries, for one platform, and the verified copy that a
 * source checkout runs. `scripts/antigravity-engine-pin.json` pins one Google release for every release target: the
 * artifact URL and Google's sha512 of it, and the size and SHA-256 of the executable inside it.
 *
 * Only two commands reach the network, and neither runs at application startup or in a unit test:
 *
 * 1. `prepare` downloads the pinned artifact of one target when the checkout has no verified copy of it, refuses it
 *    unless its sha512 is the pin's, and places the extracted executable at `checkoutAntigravityEngine`. A verified
 *    copy means no network. A build stages from this copy, so a cross build prepares the target it builds.
 * 2. `pin <version>` reads Google's release manifest of every target and writes a new pin. Google's endpoint serves
 *    only its latest release, so it refuses a version that the manifests do not serve.
 *
 * `pin --observe` changes no pin: it records what Google serves now for the freshness gate
 * (scripts/antigravity-engine-release.ts).
 */

/** The pin, relative to the repository root, in the form that git paths and messages use on every host. */
export const PIN_FILE = "scripts/antigravity-engine-pin.json";
const MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
/** Google's name of each Flywheel release target in its manifest URLs. */
const MANIFEST_TARGETS = {
  "darwin-arm64": "darwin_arm64",
  "darwin-x64": "darwin_amd64",
  "linux-arm64": "linux_arm64",
  "linux-arm64-musl": "linux_arm64_musl",
  "linux-x64": "linux_amd64",
  "linux-x64-musl": "linux_amd64_musl",
  "win32-arm64": "windows_arm64",
  "win32-x64": "windows_amd64",
} as const satisfies { readonly [target in ReleaseTargetName]: string };

interface PinnedTarget extends EngineDigest {
  readonly manifestTarget: string;
  readonly url: string;
  /** Google's sha512 of the downloaded artifact, in hex, as its manifest states it. */
  readonly sha512: string;
  /** A `tar.gz` holds the executable as `member`; an `exe` artifact is the executable itself. */
  readonly archive: "tar.gz" | "exe";
  readonly member?: string;
}

export interface AntigravityPin {
  readonly version: string;
  readonly build: string;
  readonly targets: ReadonlyMap<string, PinnedTarget>;
}

/** The pin of the checkout at `root`. Throws when the file is not a pin. */
export async function readAntigravityPin(root: string): Promise<AntigravityPin> {
  return parseAntigravityPin(await readFile(join(root, PIN_FILE), "utf8"));
}

/** The pin that `text` states. Throws when the text is not a pin. */
export function parseAntigravityPin(text: string): AntigravityPin {
  const value: unknown = JSON.parse(text);
  const malformed = () => new Error(`${PIN_FILE} is not an Antigravity CLI pin`);
  if (!isRecord(value) || typeof value["version"] !== "string" || typeof value["build"] !== "string" || !isRecord(value["targets"])) throw malformed();
  const targets = new Map<string, PinnedTarget>();
  for (const [platformArch, entry] of Object.entries(value["targets"])) {
    const target = isRecord(entry) ? pinnedTargetOf(entry) : undefined;
    if (target === undefined) throw malformed();
    targets.set(platformArch, target);
  }
  return { version: value["version"], build: value["build"], targets };
}

function pinnedTargetOf(entry: UnknownRecord): PinnedTarget | undefined {
  const { manifestTarget, url, sha512, archive, member, size, sha256 } = entry;
  if (typeof manifestTarget !== "string" || typeof url !== "string" || typeof sha512 !== "string" || typeof size !== "number" || typeof sha256 !== "string") return undefined;
  if (archive === "exe" && member === undefined) return { manifestTarget, url, sha512, archive, size, sha256 };
  if (archive === "tar.gz" && typeof member === "string") return { manifestTarget, url, sha512, archive, member, size, sha256 };
  return undefined;
}

function pinnedTarget(pin: AntigravityPin, platformArch: string): PinnedTarget {
  const target = pin.targets.get(platformArch);
  if (target === undefined) throw new Error(`The Antigravity CLI pin ${pin.version} names no artifact for ${platformArch}`);
  return target;
}

/**
 * Makes sure that the checkout at `root` holds the verified pinned executable of `platformArch` and returns its
 * absolute path. A copy that matches the pin's size and SHA-256 is used without a network request. Otherwise the
 * pinned artifact is downloaded, checked against the pin's sha512, and extracted, and its verified executable replaces
 * any other copy in one rename. Throws, and places nothing, when the download fails or the artifact or its executable
 * does not match the pin.
 *
 * Two preparations of one target can run at the same time, such as a build and the integration suite. Each one
 * writes its own temporary file and renames it onto the destination, so neither removes or truncates a copy that
 * the other placed. Windows refuses a rename onto a file that another rename holds at that moment, so the rename
 * retries that refusal for a short bound.
 */
export async function prepareAntigravityEngine(root: string, platformArch: string): Promise<string> {
  const pin = await readAntigravityPin(root);
  const target = pinnedTarget(pin, platformArch);
  const name = `Antigravity CLI ${pin.version} for ${platformArch}`;
  const label = `The ${name}`;
  const destination = join(root, checkoutAntigravityEngine(pin.version, platformArch));
  if (existsSync(destination)) {
    try {
      requireDigestMatch(label, "the pin", target, new Uint8Array(await readFile(destination)));
      await requireExecutable(label, destination, platformArch);
      return destination;
    } catch {
      // The download below replaces this copy.
    }
  }
  console.log(`Fetching the ${name}...`);
  const bytes = await executableOf(target, await download(target.url, target.sha512, name));
  requireDigestMatch(label, "the pin", target, bytes);
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes);
    await chmod(partial, 0o755);
    renameThroughSharing(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
  return destination;
}

/** Copies the verified pinned executable of the platform into the native directory, executable. */
export async function stageAntigravityEngine(root: string, nativeDir: string, platformArch: string): Promise<void> {
  const destination = join(nativeDir, antigravityEngineFile(platformArch));
  await copyFile(await prepareAntigravityEngine(root, platformArch), destination);
  await chmod(destination, 0o755);
}

/** Refuses a staged executable that is missing, is not executable, or is not the bytes that the pin states. */
export async function verifyAntigravityEngine(root: string, nativeDir: string, platformArch: string): Promise<void> {
  const pin = await readAntigravityPin(root);
  const target = pinnedTarget(pin, platformArch);
  const label = `The Antigravity CLI ${pin.version} for ${platformArch}`;
  const path = join(nativeDir, antigravityEngineFile(platformArch));
  await requireExecutable(label, path, platformArch);
  requireDigestMatch(label, "the pin", target, new Uint8Array(await readFile(path)));
}

/**
 * Writes a new pin for `version` from Google's release manifest of every release target: each artifact is
 * downloaded, checked against the manifest's sha512, and its executable measured. Throws, and writes nothing, when a
 * manifest serves another version or an artifact does not match.
 */
export async function pinAntigravityEngine(root: string, version: string): Promise<AntigravityPin> {
  const targets = new Map<string, PinnedTarget>();
  let build: string | undefined;
  for (const platformArch of RELEASE_TARGETS) {
    const manifestTarget = MANIFEST_TARGETS[platformArch];
    const manifest = await manifestOf(manifestTarget);
    if (manifest.version !== version) throw new Error(`Google's ${manifestTarget} manifest serves the Antigravity CLI ${manifest.version}, not ${version}`);
    const artifactBuild = /\/antigravity-cli\/([^/]+)\//u.exec(manifest.url)?.[1];
    if (artifactBuild === undefined || (build !== undefined && artifactBuild !== build)) throw new Error(`Google's ${manifestTarget} artifact ${manifest.url} is not of the build ${build ?? "that the URL names"}`);
    build = artifactBuild;
    const name = `Antigravity CLI ${version} for ${platformArch}`;
    console.log(`Fetching the ${name}...`);
    const artifact = await download(manifest.url, manifest.sha512, name);
    const location = manifest.url.endsWith(".exe") ? { archive: "exe" as const } : { archive: "tar.gz" as const, member: await onlyMember(artifact, name) };
    const executable = await executableOf({ ...location, url: manifest.url }, artifact);
    targets.set(platformArch, { manifestTarget, url: manifest.url, sha512: manifest.sha512, ...location, size: executable.byteLength, sha256: createHash("sha256").update(executable).digest("hex") });
  }
  if (build === undefined) throw new Error("The release contract names no target");
  const pin: AntigravityPin = { version, build, targets };
  await writeFile(join(root, PIN_FILE), `${JSON.stringify({ ...pin, targets: Object.fromEntries(targets) }, null, 2)}\n`);
  return pin;
}

/** What Google's release manifest of one target states: the one version that it serves, and that version's artifact. */
export interface ReleaseManifest {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
}

/** The URL of Google's release manifest of `manifestTarget`, such as `linux_amd64`. */
export function antigravityManifestUrl(manifestTarget: string): string {
  return `${MANIFEST_BASE}/${manifestTarget}.json`;
}

async function manifestOf(manifestTarget: string): Promise<ReleaseManifest> {
  const url = antigravityManifestUrl(manifestTarget);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return parseReleaseManifest(url, await response.json());
}

/** The manifest that `url` answered with `manifest`. Throws when it is not a release manifest. */
export function parseReleaseManifest(url: string, manifest: unknown): ReleaseManifest {
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || !("url" in manifest) || !("sha512" in manifest)
    || typeof manifest.version !== "string" || typeof manifest.url !== "string" || typeof manifest.sha512 !== "string") {
    throw new Error(`${url} is not a release manifest`);
  }
  return { version: manifest.version, url: manifest.url, sha512: manifest.sha512 };
}

/** The bytes at `url`, refused unless their sha512 is `sha512`. `name` names the engine and target in the error. */
async function download(url: string, sha512: string, name: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha512").update(bytes).digest("hex");
  if (digest !== sha512) throw new Error(`${url} has sha512 ${digest}, which does not match the pinned sha512 ${sha512} of the ${name}`);
  return bytes;
}

async function executableOf(target: Pick<PinnedTarget, "archive" | "member" | "url">, artifact: Uint8Array): Promise<Uint8Array> {
  if (target.archive === "exe") return artifact;
  const file = target.member === undefined ? undefined : (await new Bun.Archive(artifact).files()).get(target.member);
  if (file === undefined) throw new Error(`${target.url} holds no ${target.member ?? "named member"}`);
  return file.bytes();
}

async function onlyMember(artifact: Uint8Array, name: string): Promise<string> {
  const members = [...(await new Bun.Archive(artifact).files()).keys()];
  if (members.length !== 1 || members[0] === undefined) throw new Error(`The artifact of the ${name} holds ${members.length} files, not one executable`);
  return members[0];
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const [command, argument] = process.argv.slice(2);
  if (command === "prepare") {
    console.log(`The Antigravity CLI is ready at ${await prepareAntigravityEngine(root, argument ?? buildPlatformArch())}`);
  } else if (command === "pin" && argument === "--observe") {
    // Loaded only here: the freshness gate reads this file's pin and manifest helpers.
    const { observeAntigravityRelease } = await import("./antigravity-engine-release.js");
    for (const line of await observeAntigravityRelease(root)) console.log(line);
  } else if (command === "pin" && argument !== undefined) {
    const pin = await pinAntigravityEngine(root, argument);
    console.log(`Pinned the Antigravity CLI ${pin.version} (${pin.build}) for ${pin.targets.size} targets in ${PIN_FILE}`);
  } else {
    console.error("usage: bun run scripts/antigravity-engine-asset.ts prepare [<platform-arch>] | pin <version> | pin --observe");
    process.exit(2);
  }
}
