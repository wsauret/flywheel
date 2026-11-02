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
 *  needs for owned commands, and installs. The shared engine enters the
 *  installed command's account-service boundary after publication. */

import * as path from "node:path"
import { selectStartupDirectories } from "../infra/directory-authorities.js"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import { buildPlatformArch } from "../infra/native-assets.js"
import { ownedCommandRunner } from "../infra/owned-command.js"
import { wrapperDirectory } from "../infra/update/wrapper-directory.js"
import { installBuild } from "../orchestration/update/install-engine.js"
import { createCliLauncher } from "./runtime-launch.js"

export async function runBinaryInstall(): Promise<number> {
  const directories = selectStartupDirectories({ env: process.env, cwd: process.cwd() })
  try {
    await Log.init({ dir: directories.accountHome })
    const launcher = await createCliLauncher()
    try {
      const installed = await installBuild({
        userDataRoot: directories.userDataRoot,
        sourceDir: path.dirname(process.execPath),
        wrapperDir: wrapperDirectory(process.env.FLYWHEEL_INSTALL_DIR, directories.accountHome),
        platform: process.platform,
        platformArch: buildPlatformArch(),
        runCommand: ownedCommandRunner(launcher.scope),
      })
      if (installed.serviceOutput) process.stdout.write(`${installed.serviceOutput}\n`)
    } finally {
      await launcher.dispose()
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
