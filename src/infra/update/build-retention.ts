/** Collecting the build trees and staging remainders of an account.
 *
 *  Every installed build is an immutable directory that nothing overwrites, so
 *  an account accumulates one tree per update forever unless something removes
 *  the ones nothing can still be using (ARCH-DISTRIBUTION-026). This is that something, and
 *  it is the only code that removes an installed build.
 *
 *  A build is kept for any one of five independent reasons, and removed only
 *  when none of them holds:
 *
 *  - `current` resolves to it. That is the build every launch runs.
 *  - This process is executing it.
 *  - A live registration names it, which is the proof that some other process
 *    is executing it (`live-builds.ts`).
 *  - The account's start record names it as the last build proved here
 *    (`service-start-record.ts`). That is the build a rollback returns to
 *    when a newer build cannot start or cannot open any project, so it is
 *    kept however many builds were installed since.
 *  - It is one of the newest few, which is the retention band. A process
 *    launched by a build older than the registry cannot register itself, so it
 *    cannot be proved live at all; the band is what covers that transition,
 *    and it becomes redundant once every running Flywheel registers.
 *
 *  Modification time orders the band and nothing else. It is not evidence that
 *  a tree is unused - a sleeping process outlives any freshness window - so it
 *  never decides whether a build is collectible, only which collectible builds
 *  are recent enough to keep anyway.
 *
 *  The account's own state decides nothing on its own either. When `current`
 *  cannot be read, the build that must be kept is unknown, so no build is
 *  removed at all: a collector that cannot tell what is active is a collector
 *  that removes the account's only working Flywheel.
 *
 *  Reading `current` once is only sound because this collector holds the
 *  account update lease while it works. An activation moves `current` under
 *  that same authority, so a lease this sweep holds is what stops `current`
 *  being pointed at a tree the sweep already decided to remove, which would
 *  leave the account with no runnable build at all. The lease is taken here
 *  rather than inherited, because the commit that ends an update run concludes
 *  the lease that run held.
 *
 *  A staging remainder is removed on a different proof: both producers name the
 *  process that created them, so a pid no process answers to is what makes one
 *  abandoned. The lease cannot answer that question, because a first install
 *  from an archive stages before it claims one.
 *
 *  A build tree is renamed into that same remainder namespace before it is
 *  unlinked. A recursive unlink is not atomic, so a process killed in the
 *  middle of one would otherwise leave a directory at a build id's name holding
 *  no metadata: not a build any reader admits, not a remainder any collector
 *  recognizes, and therefore disk no later sweep could ever reclaim.
 *
 *  Windows lets a running build's directory be renamed but not deleted, and
 *  the only proof that nothing runs a build there is that its executable can
 *  be deleted. So on Windows the renamed tree's executable is deleted before
 *  anything else in it, and a refusal puts the tree back under its build id,
 *  whole, for the next collection. A build is therefore either whole under
 *  its id or on its way out under a remainder name, and never a tree that
 *  states a build and holds no executable. A remainder is removed on the same
 *  proof, so one a restore could not put back is not emptied under a process
 *  that still runs it.
 *
 *  The same collection removes the private name an interrupted activation
 *  left beside `current`, once its writer is gone.
 *
 *  Every removal is one operation on a held descriptor, so no name under the
 *  versions root can redirect this sweep out of it, and nothing above the
 *  versions root is ever opened for removal. */

import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { ContainedDirectory } from "../descriptor-directory.js";
import { errorMessage } from "../error-message.js";
import { Log } from "../log.js";
import { updateAuthorityDbFile, versionsDir } from "../paths.js";
import { isProcessAlive } from "../process-liveness.js";
import { coalesceRepeats } from "../repeat-coalescer.js";
import { activeBuildDir, PENDING_ACTIVATION } from "./active-build.js";
import { BUILD_METADATA_FILE, buildExecutable } from "./build-identity.js";
import { liveBuildIds, ownBuildId } from "./live-builds.js";
import { provedBuild } from "./service-start-record.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "./update-authority.js";

const log = Log.create({ service: "build-retention" });

/** How many collectible builds are kept anyway, newest first. Two covers the
 *  build a pre-registry process is most likely running: the one that was
 *  active before the last activation, and the one before that. */
const KEEP_NEWEST_BUILDS = 2;

/** How long the collection lease runs, and the ceiling that keeps one sweep
 *  inside it. A sweep that outran its lease would lose the ordering against an
 *  activation, which is the only reason the lease is taken, so the bound is
 *  structural rather than left to the caller: a backlog larger than this is
 *  taken by the runs that follow. */
const COLLECTION_LEASE_MS = 60_000;
const LEASE_SAFE_REMOVAL_LIMIT = 256;

/** A staging directory, wherever an attempt left one, and the process that
 *  created it: `.update.<pid>.<hex>` from the transfer at the versions root, and
 *  `.staging.<pid>.<hex>` from the placement inside a version directory. A name
 *  that states no pid names no owner, so it cannot be proved abandoned. */
const REMAINDER = /^\.(?:update|staging)\.([1-9][0-9]*)\./;

export interface BuildCollectionRequest {
  /** Startup-selected account data root every installed build lives under. */
  readonly userDataRoot: string;
  /** Withdraws the sweep. It is read before each removal, so a withdrawn
   *  sweep stops between two trees and leaves the rest to a later run. */
  readonly signal?: AbortSignal;
  /** This process's executable, for a test that runs one. */
  readonly execPath?: string;
  /** The platform the installed builds are for, which is this process's. */
  readonly platform?: string;
}

export interface BuildCollection {
  /** `<version>/<build id>` of every build tree removed. */
  readonly removedBuilds: readonly string[];
  /** Every staging remainder removed, named where it was found. */
  readonly removedRemainders: readonly string[];
  /** Builds still installed after this collection. */
  readonly keptBuilds: number;
  /** The removal bound or a withdrawal ended this sweep before it ran out of
   *  collectible builds, so the account still holds trees a later sweep will
   *  take. */
  readonly truncated: boolean;
}

const NOTHING: BuildCollection = { removedBuilds: [], removedRemainders: [], keptBuilds: 0, truncated: false };

/** Collect what nothing can still be using. Each removal is synchronous and
 *  holds its thread, so the sweep yields one task between removals: that is
 *  where a withdrawal, which reaches a Worker as a message, can stop it. */
export async function collectBuildTrees(request: BuildCollectionRequest): Promise<BuildCollection> {
  let authority;
  try {
    authority = createUpdateAuthority({ dbFile: updateAuthorityDbFile(request.userDataRoot, UPDATE_PROTOCOL_VERSION) });
  } catch (error) {
    // An authority this binary cannot coordinate through is a reason to collect
    // nothing, never a reason to collect anyway.
    log.debug("build collection could not reach the update authority", { error: errorMessage(error) });
    return NOTHING;
  }
  try {
    // Freshness has nothing to do with collection, so the claim ignores it and
    // asks only whether another process owns the account's builds right now.
    const claim = authority.claim({ nowMs: Date.now(), freshForMs: 0, leaseMs: COLLECTION_LEASE_MS });
    if (claim.kind !== "won") {
      log.debug("build collection skipped: another process owns the account update lease");
      return NOTHING;
    }
    const removedActivations = removeAbandonedActivations(request.userDataRoot);
    const versionsRoot = openVersionsRoot(request.userDataRoot);
    if (!versionsRoot) return { ...NOTHING, removedRemainders: removedActivations };
    try {
      const collected = await sweep(versionsRoot, request);
      return { ...collected, removedRemainders: [...removedActivations, ...collected.removedRemainders] };
    } finally {
      versionsRoot.close();
    }
  } catch (error) {
    log.warn("build collection stopped early", { error: errorMessage(error) });
    return NOTHING;
  } finally {
    // Disposal hands the lease back, so the next claimant never waits it out.
    authority.dispose();
  }
}

/** Whether a collection would find anything to remove: an abandoned staging
 *  remainder, or a build that no retention reason keeps.
 *
 *  This is the cheap half of a collection, and it removes no build and no
 *  remainder: it reads the versions root, each version directory, and each
 *  build's metadata stamp, and asks the registry which builds are live. It
 *  takes no lease, so its answer is only a reason to start the collection,
 *  which plans again under its lease before it removes anything. A caller
 *  that pays for a thread per collection runs this first and starts nothing
 *  when it answers false. */
export function buildCollectionPending(request: Pick<BuildCollectionRequest, "userDataRoot" | "execPath" | "platform">): boolean {
  try {
    if (abandonedActivations(request.userDataRoot).length > 0) return true;
    const versionsRoot = openVersionsRoot(request.userDataRoot);
    if (!versionsRoot) return false;
    try {
      const plan = planCollection(versionsRoot, request);
      return plan.remainders.length > 0 || plan.collectible.length > 0;
    } finally {
      versionsRoot.close();
    }
  } catch (error) {
    log.debug("build collection survey could not read the versions root", { error: errorMessage(error) });
    return false;
  }
}

/** A staging remainder, named by the version directory it is in, or by no
 *  version when it sits at the versions root. */
interface Remainder {
  readonly version?: string;
  readonly name: string;
}

/** What one collection would remove, decided before it removes anything. */
interface CollectionPlan {
  readonly remainders: readonly Remainder[];
  /** Every build the survey admitted. */
  readonly installed: readonly InstalledBuild[];
  /** The build `current` resolves to, or nothing when it cannot be read. */
  readonly active: string | undefined;
  /** The builds no retention reason keeps, newest first. Empty when the
   *  active build cannot be read, because then no build may be removed. */
  readonly collectible: readonly InstalledBuild[];
}

function planCollection(versionsRoot: ContainedDirectory, request: Pick<BuildCollectionRequest, "userDataRoot" | "execPath" | "platform">): CollectionPlan {
  const remainders: Remainder[] = versionsRoot.entryNames().filter(isAbandonedRemainder).map((name) => ({ name }));
  const installed = surveyBuilds(versionsRoot, remainders);
  const active = activeBuildId(request.userDataRoot);
  if (!active) return { remainders, installed, active, collectible: [] };
  const live = liveBuildIds(request.userDataRoot);
  const own = ownBuildId(request.userDataRoot, request.execPath);
  const proved = provedBuild(request.userDataRoot)?.buildId;
  const collectible = installed
    .filter((build) => build.buildId !== active && build.buildId !== own && build.buildId !== proved && !live.has(build.buildId))
    // Newest first, so the retention band keeps the recent ones.
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .slice(KEEP_NEWEST_BUILDS);
  return { remainders, installed, active, collectible };
}

async function sweep(versionsRoot: ContainedDirectory, request: BuildCollectionRequest): Promise<BuildCollection> {
  const withdrawn = (): boolean => request.signal?.aborted === true;
  const mayRemove = async (): Promise<boolean> => {
    await nextTask();
    return !withdrawn();
  };
  const plan = planCollection(versionsRoot, request);
  const platform = request.platform ?? process.platform;
  const removedRemainders = await removeRemainders(versionsRoot, plan.remainders, { mayRemove, platform });
  if (!plan.active && plan.installed.length > 0) {
    // Not an error worth failing a run over, and not a licence to remove
    // anything either: an account whose current build cannot be read keeps
    // every build it has.
    log.warn("every build kept: the account's current build could not be read", { installed: plan.installed.length });
  }

  const bounded = plan.collectible.slice(0, LEASE_SAFE_REMOVAL_LIMIT);
  // One record for the first build a sweep keeps because it still runs, and
  // a count of the rest.
  const stillRunning = coalesceRepeats<{ readonly buildId: string }>({
    windowMs: COLLECTION_LEASE_MS,
    first: (_key, kept) => { log.info("build collection kept a build whose executable still runs", kept); },
    repeated: (_key, repeats) => { log.info("build collection kept more builds whose executables still run", { count: repeats.count }); },
  });
  let removedBuilds: readonly string[];
  try {
    removedBuilds = await removeBuilds(versionsRoot, bounded, { mayRemove, platform, stillRuns: (buildId) => { stillRunning.observe("still-runs", { buildId }); } });
  } finally {
    stillRunning.end();
  }
  const stoppedEarly = plan.collectible.length > bounded.length || (withdrawn() && removedBuilds.length < bounded.length);
  return { removedBuilds, removedRemainders, keptBuilds: plan.installed.length - removedBuilds.length, truncated: stoppedEarly };
}

interface InstalledBuild {
  readonly version: string;
  readonly buildId: string;
  /** Modification time of the build's own metadata file, which orders the
   *  retention band and proves nothing about use. */
  readonly modifiedAtMs: number;
}

/** Every installed build under the versions root, noting the placement
 *  remainders found on the way.
 *
 *  A directory that states no build metadata is not a build this collector
 *  understands, so it is left exactly as it is and reported. Placement is a
 *  rename out of a staging directory, so a partial tree at a build id's name
 *  is not something this account's installer can produce. */
function surveyBuilds(versionsRoot: ContainedDirectory, remainders: Remainder[]): readonly InstalledBuild[] {
  const installed: InstalledBuild[] = [];
  for (const version of versionsRoot.directoryEntryNames()) {
    if (version.startsWith(".")) continue;
    const versionDir = openDirectory(versionsRoot, version);
    if (!versionDir) continue;
    try {
      for (const entry of versionDir.directoryEntryNames()) {
        if (isAbandonedRemainder(entry)) {
          remainders.push({ version, name: entry });
          continue;
        }
        if (entry.startsWith(".")) continue;
        const build = admitBuild(versionDir, version, entry);
        if (build) installed.push(build);
      }
    } finally {
      versionDir.close();
    }
  }
  return installed;
}

/** Remove the remainders the plan found, each one where it was found, and
 *  report each one gone as `<version>/<name>`, or its bare name at the
 *  versions root. */
async function removeRemainders(versionsRoot: ContainedDirectory, remainders: readonly Remainder[], removal: { readonly mayRemove: () => Promise<boolean>; readonly platform: string }): Promise<string[]> {
  const removed: string[] = [];
  for (const remainder of remainders) {
    if (!await removal.mayRemove()) break;
    if (remainder.version === undefined) {
      if (remove(versionsRoot, remainder.name)) removed.push(remainder.name);
      continue;
    }
    const versionDir = openDirectory(versionsRoot, remainder.version);
    if (!versionDir) continue;
    try {
      // A remainder inside a version directory can be a build a restore
      // could not put back, so on Windows it goes only once nothing runs it.
      if (removal.platform === "win32" && stillRuns(versionDir, remainder.name)) continue;
      if (remove(versionDir, remainder.name)) removed.push(`${remainder.version}/${remainder.name}`);
    } finally {
      versionDir.close();
    }
  }
  return removed;
}

/** Whether a staging remainder's creator is gone. */
function isAbandonedRemainder(entry: string): boolean {
  const [, pid] = REMAINDER.exec(entry) ?? [];
  return pid !== undefined && !isProcessAlive(Number(pid));
}

function admitBuild(versionDir: ContainedDirectory, version: string, buildId: string): InstalledBuild | undefined {
  const buildDir = openDirectory(versionDir, buildId);
  if (!buildDir) return undefined;
  try {
    return { version, buildId, modifiedAtMs: buildDir.regularFileModifiedAt(BUILD_METADATA_FILE) };
  } catch (error) {
    log.debug("versions root holds a directory that states no build", { version, buildId, error: errorMessage(error) });
    return undefined;
  } finally {
    buildDir.close();
  }
}

/** One child directory, or nothing when it cannot be opened as one. An entry a
 *  planted link or a permission makes unopenable stops that entry rather than
 *  the sweep: a collector one bad name switches off is a collector that never
 *  runs again. */
function openDirectory(parent: ContainedDirectory, name: string): ContainedDirectory | undefined {
  try {
    return parent.openExistingChild(name);
  } catch (error) {
    log.debug("versions root holds an entry this collector cannot open as a directory", { name, error: errorMessage(error) });
    return undefined;
  }
}

/** Take one build out of the installed set, through a name that says it is
 *  going. The rename is the point of no return: once it lands, the build is no
 *  longer installed whatever happens to the unlink, and what an interruption
 *  leaves states this process's pid, so the next sweep after this process ends
 *  takes it. On Windows a tree whose executable still runs is put back under
 *  its build id, whole, before anything else in it is touched. */
function retire(versionDir: ContainedDirectory, buildId: string, removal: BuildRemoval): boolean {
  const retiring = `.staging.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    versionDir.renameInto(buildId, versionDir, retiring);
  } catch (error) {
    log.warn("build collection could not retire a build tree", { buildId, error: errorMessage(error) });
    return false;
  }
  if (removal.platform === "win32" && stillRuns(versionDir, retiring)) {
    removal.stillRuns(buildId);
    try {
      versionDir.renameInto(retiring, versionDir, buildId);
    } catch (error) {
      log.warn("a running build could not be put back under its build id; it stays under a remainder name until nothing runs it", { buildId, error: errorMessage(error) });
    }
    return false;
  }
  remove(versionDir, retiring);
  return true;
}

/** Whether a Windows tree is still executing, answered by deleting its
 *  executable, which Windows refuses while a process runs it. A tree that
 *  cannot be opened is kept as one that may run. */
function stillRuns(parent: ContainedDirectory, name: string): boolean {
  const tree = openDirectory(parent, name);
  if (!tree) return true;
  try {
    tree.removeFile(buildExecutable("win32"));
    return false;
  } catch (error) {
    log.debug("a Windows build's executable refused deletion", { name, error: errorMessage(error) });
    return true;
  } finally {
    tree.close();
  }
}

/** Remove one entry and everything below it, and report whether it is gone. A
 *  removal that fails is this entry's problem and not the sweep's, for the same
 *  reason. */
function remove(parent: ContainedDirectory, name: string): boolean {
  try {
    parent.removeTree(name);
    return true;
  } catch (error) {
    log.warn("build collection could not remove an entry", { name, error: errorMessage(error) });
    return false;
  }
}

/** Remove the trees, one version directory at a time, and take a version
 *  directory that now holds nothing with them. */
/** How one sweep removes builds: its withdrawal point, the builds' platform,
 *  and where a build kept because it still runs is reported. */
interface BuildRemoval {
  readonly mayRemove: () => Promise<boolean>;
  readonly platform: string;
  readonly stillRuns: (buildId: string) => void;
}

async function removeBuilds(versionsRoot: ContainedDirectory, collectible: readonly InstalledBuild[], removal: BuildRemoval): Promise<readonly string[]> {
  const byVersion = new Map<string, string[]>();
  for (const build of collectible) {
    const held = byVersion.get(build.version) ?? [];
    held.push(build.buildId);
    byVersion.set(build.version, held);
  }

  const removed: string[] = [];
  for (const [version, buildIds] of byVersion) {
    const versionDir = openDirectory(versionsRoot, version);
    if (!versionDir) continue;
    try {
      for (const buildId of buildIds) {
        if (!await removal.mayRemove()) break;
        if (retire(versionDir, buildId, removal)) removed.push(`${version}/${buildId}`);
      }
    } finally {
      versionDir.close();
    }
    // A version that holds no build is a version of nothing. A directory that
    // still holds one is refused rather than emptied.
    versionsRoot.removeEmptyChild(version);
  }
  return removed;
}

/** The build `current` names, or nothing when it is absent, broken, or
 *  pointed anywhere but at an installed build. Every one of those means the
 *  active build is unknown, which is the same answer. */
function activeBuildId(userDataRoot: string): string | undefined {
  const active = activeBuildDir(userDataRoot);
  return active === undefined ? undefined : path.basename(active);
}

/** One whole task, so a message queued behind the current task is
 *  delivered before this resolves. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** The private names an interrupted activation left beside `current`, whose
 *  writer is gone. */
function abandonedActivations(userDataRoot: string): readonly string[] {
  const accountData = ContainedDirectory.openExisting(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
  if (!accountData) return [];
  try {
    return accountData.entryNames().filter((name) => {
      const [, writer] = PENDING_ACTIVATION.exec(name) ?? [];
      return writer !== undefined && !isProcessAlive(Number(writer));
    });
  } finally {
    accountData.close();
  }
}

function removeAbandonedActivations(userDataRoot: string): readonly string[] {
  const abandoned = abandonedActivations(userDataRoot);
  if (abandoned.length === 0) return [];
  const accountData = ContainedDirectory.openExisting(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
  if (!accountData) return [];
  try {
    return abandoned.filter((name) => remove(accountData, name));
  } finally {
    accountData.close();
  }
}

function openVersionsRoot(userDataRoot: string): ContainedDirectory | undefined {
  const accountData = ContainedDirectory.openExisting(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
  if (!accountData) return undefined;
  try {
    return accountData.openExistingChild(path.basename(versionsDir(userDataRoot)));
  } finally {
    accountData.close();
  }
}
