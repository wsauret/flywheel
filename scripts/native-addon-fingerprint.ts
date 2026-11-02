import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { sha256File } from "../src/infra/update/file-digest.js";
import { isRecord } from "../src/infra/record.js";

const FINGERPRINT_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/u;
const RUST_SOURCES = new Bun.Glob("src/**/*.rs");

interface NativeAddonFingerprint {
  readonly version: typeof FINGERPRINT_VERSION;
  readonly sourceSha256: string;
  readonly binarySha256: string;
}

function fingerprintPath(crateDir: string, platformArch: string): string {
  return join(crateDir, `native-prebuilt.${platformArch}.json`);
}

async function productionSourcePaths(crateDir: string): Promise<string[]> {
  const relativePaths = ["Cargo.lock", "Cargo.toml", "build.rs"];
  for await (const relativePath of RUST_SOURCES.scan({ cwd: crateDir, onlyFiles: true })) {
    relativePaths.push(relativePath);
  }
  return relativePaths.filter((relativePath) => existsSync(join(crateDir, relativePath))).sort();
}

/** Hash the complete production input set for one repository-owned native crate. */
export async function nativeAddonSourceSha256(crateDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of await productionSourcePaths(crateDir)) {
    const pathBytes = Buffer.from(relativePath.replaceAll("\\", "/"));
    const content = Buffer.from((await readFile(join(crateDir, relativePath), "utf8")).replaceAll("\r\n", "\n"));
    hash.update(Buffer.from(`${pathBytes.byteLength}:`));
    hash.update(pathBytes);
    hash.update(Buffer.from(`${content.byteLength}:`));
    hash.update(content);
  }
  return hash.digest("hex");
}

function parseFingerprint(value: unknown): NativeAddonFingerprint | undefined {
  if (!isRecord(value)) return undefined;
  const sourceSha256 = value["sourceSha256"];
  const binarySha256 = value["binarySha256"];
  if (value["version"] !== FINGERPRINT_VERSION) return undefined;
  if (typeof sourceSha256 !== "string" || !SHA256.test(sourceSha256)) return undefined;
  if (typeof binarySha256 !== "string" || !SHA256.test(binarySha256)) return undefined;
  return { version: FINGERPRINT_VERSION, sourceSha256, binarySha256 };
}

async function readFingerprint(crateDir: string, platformArch: string): Promise<NativeAddonFingerprint | undefined> {
  try {
    return parseFingerprint(JSON.parse(await readFile(fingerprintPath(crateDir, platformArch), "utf8")));
  } catch {
    return undefined;
  }
}

/** Report whether a tracked addon exactly matches both its crate source and recorded bytes. */
export async function trackedNativeAddonIsCurrent(crateDir: string, platformArch: string, addonPath: string): Promise<boolean> {
  if (!existsSync(addonPath)) return false;
  const fingerprint = await readFingerprint(crateDir, platformArch);
  if (fingerprint === undefined) return false;
  const [sourceSha256, binarySha256] = await Promise.all([
    nativeAddonSourceSha256(crateDir),
    sha256File(addonPath),
  ]);
  return fingerprint.sourceSha256 === sourceSha256 && fingerprint.binarySha256 === binarySha256;
}

/** Atomically attest one tracked addon after its build and publication complete. */
export async function recordTrackedNativeAddon(crateDir: string, platformArch: string, addonPath: string): Promise<void> {
  const [sourceSha256, binarySha256] = await Promise.all([
    nativeAddonSourceSha256(crateDir),
    sha256File(addonPath),
  ]);
  const destination = fingerprintPath(crateDir, platformArch);
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(temporary, `${JSON.stringify({ version: FINGERPRINT_VERSION, sourceSha256, binarySha256 }, null, 2)}\n`);
  await rename(temporary, destination);
}
