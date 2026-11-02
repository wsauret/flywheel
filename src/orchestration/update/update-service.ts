/** The account's one update coordinator and the state it publishes.
 *
 *  Everything an update needs to decide is decided here: whether the account
 *  already checked recently, whether this process is the one claimant allowed
 *  to work, whether the published release is newer than this build, whether
 *  the durable policy still permits activation, and what the user is told
 *  (ARCH-RUNTIME-043). The account service composes one for the whole account, and
 *  `flywheel update` composes one for its single manual run.
 *
 *  The published state is a discriminated union, not a status plus optional
 *  fields, so an `installing` state cannot exist without the version it is
 *  installing and an `idle` state cannot carry a stale one. Every view also
 *  carries the effective `autoInstall` policy, because the TUI reads its
 *  settings row, status row, and notice from this one projection rather than
 *  from a copy of the config.
 *
 *  Two rules make the published state truthful rather than optimistic. A
 *  candidate is published as `available` before any download begins, so an
 *  install that fails, is cancelled, or is revoked returns to a state the
 *  manual update notice still means. And the policy is always what the store
 *  answers now, never a value captured at startup: it is re-read before
 *  activation, after a settings write, and whenever the config file changes,
 *  so a disable committed by another process revokes this activation instead
 *  of racing it.
 *
 *  Nothing here downloads, copies, or removes a build. `UpdateInstaller` is
 *  the narrow seam the concrete installer binds into, and it is handed the
 *  fence this run won: activation publishes under that fence or not at all,
 *  because an atomic rename alone cannot order two valid update candidates.
 *
 *  The service owns no process-wide resource beyond one abort controller and
 *  the timers it takes from the injected scheduler. Admission closes
 *  synchronously and aborts the run in flight, including its collection, and
 *  `settled()` is the single settlement its owner's shutdown joins. */

import { errorMessage } from "../../infra/error-message.js";
import type { BuildRef } from "../../infra/update/build-identity.js";
import { Log } from "../../infra/log.js";
import type { UpdateAutoInstall, UpdateStatus, UpdateStatusView } from "../../protocol/update-protocol-types.js";
import { parseRepositoryIdentity, platformAssetName, type SelectedRelease } from "../../infra/update/release-manifest.js";
import type { UpdateAuthority, UpdateLeaseRenewal } from "../../infra/update/update-authority.js";
import { compareReleaseVersions, isLaterRelease, parseReleaseVersion, type ReleaseVersion } from "../../infra/update/version-order.js";
import { ConfigWriteError, type ConfigWriteResult } from "../config/writer.js";
import { ADMISSION_CLOSED_ERROR } from "../app-service/mutation-admission.js";
import { checkForUpdate, type UpdateCheckRequest, type UpdateCheckResult, type UpdateScheduler } from "./update-check.js";

const log = Log.create({ service: "update-service" });

/** How long one successful check stays good for the whole account. Short on
 *  purpose: it only stops a burst of processes starting together from
 *  becoming a burst of requests, so a restarted service really checks. */
const CHECK_FRESH_FOR_MS = 5 * 60 * 1_000;

/** How long a won lease lasts, and how often a working claimant renews it.
 *  A claimant that crashes cannot renew, so the account waits out at most one
 *  lease term before the next claimant wins the next fence. */
const LEASE_MS = 60_000;
const LEASE_RENEWAL_MS = LEASE_MS / 2;

/** How long after `start()` the first background check runs. Readiness is
 *  never blocked by an update, and a burst of processes starting together does
 *  not become a burst of requests. */
const FIRST_CHECK_DELAY_MS = 10_000;

/** How long a running process waits between background checks, so a release
 *  published while Flywheel is open still reaches the user without a restart
 *  or a manual `flywheel update`. */
const CHECK_INTERVAL_MS = 30 * 60 * 1_000;

type UpdateRunResult =
  /** A check inside the freshness window already answered this. */
  | { readonly kind: "fresh" }
  /** Another claimant owns the work, or took it over mid-install. */
  | { readonly kind: "busy" }
  | { readonly kind: "current" }
  /** A newer release exists and an attempt ended without activating it. */
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "installed"; readonly version: string }
  /** A release the durable policy forbids installing. */
  | { readonly kind: "policy-blocked"; readonly version: string }
  /** A release this platform has no in-process install path for. */
  | { readonly kind: "platform-blocked"; readonly version: string }
  /** A release no newer than the build a rollback refused on this account. */
  | { readonly kind: "refused"; readonly version: string }
  | { readonly kind: "cancelled" }
  /** Nothing usable happened. The reason is for the log, not the user. */
  | { readonly kind: "failed"; readonly reason: string };

interface UpdateInstallRequest {
  readonly release: SelectedRelease;
  /** The fence of the lease this run holds. The installer commits activation
   *  under it through its own handle on the account authority, so a
   *  superseded claimant publishes nothing. */
  readonly fence: number;
  readonly signal: AbortSignal;
}

type UpdateInstallOutcome =
  /** Staged and activated; the activation committed the check with it. */
  | { readonly kind: "installed" }
  /** Staged, then refused activation because the policy no longer allows it. */
  | { readonly kind: "revoked" };

/** The account's build trees, as the coordinator reaches them. One seam owns
 *  the whole filesystem side of a build: the transfer, the activation, and the
 *  collection of what nothing can still be using. A rejection from `install`
 *  means the attempt failed and changed nothing the user can see. */
export interface UpdateInstaller {
  install(request: UpdateInstallRequest): Promise<UpdateInstallOutcome>;
  /** Remove the build trees and staging remainders nothing can still be
   *  using. Called only after this run held the account update lease, and the
   *  collection claims that lease again for itself. `signal` withdraws it
   *  between two removals. Never fails a run: an account that could not be
   *  collected has spent disk, not correctness. */
  collect(signal: AbortSignal): Promise<void>;
}

/** The `updates.auto_install` policy. Display reads are separate from the
 * lock-backed revalidation that remains held through final activation. */
export interface UpdatePolicyStore {
  read(): UpdateAutoInstall;
  revalidate<T>(decide: (policy: UpdateAutoInstall) => T): Promise<T>;
  write(expected: boolean, value: boolean): Promise<ConfigWriteResult>;
}

export interface UpdateServiceDeps {
  /** This build's release version, as the binary states it, or nothing for
   *  a source run, which states none (`FLYWHEEL_APP_VERSION` is absent). A
   *  source run never updates. Whether a process is one is this explicit
   *  absence, never the shape of a version, so a release may choose any
   *  version and still update after it is installed. */
  readonly currentVersion: string | undefined;
  /** This build's own release target (`buildPlatformArch`), which selects
   *  the archive an update installs. */
  readonly platformArch: string;
  /** `owner/repo` of the release channel this client trusts, or nothing for
   *  a build that names none (`updateRepository`). Such a build never checks
   *  or installs, and its status says so. */
  readonly repository: string | undefined;
  readonly policy: UpdatePolicyStore;
  /** Opens one handle for one run. The handle is disposed with the run, so a
   *  lease never outlives the work it was won for. */
  readonly openAuthority: () => UpdateAuthority;
  readonly scheduler: UpdateScheduler;
  readonly publish: (view: UpdateStatusView) => void;
  /** Absent means notify-only: this coordinator can discover a release but owns
   *  no way to install one. */
  readonly installer?: UpdateInstaller;
  /** The build a rollback left installed but not current, because it could
   *  not start or could not open any project on this account. A release no
   *  newer than it is not installed again, and while this build runs in its
   *  place the resting status names it. Read at start and on every run. */
  readonly refusedBuild?: () => BuildRef | undefined;
  /** The installed build this process runs, which tells a refused build of
   *  the same version apart from this one. Absent for a process that runs no
   *  installed build. */
  readonly currentBuildId?: string;
  /** Present while this dev service runs the proved snapshot `running` of its
   *  checkout because the checkout's source `refused` could not start, which
   *  the resting status names. */
  readonly refusedSource?: { readonly refused: string; readonly running: string };
  readonly check?: (request: UpdateCheckRequest) => Promise<UpdateCheckResult>;
}

interface UpdateRunOptions {
  /** An operator or a person asked: the account's check freshness does not apply. */
  readonly manual?: boolean;
  /** Install this one release instead of the channel's latest, as a terminal
   *  does to run the release of the remote machine it reaches. */
  readonly release?: string;
}

export interface UpdateService {
  /** The currently published view. */
  status(): UpdateStatusView;
  /** Persist the durable policy, then publish the effective one. A successful
   *  disable also revokes an activation in flight. Once admission closed, the
   *  write is refused with the admission-closed error and never reaches the
   *  policy. */
  setAutoInstall(expected: boolean, value: boolean): Promise<ConfigWriteResult>;
  /** Re-read the effective policy and publish it. The owner's config watch
   *  calls this when the file changed, so an edit made anywhere reaches the
   *  user's view without waiting for a check. */
  refreshPolicy(): void;
  /** Publish the resting status with the policy, and arm the recurring
   *  background check. Idempotent; a no-op once admission closed. The first
   *  check runs shortly after start, and each completed background run arms
   *  the next interval. */
  start(): void;
  /** One check, and the install it permits. Concurrent callers join the run
   *  already in flight rather than claiming a second lease. A run for one
   *  named release joins no run, because the run in flight can target
   *  another release: while one is in flight, it answers `busy`. */
  run(options?: UpdateRunOptions): Promise<UpdateRunResult>;
  /** Stop admitting update work and abort what is running. Synchronous, so
   *  the shutdown barrier can close admission before any phase begins. */
  closeAdmission(): void;
  /** Resolves once no update work is running. */
  settled(): Promise<void>;
}

/** Why a run was aborted. `superseded` is another claimant taking the fence;
 *  the others are this process withdrawing. */
type AbortReason = "closed" | "revoked" | "superseded";

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const check = deps.check ?? checkForUpdate;
  let revision = 0;
  // The policy this service publishes is the one the store answers, never a
  // value a caller carries alongside it. It is first read when something asks
  // for a view or the service starts, so composing the service reads no
  // configuration.
  let publishedPolicy: UpdateAutoInstall | undefined;
  const livePolicy = (): UpdateAutoInstall => {
    publishedPolicy ??= deps.policy.read();
    return publishedPolicy;
  };
  let status: UpdateStatus = { kind: "idle" };
  let closed = false;
  let inFlight: Promise<UpdateRunResult> | null = null;
  // The last run outcome recorded at the default level.
  let lastOutcome: string | undefined;
  let controller: AbortController | null = null;
  let abortReason: AbortReason | null = null;
  let cancelScheduledCheck: (() => void) | null = null;
  // start() is idempotent across the whole lifetime, not just while a timer
  // is pending: between a fired timer and its run's re-arm the handle is
  // null, and a second start() in that gap must not arm a duplicate.
  let started = false;

  const view = (): UpdateStatusView => ({ revision, autoInstall: livePolicy(), status });

  /** Publishes only a view that differs from the published one: the cursor
   *  collapses to the latest, so republishing an unchanged view is noise. A
   *  durable change with no effective change still differs, which is what
   *  lets a toggle held off by the environment reach the user at all. */
  function publish(next: UpdateStatus, nextAutoInstall: UpdateAutoInstall = livePolicy()): void {
    const before = status;
    status = next;
    const unchanged = sameStatus(before, status) && samePolicy(livePolicy(), nextAutoInstall);
    publishedPolicy = nextAutoInstall;
    if (unchanged) return;
    revision += 1;
    deps.publish(view());
  }

  function abortWith(reason: AbortReason): void {
    if (!controller || controller.signal.aborted) return;
    abortReason = reason;
    controller.abort();
  }

  /** Publishes a status together with the policy, so what the user reads and
   *  the policy they read it against are one view. */
  function adoptPolicy(next: UpdateStatus): UpdateAutoInstall {
    const policy = deps.policy.read();
    publish(next, policy);
    return policy;
  }

  function refreshPolicy(): void {
    // A policy nobody has read yet has nothing to refresh: its first read is
    // already the current one.
    if (!publishedPolicy) return;
    const wasAllowed = publishedPolicy.effective;
    const policy = adoptPolicy(status);
    // A disable revokes every activation, including one this process is
    // already staging.
    if (wasAllowed && !policy.effective) abortWith("revoked");
  }

  return {
    status: view,

    async setAutoInstall(expected, value) {
      // A write during teardown would race the config ownership the owner is
      // handing back, so a closed coordinator refuses it before it starts.
      if (closed) return { ok: false, error: new ConfigWriteError(ADMISSION_CLOSED_ERROR) };
      // The policy before the write, so the refresh after it publishes the
      // change even when nothing had asked for a view yet.
      livePolicy();
      const result = await deps.policy.write(expected, value);
      if (!result.ok) return result;
      // The effective policy, not the value just written: an environment
      // override can keep auto-install off whatever the file now says.
      refreshPolicy();
      return result;
    },

    refreshPolicy,

    start() {
      if (started || closed) return;
      started = true;
      // The resting status needs no check: the rollback's record states it.
      publish(restingStatus());
      if (deps.repository !== undefined) scheduleCheck(FIRST_CHECK_DELAY_MS);
    },

    run,

    closeAdmission() {
      closed = true;
      cancelScheduledCheck?.();
      cancelScheduledCheck = null;
      abortWith("closed");
    },

    async settled() {
      await inFlight?.catch(() => {});
    },
  };

  /** Records a run's outcome. A background check that repeats an unchanged
   *  outcome, such as "current" every half hour or the same network failure,
   *  is DEBUG; a changed one is a decision a person can ask about and records
   *  once. A check the person asked for always records: they are waiting for
   *  its answer. */
  function recordOutcome(result: UpdateRunResult, manual: boolean): void {
    const fields = { outcome: result.kind, manual, currentVersion: deps.currentVersion ?? "source", ...("version" in result ? { version: result.version } : {}), ...(result.kind === "failed" ? { reason: result.reason } : {}) };
    const key = JSON.stringify([result.kind, "version" in result ? result.version : undefined, result.kind === "failed" ? result.reason : undefined]);
    // A fresh or busy background run checked nothing: another process
    // answered recently or holds the work.
    if (!manual && (result.kind === "fresh" || result.kind === "busy" || key === lastOutcome)) {
      log.debug("update check settled", fields);
      return;
    }
    lastOutcome = key;
    log.info("update check settled", fields);
  }

  function run(options?: UpdateRunOptions): Promise<UpdateRunResult> {
    if (closed) return Promise.resolve({ kind: "cancelled" });
    const manual = options?.manual ?? false;
    if (options?.release !== undefined && inFlight !== null) return Promise.resolve({ kind: "busy" });
    inFlight ??= runOnce(manual, options?.release).then((result) => {
      recordOutcome(result, manual);
      return result;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Arms the next background check. Each fired timer re-arms after its run
   *  settles, so checks recur without overlapping: a run in flight is joined,
   *  never doubled. */
  function scheduleCheck(delayMs: number): void {
    if (closed || cancelScheduledCheck) return;
    cancelScheduledCheck = deps.scheduler.setTimer(() => {
      cancelScheduledCheck = null;
      void run().finally(() => { scheduleCheck(CHECK_INTERVAL_MS); });
    }, delayMs);
  }

  /** The build a rollback refused on this account, from its record, with its
   *  release version. */
  function refusedRelease(): { readonly build: BuildRef; readonly version: ReleaseVersion } | undefined {
    const build = deps.refusedBuild?.();
    const version = parseReleaseVersion(build?.version ?? "");
    return build === undefined || version === undefined ? undefined : { build, version };
  }

  /** The status with no release in play. While the rollback's record names a
   *  build newer than this one, the account runs an older release than one
   *  that could not start here, and `idle` would say it is up to date, so the
   *  status names the refused build instead: always the record's build, never
   *  a release a check found. A refused build of this build's own version but
   *  another build, such as a local rebuild, is the newer one this build runs
   *  in place of, so the status names it by its build too. A dev service that
   *  runs the proved snapshot in place of its checkout's source says that the
   *  source could not start. A source run compares with nothing, and a process that names no installed build of its own
   *  cannot tell a refused build of its version from itself, so each rests on
   *  `idle`. */
  function restingStatus(refused = refusedRelease()): UpdateStatus {
    if (deps.refusedSource !== undefined) return { kind: "source-refused", ...deps.refusedSource };
    if (deps.repository === undefined) return { kind: "no-repository" };
    const current = runningVersion();
    if (!current || !refused) return { kind: "idle" };
    const order = compareReleaseVersions(refused.version, current);
    if (isLaterRelease(refused.version, current)) return { kind: "refused", version: refused.version.canonical };
    if (order === 0 && deps.currentBuildId !== undefined && refused.build.buildId !== deps.currentBuildId) return { kind: "refused", version: refused.version.canonical, buildId: refused.build.buildId };
    return { kind: "idle" };
  }

  /** This build's own version, which it orders a release against, or
   *  nothing for a source run. A release build states the version its
   *  release named, and every release names one that `parseReleaseVersion`
   *  reads, because the build's directory is named after it. */
  function runningVersion(): ReleaseVersion | undefined {
    return deps.currentVersion === undefined ? undefined : parseReleaseVersion(deps.currentVersion);
  }

  async function runOnce(manual: boolean, release: string | undefined): Promise<UpdateRunResult> {
    if (deps.currentVersion === undefined) return failed("this is a source run, which states no release version, so it does not update");
    const currentVersion = runningVersion();
    if (!currentVersion) return failed(`this build states the version ${JSON.stringify(deps.currentVersion)}, which cannot name a build directory`);
    const assetName = platformAssetName(deps.platformArch);

    if (deps.repository === undefined) return failed("this build names no release repository, so it does not update");
    let repository;
    try {
      repository = parseRepositoryIdentity(deps.repository);
    } catch (error) {
      return failed(errorMessage(error));
    }

    const abort = new AbortController();
    controller = abort;
    abortReason = null;
    let authority: UpdateAuthority | undefined;
    // Whether this run ever owned the lease. Winning it once is the cadence for
    // collection: at most one collection per account per check.
    let leased = false;
    try {
      authority = deps.openAuthority();
      const claim = authority.claim({ nowMs: deps.scheduler.nowMs(), freshForMs: manual ? 0 : CHECK_FRESH_FOR_MS, leaseMs: LEASE_MS });
      if (claim.kind !== "won") return claim.kind === "fresh" ? { kind: "fresh" } : { kind: "busy" };
      leased = true;

      const found = await check({ repository, assetName, currentVersion, fetch: globalThis.fetch, scheduler: deps.scheduler, signal: abort.signal, ...(release === undefined ? {} : { release }) });
      if (abortReason) return { kind: "cancelled" };
      const refused = refusedRelease();
      if (found.kind === "unavailable") {
        // A publisher this process cannot reach is an ordinary outcome, so the
        // state returns to rest and nothing is committed: the next claimant
        // still has a check to make. It tells nothing about this machine, so
        // a release installed for the next launch stays the status.
        log.warn("update check found no usable release metadata", { reason: found.reason });
        if (status.kind !== "installed") publish(restingStatus(refused));
        return failed(found.reason);
      }
      if (found.kind === "current") {
        publish(restingStatus(refused));
        authority.commitCheck({ fence: claim.fence, checkedAtMs: deps.scheduler.nowMs() });
        return { kind: "current" };
      }

      // A rolled-back build ran here and its service could not start, so the
      // same release would only fail and roll back again. The account stays on
      // the build it returned to until a newer release is published.
      if (refused && !isLaterRelease(found.release.version, refused.version)) {
        publish(restingStatus(refused));
        authority.commitCheck({ fence: claim.fence, checkedAtMs: deps.scheduler.nowMs() });
        return { kind: "refused", version: found.release.version.canonical };
      }

      return await settleCandidate({ found, authority, fence: claim.fence, abort });
    } catch (error) {
      log.warn("update run failed", { error: errorMessage(error) });
      return failed(errorMessage(error));
    } finally {
      // Disposal hands back a lease this run still holds, so the next claimant
      // never waits out a lease no process is using.
      authority?.dispose();
      // After disposal, because collection claims the lease itself: it needs
      // that lease to order its removals against an activation, and this run's
      // lease is already concluded by whichever commit ended it. Every run that
      // won the fence collects, so an account that stopped updating still stops
      // accumulating; a run that withdrew does not, because a shutdown must not
      // wait on disk the next run can free. The collection is part of the run,
      // so the run's abort withdraws it and `settled()` waits for it.
      if (leased && !abortReason) await collect(abort.signal);
      controller = null;
    }
  }

  async function settleCandidate(context: {
    readonly found: Extract<UpdateCheckResult, { kind: "candidate" }>;
    readonly authority: UpdateAuthority;
    readonly fence: number;
    readonly abort: AbortController;
  }): Promise<UpdateRunResult> {
    const { found, authority, fence, abort } = context;
    const version = found.release.version.canonical;
    const installer = deps.installer;

    // A coordinator with no installer bound can discover a release but owns no way
    // to take it. Every platform Flywheel publishes a build for binds one, so
    // this is the notify-only case rather than a platform judgement made here.
    const cannotInstallHere = !installer;
    /** What stands between the account and this release, against a given
     *  policy. Derived on every publish rather than captured once, because a
     *  disable committed during the attempt changes what the user should be
     *  told to do next. */
    const availableAgainst = (policy: UpdateAutoInstall): Extract<UpdateStatus, { kind: "available" }> => ({
      kind: "available",
      version,
      blocking: cannotInstallHere ? "platform" : policy.effective ? "nothing" : "auto-install-off",
    });

    // The durable policy is re-read here, not carried from startup: another
    // process may have disabled auto-install since then.
    const admitted = deps.policy.read();
    const opening = availableAgainst(admitted);
    publish(opening, admitted);

    if (opening.blocking !== "nothing" || !installer) {
      authority.commitCheck({ fence, checkedAtMs: deps.scheduler.nowMs() });
      if (opening.blocking === "auto-install-off") return { kind: "policy-blocked", version };
      return { kind: "platform-blocked", version };
    }

    publish({ kind: "installing", version });
    const stopRenewal = renewWhileWorking(authority, fence);
    let outcome: UpdateInstallOutcome | undefined;
    let failure: unknown;
    try {
      outcome = await installer.install({ release: found.release, fence, signal: abort.signal });
    } catch (error) {
      failure = error;
    } finally {
      stopRenewal();
    }

    // `livePolicy()` is the live policy: it was read at admission and every
    // `refreshPolicy` since has replaced it, so the reason published here is
    // the reason that holds now.
    publish(outcome?.kind === "installed" && !abortReason ? { kind: "installed", version } : availableAgainst(livePolicy()));
    if (abortReason === "superseded") return { kind: "busy" };
    if (abortReason) return { kind: "cancelled" };
    if (failure !== undefined) {
      log.warn("update installation failed", { version, error: errorMessage(failure) });
      // The discovery itself succeeded, so the account's check timestamp is
      // committed: a failed install must not turn into a retry loop.
      authority.commitCheck({ fence, checkedAtMs: deps.scheduler.nowMs() });
      return failed(errorMessage(failure));
    }
    if (outcome?.kind === "revoked") {
      authority.commitCheck({ fence, checkedAtMs: deps.scheduler.nowMs() });
      return { kind: "available", version };
    }
    // A landed activation committed the check inside its own fenced
    // transaction, so nothing is committed over it here.
    return { kind: "installed", version };
  }

  async function collect(signal: AbortSignal): Promise<void> {
    try {
      await deps.installer?.collect(signal);
    } catch (error) {
      log.warn("build collection failed", { error: errorMessage(error) });
    }
  }

  /** Extends the lease while the install makes progress, and abandons the
   *  attempt the moment the fence is no longer this run's.
   *
   *  An authority that cannot answer is not a fence that moved. Contention, a
   *  full disk - which this very transfer can cause, because the staging tree
   *  and the authority share a filesystem - or any I/O error all mean "ask
   *  again later", so the tick is logged and the loop stays armed: abandoning
   *  a transfer that may have minutes left over one unanswered tick is the
   *  worse outcome. A lease that really did lapse costs nothing here either,
   *  because activation commits under the fence and refuses on its own. */
  function renewWhileWorking(authority: UpdateAuthority, fence: number): () => void {
    let cancel: (() => void) | null = null;
    const arm = (): void => {
      cancel = deps.scheduler.setTimer(() => {
        cancel = null;
        let renewal: UpdateLeaseRenewal;
        try {
          renewal = authority.renew({ fence, nowMs: deps.scheduler.nowMs(), leaseMs: LEASE_MS });
        } catch (error) {
          log.warn("update lease renewal did not answer", { fence, error: errorMessage(error) });
          arm();
          return;
        }
        if (renewal === "held") arm();
        // Only another claimant's fence ends this attempt. A lease concluded
        // under this fence was concluded by this run's own installer, whose
        // activation committed through its own handle, so the install is done
        // and its outcome decides what is published.
        else if (renewal === "superseded") abortWith("superseded");
      }, LEASE_RENEWAL_MS);
    };
    arm();
    return () => { cancel?.(); cancel = null; };
  }
}

function failed(reason: string): UpdateRunResult {
  return { kind: "failed", reason };
}

function sameStatus(a: UpdateStatus, b: UpdateStatus): boolean {
  if (a.kind === "idle" && b.kind === "idle") return true;
  if (a.kind === "no-repository" && b.kind === "no-repository") return true;
  if (a.kind === "refused" && b.kind === "refused") return a.version === b.version && a.buildId === b.buildId;
  if (a.kind === "source-refused" && b.kind === "source-refused") return a.refused === b.refused && a.running === b.running;
  if (a.kind === "available" && b.kind === "available") return a.version === b.version && a.blocking === b.blocking;
  if (a.kind === "installing" && b.kind === "installing") return a.version === b.version;
  if (a.kind === "installed" && b.kind === "installed") return a.version === b.version;
  return false;
}

function samePolicy(a: UpdateAutoInstall, b: UpdateAutoInstall): boolean {
  return a.persisted === b.persisted && a.forcedOff === b.forcedOff && a.effective === b.effective;
}
