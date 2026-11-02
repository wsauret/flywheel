/** The account's updates: the one update coordinator an account runs, composed
 *  once in the account service (ARCH-RUNTIME-043).
 *
 *  Update work is account-wide. The check, the install, and the collection of
 *  old builds concern the one installation every project runs from, so they
 *  run once per account, in the process that lives as long as the account
 *  does, whether or not a project is open. No project executor composes any
 *  of it, so an executor that exits cuts no install.
 *
 *  The coordinator decides on the account service's event loop, which is cheap
 *  work: a request, a lease, and a policy read. Everything byte-heavy runs on
 *  the update Worker (`update-worker-installer.ts`). Every open project serves
 *  the one published view to its clients and routes the auto-install setting
 *  here, so the view and the policy have one owner for the whole account.
 *
 *  The coordinator holds no config watch. The account service's one watch on
 *  the account config file calls `refreshPolicy`, so the account process
 *  watches that file once (ARCH-RUNTIME-058). */

import type { StartupDirectories } from "../../infra/directory-authorities.js";
import { buildPlatformArch } from "../../infra/native-assets.js";
import { updateAuthorityDbFile } from "../../infra/paths.js";
import type { GuardianControl } from "../../infra/process-supervisor.js";
import { ownBuildId } from "../../infra/update/live-builds.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "../../infra/update/update-authority.js";
import { wrapperDirectory } from "../../infra/update/wrapper-directory.js";
import { updateRepository } from "../../protocol/installation.js";
import type { UpdateStatusView } from "../../protocol/update-protocol-types.js";
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js";
import { startReleaseNotice } from "./release-notice.js";
import { systemUpdateScheduler } from "./update-check.js";
import { createUpdatePolicyStore } from "./update-policy.js";
import { refusedBuild } from "./refused-build.js";
import { createUpdateService, type UpdateService } from "./update-service.js";
import { createUpdateWorkerInstaller } from "./update-worker-installer.js";

export interface AccountUpdates extends Pick<UpdateService, "status" | "setAutoInstall" | "refreshPolicy"> {
  /** Starts the updater and the deferred notice, using the account's existing config owner. */
  start(config: RuntimeConfigOwner): void;
  /** Hears every view the coordinator publishes from now on. An open project
   *  subscribes for its lifetime and publishes each view to its clients. */
  subscribe(listener: (view: UpdateStatusView) => void): () => void;
  /** Closes admission, withdraws the run in flight, and resolves once no
   *  update work runs. Repeated calls join the first. */
  dispose(): Promise<void>;
}

export interface AccountUpdatesOptions extends Pick<StartupDirectories, "userDataRoot" | "accountHome"> {
  /** The one Worker entry of this build, which the installer's jobs run on. */
  readonly workerUrl: string;
  /** The account service's guardian, which owns every command an install
   *  runs. */
  readonly guardian: GuardianControl;
  /** Present while a dev service runs the proved snapshot `running` of its
   *  checkout because the checkout's source `refused` could not start
   *  (ARCH-DISTRIBUTION-030). */
  readonly refusedSource?: { readonly refused: string; readonly running: string };
}

/** Composes the coordinator. Composition is state only: it reads no
 *  configuration, opens no lease, makes no request, and starts no Worker, so
 *  the service composes it before it listens and calls `start()` after. */
export function createAccountUpdates(options: AccountUpdatesOptions): AccountUpdates {
  const { userDataRoot, accountHome } = options;
  const listeners = new Set<(view: UpdateStatusView) => void>();
  const repository = updateRepository();
  let releaseNotice: UpdateStatusView["releaseNotice"];
  let noticeRevision = 0;
  let notice: ReturnType<typeof startReleaseNotice> | undefined;
  let started = false;
  const view = (): UpdateStatusView => {
    const update = service.status();
    // A refusal can arrive after the notice settled, while an older release
    // serves in place of a newer build that failed (UPD-008, UPD-012).
    const showNotice = releaseNotice !== undefined && update.status.kind !== "refused";
    return { ...update, revision: update.revision + noticeRevision, ...(showNotice ? { releaseNotice } : {}) };
  };
  const publish = (): void => { for (const listener of listeners) listener(view()); };
  // One store answers the policy for the account's admission here, and the
  // Worker's installer opens its own to ask again inside activation. This one
  // never revalidates, so it never builds the config owner that would need.
  const policy = createUpdatePolicyStore(userDataRoot);
  const platformArch = buildPlatformArch();
  // The installed build this service runs, which tells a refused build of
  // its own version apart from itself.
  const currentBuildId = ownBuildId(userDataRoot);
  const service = createUpdateService({
    // The version the build states about itself, substituted at binary build
    // time. Its absence is what marks a source run, whose runs refuse before
    // any request rather than treating every release as newer.
    currentVersion: process.env.FLYWHEEL_APP_VERSION,
    platformArch,
    // Selecting another publisher changes the trust root, which is why it is
    // an explicit override rather than a config field (ARCH-DISTRIBUTION-007).
    // A build that names no repository never checks (ARCH-DISTRIBUTION-034).
    repository,
    policy,
    openAuthority: () => createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) }),
    installer: createUpdateWorkerInstaller({
      workerUrl: options.workerUrl,
      guardian: options.guardian,
      installation: {
        userDataRoot,
        wrapperDir: wrapperDirectory(process.env.FLYWHEEL_INSTALL_DIR, accountHome),
        platform: process.platform,
        platformArch,
      },
    }),
    refusedBuild: () => refusedBuild(userDataRoot),
    ...(currentBuildId === undefined ? {} : { currentBuildId }),
    ...(options.refusedSource === undefined ? {} : { refusedSource: options.refusedSource }),
    scheduler: systemUpdateScheduler,
    publish,
  });
  let disposal: Promise<void> | undefined;
  return {
    status: view,
    setAutoInstall: service.setAutoInstall,
    refreshPolicy: service.refreshPolicy,
    start(config) {
      if (disposal !== undefined || started) return;
      started = true;
      service.start();
      // A build with no release repository has no release notes to read.
      if (service.status().status.kind === "refused" || repository === undefined) return;
      notice = startReleaseNotice({
        owner: config,
        currentVersion: process.env.FLYWHEEL_APP_VERSION,
        repository,
        fetch: globalThis.fetch,
        scheduler: systemUpdateScheduler,
        publish(next) {
          if (JSON.stringify(releaseNotice) === JSON.stringify(next)) return;
          releaseNotice = next;
          noticeRevision += 1;
          publish();
        },
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      disposal ??= (async () => {
        service.closeAdmission();
        listeners.clear();
        try {
          await Promise.all([service.settled(), notice?.dispose()]);
        } finally {
          await policy.dispose();
        }
      })();
      return disposal;
    },
  };
}
