/** Which installed builds a Flywheel process is still executing.
 *
 *  A build tree is immutable and account-global, so the only thing that makes
 *  one safe to remove is knowing nothing is reading it (ARCH-DISTRIBUTION-019, ARCH-DISTRIBUTION-026). The
 *  filesystem cannot answer that: a tree nobody has opened in months and a
 *  tree a week-long session is running look identical, and the modification
 *  time of either says nothing about the processes attached to it. So every
 *  process that runs an installed build says so, and a collector reads the
 *  answer instead of guessing.
 *
 *  One registration is one entry whose name is the whole record: the build and
 *  the process. Nothing is written inside it, so registering is one create and
 *  unregistering is one unlink, with no lock, no read-modify-write, and no
 *  ordering between processes. The registry lives beside the update authority
 *  and never inside a build tree, which nothing may write to.
 *
 *  The registration is ephemeral liveness, exactly like a session's owner pid
 *  lock: no projection replays it and no behavior depends on it surviving. A
 *  process killed before its disposer runs leaves one stale entry, which the
 *  next read removes.
 *
 *  A process running a build older than this registry cannot register, so it
 *  is never proved live. That is the transition this registry cannot answer on
 *  its own, and the collector's retention band is what covers it. */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { ContainedDirectory } from "../descriptor-directory.js";
import { errorMessage } from "../error-message.js";
import { Log } from "../log.js";
import { liveBuildsDir, versionsDir } from "../paths.js";
import { isProcessAlive } from "../process-liveness.js";
import { assertInstallLocation, BUILD_METADATA_FILE, type BuildRef, decodeBuildMetadata } from "./build-identity.js";

const log = Log.create({ service: "live-builds" });

/** A build's own metadata is read whole. It is part of a tree the installer
 *  proved by digest before placing it, and its size is the release's
 *  business: a running build that could not read it would not count as live,
 *  and collection could remove the tree it runs from. */
const METADATA_READ_BYTES = Number.POSITIVE_INFINITY;

/** `<build id>.<pid>`, which is the whole record. A build id is a payload
 *  digest and a pid is a positive decimal, so neither half can hold the
 *  separator and the split is unambiguous. */
const REGISTRATION = /^([0-9a-f]{64})\.([1-9][0-9]*)$/;

/** An installed build an executable belongs to, read off the executable's
 *  own path before any account is asked: the build directory it was
 *  launched from and the version and id that directory states. */
export interface ExecutableBuild extends BuildRef {
  readonly buildDir: string
}

/** The installed build `execPath` belongs to, or nothing when it is not one:
 *  a source checkout, a test, or any other launch that does not come from an
 *  installed tree.
 *
 *  The executable of an installed build sits at
 *  `<versions root>/<version>/<build id>/<executable>`, so the build is
 *  readable off the path the process was launched from. The path is resolved
 *  physically, because the launcher resolves `current` before it executes.
 *  The tree then has to state the identity its own location claims, so a
 *  directory planted at a build id's name is not mistaken for the build it
 *  names. */
export function executableBuild(execPath: string = process.execPath): ExecutableBuild | undefined {
  let buildDir: string;
  try {
    buildDir = path.dirname(realpathSync(execPath));
  } catch {
    return undefined;
  }
  const directory = ContainedDirectory.openExisting(path.dirname(buildDir), [path.basename(buildDir)]);
  if (!directory) return undefined;
  try {
    const raw = directory.readFile(BUILD_METADATA_FILE, METADATA_READ_BYTES);
    if (!raw) return undefined;
    const identity = decodeBuildMetadata(raw.toString("utf-8"));
    assertInstallLocation(identity, buildDir);
    return { buildDir, version: identity.version.canonical, buildId: identity.buildId };
  } catch (error) {
    log.debug("running build could not be identified", { buildDir, error: errorMessage(error) });
    return undefined;
  } finally {
    directory.close();
  }
}

/** The id of `build` when it sits in the versions home of the account at
 *  `userDataRoot`, resolved physically because an account root can itself be
 *  reached through a link. */
export function accountBuildId(build: Pick<ExecutableBuild, "buildDir" | "buildId">, userDataRoot: string): string | undefined {
  try {
    return path.dirname(path.dirname(build.buildDir)) === realpathSync(versionsDir(userDataRoot)) ? build.buildId : undefined;
  } catch {
    return undefined;
  }
}

/** The installed build of the account at `userDataRoot` that this process
 *  is executing, or nothing when it is not running one. */
export function ownBuild(userDataRoot: string, execPath: string = process.execPath): BuildRef | undefined {
  const build = executableBuild(execPath);
  if (build === undefined || accountBuildId(build, userDataRoot) === undefined) return undefined;
  return { version: build.version, buildId: build.buildId };
}

export function ownBuildId(userDataRoot: string, execPath: string = process.execPath): string | undefined {
  return ownBuild(userDataRoot, execPath)?.buildId;
}

/** Declare the build this process is executing for as long as it runs, and
 *  answer how to withdraw the declaration.
 *
 *  A process that is not running an installed build declares nothing, and the
 *  disposer of any registration is idempotent: a withdrawal is one unlink and
 *  an absent entry is already withdrawn. Registration never fails the caller,
 *  because a build that cannot be declared costs disk and a launch that
 *  cannot proceed costs the user their session. */
export function registerLiveBuild(userDataRoot: string, execPath: string = process.execPath): () => void {
  const buildId = ownBuildId(userDataRoot, execPath);
  if (!buildId) return () => {};
  const name = `${buildId}.${process.pid}`;

  try {
    const registry = openRegistry(userDataRoot);
    try {
      // An entry this pid already holds is this same declaration, so losing
      // the create states nothing new and withdraws the same way.
      registry.createExclusive(name, "");
    } finally {
      registry.close();
    }
  } catch (error) {
    log.debug("live build registration skipped", { name, error: errorMessage(error) });
    return () => {};
  }

  return () => {
    try {
      const registry = openRegistry(userDataRoot);
      try {
        registry.removeFile(name);
      } finally {
        registry.close();
      }
    } catch (error) {
      log.debug("live build withdrawal skipped", { name, error: errorMessage(error) });
    }
  };
}

/** The builds a live process is executing.
 *
 *  Every registration whose process is gone is removed on the way, which is
 *  the whole of the registry's own upkeep: the directory stays the size of the
 *  running Flywheels. An entry that is not a registration this module wrote is
 *  left exactly as it is, because removing what this module did not write is
 *  how a collector destroys something it did not understand. */
export function liveBuildIds(userDataRoot: string): ReadonlySet<string> {
  const live = new Set<string>();
  const registry = openExistingRegistry(userDataRoot);
  if (!registry) return live;
  try {
    for (const name of registry.entryNames()) {
      const [, buildId, pid] = REGISTRATION.exec(name) ?? [];
      if (!buildId || !pid) {
        log.debug("live build registry holds an entry it did not write", { name });
        continue;
      }
      if (isProcessAlive(Number(pid))) live.add(buildId);
      else registry.removeFile(name);
    }
  } catch (error) {
    log.debug("live build registry could not be read", { error: errorMessage(error) });
  } finally {
    registry.close();
  }
  return live;
}

/** The registry directory, held open below the account data root.
 *
 *  The walk mirrors the update authority's: the account data root is one
 *  component of the account home that may not be a link, because Flywheel owns
 *  that name, and only the directories below it are tightened, so this module
 *  claims no mode over the account root itself. */
function openRegistry(userDataRoot: string): ContainedDirectory {
  const names = registryNames(userDataRoot);
  const accountData = ContainedDirectory.open(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
  try {
    const updateDir = accountData.openChild(names.update, { privateDirectories: true });
    try {
      return updateDir.openChild(names.live, { privateDirectories: true });
    } finally {
      updateDir.close();
    }
  } finally {
    accountData.close();
  }
}

/** The registry when it is already there. A registry that was never written to
 *  holds no live build, and creating one to read it would be the collector
 *  writing to answer its own question. */
function openExistingRegistry(userDataRoot: string): ContainedDirectory | undefined {
  const names = registryNames(userDataRoot);
  const accountData = ContainedDirectory.openExisting(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
  if (!accountData) return undefined;
  try {
    const updateDir = accountData.openExistingChild(names.update);
    if (!updateDir) return undefined;
    try {
      return updateDir.openExistingChild(names.live);
    } finally {
      updateDir.close();
    }
  } finally {
    accountData.close();
  }
}

function registryNames(userDataRoot: string) {
  const registryDir = liveBuildsDir(userDataRoot);
  return { update: path.basename(path.dirname(registryDir)), live: path.basename(registryDir) };
}
