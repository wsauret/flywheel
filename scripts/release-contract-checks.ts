/** The release contracts every client from the first integrity-only release
 *  on depends on, checked against the staged release (ARCH-DISTRIBUTION-009).
 *
 *  Such a client refuses only what a correct release can never fail, but a
 *  correct release is one that keeps these contracts. Each one is a fact a
 *  client acts on, so a release that broke it would strand every client of
 *  that generation, whichever served client's acceptance passed:
 *
 *  - every target of this release publishes `flywheel-<target>.tar.gz`, the
 *    only asset name a client asks for (`platformAssetName`);
 *  - each archive is a gzip tar the client's own reader places
 *    (`archive-spool.ts`);
 *  - the archive holds a `build.json` whose `version` is the release's own
 *    strict `major.minor.patch` version and whose `buildId` is the 64-digit
 *    hexadecimal digest of the build's tree, the only form a running build
 *    registers under (`live-builds.ts`);
 *  - the build holds its executable under `buildExecutable(platform)`, which
 *    is executable on a POSIX target;
 *  - a Windows build carries its launchers under the `WINDOWS_LAUNCHERS`
 *    native names, which a flat Windows installation must place;
 *  - the host target's executable exits 0 when it is asked `--version`, as
 *    every client's run proof asks it. */

import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainedDirectory } from "../src/infra/descriptor-directory.js";
import { errorMessage } from "../src/infra/error-message.js";
import { namedExitStatus } from "../src/infra/exit-status.js";
import { BUILD_METADATA_FILE, buildExecutable, computeBuildId, NATIVE_DIR } from "../src/infra/update/build-identity.js";
import { platformAssetName } from "../src/infra/update/release-manifest.js";
import { extractArchive } from "../src/orchestration/update/archive-spool.js";
import { WINDOWS_LAUNCHERS } from "../src/orchestration/update/windows-install.js";
import { RELEASE_TARGET_MATRIX } from "./release-contract.js";
import { parseSemanticVersion } from "./release-version.js";

const BUILD_ID = /^[0-9a-f]{64}$/;

/** How long the host build may take to answer `--version`: the first bound
 *  of every client's run proof. */
const VERSION_RUN_MS = 30_000;

interface ContractTarget {
  readonly platformArch: string;
  readonly platform: string;
}

/** How a build's `--version` run ended: an exit with its code, a signal
 *  that killed it, or no end within the bound. */
export type VersionAnswer =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "killed"; readonly signal: string }
  | { readonly kind: "no answer" };

/** Runs the executable of the build at `buildDir` with `--version`. */
export type VersionRun = (executable: string, buildDir: string, nativeDir: string) => VersionAnswer;

export interface ContractOptions {
  readonly targets?: readonly ContractTarget[];
  /** The target whose build this host runs. */
  readonly host?: string;
  readonly runVersion?: VersionRun;
}

/** Every release contract the staged release breaks, each naming its rule. */
export async function releaseContractViolations(release: { readonly dist: string; readonly manifest: string }, options: ContractOptions = {}): Promise<readonly string[]> {
  const targets = options.targets ?? RELEASE_TARGET_MATRIX;
  const host = options.host ?? `${process.platform}-${process.arch}`;
  const manifest: unknown = JSON.parse(readFileSync(release.manifest, "utf8"));
  const version = typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string" ? manifest.version : "";
  if (parseSemanticVersion(version)?.canonical !== version) {
    return [`release.json states the version ${JSON.stringify(version)}, which is not a strict major.minor.patch release; every tag and every build directory takes one`];
  }
  const listed = new Set(typeof manifest === "object" && manifest !== null && "assets" in manifest && Array.isArray(manifest.assets)
    ? manifest.assets.flatMap((asset: unknown) => (typeof asset === "object" && asset !== null && "name" in asset && typeof asset.name === "string" ? [asset.name] : []))
    : []);
  const violations: string[] = [];
  for (const target of targets) {
    const assetName = platformAssetName(target.platformArch);
    if (!listed.has(assetName)) {
      violations.push(`release.json publishes no ${assetName}, the only archive a client on ${target.platformArch} asks for`);
      continue;
    }
    violations.push(...await buildViolations(join(release.dist, assetName), { target, version, runs: target.platformArch === host, runVersion: options.runVersion ?? runVersion }));
  }
  return violations;
}

async function buildViolations(archive: string, context: { readonly target: ContractTarget; readonly version: string; readonly runs: boolean; readonly runVersion: VersionRun }): Promise<readonly string[]> {
  const { target } = context;
  const name = `flywheel-${target.platformArch}.tar.gz`;
  const scratch = mkdtempSync(join(tmpdir(), "flywheel-release-contract-"));
  try {
    let buildDir: string;
    try {
      buildDir = join(scratch, "staging", ...await extract(scratch, archive));
    } catch (error) {
      return [`${name} is not an archive a client can place: ${errorMessage(error)}`];
    }
    const violations: string[] = [];
    const { version, buildId } = statedBuild(join(buildDir, BUILD_METADATA_FILE));
    if (version !== context.version) violations.push(`${name} holds a build.json whose version is ${JSON.stringify(version)}, not the release's ${context.version}`);
    if (buildId === undefined || !BUILD_ID.test(buildId)) {
      violations.push(`${name} holds a build.json whose buildId ${JSON.stringify(buildId)} is not a 64-digit hexadecimal digest, the only form a running build registers under`);
    } else if (computeBuildId(buildDir, target.platform) !== buildId) {
      violations.push(`${name} holds a build that does not digest to the buildId ${buildId} its build.json states`);
    }
    const executable = join(buildDir, buildExecutable(target.platform));
    const mode = fileMode(executable);
    if (mode === undefined || (target.platform !== "win32" && (mode & 0o100) === 0)) violations.push(`${name} holds no executable ${buildExecutable(target.platform)}`);
    if (target.platform === "win32") {
      for (const { nativeName } of WINDOWS_LAUNCHERS) {
        if (fileMode(join(buildDir, NATIVE_DIR, target.platformArch, nativeName)) === undefined) violations.push(`${name} carries no Windows launcher ${NATIVE_DIR}/${target.platformArch}/${nativeName}`);
      }
    }
    if (context.runs && violations.length === 0) {
      const answer = context.runVersion(executable, buildDir, join(buildDir, NATIVE_DIR, target.platformArch));
      const refused = refusedVersionRun(answer);
      if (refused !== undefined) violations.push(`${name} holds a build that ${refused}`);
    }
    return violations;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Place the archive with the client's own reader, and answer the build's
 *  directory relative to the staging directory. */
async function extract(scratch: string, archive: string): Promise<readonly string[]> {
  const staging = ContainedDirectory.open(scratch, ["staging"], { privateDirectories: true });
  const spool = staging.openChild("spool", { privateDirectories: true });
  try {
    return await extractArchive(staging, spool, createReadStream(archive), new AbortController().signal);
  } finally {
    spool.close();
    staging.close();
  }
}

/** What a `build.json` states as text. A field it does not state as a
 *  string, or a file that is not a JSON object, states nothing. */
interface StatedBuild {
  readonly version?: string;
  readonly buildId?: string;
}

function statedBuild(file: string): StatedBuild {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  return {
    ...("version" in parsed && typeof parsed.version === "string" ? { version: parsed.version } : {}),
    ...("buildId" in parsed && typeof parsed.buildId === "string" ? { buildId: parsed.buildId } : {}),
  };
}

function fileMode(file: string): number | undefined {
  try {
    const stats = statSync(file);
    return stats.isFile() ? stats.mode : undefined;
  } catch {
    return undefined;
  }
}

/** What a run that is not a clean exit did, in the gate's words. */
function refusedVersionRun(answer: VersionAnswer): string | undefined {
  switch (answer.kind) {
    case "exited": return answer.code === 0 ? undefined : `exited ${answer.code} when it was asked --version`;
    case "killed": return `was killed by ${answer.signal} when it was asked --version`;
    case "no answer": return `did not answer --version within ${VERSION_RUN_MS}ms`;
  }
}

/** The host build asked its version, as a client's run proof asks it: from
 *  its own directory, with its native directory, and in a scratch home. */
function runVersion(executable: string, buildDir: string, nativeDir: string): VersionAnswer {
  const home = mkdtempSync(join(tmpdir(), "flywheel-release-contract-home-"));
  try {
    const result = Bun.spawnSync([executable, "--version"], {
      cwd: buildDir,
      env: { ...process.env, HOME: home, USERPROFILE: home, FLYWHEEL_NATIVE_DIR: nativeDir },
      stdout: "ignore", stderr: "ignore", timeout: VERSION_RUN_MS, windowsHide: true,
    });
    if (result.exitedDueToTimeout === true) return { kind: "no answer" };
    const { code, signal } = namedExitStatus(result.exitCode, result.signalCode ?? null);
    if (code !== null) return { kind: "exited", code };
    return { kind: "killed", signal: signal ?? "an unnamed signal" };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
