/** `flywheel update`: the manual entry to the one update coordinator.
 *
 *  This command owns no update logic. It builds the same service the account
 *  service builds, with the same account authority, the same durable policy,
 *  and the same installer, and asks it for one manual run (ARCH-RUNTIME-043, ARCH-DISTRIBUTION-020). So a
 *  manual update and a background one take the same lease, obey the same
 *  policy, and install through the same installer for the platform; the only
 *  differences are that this one reports what happened, because an operator
 *  asked, and that it runs the installer on its own thread, because a
 *  one-shot command serves nothing else.
 *
 *  Every outcome is one truthful line. A manual run is a check, not an
 *  override: it obeys the same durable `updates.auto_install` control, so a
 *  policy that forbids installing is reported as guidance and nothing is
 *  downloaded and nothing is written. The durable setting is the user's, and a
 *  command that quietly turned it back on would be worse than one that
 *  refuses. */

import type { AccountDirectories, StartupDirectories } from "../infra/directory-authorities.js";
import { buildPlatformArch } from "../infra/native-assets.js";
import { updateAuthorityDbFile } from "../infra/paths.js";
import type { LauncherContext } from "../infra/process-supervisor.js";
import { ownBuildId } from "../infra/update/live-builds.js";
import { createUpdateAuthority, UPDATE_PROTOCOL_VERSION } from "../infra/update/update-authority.js";
import { refusedBuild } from "../orchestration/update/refused-build.js";
import { systemUpdateScheduler } from "../orchestration/update/update-check.js";
import { updateRepository } from "../protocol/installation.js";
import { createUpdateInstaller } from "../orchestration/update/update-install.js";
import { wrapperDirectory } from "../infra/update/wrapper-directory.js"

import { createUpdatePolicyStore } from "../orchestration/update/update-policy.js";
import { createUpdateService, type UpdateService } from "../orchestration/update/update-service.js";

const USAGE = `Usage: flywheel update

Check the release channel for a newer Flywheel and install it. On macOS and
Linux the installed build is account-global and the running Flywheel keeps its
own build until it is restarted. On Windows the installation is replaced in
place by the installer, so restart Flywheel before using it again.

This command checks on demand. It does not bypass the durable update control:
while automatic updates are off, it reports what is available and installs
nothing.

Options:
  -h, --help    Show this help and exit.`;

export type UpdateRunResult = Awaited<ReturnType<UpdateService["run"]>>;

/** One line for the operator, and whether the command failed. Kept apart from
 *  the wiring so every outcome's wording is decided in one readable place. */
export interface UpdateReport {
  readonly message: string;
  readonly failed: boolean;
}

export function updateReport(result: UpdateRunResult, currentVersion: string): UpdateReport {
  switch (result.kind) {
    case "installed":
      return { message: `Flywheel ${result.version} is installed. Restart Flywheel to use it.`, failed: false };
    case "available":
      return { message: `Flywheel ${result.version} is available, and was not installed.`, failed: false };
    case "policy-blocked":
      return {
        message: `Flywheel ${result.version} is available. Automatic updates are off, so nothing was downloaded. Turn them on in Flywheel settings to install it.`,
        failed: false,
      };
    case "platform-blocked":
      return {
        message: `Flywheel ${result.version} is available. This Flywheel installs no updates itself, so nothing was downloaded. Run the installer again to update.`,
        failed: false,
      };
    case "refused":
      return {
        message: `Flywheel ${result.version} is available, but it was rolled back on this account because it could not start its account service or could not open any project here, so it is not installed again. A newer release installs normally.`,
        failed: false,
      };
    case "current":
      return { message: `Flywheel ${currentVersion} is the newest release.`, failed: false };
    case "fresh":
      return { message: "This account checked for updates recently, and nothing newer was published.", failed: false };
    case "busy":
      return { message: "Another Flywheel process is updating this account. Try again shortly.", failed: false };
    case "cancelled":
      return { message: "The update was cancelled.", failed: true };
    case "failed":
      return { message: `The update could not be completed: ${result.reason}`, failed: true };
  }
}

export async function runUpdate(args: readonly string[], directories: StartupDirectories, launcher: LauncherContext): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const unexpected = args[0];
  if (unexpected !== undefined) {
    console.error(`Unknown update argument: ${unexpected}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  // The version the build states about itself, substituted at binary build
  // time. Its absence is what marks a source run, which refuses before any
  // request rather than treating every release as newer.
  const currentVersion = process.env.FLYWHEEL_APP_VERSION;
  const result = await withUpdateService(directories, launcher, (service) => service.run({ manual: true }));
  const report = updateReport(result, currentVersion ?? "source");
  if (report.failed) {
    console.error(report.message);
    process.exitCode = 1;
    return;
  }
  console.log(report.message);
}

/** Installs one named release through the same coordinator, policy, and
 *  installer as `flywheel update`, as a terminal does before it runs the
 *  release of the remote machine it reaches (PI-REMOTE-016). */
export function installRelease(directories: AccountDirectories, launcher: LauncherContext, release: string): Promise<UpdateRunResult> {
  return withUpdateService(directories, launcher, (service) => service.run({ manual: true, release }));
}

/** Why a run that should have installed `release` did not, in one line a
 *  person can act on. */
export function releaseInstallRefusal(result: UpdateRunResult, release: string): string {
  switch (result.kind) {
    case "installed":
      return `Flywheel ${release} is installed.`;
    case "policy-blocked":
      return `Automatic updates are off, so Flywheel ${release} was not installed. Turn them on in Flywheel settings, then open the project again.`;
    case "platform-blocked":
      return `This Flywheel installs no updates itself. Run the installer for Flywheel ${release}, then open the project again.`;
    case "refused":
      return `Flywheel ${release} was rolled back on this account because it could not start here, so it is not installed again.`;
    case "busy":
      return "Another Flywheel process is updating this account. Try again shortly.";
    case "current":
    case "fresh":
    case "available":
      return `Flywheel ${release} was not installed.`;
    case "cancelled":
      return `Installing Flywheel ${release} was cancelled.`;
    case "failed":
      return `Flywheel ${release} could not be installed: ${result.reason}`;
  }
}

/** Builds the account's update coordinator for one run, the way the account
 *  service builds it, and closes it and every process its installer started
 *  once `use` settles. */
async function withUpdateService<T>(directories: AccountDirectories, launcher: LauncherContext, use: (service: UpdateService) => Promise<T>): Promise<T> {
  const { userDataRoot, accountHome } = directories;
  const currentVersion = process.env.FLYWHEEL_APP_VERSION;
  const currentBuildId = ownBuildId(userDataRoot);
  // This command's own launch authority: the installer opens its scopes below
  // it, and closing it here ends every process the update started.
  const scope = launcher.scope.open();
  // One store answers the auto-install policy for the run that admits an
  // install and for the engine that activates it (ARCH-DISTRIBUTION-022).
  const policy = createUpdatePolicyStore(userDataRoot);
  const openAuthority = () => createUpdateAuthority({ dbFile: updateAuthorityDbFile(userDataRoot, UPDATE_PROTOCOL_VERSION) });
  const service = createUpdateService({
    currentVersion,
    platformArch: buildPlatformArch(),
    repository: updateRepository(),
    policy,
    openAuthority,
    refusedBuild: () => refusedBuild(userDataRoot),
    ...(currentBuildId === undefined ? {} : { currentBuildId }),
    scheduler: systemUpdateScheduler,
    publish: () => {},
    installer: createUpdateInstaller({
      userDataRoot,
      wrapperDir: wrapperDirectory(process.env.FLYWHEEL_INSTALL_DIR, accountHome),
      platform: process.platform,
      platformArch: buildPlatformArch(),
      scheduler: systemUpdateScheduler,
      policy,
      launcher: scope,
      openAuthority,
    }),
  });

  try {
    return await use(service);
  } finally {
    service.closeAdmission();
    try {
      await service.settled();
    } finally {
      try {
        await scope.close();
      } finally {
        await policy.dispose();
      }
    }
  }
}
