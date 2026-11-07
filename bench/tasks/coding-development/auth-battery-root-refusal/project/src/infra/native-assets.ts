import { dirname, join } from "node:path";

/** The release target this executable was built for, as its canonical
 *  `<platform>-<arch>` name, with `-musl` for a musl Linux build. It names the
 *  build's native directory, its ripgrep addon, and the archive an update
 *  installs.
 *
 *  A compiled build states the target it was built for (`build-binary.ts`
 *  substitutes it), and never detects it. The bootstrap installer chose the C
 *  library once, when it chose the archive, and a binary linked against one C
 *  library starts only where that library is, so detecting again could only
 *  disagree with the build that is running. A source run is its host's
 *  platform and architecture. Whether Flywheel publishes a build for the
 *  target is the release contract's answer, not this one's. */
export function buildPlatformArch(): string {
  return process.env.FLYWHEEL_PLATFORM_ARCH ?? `${process.platform}-${process.arch}`;
}

/** The launchd program for the macOS account service: a minimal application
 *  bundle, so the privacy consent dialog and the Privacy & Security entry
 *  name and picture it as Flywheel with its own tile. Its bytes are the
 *  identity the consent is granted to, so the tracked bundle ships unchanged
 *  in every release. */
export const MACOS_LAUNCHER_BUNDLE = "Flywheel.app";
export const MACOS_LAUNCHER_EXECUTABLE = `${MACOS_LAUNCHER_BUNDLE}/Contents/MacOS/Flywheel`;

/** The Windows launcher in a Windows build's native directory: the stable
 *  program that an installation places on PATH as `flywheel.exe` and names in
 *  the account service's scheduled task. It runs the build that the account's
 *  `current` pointer file names (`crates/windows-launcher/launcher.c`). */
export const WINDOWS_LAUNCHER_EXECUTABLE = "flywheel-launcher.exe";

export function nativeAssetDir(): string {
  return process.env.FLYWHEEL_NATIVE_DIR ?? join(dirname(process.execPath), "native", buildPlatformArch());
}
