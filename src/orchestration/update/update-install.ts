/** The one transfer that turns a published release into an installed build.
 *
 *  Everything between "a candidate exists" and "the install engine may place
 *  it" happens here, in one order: verify, then extract. The compressed asset
 *  is written to one file of this attempt's staging, bounded by the size the
 *  manifest states and hashed as its bytes arrive. Only once its size and
 *  SHA-256 are the ones the manifest states is it read again, by the archive
 *  reader (`archive-spool.ts`), which confines and places what it lists. So
 *  nothing from an archive that is not the published one is decompressed,
 *  parsed, allocated, or written beyond that one bounded file (ARCH-DISTRIBUTION-011).
 *
 *  The client sets no limit of its own on a release. The size the release
 *  states bounds the transfer, the digest proves it, and every other rule
 *  about what a release may hold is the release side's
 *  (`scripts/release-acceptance.ts`).
 *
 *  Nothing here decides whether to install, and nothing here publishes. The
 *  service owns the check, the policy, and the lease; this module is handed
 *  the fence that run won and hands it to the engine with a handle of its own
 *  on the account authority, so the activation the engine performs is the one
 *  this attempt was authorized to make. Its own handle is what lets the
 *  account service run it on the update Worker, away from the thread that
 *  holds the lease (ARCH-RUNTIME-043).
 *
 *  One bound makes a transfer safe to wait on: a stall bound, so a connection
 *  that stops delivering bytes is abandoned rather than held. There is no
 *  bound on the whole attempt, so a slow transfer that keeps delivering always
 *  finishes. A stall, a transport failure, a body that ends before the asset
 *  does, a server error, and a rate limit are the passing state of the
 *  network or the host, so the transfer asks again from the byte it reached,
 *  waiting longer before each request that follows one that delivered
 *  nothing, and it gives up only once no byte has arrived for ten minutes.
 *  Any other answer the publisher gave - a status, a size, a digest, an
 *  entry - is an answer, and repeating the request cannot change it.
 *
 *  Staging is a directory of this account's versions root: the same filesystem
 *  the build is placed on, so placement is a rename and there is no copy
 *  fallback to get wrong. Its name is unrepeatable, so nothing on disk is ever
 *  the recognizable remainder of an interrupted attempt, and every failure
 *  removes it through the held descriptor. */

import { createHash, randomBytes, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { Schema } from "effect";
import { ContainedDirectory } from "../../infra/descriptor-directory.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { coalesceRepeats } from "../../infra/repeat-coalescer.js";
import { ownedCommandRunner } from "../../infra/owned-command.js";
import { versionsDir } from "../../infra/paths.js";
import type { LauncherScope } from "../../infra/process-supervisor.js";
import { collectBuildTrees } from "../../infra/update/build-retention.js";
import type { UpdateAuthority } from "../../infra/update/update-authority.js";
import { fetchOverHttps, ReleaseManifestError } from "../../infra/update/release-manifest.js";
import { extractArchive, UpdateArchiveError } from "./archive-spool.js";
import { installBuild, InstallRevokedError } from "./install-engine.js";
import { activeLaunchers, collectWindowsLauncherDirectory } from "./windows-install.js";
import type { UpdateScheduler } from "./update-check.js";
import type { UpdateInstaller, UpdatePolicyStore } from "./update-service.js";

const log = Log.create({ service: "update-install" });

/** No byte and no answer for this long means the connection is not
 *  delivering. */
const STALL_MS = 60_000;

/** The waits before each request that follows one that delivered no byte,
 *  the last repeated. A request that delivers a byte asks again at once and
 *  starts the ladder again, so a link that drops often still finishes while it
 *  makes progress. */
const RETRY_WAITS_MS = [1_000, 10_000, 60_000] as const;

/** No byte of the asset for this long, across every request, ends the
 *  transfer. It outlasts the outages a person usually meets in ordinary use
 *  (a Wi-Fi roam or reconnect, a router or modem restart, a VPN that
 *  reconnects), which usually end within a few minutes. A network that stays
 *  down longer is a machine that is offline, and the next scheduled check
 *  starts again, so one attempt does not hold its staging and the update
 *  lease for hours. It is measured on the wall clock, which a sleeping machine
 *  advances without running timers, so the transfer also climbs the whole
 *  retry ladder after the last byte before it gives up: a machine that wakes
 *  with its network still joining gets a minute of requests, not one. */
const GIVE_UP_MS = 10 * 60_000;

/** Interruptions of one download that follow the first inside this window
 *  are counted, not recorded one by one. */
const INTERRUPTION_WINDOW_MS = 60_000;

/** The compressed asset, in this attempt's staging, until it is proved. */
const DOWNLOAD_FILE = "download";
const SPOOL_DIR_NAME = "spool";

/** The transfer could not produce an installable build. */
class UpdateTransferError extends Schema.TaggedError<UpdateTransferError>()("UpdateTransfer", {
  message: Schema.String,
  reason: Schema.String,
}) {}

function refuse(reason: string, message = `The update could not be transferred: ${reason}`): never {
  throw new UpdateTransferError({ message, reason });
}

/** An answer the publisher gave, which another request cannot change. */
function isAnswer(error: unknown): boolean {
  return error instanceof UpdateTransferError || error instanceof ReleaseManifestError || error instanceof UpdateArchiveError;
}

export interface UpdateInstallerDeps {
  /** Startup-selected account data root every installed build lives under. */
  readonly userDataRoot: string;
  /** Directory the `flywheel` launcher is published in. */
  readonly wrapperDir: string;
  readonly platform: string;
  /** This build's release target (`buildPlatformArch`). */
  readonly platformArch: string;
  /** The one clock and timer source of every update operation. */
  readonly scheduler: UpdateScheduler;
  /** The account's auto-install authority. The engine asks it again inside the
   *  ownership window rather than reading the setting for itself, so the
   *  revocation boundary and the admission decision are one answer. */
  readonly policy: Pick<UpdatePolicyStore, "read" | "revalidate">;
  /** Launch authority this installer opens one child scope per attempt from,
   *  so every process the install engine runs ends with the attempt. */
  readonly launcher: LauncherScope;
  /** Opens this installer's own handle on the account update authority. An
   *  activation commits through it under the fence the request states, and
   *  the handle closes with the attempt. */
  readonly openAuthority: () => UpdateAuthority;
  readonly fetch?: typeof globalThis.fetch;
}

export function createUpdateInstaller(deps: UpdateInstallerDeps): UpdateInstaller {
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  return {
    async install(request) {
      const versionsRoot = openVersionsRoot(deps.userDataRoot);
      try {
        return await transfer({ deps, fetchImpl, versionsRoot, request });
      } finally {
        versionsRoot.close();
      }
    },

    async collect(signal) {
      // The Windows launcher directory holds the launchers an update renamed
      // out of the way and what a flat installation left, each removable only
      // once nothing runs it.
      if (deps.platform === "win32") {
        try {
          collectWindowsLauncherDirectory(deps.wrapperDir, activeLaunchers(deps.userDataRoot, deps.platformArch));
        } catch (error) {
          log.warn("the Windows launcher directory could not be collected", { error: errorMessage(error) });
        }
      }
      const collected = await collectBuildTrees({ userDataRoot: deps.userDataRoot, signal, platform: deps.platform });
      if (collected.removedBuilds.length === 0 && collected.removedRemainders.length === 0) return;
      log.info("collected installed builds", {
        removedBuilds: collected.removedBuilds.length,
        removedRemainders: collected.removedRemainders.length,
        keptBuilds: collected.keptBuilds,
        // Said out loud, because a bounded or withdrawn sweep that reported
        // nothing would read as an account with nothing left to collect.
        moreToCollect: collected.truncated,
      });
    },
  };
}

function openVersionsRoot(userDataRoot: string): ContainedDirectory {
  const accountRoot = ContainedDirectory.open(path.dirname(userDataRoot), [path.basename(userDataRoot)], { privateDirectories: true });
  try {
    return accountRoot.openChild(path.basename(versionsDir(userDataRoot)), { privateDirectories: true });
  } finally {
    accountRoot.close();
  }
}

interface TransferContext {
  readonly deps: UpdateInstallerDeps;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly versionsRoot: ContainedDirectory;
  readonly request: Parameters<UpdateInstaller["install"]>[0];
}

async function transfer(context: TransferContext): Promise<{ readonly kind: "installed" | "revoked" }> {
  const { deps, versionsRoot, request } = context;
  // The name states the process that owns it, so a remainder an interrupted
  // attempt left is attributable rather than anonymous.
  const staging = `.update.${process.pid}.${randomBytes(16).toString("hex")}`;
  const stagingDir = versionsRoot.openChild(staging, { privateDirectories: true });
  try {
    await download(context, stagingDir);
    const build = await extract(stagingDir, request.signal);
    if (request.signal.aborted) return { kind: "revoked" };
    if (!await place(context, path.join(versionsDir(deps.userDataRoot), staging, ...build))) return { kind: "revoked" };
    return { kind: "installed" };
  } catch (error) {
    // A caller that withdrew gets the withdrawal, not a failure: nothing was
    // published, and the reason the attempt ended is the caller's own.
    if (request.signal.aborted) return { kind: "revoked" };
    throw error;
  } finally {
    stagingDir.close();
    // A cleanup that will not go is not this attempt's outcome: an install
    // that landed and activated must not be reported as a failure because
    // its spool would not unlink. The name states this process, so a later
    // collection takes whatever is left of it.
    try {
      versionsRoot.removeTree(staging);
    } catch (error) {
      log.warn("update staging could not be removed", { staging, error: errorMessage(error) });
    }
  }
}

/** What one download has taken so far: the bytes written, and their digest. */
interface DownloadProgress {
  delivered: number;
  readonly digest: Hash;
}

/** One request that ended before the asset did. */
interface Interruption {
  readonly stalled: boolean;
  readonly delivered: number;
}

/** Write the asset to the one download file of this attempt and prove it is
 *  the asset the manifest described. The digest and the byte count are taken
 *  from the bytes as they are written, so the file is proved without being
 *  read, and nothing else is written until it is. */
async function download(context: TransferContext, stagingDir: ContainedDirectory): Promise<void> {
  const { request } = context;
  const asset = request.release.asset;
  const progress: DownloadProgress = { delivered: 0, digest: createHash("sha256") };
  const version = request.release.version.canonical;
  const interruptions = coalesceRepeats<Interruption>({
    windowMs: INTERRUPTION_WINDOW_MS,
    first: (_key, interruption) => { log.warn("update download interrupted; asking again from the byte it reached", { ...interruption, sizeBytes: asset.sizeBytes, version }); },
    repeated: (_key, { count, events, windowMs }) => {
      log.warn("update download interrupted again", { repeats: count, windowMs, stalled: events.filter((event) => event.stalled).length, delivered: progress.delivered, sizeBytes: asset.sizeBytes, version });
    },
  });
  try {
    await stagingDir.writeStreamExclusive(DOWNLOAD_FILE, assetBytes(context, progress, (interruption) => { interruptions.observe("interrupted", interruption); }), { maxBytes: asset.sizeBytes, signal: request.signal });
  } catch (error) {
    if (isAnswer(error) || request.signal.aborted) throw error;
    refuse(errorMessage(error));
  } finally {
    interruptions.end();
  }
  const found = progress.digest.digest("hex");
  if (found !== asset.sha256) refuse(`the download digests to ${found}, not the ${asset.sha256} the release states`);
}

/** The asset's bytes, in order, across as many requests as the network
 *  needs. A request that stalls or fails before the publisher answers is
 *  made again from the byte the download reached: against the URL that
 *  served the earlier bytes, with `range`, where that host resumes, and
 *  from the start of the asset otherwise, with the bytes already written
 *  dropped. The digest therefore covers exactly the file written. A request
 *  that delivered a byte is made again at once; one that delivered nothing
 *  first waits its step of `RETRY_WAITS_MS`.
 *
 *  @yields {Uint8Array} the next bytes of the asset, each one written once. */
async function* assetBytes(context: TransferContext, progress: DownloadProgress, interrupted: (interruption: Interruption) => void): AsyncIterable<Uint8Array> {
  const { deps, fetchImpl, request } = context;
  const asset = request.release.asset;
  let resumeUrl: string | undefined;
  let fruitless = 0;
  let lastByteAtMs = deps.scheduler.nowMs();
  for (;;) {
    const reached = progress.delivered;
    const attempt = new AbortController();
    const stopOnCaller = (): void => { attempt.abort(); };
    request.signal.addEventListener("abort", stopOnCaller, { once: true });
    let stalled = false;
    let cancelStall = (): void => {};
    const progressed = (): void => {
      cancelStall();
      cancelStall = deps.scheduler.setTimer(() => { stalled = true; attempt.abort(); }, STALL_MS);
    };
    progressed();
    try {
      const target = reached > 0 && resumeUrl !== undefined ? resumeUrl : asset.url;
      let served = target;
      const response = await fetchOverHttps(fetchImpl, target, attempt.signal, {
        ...(reached > 0 ? { headers: { range: `bytes=${reached}-` } } : {}),
        onHop: (url) => { served = url; progressed(); },
      });
      const drop = bytesToDrop(response, reached);
      if (drop === undefined) {
        await response.body?.cancel().catch(() => {});
        // A server error or a rate limit is the host's state now, not its
        // answer about the asset, so the asset URL is asked again after a
        // wait: its fresh redirect can name a healthy host.
        if (response.status >= 500 || response.status === 429) {
          resumeUrl = undefined;
          throw new Error(`the asset request answered ${response.status}`);
        }
        if (target === asset.url) refuse(`the asset request answered ${response.status}`);
        // The host that served the earlier bytes no longer serves them, as a
        // signed redirect target does once it expires, so the asset URL is
        // asked again.
        resumeUrl = undefined;
        continue;
      }
      resumeUrl = served;
      const body = response.body ?? refuse("the asset request answered with no body");
      let dropping = drop;
      for await (const received of body) {
        progressed();
        const chunk = received.subarray(Math.min(dropping, received.byteLength));
        dropping -= received.byteLength - chunk.byteLength;
        if (chunk.byteLength === 0) continue;
        progress.delivered += chunk.byteLength;
        // The size the release states is the release's own bound on this
        // download, so a body past it is refused while it still arrives.
        if (progress.delivered > asset.sizeBytes) refuse(`the download delivers more than the ${asset.sizeBytes} bytes the release states`);
        progress.digest.update(chunk);
        lastByteAtMs = deps.scheduler.nowMs();
        yield chunk;
      }
      if (progress.delivered === asset.sizeBytes) return;
      // A body delimited by the connection's close, or a 206 that holds less
      // than it states, ends with no error when the connection is cut.
      throw new Error("the connection ended before the asset did");
    } catch (error) {
      if (request.signal.aborted || isAnswer(error)) throw error;
      // Every byte the release states is written, so whatever the connection
      // did after the last one cannot change the file: the size and digest
      // checks decide.
      if (progress.delivered === asset.sizeBytes) return;
      fruitless = progress.delivered > reached ? 0 : fruitless + 1;
      if (fruitless > RETRY_WAITS_MS.length && deps.scheduler.nowMs() - lastByteAtMs >= GIVE_UP_MS) {
        const last = stalled ? `delivered nothing for ${STALL_MS}ms` : `failed: ${errorMessage(error)}`;
        refuse(`no byte arrived for ${GIVE_UP_MS}ms across requests; the last ${last}`);
      }
      interrupted({ stalled, delivered: progress.delivered });
    } finally {
      cancelStall();
      request.signal.removeEventListener("abort", stopOnCaller);
    }
    if (fruitless > 0) await waitBeforeAsking(deps.scheduler, RETRY_WAITS_MS[Math.min(fruitless, RETRY_WAITS_MS.length) - 1] ?? 0, request.signal);
  }
}

/** Wait `delayMs` on the update scheduler, or until the caller withdraws,
 *  which ends the transfer. */
async function waitBeforeAsking(scheduler: UpdateScheduler, delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      cancel();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const cancel = scheduler.setTimer(done, delayMs);
    signal.addEventListener("abort", done, { once: true });
  });
  if (signal.aborted) throw new Error("the update was withdrawn while it waited to ask again");
}

/** How many leading bytes of `response` the download already holds, or
 *  nothing when the response cannot continue it. A first request needs a
 *  success. A resumed one takes the range it asked for, or the whole asset
 *  from a host that does not resume. */
function bytesToDrop(response: Response, reached: number): number | undefined {
  if (reached === 0) return response.ok ? 0 : undefined;
  if (response.status === 200) return reached;
  if (response.status === 206 && rangeStart(response) === reached) return 0;
  return undefined;
}

/** The first byte a `206` answer states it holds (`content-range: bytes
 *  <first>-<last>/<size>`). */
function rangeStart(response: Response): number | undefined {
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(response.headers.get("content-range")?.trim() ?? "");
  return match === null ? undefined : Number(match[1]);
}

/** Read the proved download into a payload tree of this attempt's staging,
 *  and answer where the build is, relative to the staging directory. The
 *  download is removed once it is read, so the tree the engine copies is
 *  the only large thing left. */
async function extract(stagingDir: ContainedDirectory, signal: AbortSignal): Promise<readonly string[]> {
  const spool = stagingDir.openChild(SPOOL_DIR_NAME, { privateDirectories: true });
  try {
    const verified = createReadStream(path.join(stagingDir.canonicalPath(), DOWNLOAD_FILE));
    const closed = new Promise<void>((resolve) => { verified.once("close", () => { resolve(); }); });
    try {
      return await extractArchive(stagingDir, spool, verified, signal);
    } finally {
      // Windows removes a file only once no handle holds it.
      verified.destroy();
      await closed;
      // The staging tree goes with the attempt, so a download that will not
      // unlink here (a scanner holding it on Windows) is removed with it or
      // by a later collection, and never becomes the attempt's outcome.
      try {
        stagingDir.removeFile(DOWNLOAD_FILE);
      } catch (error) {
        log.debug("the proved update download could not be removed before placement", { error: errorMessage(error) });
      }
    }
  } finally {
    spool.close();
  }
}

/** Hand the payload to the one install engine under the fence this attempt
 *  holds. The engine owns placement, the payload proof, the macOS
 *  preparation, the run of the staged build, activation, and the launcher
 *  publication; nothing of that is repeated here. */
async function place(context: TransferContext, payloadDir: string): Promise<boolean> {
  const { deps, request } = context;

  // The engine's external commands belong to this attempt: the scope is
  // closed and settled before this function answers, so no process it started
  // outlives the outcome the service publishes.
  const scope = deps.launcher.open();
  const authority = deps.openAuthority();
  try {
    try {
      await installBuild({
        userDataRoot: deps.userDataRoot,
        sourceDir: payloadDir,
        wrapperDir: deps.wrapperDir,
        platform: deps.platform,
        platformArch: deps.platformArch,
        runCommand: ownedCommandRunner(scope),
        activation: { authority, fence: request.fence, revalidate: deps.policy.revalidate },
        nowMs: deps.scheduler.nowMs,
      });
      return true;
    } catch (error) {
      if (error instanceof InstallRevokedError) return false;
      throw error;
    }
  } finally {
    authority.dispose();
    await scope.close();
  }
}
