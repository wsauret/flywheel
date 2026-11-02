/** The update Worker: the thread where the account's byte-heavy update work
 *  runs.
 *
 *  An update transfers, digests, copies, and syncs a build tree of more than a
 *  hundred megabytes, and a collection removes whole build trees. Each of those
 *  is synchronous file work that holds its thread for seconds, so none of it
 *  runs on a thread that serves a runtime (ARCH-RUNTIME-010, ARCH-RUNTIME-043). The account
 *  service starts one of these Workers for each install of an admitted release
 *  and each collection its survey found work for, hands it one job, and ends
 *  it when the job settles, so an account holds no idle update thread between
 *  runs. The Worker opens no log file: each record it writes travels to the
 *  account service, which writes it to the account's one stream.
 *
 *  The Worker runs the same installer `flywheel update` runs on its own thread.
 *  It owns nothing the account service decides: the service keeps the check,
 *  the policy admission, and the lease, and the Worker is handed the fence that
 *  run won. It opens its own handle on the account authority to commit under
 *  that fence, and its own policy store to ask the policy again inside the
 *  activation window. The commands the install runs launch here, because a
 *  command's streams cannot cross a thread, but they belong to a generation of
 *  the account service's guardian that the service opened for this job and
 *  closes when the job settles. */

import type { DebugLogRecordInput } from "../../infra/debug-log.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { connectOwnedProcessBridge } from "../../infra/owned-process-bridge.js";
import { updateAuthorityDbFile } from "../../infra/paths.js";
import type { SelectedRelease } from "../../infra/update/release-manifest.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "../../infra/update/update-authority.js";
import type { WorkerSelf } from "../app-service/bun-worker-rpc.js";
import { systemUpdateScheduler } from "./update-check.js";
import { createUpdateInstaller } from "./update-install.js";
import { createUpdatePolicyStore } from "./update-policy.js";
import type { UpdateInstaller } from "./update-service.js";

/** Where the installer places builds and publishes the launcher. The account
 *  service decides these once, from its own startup directories. */
export interface UpdateWorkerInstallation {
  readonly userDataRoot: string;
  readonly wrapperDir: string;
  readonly platform: string;
  readonly platformArch: string;
}

/** The one job a Worker is started for. */
export type UpdateWorkerJob =
  | { readonly kind: "install"; readonly release: SelectedRelease; readonly fence: number }
  | { readonly kind: "collect" };

/** How the job ended. A failure carries only its message: the service logs it
 *  and tells the user nothing more. */
export type UpdateWorkerSettlement =
  | { readonly kind: "installed" }
  | { readonly kind: "revoked" }
  | { readonly kind: "collected" }
  | { readonly kind: "failed"; readonly message: string };

export interface UpdateWorkerInit {
  readonly flywheel: "update.init";
  /** The Worker's end of the owned-process bridge to the account guardian. */
  readonly ownership: MessagePort;
  readonly installation: UpdateWorkerInstallation;
  readonly job: UpdateWorkerJob;
}

/** Frames the Worker posts. `update.ready` says the Worker hears a
 *  withdrawal, `update.log` carries one diagnostics record to the account
 *  service's log stream, and `update.settled` carries the job's outcome. All
 *  three travel on the one Worker port, so every record the job wrote arrives
 *  before its outcome. */
export type UpdateWorkerFrame =
  | { readonly flywheel: "update.ready" }
  | { readonly flywheel: "update.log"; readonly record: DebugLogRecordInput }
  | { readonly flywheel: "update.settled"; readonly settlement: UpdateWorkerSettlement };

/** Frames the account service posts after the init frame. `update.cancel`
 *  withdraws the job; `update.exit` follows the close of the job's command
 *  generation and ends the Worker. A withdrawal is not the end of that
 *  generation: the job keeps its commands until it reports, so a withdrawal
 *  never ends an activation part way (ARCH-RUNTIME-043). */
export type UpdateWorkerControl = { readonly flywheel: "update.cancel" } | { readonly flywheel: "update.exit" };

const log = Log.create({ service: "update-worker" });

/** Runs the one job `init` names and reports how it ended. */
export async function runUpdateWorker(worker: WorkerSelf, init: UpdateWorkerInit): Promise<void> {
  // The listener comes first, so a withdrawal the service sends as soon as it
  // reads `update.ready` is never posted to a Worker that cannot hear it.
  const withdrawal = new AbortController();
  worker.addEventListener("message", (event) => {
    const control = controlName(event.data);
    if (control === "update.cancel") withdrawal.abort();
    if (control === "update.exit") process.exit(0);
  });
  // The job opens no log file: the account service owns the account's one
  // stream, and a file per job would be a file per check.
  await Log.init({ forward: (record) => { worker.postMessage({ flywheel: "update.log", record } satisfies UpdateWorkerFrame, []); } });
  worker.postMessage({ flywheel: "update.ready" } satisfies UpdateWorkerFrame, []);

  const { userDataRoot } = init.installation;
  const policy = createUpdatePolicyStore(userDataRoot);
  const installer = createUpdateInstaller({
    ...init.installation,
    scheduler: systemUpdateScheduler,
    policy,
    launcher: connectOwnedProcessBridge({ port: init.ownership }).launcher,
    openAuthority: () => createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) }),
  });
  let settlement: UpdateWorkerSettlement;
  try {
    settlement = await runJob(installer, init.job, withdrawal.signal);
  } catch (error) {
    settlement = { kind: "failed", message: errorMessage(error) };
  } finally {
    await policy.dispose().catch((error: unknown) => { log.warn("update policy store did not close", { error: errorMessage(error) }); });
  }
  worker.postMessage({ flywheel: "update.settled", settlement } satisfies UpdateWorkerFrame, []);
}

async function runJob(installer: UpdateInstaller, job: UpdateWorkerJob, signal: AbortSignal): Promise<UpdateWorkerSettlement> {
  if (job.kind === "collect") {
    await installer.collect(signal);
    return { kind: "collected" };
  }
  return installer.install({ release: job.release, fence: job.fence, signal });
}

function controlName(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("flywheel" in data)) return undefined;
  return typeof data.flywheel === "string" ? data.flywheel : undefined;
}
