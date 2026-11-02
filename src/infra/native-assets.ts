import { dirname, join } from "node:path";
import { checkoutProgram, runsThroughBun } from "./cli-subprocess.js";

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
 *  platform, architecture, and C library, unless `FLYWHEEL_PLATFORM_ARCH`
 *  names another target. Whether Flywheel publishes a build for the target is
 *  the release contract's answer, not this one's. */
export function buildPlatformArch(): string {
  return process.env.FLYWHEEL_PLATFORM_ARCH ?? `${process.platform}-${process.arch}${hostLibcSuffix()}`;
}

/** The suffix with which a release target names its C library: `-musl` on a
 *  Linux whose C library is musl, and nothing everywhere else. The runtime is
 *  linked against its host's C library, and its report states a glibc version
 *  only when that library is glibc. So the report answers the question
 *  without a process launch, and without a guess from the files on disk: a
 *  glibc Linux can also hold the musl loader. Only Linux has a musl build, so
 *  no other platform reads the report. */
export function libcSuffix(platform: NodeJS.Platform, report: () => object): "" | "-musl" {
  if (platform !== "linux") return "";
  const runtime = report();
  const header = "header" in runtime && typeof runtime.header === "object" && runtime.header !== null ? runtime.header : {};
  return "glibcVersionRuntime" in header && typeof header.glibcVersionRuntime === "string" ? "" : "-musl";
}

let hostLibc: "" | "-musl" | undefined;

/** This host's C library suffix (`libcSuffix`), read once per process. */
export function hostLibcSuffix(): "" | "-musl" {
  hostLibc ??= libcSuffix(process.platform, () => process.report.getReport());
  return hostLibc;
}

/** The launchd program for the macOS account service: a minimal application
 *  bundle, so the privacy consent dialog and the Privacy & Security entry
 *  name and picture it as Flywheel with its own tile. Its bytes are the
 *  identity the consent is granted to, so the tracked bundle ships unchanged
 *  in every release. */
export const MACOS_LAUNCHER_BUNDLE = "Flywheel.app";
export const MACOS_LAUNCHER_EXECUTABLE = `${MACOS_LAUNCHER_BUNDLE}/Contents/MacOS/Flywheel`;

/** The Windows launchers in a Windows build's native directory. Both run the
 *  build that the account's `current` pointer file names. The console variant
 *  is placed on PATH; the windowless variant is used by Task Scheduler. */
export const WINDOWS_LAUNCHER_EXECUTABLE = "flywheel-launcher.exe";
export const WINDOWS_SERVICE_LAUNCHER_EXECUTABLE = "flywheel-service-launcher.exe";

/** A per-command Git shim, not an account-service launcher. */
export const WINDOWS_GIT_FORWARDER_EXECUTABLE = "flywheel-git-forwarder.exe";

/** Resolves the tracked forwarding asset in source runs, or the staged asset in a packaged build. */
export function windowsGitForwarderPath(platformArch = buildPlatformArch()): string {
  return runsThroughBun(process.execPath)
    ? checkoutProgram(join("crates", "windows-git-forwarder", `flywheel-git-forwarder.${platformArch}.exe`), import.meta.url)
    : join(nativeAssetDir(), WINDOWS_GIT_FORWARDER_EXECUTABLE);
}

/** The Claude engine's file name, in a build's native directory and in the Agent SDK's platform package. */
export function claudeEngineFile(platformArch: string): string {
  return platformArch.startsWith("win32-") ? "claude.exe" : "claude";
}

/** The Claude engine of a source checkout, relative to the checkout: the binary of the Agent SDK's platform package,
 *  which `bun install` placed from the lockfile. */
export function checkoutClaudeEngine(platformArch: string): string {
  return join("node_modules", "@anthropic-ai", `claude-agent-sdk-${platformArch}`, claudeEngineFile(platformArch));
}

export function nativeAssetDir(): string {
  return process.env.FLYWHEEL_NATIVE_DIR ?? join(dirname(process.execPath), "native", buildPlatformArch());
}
