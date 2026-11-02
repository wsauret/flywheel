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

/** The Linux target whose container runs the live Claude engine tier on the release login volume. */
export interface LinuxClaudeLive {
  readonly target: ReleaseTargetName;
  readonly dockerPlatform: string;
}

export interface ReadinessPlan {
  readonly builds: readonly ReleaseBuild[];
  readonly host?: ReleaseBuild;
  readonly linuxRuntime: readonly LinuxRuntimeEvidence[];
  /** Owed on a Claude engine bump. One native glibc container proves the engine on Linux: every Linux target ships
   *  the same engine and keeps its login the same way, and the package containers already prove each archive. */
  readonly linuxClaudeLive?: LinuxClaudeLive;
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
    ...(native === undefined ? {} : { linuxClaudeLive: { target: native.target, dockerPlatform: native.dockerPlatform } }),
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
    "--archive", "/input/archive.tar.gz", "--target", options.target, "--expected-version", options.version, "--tokenizer-manifest", "/input/tokenizer-prebuilt.json",
  ];
}

/** The named Docker volume on the Mac that holds the Linux release login. It is the home of every container that logs
 *  in to Claude or runs the live Claude engine tier. The engine keeps the login's token in a file there, which no
 *  container copies out. */
export const RELEASE_LOGIN_VOLUME = "flywheel-readiness-claude";
/** Where a container mounts the release login volume, as its HOME. */
const RELEASE_LOGIN_CONTAINER_HOME = "/home/readiness";

/** The Docker invocation that tells, in seconds, whether the release login volume holds a usable Claude login in the
 *  auth profile `liveAuthProfile`. It mounts the volume and the repository read-only and has no network. The status
 *  mode reads only each login folder's account file and whether a token file exists, never a token. */
export function releaseLoginStatusContainerCommand(options: { readonly dockerPlatform: string; readonly root: string; readonly bunVersion: string; readonly liveAuthProfile: string }): readonly string[] {
  return [
    "docker", "run", "--rm", `--platform=${options.dockerPlatform}`, "--network=none",
    "--mount", `type=volume,source=${RELEASE_LOGIN_VOLUME},target=${RELEASE_LOGIN_CONTAINER_HOME},readonly`,
    "--mount", `type=bind,source=${options.root},target=/repo,readonly`,
    "--env", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "--env", `${LIVE_AUTH_PROFILE_SETTING}=${options.liveAuthProfile}`,
    `oven/bun:${options.bunVersion}`, "bun", "run", "/repo/scripts/readiness-login.ts", "--status", RELEASE_LOGIN_CONTAINER_HOME,
  ];
}

/** One container on the release login volume that installs the candidate for Linux and runs one step there: the
 *  person's Claude login (`login`, interactive), or the live Claude engine tier (`live`), both in the auth profile
 *  `liveAuthProfile`. `candidate` is a tar of the candidate's tracked files, mounted read-only, and the image is the
 *  exact Bun that runs readiness. Bun's package cache stays in the container, so the volume holds only the login and
 *  what a run on it records. */
export function releaseLoginContainerCommand(options: { readonly dockerPlatform: string; readonly bunVersion: string; readonly candidate: string; readonly liveAuthProfile: string; readonly step: "login" | "live" }): readonly string[] {
  const step = options.step === "login" ? `bun run scripts/readiness-login.ts --in-home ${RELEASE_LOGIN_CONTAINER_HOME}` : "bun run test:integration:claude-engine";
  return [
    "docker", "run", "--rm", ...(options.step === "login" ? ["-it"] : []), `--platform=${options.dockerPlatform}`,
    "--mount", `type=volume,source=${RELEASE_LOGIN_VOLUME},target=${RELEASE_LOGIN_CONTAINER_HOME}`,
    "--mount", `type=bind,source=${options.candidate},target=/input/candidate.tar,readonly`,
    "--env", `HOME=${RELEASE_LOGIN_CONTAINER_HOME}`, "--env", "BUN_INSTALL_CACHE_DIR=/tmp/bun-install-cache",
    "--env", `${LIVE_AUTH_PROFILE_SETTING}=${options.liveAuthProfile}`,
    `oven/bun:${options.bunVersion}`, "sh", "-c",
    `mkdir /work && tar -xf /input/candidate.tar -C /work && cd /work && bun install --frozen-lockfile && ${step}`,
  ];
}
