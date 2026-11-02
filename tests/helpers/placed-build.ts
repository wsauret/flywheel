import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ContainedDirectory } from "../../src/infra/descriptor-directory.js";
import { versionsDir } from "../../src/infra/paths.js";
import { openActiveBuild, publishActivation } from "../../src/infra/update/active-build.js";
import { assertInstallLocation, buildInstallDir, BUILD_METADATA_FILE, buildExecutable, type BuildRef, buildIdentityBeside, decodeBuildMetadata, versionLine } from "../../src/infra/update/build-identity.js";

/** What a staged or placed build prints when the install engine asks it its
 *  version, or nothing when `command` is not that question. It is the line the
 *  real executable prints from the metadata beside it, so a fake command runner
 *  answers the engine's run proof the way a working build does. */
export function placedBuildVersionAnswer(command: readonly string[]): string | undefined {
  const [executable, argument] = command;
  if (argument !== "--version" || executable === undefined) return undefined;
  const metadata = decodeBuildMetadata(readFileSync(join(dirname(executable), BUILD_METADATA_FILE), "utf8"));
  return `${versionLine(metadata.version.canonical, buildIdentityBeside(executable)?.buildId)}\n`;
}

/** Place a build under an account's versions root the way the install engine
 *  leaves one: its directory, its metadata, and an executable a process can
 *  name as the build it runs. The executable does nothing. Answers the
 *  executable's path. */
export function placeBuild(userDataRoot: string, build: BuildRef): string {
  const directory = join(versionsDir(userDataRoot), build.version, build.buildId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, BUILD_METADATA_FILE), JSON.stringify({ ...build, asset: "flywheel-darwin-arm64.tar.gz" }));
  const executable = join(directory, buildExecutable(process.platform));
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  return executable;
}

/** Activate an already placed fixture build through the host's activation writer. */
export function activatePlacedBuild(userDataRoot: string, build: BuildRef): void {
  const accountRoot = ContainedDirectory.openExisting(dirname(userDataRoot), [basename(userDataRoot)]);
  if (!accountRoot) throw new Error("fixture account root does not exist");
  try {
    publishActivation(accountRoot, userDataRoot, build);
  } finally {
    accountRoot.close();
  }
}

/** Copy only the active immutable payload into a fresh fixture account and activate it.
 * Legacy self-contained baselines can have no activation. Invalid activations still fail.
 * No account configuration, credentials, or caches cross this boundary. */
export function copyActiveBuild(sourceHome: string, targetHome: string, legacyBaseline: boolean): void {
  const sourceRoot = join(sourceHome, ".flywheel");
  const account = ContainedDirectory.openExisting(sourceHome, [".flywheel"]);
  let active: ReturnType<typeof openActiveBuild>;
  try {
    active = account ? openActiveBuild(account, sourceRoot) : undefined;
    if (!active) {
      if (legacyBaseline && (account === undefined || !account.hasEntry("current"))) return;
      throw new Error(`No active immutable build under ${sourceHome}`);
    }
    const identity = decodeBuildMetadata(readFileSync(join(active.path, BUILD_METADATA_FILE), "utf8"));
    assertInstallLocation(identity, active.path);
    const targetRoot = join(targetHome, ".flywheel");
    mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    cpSync(active.path, buildInstallDir(targetRoot, identity), { recursive: true });
    activatePlacedBuild(targetRoot, { version: identity.version.canonical, buildId: identity.buildId });
  } finally {
    active?.directory.close();
    account?.close();
  }
}
