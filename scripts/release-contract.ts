/** Canonical targets and derived artifacts for one Flywheel release.
 *
 *  A Linux target states the container it is proved in: the Docker platform,
 *  and the suffix of the `oven/bun` image tag that carries its C library. A
 *  musl target names its C library in `platformArch`, and a glibc target keeps
 *  the name it has always had. */
export const RELEASE_TARGET_MATRIX = [
  { platform: "darwin", arch: "arm64", platformArch: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { platform: "darwin", arch: "x64", platformArch: "darwin-x64", bunTarget: "bun-darwin-x64" },
  { platform: "linux", arch: "arm64", platformArch: "linux-arm64", bunTarget: "bun-linux-arm64", dockerPlatform: "linux/arm64", dockerImageSuffix: "" },
  { platform: "linux", arch: "arm64", platformArch: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", dockerPlatform: "linux/arm64", dockerImageSuffix: "-alpine" },
  { platform: "linux", arch: "x64", platformArch: "linux-x64", bunTarget: "bun-linux-x64", dockerPlatform: "linux/amd64", dockerImageSuffix: "" },
  { platform: "linux", arch: "x64", platformArch: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", dockerPlatform: "linux/amd64", dockerImageSuffix: "-alpine" },
  { platform: "win32", arch: "arm64", platformArch: "win32-arm64", bunTarget: "bun-windows-arm64" },
  { platform: "win32", arch: "x64", platformArch: "win32-x64", bunTarget: "bun-windows-x64" },
] as const;

export type ReleaseTarget = (typeof RELEASE_TARGET_MATRIX)[number];
export type ReleaseTargetName = ReleaseTarget["platformArch"];

export const RELEASE_TARGETS = RELEASE_TARGET_MATRIX.map(({ platformArch }) => platformArch);
export const RELEASE_ARCHIVES = RELEASE_TARGET_MATRIX.map(({ platformArch }) => `flywheel-${platformArch}.tar.gz`);
export const RELEASE_ASSETS = [
  "SHASUMS256.txt",
  ...RELEASE_ARCHIVES,
  "install.ps1",
  "install.sh",
  "release.json",
] as const;
/** The official release repository: the publisher trust root that official builds check and install updates from
 *  (ARCH-DISTRIBUTION-007). It is the one place the repository names it. */
export const OFFICIAL_RELEASE_REPOSITORY = "wsauret/flywheel";

/** The repository a release publishes to and its release builds compile in as their update repository:
 *  `PUBLIC_REPO` when the release machine names one, as a fork does, otherwise the official repository. */
export function releaseRepository(environment: { readonly [name: string]: string | undefined }): string {
  return environment.PUBLIC_REPO?.trim() || OFFICIAL_RELEASE_REPOSITORY;
}

/** The release machine's variable that names the official report endpoint. It lives only in the official release
 *  pipeline's environment, never in the repository, so a fork's release build carries no endpoint and sends no
 *  report to the Flywheel maintainers (ARCH-DISTRIBUTION-034). */
export const RELEASE_REPORT_ENDPOINT_VARIABLE = "FLYWHEEL_RELEASE_REPORT_ENDPOINT";

/** The report endpoint a release build compiles in, or undefined when the environment names none. A value that is
 *  not an HTTPS URL throws, so a mistyped endpoint never ships a binary whose every report fails. */
export function releaseReportEndpoint(environment: { readonly [name: string]: string | undefined }): string | undefined {
  const value = environment[RELEASE_REPORT_ENDPOINT_VARIABLE]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!URL.canParse(value) || new URL(value).protocol !== "https:") throw new Error(`${RELEASE_REPORT_ENDPOINT_VARIABLE} must be an https URL`);
  return value;
}

/** The publisher inputs a release build compiles in (ARCH-DISTRIBUTION-034): the repository it checks and installs
 *  updates from, and the report endpoint, if any. Every other build compiles in neither. */
export function releaseBuildInputs(environment: { readonly [name: string]: string | undefined }) {
  return { updateRepository: releaseRepository(environment), reportEndpoint: releaseReportEndpoint(environment) };
}

/** Why a release run must not start, or undefined. A release to the official repository carries the maintainers'
 *  report endpoint, so a forgotten variable never ships an official release that reports nothing. */
export function officialReleaseRefusal(environment: { readonly [name: string]: string | undefined }): string | undefined {
  const inputs = releaseBuildInputs(environment);
  if (inputs.updateRepository !== OFFICIAL_RELEASE_REPOSITORY || inputs.reportEndpoint !== undefined) return undefined;
  return `a release to ${OFFICIAL_RELEASE_REPOSITORY} needs ${RELEASE_REPORT_ENDPOINT_VARIABLE}; a fork sets PUBLIC_REPO to its own repository instead`;
}

/** The one build command per target that release and readiness both run. `--release` compiles in the inputs of
 *  `releaseBuildInputs`. */
export const RELEASE_BUILD_COMMANDS = RELEASE_TARGET_MATRIX.map(({ bunTarget }) => [
  "bun", "run", "scripts/build-binary.ts", `--target=${bunTarget}`, "--native-provenance=source-build", "--release",
] as const);
