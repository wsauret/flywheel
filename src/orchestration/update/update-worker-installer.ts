/** The account service's update installer: the same installer `flywheel
 *  update` runs, moved onto an owned Worker for each job.
 *
 *  The account service shares its event loop with every client it serves, and
 *  an install or a collection holds its thread for seconds of synchronous file
 *  work. So this installer does none of that work here. Each `install` starts
 *  one update Worker, hands it the job, and answers with what the Worker
 *  reports (`update-worker.ts`); the coordinator asks for an install only once
 *  it admitted a newer release. A `collect` first runs the cheap survey here,
 *  a read of the versions root, and starts a Worker only when the survey
 *  found something to remove. The Worker ends with its job, so an
 *  account that checks every half hour and has nothing to collect starts no
 *  Worker between checks.
 *
 *  The Worker opens no log file of its own. Each record it writes arrives here
 *  as a frame on the job's port and is written to the account service's one
 *  stream, so a job adds no file to the account's log directory.
 *
 *  The commands an install runs, the macOS quarantine clear and the service
 *  registration, belong to the account service and never to a project
 *  executor: each job opens one generation on the account guardian, the Worker
 *  launches into it through the owned-process bridge, and the job closes it
 *  before it answers. So an executor that exits cuts no install, and no
 *  process an install started outlives the outcome the service publishes. */

import { createBoundedWorkerSpawner } from "../../infra/bounded-worker-spawner.js";
import { DebugLog, parseForwardedLogRecord } from "../../infra/debug-log.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { serveOwnedProcessBridge, type OwnedProcessBridge } from "../../infra/owned-process-bridge.js";
import type { GuardianControl } from "../../infra/process-supervisor.js";
import { terminateWorker } from "../../infra/worker-termination.js";
import { buildCollectionPending } from "../../infra/update/build-retention.js";
import type { UpdateInstaller } from "./update-service.js";
import { windowsLauncherCollectionPending } from "./windows-install.js";
import type { UpdateWorkerControl, UpdateWorkerFrame, UpdateWorkerInit, UpdateWorkerInstallation, UpdateWorkerJob, UpdateWorkerSettlement } from "./update-worker.js";

const log = Log.create({ service: "update-worker-installer" });

export interface UpdateWorkerInstallerOptions {
  /** The one Worker entry of this build. */
  readonly workerUrl: string;
  /** The account service's guardian. Every command a job runs is leased into
   *  a generation of it that the job opens and closes. */
  readonly guardian: GuardianControl;
  readonly installation: UpdateWorkerInstallation;
}

export function createUpdateWorkerInstaller(options: UpdateWorkerInstallerOptions): UpdateInstaller {
  return {
    async install(request) {
      const settlement = await runUpdateWorkerJob(options, { kind: "install", release: request.release, fence: request.fence }, request.signal);
      if (settlement.kind === "installed" || settlement.kind === "revoked") return { kind: settlement.kind };
      throw new Error(settlement.kind === "failed" ? settlement.message : `the update Worker answered an install with ${settlement.kind}`);
    },
    async collect(signal) {
      if (!collectionPending(options.installation)) return;
      const settlement = await runUpdateWorkerJob(options, { kind: "collect" }, signal);
      if (settlement.kind === "failed") throw new Error(settlement.message);
    },
  };
}

/** Whether a collection on this installation would find anything to remove,
 *  answered on this thread by the survey, which removes nothing: the versions
 *  root on every platform, and on Windows the launcher directory too. */
function collectionPending(installation: UpdateWorkerInstallation): boolean {
  if (installation.platform === "win32" && windowsLauncherCollectionPending(installation.wrapperDir)) return true;
  return buildCollectionPending({ userDataRoot: installation.userDataRoot, platform: installation.platform });
}

/** Starts one Worker for one job and joins it. The Worker, its bridge, and
 *  the guardian generation behind the bridge are all released before this
 *  answers, whatever the job did. */
async function runUpdateWorkerJob(options: UpdateWorkerInstallerOptions, job: UpdateWorkerJob, signal: AbortSignal): Promise<UpdateWorkerSettlement> {
  // A job withdrawn before it starts is done: it starts no Worker to be told.
  if (signal.aborted) return job.kind === "install" ? { kind: "revoked" } : { kind: "collected" };
  // The `update-installer` budget of one generation applies per job: each job
  // takes a spawner of its own and never starts a second Worker. The
  // coordinator runs one job at a time, so at most one update Worker is ever
  // live in the account service.
  const spawn = createBoundedWorkerSpawner("update-installer");
  const worker = spawn(options.workerUrl, { name: "flywheel-update", ref: false, smol: true });
  DebugLog.record({ type: "runtime.worker.allocated", payload: { kind: "update" } });
  const closed = new Promise<void>((resolve) => { worker.addEventListener("close", () => { resolve(); }, { once: true }); });
  const settled = Promise.withResolvers<UpdateWorkerSettlement>();
  let bridge: OwnedProcessBridge | undefined;
  let reported = false;
  let ready = false;
  const post = (control: UpdateWorkerControl): void => { worker.postMessage(control, []); };
  // A withdrawal is posted only once the Worker listens for it: a frame sent
  // while the Worker still loads its role would reach no listener.
  const withdraw = (): void => { if (ready) post({ flywheel: "update.cancel" }); };
  worker.addEventListener("message", (event) => {
    const frame = workerFrame(event.data);
    if (frame?.flywheel === "update.log") DebugLog.record(frame.record);
    if (frame?.flywheel === "update.ready") {
      ready = true;
      if (signal.aborted) withdraw();
    }
    if (frame?.flywheel === "update.settled") {
      reported = true;
      settled.resolve(frame.settlement);
    }
  });
  worker.addEventListener("error", (event) => {
    settled.resolve({ kind: "failed", message: `the update Worker failed: ${event.message || "it reported no cause"}` });
  });
  void closed.then(() => {
    bridge?.peerExited();
    settled.resolve({ kind: "failed", message: "the update Worker ended before its job settled" });
  });
  signal.addEventListener("abort", withdraw, { once: true });
  try {
    const ownership = new MessageChannel();
    bridge = serveOwnedProcessBridge({ port: ownership.port1, guardian: options.guardian });
    const init: UpdateWorkerInit = { flywheel: "update.init", ownership: ownership.port2, installation: options.installation, job };
    worker.postMessage(init, [ownership.port2]);
    return await settled.promise;
  } catch (error) {
    return { kind: "failed", message: errorMessage(error) };
  } finally {
    signal.removeEventListener("abort", withdraw);
    const closure = await bridge?.close();
    if (closure && !closure.settled) log.warn("an update job's commands did not prove settlement", { reason: closure.reason });
    // A Worker that reported its job is idle and ends itself. One that did
    // not report may be wedged, so it is ended here.
    if (reported) {
      post({ flywheel: "update.exit" });
      await closed;
    } else {
      await terminateWorker(worker);
    }
  }
}

function workerFrame(data: unknown): UpdateWorkerFrame | undefined {
  if (typeof data !== "object" || data === null || !("flywheel" in data)) return undefined;
  if (data.flywheel === "update.ready") return { flywheel: "update.ready" };
  if (data.flywheel === "update.log") {
    const record = "record" in data ? parseForwardedLogRecord(data.record) : undefined;
    return record && { flywheel: "update.log", record };
  }
  if (data.flywheel !== "update.settled" || !("settlement" in data)) return undefined;
  const settlement = updateSettlement(data.settlement);
  return settlement && { flywheel: "update.settled", settlement };
}

function updateSettlement(value: unknown): UpdateWorkerSettlement | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value)) return undefined;
  if (value.kind === "installed" || value.kind === "revoked" || value.kind === "collected") return { kind: value.kind };
  if (value.kind === "failed" && "message" in value && typeof value.message === "string") return { kind: "failed", message: value.message };
  return undefined;
}
