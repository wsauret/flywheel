/** The hidden install role of this executable.
 *
 *  A downloaded archive holds a complete build and a few lines of shell or
 *  PowerShell. The script locates the executable and re-enters it in this
 *  role; the executable then installs itself through the one TypeScript
 *  install engine (ARCH-DISTRIBUTION-014). So the layout, the staging, the macOS
 *  preparation, and the activation are the same code for a first
 *  installation and for an update on every platform, and the script owns
 *  none of them.
 *
 *  The payload is the directory the running executable sits in. Nothing about
 *  where to read the build from is taken from an argument, an environment
 *  variable, or the working directory: the build that installs itself is the
 *  one that is running.
 *
 *  This role selects the account directories, opens the launcher the engine
 *  needs for owned commands, installs, and then collects the builds the
 *  account no longer needs. The shared engine enters the installed command's
 *  account-service boundary after publication. */

import * as path from "node:path"
import { selectStartupDirectories } from "../infra/platform/files/directory-authorities.js"
import { errorMessage } from "../infra/diagnostics/error-message.js"
import { Log } from "../infra/diagnostics/log.js"
import { buildPlatformArch } from "../infra/platform/native-assets.js"
import { ownedCommandRunner } from "../infra/owned-command.js"
import { wrapperDirectory } from "../infra/update/wrapper-directory.js"
import { installBuild } from "../orchestration/update/install-engine.js"
import { collectInstalledBuilds } from "../orchestration/update/update-install.js"
import { createCliLauncher } from "./account-service/runtime-launch.js"

export async function runBinaryInstall(): Promise<number> {
  const directories = selectStartupDirectories({ env: process.env, cwd: process.cwd() })
  try {
    await Log.init({ dir: directories.accountHome })
    const installation = {
      userDataRoot: directories.userDataRoot,
      wrapperDir: wrapperDirectory(process.env.FLYWHEEL_INSTALL_DIR, directories.accountHome),
      platform: process.platform,
      platformArch: buildPlatformArch(),
    }
    const launcher = await createCliLauncher()
    try {
      const installed = await installBuild({
        ...installation,
        sourceDir: path.dirname(process.execPath),
        runCommand: ownedCommandRunner(launcher.scope),
      })
      if (installed.serviceOutput) process.stdout.write(`${installed.serviceOutput}\n`)
    } finally {
      await launcher.dispose()
    }
    // A build installed from an archive or a local build runs no update, so
    // the installation collects what the account no longer needs
    // (ARCH-DISTRIBUTION-027). The build is already active, so a collection
    // that fails costs disk, not the installation.
    try {
      await collectInstalledBuilds(installation)
    } catch (err) {
      Log.create({ service: "install" }).warn("build collection failed", { error: errorMessage(err) })
    }
    return 0
  } catch (err) {
    Log.create({ service: "install" }).error("flywheel install failed", { error: errorMessage(err) })
    process.stderr.write(`flywheel install: ${errorMessage(err)}\n`)
    return 1
  } finally {
    await Log.closeGlobal()
  }
}
