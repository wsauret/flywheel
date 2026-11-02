/** What one installed build is, and where it lives.
 *
 *  A build is the executable, its native libraries, and its fonts as one
 *  thing (ARCH-DISTRIBUTION-001). `build.json` binds that payload to a version and a build
 *  identity, and the release computes the identity as a digest of the payload
 *  itself: a rebuilt tree that differs by one byte, one path, or one
 *  executable bit is a different build and therefore a different directory.
 *  Nothing is ever written over a physical build, so a process that started
 *  from one keeps reading exactly the files it started with.
 *
 *  An updater reads the `build.json` of a later release, so the decode reads
 *  only the two fields that name the build's directory and ignores every
 *  other field. Each must be one directory name, which is the one guarantee
 *  no other module has to re-derive from an installed file it did not
 *  write. */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Schema } from "effect";
import { errorMessage } from "../error-message.js";
import { versionsDir } from "../paths.js";
import { sha256FileSync } from "./file-digest.js";
import { isDirectoryName, parseReleaseVersion, type ReleaseVersion } from "./version-order.js";

/** The metadata file at the root of every physical build. */
export const BUILD_METADATA_FILE = "build.json";

/** The executable at the root of every physical build of `platform`: the
 *  build's own platform, never the one a process runs on. Windows runs a
 *  program only by an executable extension, so its build names one; the
 *  launcher on PATH (`flywheel` or `flywheel.exe`) is never this file. */
export function buildExecutable(platform: string): string {
  return platform === "win32" ? "flywheel-bin.exe" : "flywheel-bin";
}

/** The directory under a physical build that holds each platform's native
 *  libraries, as `native/<platform>-<arch>`. The build's launcher exports it
 *  as `FLYWHEEL_NATIVE_DIR`. */
export const NATIVE_DIR = "native";

export interface BuildIdentity {
  readonly version: ReleaseVersion;
  /** The release's digest of the payload manifest; also the build's
   *  directory name. */
  readonly buildId: string;
}

/** An installed build does not describe itself, or does not describe the
 *  place it was found in. */
export class BuildIdentityError extends Schema.TaggedErrorClass<BuildIdentityError>()("BuildIdentity", {
  message: Schema.String,
  reason: Schema.String,
}) {}

function refuse(reason: string): never {
  throw new BuildIdentityError({ message: `The build metadata is not usable: ${reason}`, reason });
}

const BuildMetadataSchema = Schema.Struct({
  version: Schema.String,
  buildId: Schema.String,
});
const decodeMetadata = Schema.decodeUnknownSync(BuildMetadataSchema);

export function decodeBuildMetadata(raw: string): BuildIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    refuse(`the metadata is not JSON: ${errorMessage(error)}`);
  }

  let metadata: typeof BuildMetadataSchema.Type;
  try {
    metadata = decodeMetadata(parsed);
  } catch (error) {
    refuse(`the metadata is missing or misstates a required field: ${errorMessage(error)}`);
  }

  const version = parseReleaseVersion(metadata.version);
  if (!version) refuse(`the version ${JSON.stringify(metadata.version)} cannot name a build directory`);
  if (!isDirectoryName(metadata.buildId)) refuse(`the build identity ${JSON.stringify(metadata.buildId)} cannot name a build directory`);
  return { version, buildId: metadata.buildId };
}

/** The one physical directory this build occupies under an account root. */
export function buildInstallDir(userDataRoot: string, identity: BuildIdentity): string {
  return path.join(versionsDir(userDataRoot), identity.version.canonical, identity.buildId);
}

/** Refuse a build directory whose metadata describes another build. A
 *  physical tree is immutable, so the path is as much a claim about the
 *  build as the file inside it, and activation acts on both. */
export function assertInstallLocation(identity: BuildIdentity, dir: string): void {
  const found = { buildId: path.basename(dir), version: path.basename(path.dirname(dir)) };
  if (found.version !== identity.version.canonical || found.buildId !== identity.buildId) {
    refuse(`the build at ${JSON.stringify(dir)} states version ${identity.version.canonical} and build ${identity.buildId}`);
  }
}

/** One installed build as a durable record names it: the two components of
 *  its directory under the versions root. Each is held to one directory
 *  name, because a reader joins them into a path, and to nothing narrower,
 *  because a record can name a build of a later release. Every record an
 *  earlier build wrote, with a `major.minor.patch` version and a 64-digit
 *  hexadecimal build id, still reads. */
const DirectoryNameSchema = Schema.String.check(Schema.makeFilter((value: string) => isDirectoryName(value) || "one directory name"));
export const BuildRefSchema = Schema.Struct({
  version: DirectoryNameSchema,
  buildId: DirectoryNameSchema,
});
export type BuildRef = typeof BuildRefSchema.Type;

/** The line `flywheel --version` prints. An installed build names its build
 *  identity too, which is how an installer proves that the executable it is
 *  about to activate runs on this host and is the build it placed. */
export function versionLine(version: string, buildId: string | undefined): string {
  return buildId === undefined ? `flywheel ${version}` : `flywheel ${version} (build ${buildId})`;
}

/** The build identity the metadata beside an executable states, or nothing
 *  when there is no usable metadata there, as for a source checkout.
 *  `--version` prints its id. */
export function buildIdentityBeside(executable: string): BuildIdentity | undefined {
  try {
    return decodeBuildMetadata(fs.readFileSync(path.join(path.dirname(executable), BUILD_METADATA_FILE), "utf8"));
  } catch {
    return undefined;
  }
}

/** The build identity of a staged or installed payload tree.
 *
 *  It digests a manifest of the tree rather than its bytes alone: every entry
 *  contributes its normalized relative path, its type, its executable mode,
 *  its size, and its own byte digest, in one sorted order. A renamed file, an
 *  added empty directory, and a lost executable bit therefore each produce a
 *  different identity, which is what makes a build directory safe to treat as
 *  immutable.
 *
 *  `build.json` is excluded because it carries the identity this computes. A
 *  symlink, a device, or any other irregular entry has no identity at all and
 *  is refused rather than digested as if it were a file.
 *
 *  The executable state is the build platform's own fact. Windows keeps no
 *  execute bit, so a Windows build states every file as not executable, and
 *  the identity a Mac computes for a Windows archive is the identity Windows
 *  computes for the extracted tree. `platform` is the build's platform, never
 *  the one this process runs on.
 *
 *  The walk is synchronous throughout, so activation can prove the identity of
 *  the build it is about to compare while it holds the account config lock. */
export function computeBuildId(rootDir: string, platform: string): string {
  const lines: string[] = [];
  for (const entry of listPayload(rootDir, "")) {
    const full = path.join(rootDir, entry.relativePath);
    if (entry.kind === "directory") {
      lines.push(`${entry.relativePath}\tdirectory\t0\t0\t`);
      continue;
    }
    const stats = fs.statSync(full);
    const executable = platform === "win32" || (stats.mode & 0o100) === 0 ? 0 : 1;
    lines.push(`${entry.relativePath}\tfile\t${executable}\t${stats.size}\t${sha256FileSync(full)}`);
  }
  lines.sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

interface PayloadEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
}

function listPayload(rootDir: string, prefix: string): PayloadEntry[] {
  const entries: PayloadEntry[] = [];
  for (const dirent of fs.readdirSync(path.join(rootDir, prefix), { withFileTypes: true })) {
    const relativePath = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      entries.push({ relativePath, kind: "directory" }, ...listPayload(rootDir, relativePath));
      continue;
    }
    if (!dirent.isFile()) refuse(`${JSON.stringify(relativePath)} is neither a regular file nor a directory`);
    if (relativePath === BUILD_METADATA_FILE) continue;
    entries.push({ relativePath, kind: "file" });
  }
  return entries;
}
