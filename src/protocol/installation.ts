import { join, win32 } from "node:path"

import { launcherName, wrapperDirectory } from "../infra/update/wrapper-directory.js"

/** The GitHub repository whose releases this build checks and installs
 *  (ARCH-DISTRIBUTION-007, ARCH-DISTRIBUTION-034): `FLYWHEEL_REPO` when the
 *  person names one, otherwise the repository that this build's release build
 *  compiled in. Official releases compile in the official repository, and a
 *  fork's release compiles in its own. Undefined for a build that names
 *  none, such as a local install or a source run: it never checks for or
 *  installs updates. The literal `process.env.FLYWHEEL_UPDATE_REPOSITORY` is
 *  what the build replaces, so it must stay spelled this way. */
export function updateRepository(): string | undefined {
  return process.env.FLYWHEEL_REPO || process.env.FLYWHEEL_UPDATE_REPOSITORY || undefined
}

/** The platform's bootstrap installer, the one a person runs from the README,
 *  at the address that always serves the latest release's copy. The installer
 *  itself resolves `latest` to one immutable tag before it downloads anything. */
export function bootstrapInstallerUrl(platform: NodeJS.Platform, repository: string): string {
  return `https://github.com/${repository}/releases/latest/download/${platform === "win32" ? "install.ps1" : "install.sh"}`
}

/** The environment the installer ran with; only `FLYWHEEL_INSTALL_DIR` and,
 *  on Windows, `LOCALAPPDATA` are read. */
interface LauncherEnvironment {
  readonly [name: string]: string | undefined
}

/** Where the account's installer places the launcher a person runs as
 *  `flywheel`, by the same rule the installer uses, with no registry or shell
 *  profile read. A process that was already running when the install ran finds
 *  it here and not on PATH: the installer's PATH edit reaches a shell profile
 *  or the Windows registry, never a process's own environment.
 *
 *  It is the POSIX wrapper on macOS and Linux and the Windows launcher
 *  `flywheel.exe` on Windows, in `FLYWHEEL_INSTALL_DIR`, else the platform's
 *  default directory. An empty variable counts as unset, as it does for the
 *  installers. */
export function installedLauncherPath(platform: NodeJS.Platform, env: LauncherEnvironment, accountHome: string): string {
  const directory = wrapperDirectory(env.FLYWHEEL_INSTALL_DIR, accountHome, platform, env.LOCALAPPDATA)
  return platform === "win32" ? win32.join(directory, launcherName(platform)) : join(directory, launcherName(platform))
}
