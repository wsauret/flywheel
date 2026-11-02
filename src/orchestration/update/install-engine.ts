/** The one installation of a Flywheel build, on every platform.
 *
 *  Every install path reaches this engine: the bootstrap scripts, the archive
 *  installers, and the updater. Shell and PowerShell code locate an extracted
 *  payload and hand it over; they own no layout, no staging placement, no
 *  macOS command, and never the activation (ARCH-DISTRIBUTION-014). What differs between
 *  platforms is two primitives: the activation, a symlink on macOS and Linux
 *  and a pointer file on Windows (`active-build.ts`), and the launcher on
 *  PATH, a POSIX `sh` wrapper or the Windows launcher executable
 *  (`windows-install.ts`).
 *
 *  What the engine promises:
 *
 *  - A physical build tree is immutable. The payload is validated, copied into
 *    a private staging directory of this account, validated again by its own
 *    identity, made durable, and only then renamed to its final name. Nothing
 *    is ever written over a build a running process may be reading.
 *  - A copy is proved, never assumed. `build.json` names the build: its
 *    version and its build id are the two components of its directory. The
 *    engine digests the payload it was handed, records it when that digest is
 *    not the stated build id, and requires the staged copy, the placed tree,
 *    and the tree it activates to each digest the same, so nothing changes
 *    between the proved payload and the build that runs. A repeated build id
 *    is an idempotent no-op, and a same-version different build id is a new
 *    sibling.
 *  - A build runs before it is placed or activated. The staged executable, or
 *    the executable of a build already in place, is asked its version from
 *    its own directory, once more with a longer bound when the first run does
 *    not answer, and only a build that answers lets the build take its name
 *    or `current` move. A digest proves the bytes; only a run
 *    proves that this host can execute them.
 *  - The payload is read, not judged. An updater runs this engine on the
 *    payload of a later release, so the engine asks of a payload only what it
 *    needs to place and run it: `build.json` with a version and a build id
 *    that can each be a directory name, and an executable. Every other rule
 *    about a release is the release side's (ARCH-DISTRIBUTION-008).
 *  - Publication happens under the two account-global authorities in one fixed
 *    order: config ownership first, then the fenced update authority
 *    (ARCH-DISTRIBUTION-020, ARCH-RUNTIME-066). The `current` rename happens inside the authority transaction,
 *    so an activation the database records is one the filesystem already made
 *    true.
 *  - Activation comes before the launcher is touched. Every refusal and every
 *    crash window therefore falls where the old command is still whole: the
 *    launcher is replaced, and a previous flat installation converted, only
 *    after `current` already names the new build.
 *  - Nothing this engine did not write is removed. The POSIX wrapper is
 *    replaced only over an absent entry or one proved byte for byte to be
 *    Flywheel's, and the Windows launcher only under an install record in a
 *    shape this engine writes. A flat layout of an earlier installer is
 *    converted only when the wrapper or the record vouching for it is exactly
 *    what that installer wrote. Any other file, directory, link, or extra hard
 *    link blocks installation instead of being deleted. */

import { isExecutableFile } from "../../infra/executable-file.js";
import { cpSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { Schema } from "effect";
import { ContainedDirectory } from "../../infra/descriptor-directory.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import type { OwnedCommandRunner } from "../../infra/owned-command.js";
import { listProcesses, type ProcessRow } from "../../infra/process-table.js";
import { CURRENT_BUILD_LINK, updateAuthorityDbFile, versionsDir } from "../../infra/paths.js";
import { ActivationError, openActiveBuild, publishActivation } from "../../infra/update/active-build.js";
import { assertInstallLocation, BUILD_METADATA_FILE, buildExecutable, type BuildIdentity, buildInstallDir, type BuildRef, computeBuildId, decodeBuildMetadata, NATIVE_DIR } from "../../infra/update/build-identity.js";
import { launcherName } from "../../infra/update/wrapper-directory.js";
import { isSharingRefusal } from "../../infra/windows-file-replacement.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION, type UpdateAuthority } from "../../infra/update/update-authority.js";
import { compareReleaseVersions } from "../../infra/update/version-order.js";
import { createRuntimeConfigOwner } from "../config/runtime-config-owner.js";
import { provedBuild } from "../../infra/update/service-start-record.js";
import { writeRefusedBuild } from "./refused-build.js";
import { collectWindowsLauncherDirectory, descendsFromFlatBuild, proveWindowsLauncher, publishWindowsLauncher, WINDOWS_LAUNCHERS, type WindowsLauncherOwnership, type WindowsLaunchers } from "./windows-install.js";

/** The fonts directory the flat POSIX installer kept beside its wrapper. */
const FONTS_DIR = "fonts";

/** The name the POSIX wrapper is published under, and the flat entries the
 *  previous POSIX installer owned beside it. */
const WRAPPER_NAME = launcherName("linux");
const LEGACY_ENTRIES = [buildExecutable("linux"), NATIVE_DIR, FONTS_DIR] as const;

/** The exact opening of a wrapper this installer wrote. It is the only proof
 *  that the entry at `flywheel` is Flywheel's to replace, so the match is on
 *  the head of the file and never on the marker appearing somewhere in it: any
 *  file may quote a comment. */
const WRAPPER_MARKER = "# flywheel-owned-wrapper v1";
/** POSIX sh, because a musl Linux such as Alpine installs no bash. */
const WRAPPER_HEADER = `#!/bin/sh\n${WRAPPER_MARKER}\n`;
/** The opening every release before the POSIX launcher wrote. The body
 *  beneath it is the same, so a wrapper that opens this way is still one this
 *  installer wrote, and the next installation replaces it. Remove this after
 *  2027-03-23, when every installation has updated past it. */
const PREVIOUS_WRAPPER_HEADER = `#!/usr/bin/env bash\n${WRAPPER_MARKER}\n`;

/** A wrapper is a few lines of shell. */
const WRAPPER_MAX_BYTES = 8 * 1024;
/** A build's own metadata is read whole: its size is the release's
 *  business. */
const METADATA_READ_BYTES = Number.POSITIVE_INFINITY;

/** How long the installer holds the update lease. Installation is seconds of
 *  copying, and a crashed installer must not lock the account out for longer
 *  than one renewal period. */
const LEASE_MS = 60_000;

/** How long the placed executable may take to answer its version, run by
 *  run. A first run of a new executable can wait on the platform's own checks
 *  of it, such as a macOS signature assessment or a Windows malware scan of a
 *  large binary, so a run that does not answer within 30 s is asked once
 *  more within 120 s, and only a build that answers within neither does not
 *  run here. The refusal removes only this attempt's staging, so the next
 *  check tries again. */
const RUN_PROOF_BOUNDS_MS = [30_000, 120_000] as const;
/** How much of a refused answer is quoted in the refusal. */
const QUOTED_ANSWER_MAX_CHARS = 200;

export interface InstallRequest {
  /** Startup-selected account data root every installed build lives under. */
  readonly userDataRoot: string;
  /** The extracted payload tree: the executable, its assets, and `build.json`. */
  readonly sourceDir: string;
  /** Directory the launcher is published in. This is the only thing
   *  `FLYWHEEL_INSTALL_DIR` selects. */
  readonly wrapperDir: string;
  readonly platform: string;
  /** The release target of the build that runs this installation
   *  (`buildPlatformArch`), which names the build's native directory. */
  readonly platformArch: string;
  /** Every external process this engine runs. Fixed executable, fixed argv. */
  readonly runCommand: OwnedCommandRunner;
  /** The fenced authority the caller already holds, when the caller is the
   *  update coordinator: activation commits under that fence instead of
   *  claiming a second lease, which the caller's own lease would refuse.
   *  Absent for an installation nobody is coordinating, such as the first
   *  install from an archive, which is the user asking directly. */
  readonly activation?: {
    readonly authority: UpdateAuthority;
    readonly fence: number;
    /** Revalidate through the account's one auto-install authority while config
     * ownership remains held through activation. */
    readonly revalidate: <T>(decide: (policy: { readonly effective: boolean }) => T) => Promise<T>;
  };
  readonly nowMs?: () => number;
  /** The host's process table, read only to prove that a flat Windows
   *  installation is being converted by its own updater. */
  readonly processTable?: () => Promise<readonly ProcessRow[] | undefined>;
}

export interface InstallOutcome {
  /** `placed` wrote a new immutable build tree; `present` found this exact
   *  build already installed and wrote none. */
  readonly kind: "placed" | "present";
  readonly version: string;
  readonly buildId: string;
  readonly buildDir: string;
  readonly wrapperPath: string;
  /** What the installed command's `serve install` printed for the person,
   *  such as the Linux notice that the service stops at logout. An update's
   *  refresh prints nothing. */
  readonly serviceOutput: string;
}

/** A coordinated update lost activation permission while it was staged. */
export class InstallRevokedError extends Schema.TaggedErrorClass<InstallRevokedError>()("InstallRevoked", {
  message: Schema.String,
}) {}

/** Installation refused. The account is left exactly as it was found. */
class InstallError extends Schema.TaggedErrorClass<InstallError>()("Install", {
  message: Schema.String,
  reason: Schema.String,
}) {}

class InstallServiceError extends Error {
  readonly _tag = "InstallServiceError" as const
}

function refuse(reason: string): never {
  throw new InstallError({ message: `Flywheel was not installed: ${reason}`, reason });
}

const log = Log.create({ service: "install" });

export async function installBuild(request: InstallRequest): Promise<InstallOutcome> {
  const { identity, digest } = admitPayload(request.sourceDir, request.platform);
  const buildDir = buildInstallDir(request.userDataRoot, identity);

  const accountRoot = ContainedDirectory.open(path.dirname(request.userDataRoot), [path.basename(request.userDataRoot)], { privateDirectories: true });
  try {
    // Refused before anything is placed: an installation that cannot publish
    // its launcher must not leave a new build tree and a moved `current` behind.
    const launcher = proveLauncher(request);
    // A flat updater installs by running the bootstrap installer while it
    // holds the account lease, and names no requester. Its conversion is the
    // one installation whose lease another process holds, and it is an
    // update, so it creates no registration a person turned off
    // (PI-REMOTE-009). The process table proves the flat build started it.
    // Remove after 2026-12-28 with the flat conversion.
    const flatConversion = launcher.platform === "win32"
      && (launcher.ownership.kind === "flat"
        || (launcher.ownership.kind === "launcher" && launcher.ownership.retiring.length > 0 && launcher.ownership.missing.includes("service")));
    const flatUpdater = flatConversion ? descendsFromFlatBuild(request.wrapperDir, await (request.processTable ?? listProcesses)()) : false;

    const versionsRoot = accountRoot.openChild(path.basename(versionsDir(request.userDataRoot)), { privateDirectories: true });
    let kind: InstallOutcome["kind"];
    try {
      const versionDir = versionsRoot.openChild(identity.version.canonical, { privateDirectories: true });
      try {
        kind = await place(versionDir, { identity, digest, buildDir, request });
      } finally {
        versionDir.close();
      }
    } finally {
      versionsRoot.close();
    }

    validateInstalledBuild(buildDir, { identity, digest }, request.platform);
    let underFlatUpdater: boolean;
    try {
      underFlatUpdater = await activate(accountRoot, { identity, request, flatUpdater });
    } catch (error) {
      // A refused activation is a decision a person can ask about: the
      // account keeps the build it had.
      log.warn("build activation refused", { version: identity.version.canonical, buildId: identity.buildId, requester: request.activation ? "update" : "install", reason: errorMessage(error) });
      throw error;
    }
    await publishLauncher(request, { launcher, buildDir });
    const wrapperPath = path.join(request.wrapperDir, launcherName(request.platform));
    // An update states itself, so the service boundary refreshes a
    // registration that exists and creates none: a person's Process
    // initiation Off holds through every update (PI-REMOTE-009). An
    // installation nobody coordinates is one a person asked for, and it
    // creates a missing registration.
    const update = request.activation !== undefined || underFlatUpdater;
    const service = await request.runCommand([wrapperPath, "serve", "install", ...(update ? ["--update"] : [])]);
    if (service.exitCode !== 0) {
      const detail = (service.stderr || service.stdout).trim();
      throw new InstallServiceError(`Flywheel was installed, but its account service could not be registered and started (exit ${service.exitCode ?? "signal"})${detail ? `: ${detail}` : ""}`);
    }
    return { kind, version: identity.version.canonical, buildId: identity.buildId, buildDir, wrapperPath, serviceOutput: service.stdout.trim() };
  } finally {
    accountRoot.close();
  }
}

/** What a payload states about itself, and the digest every copy of it must
 *  keep. */
interface AdmittedPayload {
  readonly identity: BuildIdentity;
  readonly digest: string;
}

/** The executable is what the run proof starts, so a payload with none is no
 *  build. A tree that does not digest to the build id `build.json` states is
 *  still the payload of a release whose own digest the transfer proved: this
 *  client may read an entry another way than the release side does, such as
 *  one it leaves out, so the difference is recorded and the build is
 *  installed under the id the release states. Its run still proves it. */
function admitPayload(sourceDir: string, platform: string): AdmittedPayload {
  const identity = readBuildMetadata(sourceDir);
  requireExecutable(path.join(sourceDir, buildExecutable(platform)), platform);
  const digest = digestOf(sourceDir, "the payload", platform);
  if (digest !== identity.buildId) log.info("the payload does not digest to the build id its build.json states", { stated: identity.buildId, computed: digest });
  return { identity, digest };
}

function readBuildMetadata(dir: string): BuildIdentity {
  const directory = ContainedDirectory.openExisting(path.dirname(dir), [path.basename(dir)]);
  if (!directory) refuse(`there is no build at ${JSON.stringify(dir)}`);
  try {
    const raw = directory.readFile(BUILD_METADATA_FILE, METADATA_READ_BYTES);
    if (!raw) refuse(`the build at ${JSON.stringify(dir)} states no ${BUILD_METADATA_FILE}`);
    return decodeBuildMetadata(raw.toString("utf-8"));
  } catch (error) {
    if (error instanceof InstallError) throw error;
    refuse(`the build at ${JSON.stringify(dir)} does not describe itself: ${errorMessage(error)}`);
  } finally {
    directory.close();
  }
}

function digestOf(dir: string, subject: string, platform: string): string {
  try {
    return computeBuildId(dir, platform);
  } catch (error) {
    refuse(`${subject} at ${JSON.stringify(dir)} cannot be digested: ${errorMessage(error)}`);
  }
}

/** Refuse a copy of the payload that is not the payload. */
function requireDigest(dir: string, digest: string, subject: string, platform: string): void {
  const computed = digestOf(dir, subject, platform);
  if (computed !== digest) refuse(`${subject} at ${JSON.stringify(dir)} digests to ${computed}, not the ${digest} of the payload it was copied from`);
}

/** The build's own platform decides what "executable" means, not the platform
 *  this process runs on: the engine installs the build the request names. */
function requireExecutable(filePath: string, platform: string): void {
  const stats = statOrRefuse(filePath);
  if (!stats.isFile()) refuse(`${JSON.stringify(filePath)} is not a regular file`);
  if (!isExecutableFile(filePath, stats, platform)) refuse(`${JSON.stringify(filePath)} is not executable`);
}

function statOrRefuse(target: string): Stats {
  try {
    return statSync(target);
  } catch {
    refuse(`the build is missing ${JSON.stringify(target)}`);
  }
}

interface PlacementContext {
  readonly identity: BuildIdentity;
  /** The digest of the admitted payload. */
  readonly digest: string;
  readonly buildDir: string;
  readonly request: InstallRequest;
}

/** Put this build in its one physical place, or prove it is already there,
 *  and in both cases prove that it runs on this host. */
async function place(versionDir: ContainedDirectory, context: PlacementContext): Promise<InstallOutcome["kind"]> {
  const { identity, digest, buildDir, request } = context;
  if (versionDir.hasEntry(identity.buildId)) {
    requireDigest(buildDir, digest, "the installed build", request.platform);
    // Something else placed it, possibly an installer that predates the run
    // proof, so it runs here before it can become current.
    await proveBuildRuns(buildDir, identity, request);
    return "present";
  }

  const staging = `.staging.${process.pid}.${randomBytes(8).toString("hex")}`;
  versionDir.openChild(staging, { privateDirectories: true }).close();
  const stagingDir = path.join(path.dirname(buildDir), staging);
  try {
    // The staging directory is this account's alone (0700, unrepeatable name)
    // and holds nothing yet, so the copy below cannot be redirected into or out
    // of it. What the copy produced is then proved by its own digest.
    cpSync(request.sourceDir, stagingDir, { recursive: true, dereference: false });
    await prepareForMacOS(stagingDir, request);
    requireDigest(stagingDir, digest, "the staged build", request.platform);
    // Before the build takes its name: a build that does not run here is
    // never placed, so it never occupies the collector's retention band.
    await proveBuildRuns(stagingDir, identity, request);
    syncTree(stagingDir);
  } catch (error) {
    versionDir.removeTree(staging);
    if (error instanceof InstallError) throw error;
    refuse(`the build could not be staged for ${JSON.stringify(buildDir)}: ${errorMessage(error)}`);
  }

  try {
    versionDir.renameInto(staging, versionDir, identity.buildId);
    return "placed";
  } catch {
    // Another installer of this same build won the name. A build directory is
    // immutable, so the tree that landed there is this one once it proves its
    // identity; this staging tree is simply surplus.
    versionDir.removeTree(staging);
    requireDigest(buildDir, digest, "the installed build", request.platform);
    return "present";
  }
}

/** Clear the quarantine attribute macOS puts on a downloaded payload. The
 *  signature itself is the build's, applied when the build was produced:
 *  re-signing here would change the executable and with it the identity this
 *  tree is placed under. */
async function prepareForMacOS(stagingDir: string, request: InstallRequest): Promise<void> {
  if (request.platform !== "darwin") return;
  const result = await request.runCommand(["/usr/bin/xattr", "-dr", "com.apple.quarantine", stagingDir], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) refuse(`the macOS quarantine attribute could not be cleared (exit ${String(result.exitCode)})`);
}

/** Make every file and directory of a staged tree durable before it is
 *  published. A rename is atomic, never durable: after a crash the entry can
 *  name a tree whose contents never reached the disk.
 *
 *  Windows flushes a file only through a handle that may write it, and has
 *  no flush of a directory at all, so there the files are flushed and the
 *  directories are left to the file system's own ordering. */
function syncTree(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) syncTree(full);
    else syncPath(full, process.platform === "win32" ? "r+" : "r");
  }
  if (process.platform !== "win32") syncPath(dir, "r");
}

function syncPath(target: string, flags: "r" | "r+"): void {
  const fd = openSync(target, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Move `current` onto this build, under the two account-global authorities in
 *  their fixed order. The rename runs inside the authority transaction, so a
 *  claimant another one superseded flips nothing.
 *
 *  The one activation outside that transaction is a flat Windows conversion
 *  under its own updater's lease. A flat build updates by running the
 *  bootstrap installer while it holds the account lease, and commits the
 *  check itself once the installer exits, so the installation that converts
 *  it meets that live lease and activates under it, as the flat installer
 *  did. `flatUpdater` is whether the flat build started this installation:
 *  a table that proves it did not refuses the lease like any other, and a
 *  table that cannot be read proves nothing either way. Answers whether the
 *  activation ran under that lease. Remove after 2026-12-28 with the flat
 *  conversion. */
async function activate(accountRoot: ContainedDirectory, context: { readonly identity: BuildIdentity; readonly request: InstallRequest; readonly flatUpdater: boolean | undefined }): Promise<boolean> {
  const { identity, request } = context;
  const now = request.nowMs?.() ?? Date.now();
  const build = { version: identity.version.canonical, buildId: identity.buildId };
  let underFlatUpdater = false;

  const activateOwned = (): void => {
    const held = request.activation;
    const active = readActiveBuild(accountRoot, request.userDataRoot);
    // A version this engine cannot order against the active one is a later
    // release: the release side publishes only forward (ARCH-DISTRIBUTION-010).
    const comparison = active ? compareReleaseVersions(identity.version, active.version) ?? 1 : 1;
    if (comparison < 0) {
      refuse(`the active build is version ${active?.version.canonical} build ${active?.buildId}; activation must move forward`);
    }
    const shouldActivate = comparison > 0 || (comparison === 0 && request.activation === undefined && active?.buildId !== identity.buildId);

    const commit = (authority: UpdateAuthority, fence: number): void => {
      const committed = authority.commitActivation({
        fence,
        checkedAtMs: now,
        activate: () => { if (shouldActivate) publishActivation(accountRoot, request.userDataRoot, build); },
      });
      if (!committed) refuse("another Flywheel process took the update lease while this installation was working");
      // The account's build changed, or was proved unchanged: one record either way.
      log.info(shouldActivate ? "build activated" : "build already active; activation unchanged", {
        from: active ? { version: active.version.canonical, buildId: active.buildId } : null,
        to: { version: identity.version.canonical, buildId: identity.buildId },
        requester: held ? "update" : "install",
      });
    };

    if (held) {
      commit(held.authority, held.fence);
      return;
    }
    const authority = createUpdateAuthority({ dbFile: updateAuthorityDbFile(request.userDataRoot, UPDATE_PROTOCOL_VERSION) });
    try {
      const claim = authority.claim({ nowMs: now, freshForMs: 0, leaseMs: LEASE_MS });
      if (claim.kind === "busy" && context.flatUpdater !== false) {
        if (shouldActivate) publishActivation(accountRoot, request.userDataRoot, build);
        underFlatUpdater = true;
        log.info("build activated under the flat Windows updater's lease", { to: build, activated: shouldActivate, provedUpdater: context.flatUpdater === true });
        return;
      }
      if (claim.kind !== "won") refuse("another Flywheel process is updating this account right now");
      commit(authority, claim.fence);
    } finally {
      authority.dispose();
    }
  };

  if (request.activation) {
    await request.activation.revalidate((policy) => {
      if (!policy.effective) throw new InstallRevokedError({ message: "automatic update installation was disabled before activation" });
      activateOwned();
    });
    return false;
  }
  const owner = await createRuntimeConfigOwner({ userDataRoot: request.userDataRoot, watch: false });
  try {
    await owner.revalidateUseTime(() => undefined, activateOwned);
  } finally {
    await owner.dispose();
  }
  return underFlatUpdater;
}

export type RollbackOutcome =
  /** `unrecorded` is why the refusal of `from` could not be recorded, so an
   *  update check can offer that release again. */
  | { readonly kind: "rolled-back"; readonly from: BuildRef; readonly to: BuildRef; readonly unrecorded?: string }
  /** `current` did not move: `cause` is the kind of refusal, and `reason`
   *  says it for the log. */
  | { readonly kind: "kept"; readonly cause: RollbackKeptCause; readonly reason: string };

/** Why a rollback kept `current`. Three causes clear by themselves, so asking
 *  again later can return: `lease-held`, while another claimant works under
 *  the account update lease; `state-unusable`, while the account's update
 *  state cannot be opened; and `activation-busy`, when Windows refused the
 *  rename of `current` for its whole retry bound because readers held it.
 *  The others last: `unproved`, no other build is proved here; `proved`, the
 *  failed build is itself the proved one; `activation-moved`, `current` no
 *  longer names the failed build or cannot be read; `previous-unusable`, the
 *  proved build is gone or broken; and `activation-unwritable`, `current`
 *  could not be written for any other reason. */
export type RollbackKeptCause = "unproved" | "proved" | "lease-held" | "state-unusable" | "activation-busy" | "activation-moved" | "previous-unusable" | "activation-unwritable";

/** Move `current` back from a build that cannot start on this account, or
 *  cannot open any project here, to the last build proved on this account:
 *  one of whose project executors reported ready here (ARCH-DISTRIBUTION-024).
 *
 *  The target comes from the start record, which every build that keeps it
 *  names, whichever engine activated the build that failed. So a failed build
 *  that an older engine activated again is rolled back again. A proved build
 *  is not rolled back: it works on this account, so a later failure is not
 *  the build's.
 *
 *  It moves `current` under the account update lease, exactly as an
 *  activation does, so it cannot interleave with one. It does not take the
 *  config ownership lock: that lock is how disabling automatic installation
 *  revokes activations, and returning to a build that ran is not an
 *  installation. The failed build stays installed, and the refused-build record
 *  names it as refused, so an update check does not activate it again until a
 *  newer release is published. */
export function rollBackActivation(request: { readonly userDataRoot: string; readonly failed: BuildRef; readonly reason: string; readonly nowMs: number; readonly platform?: string }): RollbackOutcome {
  const { userDataRoot, failed } = request;
  const platform = request.platform ?? process.platform;
  const previous = provedBuild(userDataRoot);
  if (!previous) return { kind: "kept", cause: "unproved", reason: "no build is proved on this account" };
  if (previous.buildId === failed.buildId) return { kind: "kept", cause: "proved", reason: "this build is proved on this account" };

  let accountRoot: ContainedDirectory | undefined;
  let authority: UpdateAuthority | undefined;
  /** Why `current` could not be written, when that is why the rollback ended. */
  let unpublished: unknown;
  try {
    accountRoot = ContainedDirectory.open(path.dirname(userDataRoot), [path.basename(userDataRoot)], { privateDirectories: true });
    authority = createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) });
    const claim = authority.claim({ nowMs: request.nowMs, freshForMs: 0, leaseMs: LEASE_MS });
    if (claim.kind !== "won") return { kind: "kept", cause: "lease-held", reason: "another Flywheel process holds the update lease" };
    // Decided under the lease, so no activation can move `current` between
    // this check and the rename.
    const unusable = rollbackRefusal(accountRoot, { userDataRoot, failed, previous, platform });
    if (unusable) return { kind: "kept", ...unusable };
    const root = accountRoot;
    let unrecorded: string | undefined;
    const committed = authority.commitActivation({
      fence: claim.fence,
      checkedAtMs: request.nowMs,
      activate: () => {
        // The link moves first: a record that cannot be written must not keep
        // the account on a build that cannot start.
        try {
          publishActivation(root, userDataRoot, previous);
        } catch (error) {
          unpublished = error;
          throw error;
        }
        try {
          writeRefusedBuild(root, { version: 1, refused: failed, reason: request.reason });
        } catch (error) {
          unrecorded = errorMessage(error);
        }
      },
    });
    if (!committed) return { kind: "kept", cause: "lease-held", reason: "another Flywheel process took the update lease" };
    return { kind: "rolled-back", from: failed, to: previous, ...(unrecorded === undefined ? {} : { unrecorded }) };
  } catch (error) {
    if (unpublished !== undefined) {
      return { kind: "kept", cause: isSharingRefusal(unpublished) ? "activation-busy" : "activation-unwritable", reason: `the current build could not be moved back: ${errorMessage(unpublished)}` };
    }
    return { kind: "kept", cause: "state-unusable", reason: `the account's update state could not be used: ${errorMessage(error)}` };
  } finally {
    authority?.dispose();
    accountRoot?.close();
  }
}

/** Why `current` cannot move back to `previous` now, or nothing when it can. */
function rollbackRefusal(accountRoot: ContainedDirectory, context: { readonly userDataRoot: string; readonly failed: BuildRef; readonly previous: BuildRef; readonly platform: string }): { readonly cause: RollbackKeptCause; readonly reason: string } | undefined {
  const { userDataRoot, failed, previous, platform } = context;
  try {
    const active = readActiveBuild(accountRoot, userDataRoot);
    if (active?.buildId !== failed.buildId) return { cause: "activation-moved", reason: "the current build no longer names this build" };
  } catch (error) {
    return { cause: "activation-moved", reason: `the current build cannot be read: ${errorMessage(error)}` };
  }
  try {
    const previousDir = path.join(versionsDir(userDataRoot), previous.version, previous.buildId);
    const found = readBuildMetadata(previousDir);
    if (found.buildId !== previous.buildId || found.version.canonical !== previous.version) return { cause: "previous-unusable", reason: `the build at ${JSON.stringify(previousDir)} states version ${found.version.canonical} build ${found.buildId}` };
    requireExecutable(path.join(previousDir, buildExecutable(platform)), platform);
    return undefined;
  } catch (error) {
    return { cause: "previous-unusable", reason: `the previous build ${previous.version} ${previous.buildId} is not usable: ${errorMessage(error)}` };
  }
}

/** Prove the immutable physical tree one activation will name before the final
 *  rename. Nothing between this proof and the rename can fail on the build's
 *  own account, so a reported installation failure cannot hide a changed
 *  link. */
function validateInstalledBuild(buildDir: string, payload: AdmittedPayload, platform: string): void {
  const found = readBuildMetadata(buildDir);
  if (found.buildId !== payload.identity.buildId || found.version.canonical !== payload.identity.version.canonical) {
    refuse(`the installed tree states version ${found.version.canonical} build ${found.buildId}`);
  }
  requireDigest(buildDir, payload.digest, "the installed build", platform);
}

/** Run the executable of the build tree at `buildDir` once, from that
 *  directory and with the native directory its launcher would export, and
 *  refuse the build unless it answers: it exits zero within the bound. What
 *  it prints is the build's own business, because a later release may print
 *  its version another way. A refusal leaves `current` and the launcher
 *  exactly as they were. */
async function proveBuildRuns(buildDir: string, identity: BuildIdentity, request: InstallRequest): Promise<void> {
  let result;
  for (const timeoutMs of RUN_PROOF_BOUNDS_MS) {
    try {
      result = await request.runCommand([path.join(buildDir, buildExecutable(request.platform)), "--version"], {
        cwd: buildDir,
        env: { ...process.env, FLYWHEEL_NATIVE_DIR: path.join(buildDir, NATIVE_DIR, request.platformArch) },
        timeoutMs,
      });
    } catch (error) {
      refuse(`the build ${identity.buildId} could not be started on this host: ${errorMessage(error)}`);
    }
    if (!result.timedOut) break;
    log.info("the staged build did not answer its version within the bound", { buildId: identity.buildId, timeoutMs });
  }
  if (result === undefined || result.timedOut) refuse(`the build ${identity.buildId} did not answer its version within ${RUN_PROOF_BOUNDS_MS.at(-1)}ms`);
  if (result.exitCode !== 0) {
    const detail = quoted(lastLine(result.stderr) || lastLine(result.stdout));
    refuse(`the build ${identity.buildId} exited ${result.exitCode ?? "by a signal"} when it was asked its version${detail ? `: ${detail}` : ""}`);
  }
}

function lastLine(text: string): string {
  return text.trimEnd().split("\n").at(-1)?.trim() ?? "";
}

function quoted(text: string): string {
  return text.length > QUOTED_ANSWER_MAX_CHARS ? `${text.slice(0, QUOTED_ANSWER_MAX_CHARS)}...` : text;
}

/** The physical build `current` selects, while the config lock is held. A
 *  missing activation is an initial activation.
 *
 *  What comes back is an installed build or nothing: the activation is
 *  followed once to a held directory exactly two components below the
 *  account's versions root (`active-build.ts`), and its metadata describes the
 *  place it was found in. The old payload is not rehashed: the candidate has
 *  already proved its own identity, and changed old bytes must not block
 *  replacement with that verified build. */
function readActiveBuild(accountRoot: ContainedDirectory, userDataRoot: string): BuildIdentity | undefined {
  let active;
  try {
    active = openActiveBuild(accountRoot, userDataRoot);
  } catch (error) {
    refuse(error instanceof ActivationError ? error.message : `the current build does not resolve to a usable build: ${errorMessage(error)}`);
  }
  if (!active) return undefined;
  try {
    const raw = active.directory.readFile(BUILD_METADATA_FILE, METADATA_READ_BYTES);
    if (!raw) refuse("the current build resolves to a tree that states no build metadata");
    const identity = decodeBuildMetadata(raw.toString("utf-8"));
    assertInstallLocation(identity, active.path);
    return identity;
  } catch (error) {
    if (error instanceof InstallError) throw error;
    refuse(`the current build does not resolve to a usable build: ${errorMessage(error)}`);
  } finally {
    active.directory.close();
  }
}

/** The launcher directory's ownership on the platform's launcher, proved
 *  before anything is placed. */
type LauncherOwnership =
  | { readonly platform: "posix"; readonly ownership: WrapperOwnership }
  | { readonly platform: "win32"; readonly ownership: WindowsLauncherOwnership };

function proveLauncher(request: InstallRequest): LauncherOwnership {
  if (request.platform !== "win32") return { platform: "posix", ownership: proveWrapperOwnership(request.wrapperDir, request.platformArch) };
  const directory = openWrapperDirectory(request.wrapperDir);
  try {
    return { platform: "win32", ownership: proveWindowsLauncher(directory, request.wrapperDir, windowsLaunchersOf(request.sourceDir, request.platformArch)) };
  } catch (error) {
    refuse(errorMessage(error));
  } finally {
    directory.close();
  }
}

/** Publish the activated build's launcher, and on Windows collect what the
 *  launcher directory no longer needs. A collection that cannot finish now is
 *  not this installation's failure: the next update check tries again. */
async function publishLauncher(request: InstallRequest, context: { readonly launcher: LauncherOwnership; readonly buildDir: string }): Promise<void> {
  const { launcher, buildDir } = context;
  if (launcher.platform === "posix") {
    publishWrapper(request, { platformArch: request.platformArch, ownership: launcher.ownership });
    return;
  }
  const directory = openWrapperDirectory(request.wrapperDir);
  const placed = windowsLaunchersOf(buildDir, request.platformArch);
  try {
    await publishWindowsLauncher(directory, request.wrapperDir, launcher.ownership, {
      launchers: placed,
      metadata: readFileSync(path.join(buildDir, BUILD_METADATA_FILE), "utf-8"),
    });
  } catch (error) {
    refuse(`the Windows launcher could not be placed: ${errorMessage(error)}`);
  } finally {
    directory.close();
  }
  try {
    collectWindowsLauncherDirectory(request.wrapperDir, placed);
  } catch (error) {
    log.warn("the Windows launcher directory could not be collected", { error: errorMessage(error) });
  }
}

/** The Windows launchers a build tree carries in its native directory, or
 *  nothing when it carries them under no name this engine knows. A later
 *  release may move or rename them, and the launchers in place still run its
 *  build through `current`, so an update keeps them (`publishWindowsLauncher`). */
function windowsLaunchersOf(buildDir: string, platformArch: string): WindowsLaunchers | undefined {
  const nativeDir = path.join(buildDir, NATIVE_DIR, platformArch);
  const [consoleName, serviceName] = WINDOWS_LAUNCHERS.map(({ nativeName }) => path.join(nativeDir, nativeName));
  if (consoleName === undefined || serviceName === undefined || !existsSync(consoleName) || !existsSync(serviceName)) return undefined;
  return { console: new Uint8Array(readFileSync(consoleName)), service: new Uint8Array(readFileSync(serviceName)) };
}

/** What the wrapper directory holds at the name this installer publishes, read
 *  before anything is placed so an unrecognized entry refuses the whole
 *  installation instead of half of it.
 *
 *  `absent` is nothing at `flywheel` and no flat entry beside it.
 *  `legacy-exact` is byte for byte the wrapper the previous flat installer
 *  wrote, which is the one proof that the flat entries beside it are that
 *  installation's remains. `current-exact` is a wrapper this installer wrote:
 *  it names no sibling, so it vouches for none and authorizes no cleanup. */
type WrapperOwnership = "absent" | "legacy-exact" | "current-exact";

function proveWrapperOwnership(wrapperDir: string, platformArch: string): WrapperOwnership {
  const directory = openWrapperDirectory(wrapperDir);
  try {
    const existing = readOwnedWrapper(directory, wrapperDir);
    if (existing === undefined) {
      for (const name of LEGACY_ENTRIES) {
        if (directory.hasEntry(name)) refuse(`${JSON.stringify(path.join(wrapperDir, name))} is not a Flywheel entry this installer may replace`);
      }
      return "absent";
    }
    if (existing === legacyWrapperScript(platformArch)) return "legacy-exact";
    if (existing.startsWith(WRAPPER_HEADER) || existing.startsWith(PREVIOUS_WRAPPER_HEADER)) return "current-exact";
    refuse(`${JSON.stringify(path.join(wrapperDir, WRAPPER_NAME))} was not written by Flywheel`);
  } finally {
    directory.close();
  }
}

function readOwnedWrapper(directory: ContainedDirectory, wrapperDir: string): string | undefined {
  let owned;
  try {
    owned = directory.readOwnedFile(WRAPPER_NAME, WRAPPER_MAX_BYTES);
  } catch (error) {
    refuse(`${JSON.stringify(path.join(wrapperDir, WRAPPER_NAME))} is not a regular file this installer may replace: ${errorMessage(error)}`);
  }
  if (!owned) return undefined;
  if (owned.linkCount !== 1) refuse(`${JSON.stringify(path.join(wrapperDir, WRAPPER_NAME))} is also reachable under another name, so replacing it would change a file this installer does not own`);
  return owned.content.toString("utf-8");
}

function openWrapperDirectory(wrapperDir: string): ContainedDirectory {
  try {
    // The default wrapper directory is ~/.local/bin, and a fresh account has
    // no ~/.local yet. `open` creates missing components only below an
    // existing base, so the walk starts at the deepest ancestor that exists
    // and creates every component from there.
    let base = path.dirname(wrapperDir);
    const missing = [path.basename(wrapperDir)];
    while (!existsSync(base) && path.dirname(base) !== base) {
      missing.unshift(path.basename(base));
      base = path.dirname(base);
    }
    return ContainedDirectory.open(base, missing);
  } catch (error) {
    refuse(`the wrapper directory ${JSON.stringify(wrapperDir)} cannot be used: ${errorMessage(error)}`);
  }
}

/** Publish the launcher over the entry the same ownership proof still admits,
 *  and then remove what the previous flat installer left. The build is already
 *  active, so the wrapper being replaced reaches a runnable command right up to
 *  the rename that replaces it. */
function publishWrapper(request: InstallRequest, context: { readonly platformArch: string; readonly ownership: WrapperOwnership }): void {
  if (proveWrapperOwnership(request.wrapperDir, context.platformArch) !== context.ownership) {
    refuse("the wrapper installation changed while the build was being prepared");
  }
  const directory = openWrapperDirectory(request.wrapperDir);
  try {
    directory.publishFileThrough(
      `.${WRAPPER_NAME}.${process.pid}.${randomBytes(8).toString("hex")}`,
      WRAPPER_NAME,
      wrapperScript(request.userDataRoot, context.platformArch, request.wrapperDir),
      0o755,
    );
    if (context.ownership !== "legacy-exact") return;
    directory.removeFile(buildExecutable("linux"));
    directory.removeTree(NATIVE_DIR);
    directory.removeTree(FONTS_DIR);
  } finally {
    directory.close();
  }
}

/** The launcher on the user's PATH. It resolves `current` physically before it
 *  exports anything, so a build activated between two launches is never half
 *  loaded: one launch reads one physical tree.
 *
 *  It refuses to execute anything that link does not resolve to exactly two
 *  components below the account's versions root. A `current` bent onto any
 *  other tree is a launcher that runs code the installer never placed, so the
 *  wrapper fails closed rather than exec what it found. */
function wrapperScript(userDataRoot: string, platformArch: string, wrapperDir: string): string {
  const versionsName = path.basename(versionsDir(userDataRoot));
  return `${WRAPPER_HEADER}# Written by the Flywheel installer. It resolves the account's current build and
# executes it; deleting it removes the launcher and no installed build.
set -eu
FLYWHEEL_HOME=${shellQuote(userDataRoot)}
export FLYWHEEL_INSTALL_DIR=${shellQuote(wrapperDir)}
BUILD_DIR="$(cd -P -- "$FLYWHEEL_HOME/${CURRENT_BUILD_LINK}" && pwd -P)"
VERSIONS_ROOT="$(cd -P -- "$FLYWHEEL_HOME/${versionsName}" && pwd -P)"
if [ "$(dirname "$(dirname "$BUILD_DIR")")" != "$VERSIONS_ROOT" ]; then
  echo "flywheel: $FLYWHEEL_HOME/${CURRENT_BUILD_LINK} does not name an installed build under $VERSIONS_ROOT" >&2
  exit 1
fi
export FLYWHEEL_NATIVE_DIR="$BUILD_DIR/${NATIVE_DIR}/${platformArch}"
exec "$BUILD_DIR/${buildExecutable("linux")}" "$@"
`;
}

/** The wrapper the flat installer wrote, byte for byte. It exists only so an
 *  installation that finds one can prove it is Flywheel's and migrate it. */
function legacyWrapperScript(platformArch: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
SOURCE="\${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SELF_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
export FLYWHEEL_NATIVE_DIR="$SELF_DIR/native/${platformArch}"
exec "$SELF_DIR/flywheel-bin" "$@"
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
