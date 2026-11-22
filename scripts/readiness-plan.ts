import { LIVE_AUTH_PROFILE_SETTING } from "./claude-engine-release.js";
import { RELEASE_ARCHIVES, RELEASE_BUILD_COMMANDS, RELEASE_TARGET_MATRIX, RELEASE_TARGETS, type ReleaseTargetName } from "./release-contract.js";

export interface ReleaseBuild {
  readonly target: ReleaseTargetName;
  readonly archive: string;
  readonly command: readonly string[];
}

export interface LinuxRuntimeEvidence {
  readonly target: ReleaseTargetName;
  readonly archive: string;
  readonly dockerPlatform: string;
  readonly dockerImageSuffix: string;
  readonly evidence: "native container functional evidence" | "emulated container functional evidence";
}

/** A Linux target whose container runs one tier of an engine bump's qualification. */
export interface LinuxContainerTarget {
  readonly target: ReleaseTargetName;
  readonly dockerPlatform: string;
}

export interface ReadinessPlan {
  readonly builds: readonly ReleaseBuild[];
  readonly host?: ReleaseBuild;
  readonly linuxRuntime: readonly LinuxRuntimeEvidence[];
  /** Owed on a Claude engine bump. One native glibc container proves the engine on Linux: every Linux target ships
   *  the same engine and keeps its login the same way, and the package containers already prove each archive. */
  readonly linuxClaudeLive?: LinuxContainerTarget;
  /** Owed on an Antigravity CLI bump: the fake-host tier in one native glibc container. Each Linux target ships its
   *  own agy build, and the package containers run each archive's agy for its version. */
  readonly linuxAntigravityFakeHost?: LinuxContainerTarget;
  readonly performance: "required" | "unavailable" | "skipped";
  readonly unavailable: readonly string[];
}

/** What the host has installed, of the tools that decide which checks it can prove. */
export interface ReadinessTools {
  /** tmux on macOS and Linux, or psmux on Windows, which installs as `tmux`. */
  readonly tmux: boolean;
}

function canonicalBuilds(): readonly ReleaseBuild[] {
  return RELEASE_TARGETS.map((target, index) => ({
    target,
    archive: RELEASE_ARCHIVES[index]!,
    command: RELEASE_BUILD_COMMANDS[index]!,
  }));
}

/** Derive the checks one host can prove from the canonical release target
 *  matrix and the tools it has. The performance gate drives the installed
 *  binary through tmux, so it is owed wherever tmux answers. */
export function readinessPlan(platform: string, arch: string, quick: boolean, tools: ReadinessTools): ReadinessPlan {
  if (quick) return { builds: [], linuxRuntime: [], performance: "skipped", unavailable: [] };
  const canonical = canonicalBuilds();
  const host = canonical.find((build) => build.target === `${platform}-${arch}`);
  const builds = platform === "darwin" && arch === "arm64" ? canonical : host ? [host] : [];
  const linuxRuntime = platform === "darwin" && arch === "arm64"
    ? RELEASE_TARGET_MATRIX.filter((target) => target.platform === "linux").map((target) => ({
      target: target.platformArch,
      archive: `flywheel-${target.platformArch}.tar.gz`,
      dockerPlatform: target.dockerPlatform,
      dockerImageSuffix: target.dockerImageSuffix,
      evidence: target.arch === arch ? "native container functional evidence" as const : "emulated container functional evidence" as const,
    }))
    : [];
  const unavailable = tools.tmux
    ? []
    : [platform === "win32" ? "performance gate: tmux is unavailable; install psmux, which provides tmux on Windows" : "performance gate: tmux is unavailable; install tmux"];
  const native = linuxRuntime.find((runtime) => runtime.evidence === "native container functional evidence" && runtime.dockerImageSuffix === "");
  return {
    builds, host, linuxRuntime, performance: tools.tmux ? "required" : "unavailable", unavailable,
    ...(native === undefined ? {} : { linuxClaudeLive: { target: native.target, dockerPlatform: native.dockerPlatform }, linuxAntigravityFakeHost: { target: native.target, dockerPlatform: native.dockerPlatform } }),
  };
}

interface DockerRuntimeCommandOptions {
  readonly target: ReleaseTargetName;
  readonly dockerPlatform: string;
  /** Appended to the `oven/bun` tag: empty for glibc, `-alpine` for musl. */
  readonly dockerImageSuffix: string;
  readonly archive: string;
  readonly harness: string;
  readonly tokenizerManifest: string;
  readonly version: string;
  /** The Antigravity CLI version that the pin states, which the archive's agy must report. */
  readonly antigravityVersion: string;
  readonly bunVersion: string;
}

/** Construct one hermetic Docker invocation. The repository and host HOME are never mounted. */
export function dockerRuntimeCommand(options: DockerRuntimeCommandOptions): readonly string[] {
  return [
    "docker", "run", "--rm", `--platform=${options.dockerPlatform}`, "--network=none",
    "--mount", `type=bind,source=${options.archive},target=/input/archive.tar.gz,readonly`,
    "--mount", `type=bind,source=${options.harness},target=/input/readiness-package-smoke.ts,readonly`,
    "--mount", `type=bind,source=${options.tokenizerManifest},target=/input/tokenizer-prebuilt.json,readonly`,
    `oven/bun:${options.bunVersion}${options.dockerImageSuffix}`, "bun", "run", "/input/readiness-package-smoke.ts",
    "--archive", "/input/archive.tar.gz", "--target", options.target, "--expected-version", options.version, "--expected-antigravity-version", options.antigravityVersion, "--tokenizer-manifest", "/input/tokenizer-prebuilt.json",
  ];
}

/** The named Docker volume on the Mac that holds the Linux release login. It is the home of every container that logs
 *  in to Claude or runs the live Claude engine tier. The engine keeps the login's token in a file there, which no
 *  container copies out. */
export const RELEASE_LOGIN_VOLUME = "flywheel-readiness-claude";
/** Where a container mounts the release login volume, as its HOME. */
const RELEASE_LOGIN_CONTAINER_HOME = "/home/readiness";

/** How a container installs the candidate that `/input/candidate.tar` holds, for Linux. */
const INSTALL_CANDIDATE = "mkdir /work && tar -xf /input/candidate.tar -C /work && cd /work && bun install --frozen-lockfile";

/** What a container on the release login volume runs after it installs the candidate. */
const CONTAINER_STEPS = {
  login: `bun run scripts/readiness-login.ts --in-home ${RELEASE_LOGIN_CONTAINER_HOME}`,
  status: `bun run scripts/readiness-login.ts --status ${RELEASE_LOGIN_CONTAINER_HOME}`,
  live: "bun run test:integration:claude-engine",
} as const;

/** One container on the release login volume that installs the candidate for Linux and runs one step there, in the
 *  auth profile `liveAuthProfile`: the person's Claude login (`login`, interactive), the login's status line
 *  (`status`), or the live Claude engine tier (`live`). The status step asks the Linux engine of the candidate for the
 *  login's sign-in, so it needs the install too. It only reads the volume, so it mounts it read-only and keeps the
 *  container's own home, where its debug log goes. `candidate` is a tar of the candidate's tracked files, mounted
 *  read-only, and the image is the exact Bun that runs readiness. Bun's package cache stays in the container, so the
 *  volume holds only the login and what a run on it records. */
export function releaseLoginContainerCommand(options: { readonly dockerPlatform: string; readonly bunVersion: string; readonly candidate: string; readonly liveAuthProfile: string; readonly step: keyof typeof CONTAINER_STEPS }): readonly string[] {
  const step = CONTAINER_STEPS[options.step];
  const readOnly = options.step === "status";
  return [
    "docker", "run", "--rm", ...(options.step === "login" ? ["-it"] : []), `--platform=${options.dockerPlatform}`,
    "--mount", `type=volume,source=${RELEASE_LOGIN_VOLUME},target=${RELEASE_LOGIN_CONTAINER_HOME}${readOnly ? ",readonly" : ""}`,
    "--mount", `type=bind,source=${options.candidate},target=/input/candidate.tar,readonly`,
    ...(readOnly ? [] : ["--env", `HOME=${RELEASE_LOGIN_CONTAINER_HOME}`]), "--env", "BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache",
    "--env", `${LIVE_AUTH_PROFILE_SETTING}=${options.liveAuthProfile}`,
    `oven/bun:${options.bunVersion}`, "sh", "-c",
    `${INSTALL_CANDIDATE} && ${step}`,
  ];
}

/** One container that installs the candidate for Linux and runs the Antigravity CLI's fake-host tier on the pinned
 *  Linux agy, through the guarded integration runner (scripts/test-integration.ts), which gives the tier a private
 *  TMPDIR and fails on leftovers. The image has neither git, which the tier's private workspaces need, nor ps, which
 *  its process checks read, so the container installs both. The runner downloads and verifies the pinned agy, so the
 *  container has network access. `candidate` is a tar of the candidate's tracked files, mounted read-only, and the image is the
 *  exact Bun that runs readiness. */
export function antigravityFakeHostContainerCommand(options: { readonly dockerPlatform: string; readonly bunVersion: string; readonly candidate: string }): readonly string[] {
  return [
    "docker", "run", "--rm", `--platform=${options.dockerPlatform}`,
    "--mount", `type=bind,source=${options.candidate},target=/input/candidate.tar,readonly`,
    "--env", "BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache",
    `oven/bun:${options.bunVersion}`, "sh", "-c",
    `apt-get update -qq && apt-get install -qq -y --no-install-recommends git procps && ${INSTALL_CANDIDATE} && bun run test:integration:antigravity-engine`,
  ];
}
