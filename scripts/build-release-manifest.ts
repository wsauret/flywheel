/** Emit `release.json`, the whole public update contract.
 *
 *  A release publishes exactly one archive per release target. This script
 *  states each one once: its immutable tag-addressed URL, its exact size, and
 *  its exact SHA-256. The checksum file also states the Claude plugin archive,
 *  whose digest is verified here like an archive's, but the manifest leaves it
 *  out: no installed client reads it. The digest is what makes a download verifiable against a
 *  manifest a client fetched separately (ARCH-DISTRIBUTION-007), so nothing here is
 *  inferred: an archive with no checksum line, a checksum stated twice, an
 *  archive that is not one of the release targets, a target that was not
 *  built, and bytes that do not match their stated digest each refuse the
 *  whole release.
 *
 *  The emitted manifest is then decoded once per target through the client's
 *  own decoder, so a manifest this script writes is one the client built from
 *  this tree reads. Whether every served client accepts the whole release is
 *  `scripts/release-acceptance.ts`'s question.
 *
 * Usage:
 *   bun run scripts/build-release-manifest.ts --dist dist --repo owner/name --version 1.4.2
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "../src/infra/update/file-digest.js";
import { parseRepositoryIdentity, platformAssetName, selectReleaseAsset } from "../src/infra/update/release-manifest.js";
import { CHECKSUMMED_ASSETS, RELEASE_ARCHIVES, RELEASE_TARGETS, releaseRepository } from "./release-contract.js";

const CHECKSUM_FILE = "SHASUMS256.txt";
const CHECKSUM_LINE = /^([0-9a-f]{64})\s+\*?(\S+)$/;

export interface ReleaseManifestInputs {
  readonly distDir: string;
  /** The GitHub repository the release is published under. */
  readonly repository: string;
  /** Canonical `major.minor.patch`. The tag is `v` and this. */
  readonly version: string;
}

export class ReleaseManifestBuildError extends Error {
  constructor(reason: string) {
    super(`The release manifest cannot be composed: ${reason}`);
    this.name = "ReleaseManifestBuildError";
  }
}

export async function composeReleaseManifest(inputs: ReleaseManifestInputs): Promise<string> {
  const repository = parseRepositoryIdentity(inputs.repository);
  const tag = `v${inputs.version}`;
  const stated = readChecksums(join(inputs.distDir, CHECKSUM_FILE));

  const assets = [];
  for (const name of CHECKSUMMED_ASSETS) {
    const sha256 = stated.get(name);
    if (sha256 === undefined) throw new ReleaseManifestBuildError(`${CHECKSUM_FILE} states no ${name}`);
    stated.delete(name);

    const file = join(inputs.distDir, name);
    const size = fileSize(file, name);
    const found = await sha256File(file);
    if (found !== sha256) throw new ReleaseManifestBuildError(`${name} holds the digest ${found}, not the ${sha256} ${CHECKSUM_FILE} states`);
    if (RELEASE_ARCHIVES.some((archive) => archive === name)) assets.push({ name, url: `https://github.com/${repository.owner}/${repository.repo}/releases/download/${tag}/${name}`, size, sha256 });
  }

  const [unexpected] = stated.keys();
  if (unexpected !== undefined) throw new ReleaseManifestBuildError(`${CHECKSUM_FILE} states ${unexpected}, which is not one of the ${CHECKSUMMED_ASSETS.length} assets a release checksums`);

  const manifest = `${JSON.stringify({ version: inputs.version, tag, assets }, null, 2)}\n`;
  for (const target of RELEASE_TARGETS) selectReleaseAsset(manifest, { assetName: platformAssetName(target) });
  return manifest;
}

function fileSize(file: string, name: string): number {
  let stats;
  try {
    stats = statSync(file);
  } catch {
    throw new ReleaseManifestBuildError(`the release is missing ${name}`);
  }
  if (!stats.isFile()) throw new ReleaseManifestBuildError(`${name} is not a regular file`);
  if (stats.size === 0) throw new ReleaseManifestBuildError(`${name} is empty`);
  return stats.size;
}

function readChecksums(checksumFile: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(checksumFile, "utf-8");
  } catch {
    throw new ReleaseManifestBuildError(`the release is missing ${CHECKSUM_FILE}`);
  }

  const stated = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = CHECKSUM_LINE.exec(line.trim());
    if (!match) throw new ReleaseManifestBuildError(`${CHECKSUM_FILE} holds a line that is not a digest and a name: ${JSON.stringify(line)}`);
    const [, sha256 = "", name = ""] = match;
    if (stated.has(name)) throw new ReleaseManifestBuildError(`${CHECKSUM_FILE} states ${name} twice`);
    stated.set(name, sha256);
  }
  return stated;
}

function isPackageJson(value: unknown): value is { version: string } {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string";
}

if (import.meta.main) {
  const option = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const inline = process.argv.find((argument) => argument.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };

  const distDir = option("dist") ?? "dist";
  const repository = option("repo") ?? process.env.FLYWHEEL_REPO ?? releaseRepository(process.env);
  const packageJson: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json();
  if (!isPackageJson(packageJson)) throw new ReleaseManifestBuildError("package.json has no string version");
  const version = option("version") ?? packageJson.version;

  const manifest = await composeReleaseManifest({ distDir, repository, version });
  await Bun.write(join(distDir, "release.json"), manifest);
  console.log(`Wrote ${join(distDir, "release.json")} for ${repository} v${version}`);
}
