/** The proof that a build works on this machine, and the return from a build
 *  that cannot open any project here (ARCH-DISTRIBUTION-024).
 *
 *  A build proves itself only when one of its project executors reports
 *  ready: an account service that listens can still be unable to open a
 *  single project. The account service holds one fallback for the build it
 *  runs, and every project tells it two things: that an executor generation
 *  reported ready, and that the project failed to open by a failure of its
 *  own, which is its state Worker ending before it served, or a generation's
 *  own exit or crash or a wedge the account proved before it reported ready.
 *  A stop the account asks for, an external
 *  signal, a lost guardian or channel, and an error on the account's side
 *  are never a failed open.
 *
 *  The first ready generation in this process records the proof: the start
 *  record names the installed build, and the dev lane's proof record names
 *  the snapshot. After it, nothing counts, so a later failure of one project
 *  is that project's crash loop, which its executor state reports. Until it,
 *  three failed opens in a row, across every project, return the lane to its
 *  proved build. The installed lane moves `current` back through the
 *  rollback of the install engine, which records the failed build as
 *  refused; the dev lane records the failed snapshot as refused, so the next
 *  dev entry runs the proved snapshot. Either lane then leaves through its
 *  replacement owner, so clients reconnect on their own and the work the cut
 *  interrupts continues on the build the lane returns to. Once the lane
 *  returns, a generation that reports ready later proves nothing: the build
 *  is refused, and a refused build is never recorded as proved.
 *
 *  The return has three outcomes. It returns; it stays for good, because no
 *  other build is proved, this build is itself the proved one, `current` no
 *  longer names it or cannot be written, or the proved build is gone, and
 *  says why once; or it cannot return now, such as while an update check
 *  holds the account update lease, the update state cannot be read, or
 *  Windows readers hold `current` past the rename's bound, and the next
 *  failed open asks again.
 *
 *  Each lane's records load lazily: an installed service never loads the
 *  source snapshot module, and neither lane loads the install engine until
 *  it returns. */

import type { SourceSnapshotLocation } from "../../infra/cli-subprocess.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import type { BuildRef } from "../../infra/update/build-identity.js";
import { ownBuild } from "../../infra/update/live-builds.js";
import { provedBuild, recordBuildProved } from "../../infra/update/service-start-record.js";
import type { RollbackKeptCause } from "./install-engine.js";
import { refusedBuild } from "./refused-build.js";

const log = Log.create({ service: "build-fallback" });

/** The refusals of a rollback that clear by themselves, so the next failed
 *  open asks again (`RollbackKeptCause`). */
const CLEARS_BY_ITSELF: ReadonlySet<RollbackKeptCause> = new Set(["lease-held", "state-unusable", "activation-busy"]);

/** How many project executors of an unproved build in a row may end before
 *  they report ready. The one that reaches it returns the lane. */
const FAILED_OPENS_BEFORE_RETURN = 3;

/** What every project's state Worker and executor generations tell the
 *  build's fallback. */
export interface BuildProof {
  /** A project executor of this build reported ready. */
  executorReady(): void;
  /** A project of this build failed to open by a failure of its own: its
   *  state Worker ended before it served, or an executor ended before it
   *  reported ready. */
  failedToOpen(): void;
}

/** What asked for the replacement that returns a lane to its proved build,
 *  recorded once with the request. */
export interface BuildFallbackTrigger {
  readonly kind: "build could not open a project";
  readonly failedBuild: string;
  readonly provedBuild: string;
  readonly failedOpens: number;
}

/** The build an account service runs: an installed build, named by the
 *  executable the service runs (the process's own when absent), or the
 *  snapshot a dev service runs from. */
export type FallbackBuild =
  | { readonly lane: "installed"; readonly userDataRoot: string; readonly execPath?: string }
  | { readonly lane: "dev"; readonly snapshot: SourceSnapshotLocation };

/** How one attempt to return a lane to its proved build ended. */
type LaneReturn =
  | { readonly kind: "returned"; readonly proved: string; readonly unrecorded?: string }
  /** The lane stays for good: no other build is proved, or this one is. */
  | { readonly kind: "stays"; readonly reason: string }
  /** The lane cannot return now; the next failed open asks again. */
  | { readonly kind: "retries"; readonly reason: string };

/** How one lane records its proof and returns to its proved build. */
interface FallbackLane {
  /** The build or snapshot this service runs, as its records name it. */
  readonly build: string;
  /** Records the proof, and answers whether the build is now proved: a
   *  refused build, or a record that cannot be written, proves nothing. */
  prove(): Promise<boolean>;
  returnToProved(reason: string): Promise<LaneReturn>;
}

function installedLane(userDataRoot: string, build: BuildRef): FallbackLane {
  return {
    build: build.buildId,
    prove: async () => refusedBuild(userDataRoot)?.buildId !== build.buildId && recordBuildProved(userDataRoot, build),
    async returnToProved(reason) {
      // The two lasting reasons of the start record are decided here, so an
      // installed service that no build can return to never loads the engine.
      const proved = provedBuild(userDataRoot);
      if (proved === undefined) return { kind: "stays", reason: "no build is proved on this account" };
      if (proved.buildId === build.buildId) return { kind: "stays", reason: "this build is proved on this account" };
      const { rollBackActivation } = await import("./install-engine.js");
      const outcome = rollBackActivation({ userDataRoot, failed: build, reason, nowMs: Date.now() });
      // Only a refusal that clears by itself is asked again.
      if (outcome.kind === "kept") return { kind: CLEARS_BY_ITSELF.has(outcome.cause) ? "retries" : "stays", reason: outcome.reason };
      return { kind: "returned", proved: outcome.to.buildId, ...(outcome.unrecorded === undefined ? {} : { unrecorded: outcome.unrecorded }) };
    },
  };
}

function devLane(snapshot: SourceSnapshotLocation): FallbackLane {
  return {
    build: snapshot.digest,
    prove: async () => (await import("../../infra/source-snapshot.js")).recordSnapshotProved(snapshot),
    returnToProved: async (reason) => (await import("../../infra/source-snapshot.js")).refuseSourceSnapshot(snapshot, reason),
  };
}

/** The fallback of the build this account service runs, or nothing for an
 *  installed service that runs no installed build: it has no build to prove
 *  or to leave. */
export function createBuildFallback(options: {
  readonly build: FallbackBuild;
  /** Asks the account's replacement owner to make way for the proved build. */
  readonly request: (trigger: BuildFallbackTrigger) => Promise<"busy" | "retiring">;
}): BuildProof | undefined {
  const { build } = options;
  const installed = build.lane === "installed" ? ownBuild(build.userDataRoot, build.execPath) : undefined;
  const lane = build.lane === "dev" ? devLane(build.snapshot) : installed === undefined ? undefined : installedLane(build.userDataRoot, installed);
  if (lane === undefined) return undefined;
  const evidence = { lane: build.lane, build: lane.build };
  let proved = false;
  let failedOpens = 0;
  /** The lane returned, so the build is refused and nothing it does counts. */
  let returned = false;
  /** The lane stays for good, so no failed open asks again; a generation
   *  that reports ready still proves the build. */
  let stays = false;
  /** An attempt to return is in flight. */
  let returning = false;
  /** A generation reported ready while an attempt was in flight. */
  let readyWhileReturning = false;
  let retries = 0;

  const prove = (): void => {
    proved = true;
    void lane.prove().then((recorded) => {
      if (recorded) log.info("the build proved itself on this machine: one of its project executors reported ready", evidence);
    }, (error: unknown) => {
      log.warn("the proof of this build could not be recorded", { ...evidence, error: errorMessage(error) });
    });
  };

  const returnToProved = async (): Promise<void> => {
    // The count this attempt decides on; failed opens during it ask again.
    const opens = failedOpens;
    const outcome = await lane.returnToProved(`its project executors stopped before they were ready ${opens} times in a row`);
    if (outcome.kind === "retries") {
      // Each failed open after the limit asks again, so only the first
      // refusal is recorded in full.
      retries += 1;
      const fields = { ...evidence, failedOpens: opens, retries, reason: outcome.reason };
      if (retries === 1) log.info("the build could not open a project too many times in a row, and it cannot return to the last proved build now; the next failed open asks again", fields);
      else log.debug("the build still cannot return to the last proved build", fields);
      return;
    }
    if (outcome.kind === "stays") {
      stays = true;
      log.info("the build could not open a project too many times in a row, and it stays", { ...evidence, failedOpens: opens, reason: outcome.reason });
      return;
    }
    returned = true;
    log.warn("the build could not open a project too many times in a row; the account returns to the last proved build", { ...evidence, failedOpens: opens, proved: outcome.proved, ...(outcome.unrecorded === undefined ? {} : { unrecorded: outcome.unrecorded }) });
    await options.request({ kind: "build could not open a project", failedBuild: lane.build, provedBuild: outcome.proved, failedOpens: opens });
  };

  return {
    executorReady() {
      if (proved || returned) return;
      if (returning) {
        readyWhileReturning = true;
        return;
      }
      prove();
    },
    failedToOpen() {
      if (proved || returned || stays) return;
      failedOpens += 1;
      if (failedOpens < FAILED_OPENS_BEFORE_RETURN || returning) return;
      returning = true;
      void returnToProved().catch((error: unknown) => {
        log.warn("the return to the last proved build failed", { ...evidence, failedOpens, error: errorMessage(error) });
      }).finally(() => {
        returning = false;
        // A generation that became ready while the attempt ran proves the
        // build, unless the lane returned and so refused it.
        if (readyWhileReturning && !returned) prove();
        readyWhileReturning = false;
      });
    },
  };
}
