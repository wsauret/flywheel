import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeEngineFile } from "../src/infra/native-assets.js";

/**
 * The Claude engine that every release archive carries: the `claude` binary that the Agent SDK pins, for one
 * platform. The bytes come from one of two places, and both are checked against the lockfile:
 *
 * 1. The SDK's platform package in node_modules, when `bun install` placed the locked version there. It does so for the
 *    host platform, and bun verified the package against the bun.lock integrity when it installed it.
 * 2. Otherwise, the locked platform package from the npm registry, verified against the bun.lock integrity before any
 *    byte of it is used, and kept in node_modules/.cache for the next build.
 *
 * Either way, the binary must then match the SHA-256 and size that the SDK's own manifest states for that platform.
 * The SDK package is the one bun installed against the lockfile, so the chain of checks runs from bun.lock to the bytes.
 * A cross build therefore needs no change to node_modules, and a build never ships a binary that the lockfile does
 * not name.
 */

export const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const REGISTRY = "https://registry.npmjs.org";

interface EngineEntry {
  readonly binary: string;
  readonly sha256: string;
  readonly size: number;
}

interface LockedPackage {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

/** The lockfile entry of one package: its version and its sha512 integrity. */
async function lockedPackage(root: string, name: string): Promise<LockedPackage> {
  return lockedPackageIn(await readFile(join(root, "bun.lock"), "utf8"), name);
}

/** The entry of one package in the text of a `bun.lock`, such as one that git reads from an earlier commit. Throws
 *  when the lockfile names no such package or its entry has no version or sha512 integrity. */
export function lockedPackageIn(lockText: string, name: string): LockedPackage {
  const locked = lockEntry(lockText, name);
  if (locked === undefined) throw new Error(`bun.lock has no entry for ${name}`);
  return locked;
}

/** Whether the text of a `bun.lock` has an entry for the package, such as an earlier release that predates it. */
export function lockHasPackage(lockText: string, name: string): boolean {
  return lockEntry(lockText, name) !== undefined;
}

/** The package's entry, or undefined when the lockfile names no such package. Throws when the entry has no version
 *  or sha512 integrity. */
function lockEntry(lockText: string, name: string): LockedPackage | undefined {
  const lock: unknown = Bun.JSONC.parse(lockText);
  const packages = isRecord(lock) ? lock["packages"] : undefined;
  const entry: unknown = isRecord(packages) ? packages[name] : undefined;
  if (!Array.isArray(entry)) return undefined;
  const spec: unknown = entry[0];
  const integrity: unknown = entry[3];
  const version = typeof spec === "string" && spec.startsWith(`${name}@`) ? spec.slice(name.length + 1) : undefined;
  if (version === undefined || typeof integrity !== "string" || !integrity.startsWith("sha512-")) throw new Error(`bun.lock entry of ${name} has no version or sha512 integrity`);
  return { name, version, integrity };
}

/** The SDK manifest's entry for the platform, from the SDK package that bun installed at the locked version. */
async function engineEntry(root: string, platformArch: string): Promise<EngineEntry> {
  const sdkDir = join(root, "node_modules", ...SDK_PACKAGE.split("/"));
  const locked = await lockedPackage(root, SDK_PACKAGE);
  const installed: unknown = JSON.parse(await readFile(join(sdkDir, "package.json"), "utf8"));
  if (!isRecord(installed) || installed["version"] !== locked.version) throw new Error(`${SDK_PACKAGE} in node_modules is not the locked ${locked.version}: run bun install`);
  const manifest: unknown = JSON.parse(await readFile(join(sdkDir, "manifest.json"), "utf8"));
  const platforms = isRecord(manifest) ? manifest["platforms"] : undefined;
  const entry = isRecord(platforms) ? platforms[platformArch] : undefined;
  if (!isRecord(entry) || typeof entry["binary"] !== "string" || typeof entry["checksum"] !== "string" || typeof entry["size"] !== "number") {
    throw new Error(`The ${SDK_PACKAGE} ${locked.version} manifest names no engine for ${platformArch}`);
  }
  if (entry["binary"] !== claudeEngineFile(platformArch)) throw new Error(`The ${SDK_PACKAGE} manifest names the ${platformArch} engine ${entry["binary"]}, not ${claudeEngineFile(platformArch)}`);
  return { binary: entry["binary"], sha256: entry["checksum"], size: entry["size"] };
}

/** The engine bytes of the locked platform package: the installed copy when it is the locked version, else the
 *  registry tarball checked against the lockfile. */
async function lockedEngineBytes(root: string, platformArch: string, binary: string): Promise<Uint8Array> {
  const locked = await lockedPackage(root, `${SDK_PACKAGE}-${platformArch}`);
  const packageDir = join(root, "node_modules", ...locked.name.split("/"));
  if (existsSync(join(packageDir, "package.json"))) {
    const installed: unknown = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    if (isRecord(installed) && installed["version"] === locked.version) return new Uint8Array(await readFile(join(packageDir, binary)));
  }
  const tarball = await lockedTarball(root, locked);
  const file = (await new Bun.Archive(tarball).files()).get(`package/${binary}`);
  if (file === undefined) throw new Error(`${locked.name}@${locked.version} holds no package/${binary}`);
  return file.bytes();
}

/** The registry tarball of a locked package, from the build cache or the registry, refused unless its sha512 is the
 *  lockfile's integrity. */
async function lockedTarball(root: string, locked: LockedPackage): Promise<Uint8Array> {
  const base = locked.name.split("/").at(-1) ?? locked.name;
  const cache = join(root, "node_modules", ".cache", "claude-engine", `${base}-${locked.version}.tgz`);
  if (existsSync(cache)) {
    const cached = new Uint8Array(await readFile(cache));
    if (sha512Integrity(cached) === locked.integrity) return cached;
    await rm(cache, { force: true });
  }
  const url = `${REGISTRY}/${locked.name}/-/${base}-${locked.version}.tgz`;
  console.log(`Fetching ${locked.name}@${locked.version} for the Claude engine...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha512Integrity(bytes) !== locked.integrity) throw new Error(`${url} does not match the bun.lock integrity of ${locked.name}@${locked.version}`);
  await mkdir(join(cache, ".."), { recursive: true });
  await writeFile(`${cache}.partial`, bytes);
  await rename(`${cache}.partial`, cache);
  return bytes;
}

/** Copies the locked engine of the platform into the native directory, executable, after it matches the SDK manifest. */
export async function stageClaudeEngine(root: string, nativeDir: string, platformArch: string): Promise<void> {
  const entry = await engineEntry(root, platformArch);
  const bytes = await lockedEngineBytes(root, platformArch, entry.binary);
  requireManifestMatch(platformArch, entry, bytes);
  const destination = join(nativeDir, entry.binary);
  await writeFile(destination, bytes);
  await chmod(destination, 0o755);
}

/** Refuses a staged engine that is missing, is not executable, or is not the bytes that the SDK manifest states. */
export async function verifyClaudeEngine(root: string, nativeDir: string, platformArch: string): Promise<void> {
  const entry = await engineEntry(root, platformArch);
  const path = join(nativeDir, entry.binary);
  // A Windows host's file system keeps no executable bit, so only a POSIX host can check it.
  if (process.platform !== "win32" && !platformArch.startsWith("win32-") && ((await stat(path)).mode & 0o111) === 0) throw new Error(`The Claude engine for ${platformArch} is not executable`);
  requireManifestMatch(platformArch, entry, new Uint8Array(await readFile(path)));
}

function requireManifestMatch(platformArch: string, entry: EngineEntry, bytes: Uint8Array): void {
  if (bytes.byteLength !== entry.size) throw new Error(`The Claude engine for ${platformArch} is ${bytes.byteLength} bytes, and the SDK manifest states ${entry.size}`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) throw new Error(`The Claude engine for ${platformArch} has SHA-256 ${digest}, and the SDK manifest states ${entry.sha256}`);
}

function sha512Integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
