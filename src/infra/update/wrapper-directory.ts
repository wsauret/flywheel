import { join, resolve, win32 } from "node:path"

export const WINDOWS_LAUNCHER_NAME = "flywheel.exe"
export const WINDOWS_SERVICE_LAUNCHER_NAME = "flywheel-service.exe"

/** Where the account's launcher is published: `FLYWHEEL_INSTALL_DIR` when it
 *  is set and not empty, else `~/.local/bin` on macOS and Linux, and on
 *  Windows `%LOCALAPPDATA%\Flywheel\bin`, else `~\.flywheel\bin`. It selects
 *  this directory only; immutable builds remain under the account data root.
 *  Every installer and every build that looks for its launcher uses this one
 *  rule. The launcher states it back to the build it runs: the POSIX wrapper
 *  and the Windows launcher both export `FLYWHEEL_INSTALL_DIR` as the
 *  directory they sit in. */
export function wrapperDirectory(requested: string | undefined, accountHome: string, platform: string = process.platform, localAppData: string | undefined = process.env.LOCALAPPDATA): string {
  if (platform === "win32") {
    if (requested) return requested
    return localAppData ? win32.join(localAppData, "Flywheel", "bin") : win32.join(accountHome, ".flywheel", "bin")
  }
  return requested === undefined || requested === "" ? join(accountHome, ".local", "bin") : resolve(requested)
}

/** The interactive launcher's name in that directory: the name a person runs
 *  as `flywheel`. Windows Task Scheduler names the sibling service launcher. */
export function launcherName(platform: string): string {
  return platform === "win32" ? WINDOWS_LAUNCHER_NAME : "flywheel"
}
