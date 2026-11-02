import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hostLibcSuffix, MACOS_LAUNCHER_BUNDLE, MACOS_LAUNCHER_EXECUTABLE, WINDOWS_GIT_FORWARDER_EXECUTABLE, WINDOWS_LAUNCHER_EXECUTABLE, WINDOWS_SERVICE_LAUNCHER_EXECUTABLE } from "../src/infra/native-assets.js";
import { trackedNativeAddonIsCurrent } from "./native-addon-fingerprint.js";
import { RELEASE_TARGETS } from "./release-contract.js";
import { buildExecutable } from "../src/infra/update/build-identity.js";

interface StringDictionary {
  [key: string]: string;
}
/** The release target of this host, with `-musl` on musl Linux, so a source run and a host build stage the native
 *  assets of the C library they run on. */
export function hostPlatformArch(): string {
  return `${normalizePlatform(process.platform)}-${normalizeArch(process.arch)}${hostLibcSuffix()}`;
}

export function hostBinaryPath(root: string): string {
  const platformArch = hostPlatformArch();
  return join(root, "dist", `flywheel-${platformArch}`, "build", buildExecutable(process.platform));
}

/** sharp's own naming for a platform-arch. Only musl differs, and it differs by
 *  shape rather than by suffix: the libc lands on the platform half of the
 *  name. */
export function sharpPlatformArch(platformArch: string): string {
  const musl = platformArch.match(/^linux-(x64|arm64)-musl$/);
  return musl ? `linuxmusl-${musl[1]}` : platformArch;
}

export function platformArchForTarget(target: string | undefined): string {
  if (!target) return hostPlatformArch();
  const [os, cpu, ...suffix] = target.replace(/^bun-/, "").split("-");
  if (!os || !cpu) throw new Error(`Unrecognized --target value: ${target}`);
  return [normalizePlatform(os), normalizeArch(cpu), ...suffix].join("-");
}

function normalizePlatform(value: string): "darwin" | "linux" | "win32" {
  if (value === "windows") return "win32";
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new Error(`Unsupported native platform: ${value}`);
}

function normalizeArch(value: string): "arm64" | "x64" {
  if (value === "arm64" || value === "x64") return value;
  throw new Error(`Unsupported native architecture: ${value}`);
}

export function nativeAssetDir(root: string, platformArch: string): string {
  return join(root, "dist", "native", platformArch);
}

/** The package that holds libvips for a target. sharp ships libvips beside
 *  its addon in each Windows platform package, and names the separate Windows
 *  libvips package only as a development dependency for its own build, so an
 *  install never holds that package and the runtime never needs it. Every
 *  other target loads libvips from its own package. */
function libvipsPackage(platformArch: string): string {
  const sharpArch = sharpPlatformArch(platformArch);
  return platformArch.startsWith("win32-") ? `@img/sharp-${sharpArch}` : `@img/sharp-libvips-${sharpArch}`;
}

/** sharp's prebuilt packages for a target: the package of its addon and the
 *  package that holds libvips, each once. */
function sharpNativePackages(platformArch: string): readonly string[] {
  return [...new Set([`@img/sharp-${sharpPlatformArch(platformArch)}`, libvipsPackage(platformArch)])];
}

export function nativeRuntimePackages(platformArch: string): readonly string[] {
  return ["sharp", "@img/colour", "detect-libc", "semver", ...sharpNativePackages(platformArch)];
}

export function nativeEnv(nativeDir: string): StringDictionary {
  return { FLYWHEEL_NATIVE_DIR: nativeDir };
}

export const TREE_SITTER_WASM_FILES = [
  "tree-sitter.wasm",
  "tree-sitter-bash.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-python.wasm",
] as const;

export const TOKENIZER_ASSET_FILE = "flywheel-tokenizer.wasm.zst";

/** The launchd program for the macOS account service, as the application
 *  bundle macOS names and pictures as Flywheel. Its bytes are the identity
 *  the privacy consent is granted to, so the tracked bundle ships unchanged in
 *  every release and is only ever rebuilt on purpose (`bun run build:macos-launcher`). */
export { MACOS_LAUNCHER_BUNDLE, MACOS_LAUNCHER_EXECUTABLE };
export const MACOS_LAUNCHER_IDENTIFIER = "sh.flywl.flywheel.launcher";

export function macosLauncherDir(root: string): string {
  return join(root, "crates", "macos-launcher");
}

/** The crate of the Windows console and windowless service launchers. Both
 *  read the account's build pointer and run the build it names. The tracked
 *  executables ship unchanged in every release and are only ever rebuilt on
 *  purpose (`bun run build:windows-launcher`). */
export function windowsLauncherDir(root: string): string {
  return join(root, "crates", "windows-launcher");
}

export const WINDOWS_LAUNCHER_VARIANTS = ["console", "service"] as const;
export type WindowsLauncherVariant = typeof WINDOWS_LAUNCHER_VARIANTS[number];

/** One tracked launcher executable for one Windows target. */
export function windowsLauncherPrebuiltName(platformArch: string, variant: WindowsLauncherVariant = "console"): string {
  return `flywheel-${variant === "console" ? "launcher" : "service-launcher"}.${platformArch}.exe`;
}

/** The independent native shim that forwards Git argv to a pinned runtime. */
export function windowsGitForwarderDir(root: string): string {
  return join(root, "crates", "windows-git-forwarder");
}

export function windowsGitForwarderPrebuiltName(platformArch: string): string {
  return `flywheel-git-forwarder.${platformArch}.exe`;
}

/** The digest of a launcher crate's source, with line endings normalized, so
 *  a Windows checkout that writes CRLF names the same source. */
export async function launcherSourceSha256(launcherDir: string): Promise<string> {
  const source = (await readFile(join(launcherDir, "launcher.c"), "utf-8")).replaceAll("\r\n", "\n");
  return createHash("sha256").update(source).digest("hex");
}

/** Refuses a tracked launcher source whose prebuilt was not rebuilt from it,
 *  because the release would ship the old program under the new source. */
function requireBuiltFromSource(label: string, source: string, manifest: LauncherManifest, rebuild: string): void {
  if (source !== manifest.sourceSha256) throw new Error(`${label} source changed since its prebuilt was built: run ${rebuild}`);
}

interface PrebuiltEntry {
  readonly sha256: string;
  readonly bytes: number;
}

interface LauncherManifest {
  readonly sourceSha256: string;
  readonly files: { readonly [relativePath: string]: PrebuiltEntry };
}

async function readLauncherManifest(dir: string, label: string): Promise<LauncherManifest> {
  const value: unknown = JSON.parse(await readFile(join(dir, "launcher-prebuilt.json"), "utf-8"));
  if (typeof value !== "object" || value === null || !("sourceSha256" in value) || typeof value.sourceSha256 !== "string" || !("files" in value) || typeof value.files !== "object" || value.files === null) throw new Error(`Invalid ${label} prebuilt manifest`);
  const files: { [relativePath: string]: PrebuiltEntry } = {};
  for (const [relativePath, entry] of Object.entries(value.files)) {
    if (typeof entry !== "object" || entry === null || !("sha256" in entry) || !("bytes" in entry) || typeof entry.sha256 !== "string" || typeof entry.bytes !== "number") throw new Error(`Invalid ${label} prebuilt manifest entry: ${relativePath}`);
    files[relativePath] = { sha256: entry.sha256, bytes: entry.bytes };
  }
  return { sourceSha256: value.sourceSha256, files };
}

async function verifyPrebuiltFile(label: string, name: string, path: string, expected: PrebuiltEntry): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.byteLength !== expected.bytes) throw new Error(`${label} byte length mismatch: ${name} is ${bytes.byteLength}`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.sha256) throw new Error(`${label} digest mismatch: ${name} is ${digest}`);
}

/** Every file under `dir`, as sorted POSIX paths relative to it. */
export async function bundleFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort();
}

/** Verifies the tracked launcher bundle against its manifest, file by file:
 *  the bytes are the identity macOS consent attaches to, so a drifted or
 *  unlisted file is a build error, and so is a source the bundle was not
 *  built from. */
export async function verifyMacosLauncherAsset(root: string, bundleDir: string): Promise<void> {
  const manifest = await readLauncherManifest(macosLauncherDir(root), "macOS launcher");
  requireBuiltFromSource("macOS launcher", await launcherSourceSha256(macosLauncherDir(root)), manifest, "bun run build:macos-launcher");
  const present = await bundleFiles(bundleDir);
  for (const file of present) if (!(file in manifest.files)) throw new Error(`macOS launcher has an unlisted file: ${file}`);
  for (const [file, expected] of Object.entries(manifest.files)) {
    if (!present.includes(file)) throw new Error(`macOS launcher is missing ${file}`);
    await verifyPrebuiltFile("macOS launcher", file, join(bundleDir, file), expected);
  }
}

/** Verifies one Windows launcher executable against the tracked manifest
 *  entry for `platformArch`, and the tracked source against the source the
 *  manifest was built from. */
export async function verifyWindowsLauncherAsset(root: string, platformArch: string, variant: WindowsLauncherVariant, executable: string): Promise<void> {
  const manifest = await readLauncherManifest(windowsLauncherDir(root), "Windows launcher");
  requireBuiltFromSource("Windows launcher", await launcherSourceSha256(windowsLauncherDir(root)), manifest, "bun run build:windows-launcher");
  const name = windowsLauncherPrebuiltName(platformArch, variant);
  const expected = manifest.files[name];
  if (expected === undefined) throw new Error(`Windows launcher manifest has no entry for ${name}`);
  await verifyPrebuiltFile("Windows launcher", name, executable, expected);
}

/** Refuses an unbuilt source or changed forwarding executable before staging or release. */
export async function verifyWindowsGitForwarderAsset(root: string, platformArch: string, executable: string): Promise<void> {
  const dir = windowsGitForwarderDir(root);
  const manifest = await readLauncherManifest(dir, "Windows Git forwarder");
  requireBuiltFromSource("Windows Git forwarder", await launcherSourceSha256(dir), manifest, "bun run build:windows-git-forwarder");
  const name = windowsGitForwarderPrebuiltName(platformArch);
  const expected = manifest.files[name];
  if (expected === undefined) throw new Error(`Windows Git forwarder manifest has no entry for ${name}`);
  await verifyPrebuiltFile("Windows Git forwarder", name, executable, expected);
}

interface TokenizerArtifactManifest {
  readonly artifact: {
    readonly compressedSha256: string;
    readonly compressedBytes: number;
  };
}

function tokenizerArtifactManifest(value: unknown): TokenizerArtifactManifest {
  if (typeof value !== "object" || value === null || !("artifact" in value)) throw new Error("Invalid tokenizer prebuilt manifest");
  const artifact = value.artifact;
  if (
    typeof artifact !== "object" || artifact === null ||
    !("compressedSha256" in artifact) || typeof artifact.compressedSha256 !== "string" ||
    !("compressedBytes" in artifact) || typeof artifact.compressedBytes !== "number"
  ) throw new Error("Invalid tokenizer prebuilt manifest artifact");
  return { artifact: { compressedSha256: artifact.compressedSha256, compressedBytes: artifact.compressedBytes } };
}

/** Verifies the universal tokenizer artifact against its tracked build manifest. */
export async function verifyTokenizerAsset(root: string, assetPath: string): Promise<void> {
  const manifest = tokenizerArtifactManifest(JSON.parse(await readFile(join(root, "crates", "tokenizer", "tokenizer-prebuilt.json"), "utf-8")));
  const asset = await readFile(assetPath);
  if (asset.byteLength !== manifest.artifact.compressedBytes) throw new Error(`Tokenizer compressed byte length mismatch: ${asset.byteLength}`);
  const digest = createHash("sha256").update(asset).digest("hex");
  if (digest !== manifest.artifact.compressedSha256) throw new Error(`Tokenizer compressed digest mismatch: ${digest}`);
}

// The parser runtime ships with web-tree-sitter; every grammar ships with @vscode/tree-sitter-wasm under its own name.
const TREE_SITTER_WASM_ASSETS = TREE_SITTER_WASM_FILES.map((destination) => ({
  source: destination === "tree-sitter.wasm" ? ["web-tree-sitter", destination] : ["@vscode", "tree-sitter-wasm", "wasm", destination],
  destination,
}));

export function ripgrepAddonName(platformArch: string): string {
  return `flywheel-ripgrep.${platformArch}.node`;
}

/** The tracked ripgrep prebuilts, one per release target, that are absent or whose fingerprint no longer matches the crate source. */
export async function staleRipgrepPrebuilts(root: string): Promise<string[]> {
  const stale: string[] = [];
  for (const platformArch of RELEASE_TARGETS) {
    if (!await trackedNativeAddonIsCurrent(join(root, "crates", "ripgrep"), platformArch, ripgrepAddonPath(root, platformArch))) stale.push(platformArch);
  }
  return stale;
}

export function resolveNativeAddonStagingPath(root: string, outputDir: string, addon: string, platformArch: string): string {
  const distRoot = resolve(root, "dist");
  const resolvedDir = resolve(root, outputDir);
  const fromDist = relative(distRoot, resolvedDir);
  if (fromDist === "" || fromDist === ".." || fromDist.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromDist)) {
    throw new Error(`Native addon output directory must be inside repository dist staging: ${outputDir}`);
  }
  return join(resolvedDir, `${addon}.${platformArch}.node`);
}

/** Resolve an explicit fresh-addon destination under repository dist staging. */
export function resolveRipgrepStagingPath(root: string, outputDir: string, platformArch: string): string {
  return resolveNativeAddonStagingPath(root, outputDir, "flywheel-ripgrep", platformArch);
}

export async function targetNativePackagesToInstall(
  root: string,
  platformArch: string,
): Promise<readonly { name: string; version: string }[]> {
  const opentuiPkgJson = parsePackageVersions(JSON.parse(
    await readFile(join(root, "node_modules", "@opentui", "core", "package.json"), "utf-8"),
  ));
  const sharpPkgJson = parsePackageVersions(JSON.parse(
    await readFile(join(root, "node_modules", "sharp", "package.json"), "utf-8"),
  ));
  // sharp does not use this repository's platform-arch spelling for musl: it
  // publishes `linuxmusl-x64`, not `linux-x64-musl`. Asking for the latter
  // requests a package that has never existed, and the failure reads as "no
  // pinned version" rather than as a naming mismatch.
  const required = [
    { name: `@opentui/core-${platformArch}`, version: dependencyVersion(opentuiPkgJson, `@opentui/core-${platformArch}`) },
    ...sharpNativePackages(platformArch).map((name) => ({ name, version: dependencyVersion(sharpPkgJson, name) })),
  ];
  const packages = [];

  for (const pkg of required) {
    if (!pkg.version) throw new Error(`No pinned version found for ${pkg.name}`);
    const packageJsonPath = join(root, "node_modules", ...pkg.name.split("/"), "package.json");
    if (!existsSync(packageJsonPath) || packageVersion(JSON.parse(await readFile(packageJsonPath, "utf-8"))) !== pkg.version) {
      packages.push(pkg);
    }
  }

  return packages;
}

export async function ensureTargetNativePackages(root: string, platformArch: string): Promise<void> {
  // Host builds need this as much as cross builds: a workspace-configured
  // `bun install` does not materialize the platform-optional native packages,
  // so the build installs exactly what it requires instead of assuming the
  // package manager already did.
  const [os, cpu] = platformArch.split("-");
  if (!os || !cpu) throw new Error(`Unrecognized platform/arch value: ${platformArch}`);

  const packages = await targetNativePackagesToInstall(root, platformArch);
  if (packages.length === 0) return;

  for (const pkg of packages) {
    await rm(join(root, "node_modules", ...pkg.name.split("/")), { recursive: true, force: true });
  }

  console.log(`Installing target-platform native packages (${os}/${cpu})...`);
  const specs = packages.map((pkg) => `${pkg.name}@${pkg.version}`);
  const proc = Bun.spawn(
    ["bun", "add", "--no-save", `--os=${os}`, `--cpu=${cpu}`, ...specs],
    { cwd: root, stdout: "inherit", stderr: "inherit", windowsHide: true },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`Failed to install target-platform packages: ${specs.join(", ")}`);
  }
}

interface PackageVersions {
  dependencies?: StringDictionary;
  optionalDependencies?: StringDictionary;
}

function parsePackageVersions(value: unknown): PackageVersions {
  if (typeof value !== "object" || value === null) throw new Error("Invalid package.json: expected an object");
  const dependencies = "dependencies" in value ? stringDictionary(value.dependencies) : undefined;
  const optionalDependencies = "optionalDependencies" in value ? stringDictionary(value.optionalDependencies) : undefined;
  return { dependencies, optionalDependencies };
}

function stringDictionary(value: unknown): StringDictionary | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid package.json dependency map");
  const dictionary: StringDictionary = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") throw new Error("Invalid package.json dependency version");
    dictionary[name] = version;
  }
  return dictionary;
}

/** The version a package's runtime pins for `name`. A development dependency
 *  is not a runtime package, so it never names a package the build ships. */
function dependencyVersion(pkg: PackageVersions, name: string): string {
  return pkg.optionalDependencies?.[name] ?? pkg.dependencies?.[name] ?? "";
}

function packageVersion(value: unknown): string {
  if (typeof value !== "object" || value === null || !("version" in value)) return "";
  return typeof value.version === "string" ? value.version : "";
}

export async function resetNativeDir(nativeDir: string): Promise<void> {
  await rm(nativeDir, { recursive: true, force: true });
  await mkdir(nativeDir, { recursive: true });
}

export type NativeProvenance =
  | { readonly kind: "source-build" }
  | { readonly kind: "tracked-prebuilt" };

export async function copyNativeAssets(
  root: string,
  nativeDir: string,
  platformArch: string,
  provenance: NativeProvenance,
): Promise<void> {
  await mkdir(nativeDir, { recursive: true });
  await stageRipgrepAddon(root, nativeDir, platformArch, provenance);
  const tokenizerSource = join(root, "crates", "tokenizer", TOKENIZER_ASSET_FILE);
  await verifyTokenizerAsset(root, tokenizerSource);
  await copyFile(tokenizerSource, join(nativeDir, TOKENIZER_ASSET_FILE));
  if (platformArch.startsWith("darwin-")) {
    const launcherSource = join(macosLauncherDir(root), MACOS_LAUNCHER_BUNDLE);
    await verifyMacosLauncherAsset(root, launcherSource);
    const staged = join(nativeDir, MACOS_LAUNCHER_BUNDLE);
    await rm(staged, { recursive: true, force: true });
    await cp(launcherSource, staged, { recursive: true });
  }
  if (platformArch.startsWith("win32-")) {
    for (const [variant, destination] of [["console", WINDOWS_LAUNCHER_EXECUTABLE], ["service", WINDOWS_SERVICE_LAUNCHER_EXECUTABLE]] as const) {
      const launcherSource = join(windowsLauncherDir(root), windowsLauncherPrebuiltName(platformArch, variant));
      await verifyWindowsLauncherAsset(root, platformArch, variant, launcherSource);
      await copyFile(launcherSource, join(nativeDir, destination));
    }
    const forwarderSource = join(windowsGitForwarderDir(root), windowsGitForwarderPrebuiltName(platformArch));
    await verifyWindowsGitForwarderAsset(root, platformArch, forwarderSource);
    await copyFile(forwarderSource, join(nativeDir, WINDOWS_GIT_FORWARDER_EXECUTABLE));
  }
  await copyFile(await openTuiLibraryPath(root, platformArch), join(nativeDir, `libopentui${nativeLibraryExt(platformArch)}`));
  await copyTreeSitterWasmAssets(root, nativeDir);

  const runtimeNodeModulesDir = join(nativeDir, "node_modules");
  await rm(runtimeNodeModulesDir, { recursive: true, force: true });
  await mkdir(runtimeNodeModulesDir, { recursive: true });
  for (const packageName of nativeRuntimePackages(platformArch)) {
    await copyRuntimePackage(root, runtimeNodeModulesDir, packageName);
  }
  await patchVendoredSharpRuntime(runtimeNodeModulesDir, platformArch);
}

export async function verifyNativeAssets(nativeDir: string, platformArch: string, root = resolve(import.meta.dir, "..")): Promise<void> {
  const entries = await readdir(nativeDir);
  const missing: string[] = [];

  if (!entries.includes(ripgrepAddonName(platformArch))) missing.push(ripgrepAddonName(platformArch));
  if (!entries.includes(TOKENIZER_ASSET_FILE)) {
    missing.push(TOKENIZER_ASSET_FILE);
  } else {
    await verifyTokenizerAsset(root, join(nativeDir, TOKENIZER_ASSET_FILE));
  }
  if (platformArch.startsWith("darwin-")) {
    if (!entries.includes(MACOS_LAUNCHER_BUNDLE)) missing.push(MACOS_LAUNCHER_BUNDLE);
    else await verifyMacosLauncherAsset(root, join(nativeDir, MACOS_LAUNCHER_BUNDLE));
  }
  if (platformArch.startsWith("win32-")) {
    for (const [variant, destination] of [["console", WINDOWS_LAUNCHER_EXECUTABLE], ["service", WINDOWS_SERVICE_LAUNCHER_EXECUTABLE]] as const) {
      if (!entries.includes(destination)) missing.push(destination);
      else await verifyWindowsLauncherAsset(root, platformArch, variant, join(nativeDir, destination));
    }
    if (!entries.includes(WINDOWS_GIT_FORWARDER_EXECUTABLE)) missing.push(WINDOWS_GIT_FORWARDER_EXECUTABLE);
    else await verifyWindowsGitForwarderAsset(root, platformArch, join(nativeDir, WINDOWS_GIT_FORWARDER_EXECUTABLE));
  }
  for (const asset of TREE_SITTER_WASM_ASSETS) {
    if (!entries.includes(asset.destination)) missing.push(asset.destination);
  }

  const openTuiExt = nativeLibraryExt(platformArch);
  if (!entries.some((entry) => isOpenTuiLibrary(entry, openTuiExt))) {
    missing.push(`*opentui*${openTuiExt}`);
  }

  const runtimeNodeModulesDir = join(nativeDir, "node_modules");
  const sharpArch = sharpPlatformArch(platformArch);
  const sharpNodeDir = join(runtimeNodeModulesDir, "@img", `sharp-${sharpArch}`, "lib");
  const sharpNodeFiles = existsSync(sharpNodeDir) ? await readdir(sharpNodeDir) : [];
  if (!sharpNodeFiles.some((entry) => entry.startsWith(`sharp-${sharpArch}`) && entry.endsWith(".node"))) {
    missing.push(join(sharpNodeDir, `sharp-${sharpArch}*.node`));
  }

  const libvipsDir = join(runtimeNodeModulesDir, ...libvipsPackage(platformArch).split("/"), "lib");
  const libvipsFiles = existsSync(libvipsDir) ? await readdir(libvipsDir) : [];
  const libvipsExt = nativeLibraryExt(platformArch);
  const hasLibvips = platformArch.startsWith("win32-")
    ? libvipsFiles.some((entry) => entry.startsWith("libvips") && entry.endsWith(libvipsExt))
    : libvipsFiles.some((entry) => entry.startsWith("libvips-cpp") && entry.includes(libvipsExt));
  if (!hasLibvips) {
    missing.push(join(libvipsDir, platformArch.startsWith("win32-") ? `libvips*${libvipsExt}` : `libvips-cpp*${libvipsExt}*`));
  }

  if (missing.length > 0) {
    throw new Error(`Missing native asset(s) for ${platformArch}: ${missing.join(", ")}`);
  }
}

async function copyTreeSitterWasmAssets(root: string, nativeDir: string): Promise<void> {
  for (const asset of TREE_SITTER_WASM_ASSETS) {
    await copyFile(
      join(root, "node_modules", ...asset.source),
      join(nativeDir, asset.destination),
    );
  }
}

async function stageRipgrepAddon(root: string, nativeDir: string, platformArch: string, provenance: NativeProvenance): Promise<void> {
  const stagedPath = join(nativeDir, ripgrepAddonName(platformArch));
  if (provenance.kind === "source-build") {
    await buildRipgrepAddon(root, platformArch, nativeDir);
    return;
  }

  const addon = ripgrepAddonName(platformArch);
  const source = ripgrepAddonPath(root, platformArch);
  const crateDir = join(root, "crates", "ripgrep");
  if (!await trackedNativeAddonIsCurrent(crateDir, platformArch, source)) {
    console.log(`Building stale or unverified ${addon}...`);
    const proc = Bun.spawn(["bun", "run", join(root, "scripts", "build-ripgrep.ts"), `--platform-arch=${platformArch}`], {
      cwd: root, stdout: "inherit", stderr: "inherit", windowsHide: true,
    });
    if ((await proc.exited) !== 0 || !await trackedNativeAddonIsCurrent(crateDir, platformArch, source)) {
      throw new Error(`Failed to build a verified native addon for ${platformArch}: ${addon}`);
    }
  }
  await copyFile(source, stagedPath);
}

async function buildRipgrepAddon(root: string, platformArch: string, outputDir: string): Promise<void> {
  const outputPath = join(outputDir, ripgrepAddonName(platformArch));
  console.log(`Building ripgrep native addon for ${platformArch}...`);
  const proc = Bun.spawn([
    "bun",
    "run",
    join(root, "scripts", "build-ripgrep.ts"),
    `--platform-arch=${platformArch}`,
    `--output-dir=${outputDir}`,
  ], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  });
  if ((await proc.exited) !== 0) throw new Error(`Failed to build ripgrep native addon for ${platformArch}`);
  if (!existsSync(outputPath)) throw new Error(`Missing freshly built ripgrep native addon for ${platformArch}: ${outputPath}`);
}



async function copyRuntimePackage(root: string, runtimeNodeModulesDir: string, packageName: string): Promise<void> {
  const segments = packageName.split("/");
  const source = join(root, "node_modules", ...segments);
  const destination = join(runtimeNodeModulesDir, ...segments);
  const destinationParent = join(runtimeNodeModulesDir, ...segments.slice(0, -1));

  try {
    await mkdir(destinationParent, { recursive: true });
    // The staged package is patched in place below, so it must be a copy of
    // the files: a package the checkout installs as a link would otherwise
    // stage as that link, and the patch would rewrite the installed package.
    await cp(source, destination, { recursive: true, force: true, dereference: true });
  } catch (error) {
    throw new Error(`Missing native runtime package ${packageName}: ${error}`, { cause: error });
  }
}

/** Rewrites the vendored sharp runtime's bare-specifier requires to relative
 *  paths. The compiled binary loads this tree from disk by absolute path, where
 *  bare specifiers resolve into the binary's bundled module graph instead of
 *  the vendored node_modules, so every require reachable at runtime must be a
 *  relative path. sharp 0.35 ships its runtime as dist/*.cjs and requires the
 *  prebuilt .node through a static per-platform exports subpath; we route that
 *  through the platform package's index.cjs, which itself uses relative paths. */
async function patchVendoredSharpRuntime(runtimeNodeModulesDir: string, platformArch: string): Promise<void> {
  const runtimePlatform = ["", "{runtimePlatform}"].join("$");
  const patches = [
    { file: join(runtimeNodeModulesDir, "sharp", "dist", "colour.cjs"), replacements: [["require('@img/colour')", "require('../../@img/colour/index.cjs')"]] },
    { file: join(runtimeNodeModulesDir, "sharp", "dist", "utility.cjs"), replacements: [["require('detect-libc')", "require('../../detect-libc/lib/detect-libc.js')"], [`require(\`@img/sharp-${runtimePlatform}/versions\`)`, `require(\`../../@img/sharp-${runtimePlatform}/versions.json\`)`], [`require(\`@img/sharp-libvips-${runtimePlatform}/versions\`)`, `require(\`../../@img/sharp-libvips-${runtimePlatform}/versions.json\`)`]] },
    { file: join(runtimeNodeModulesDir, "sharp", "dist", "sharp.cjs"), replacements: [['require("detect-libc")', 'require("../../detect-libc/lib/detect-libc.js")'], [`require("@img/sharp-${sharpPlatformArch(platformArch)}/sharp.node")`, `require("../../@img/sharp-${sharpPlatformArch(platformArch)}/index.cjs")`], [`require(\`@img/sharp-libvips-${runtimePlatform}/package\`)`, `require(\`../../@img/sharp-libvips-${runtimePlatform}/package.json\`)`]] },
    { file: join(runtimeNodeModulesDir, "sharp", "dist", "libvips.cjs"), replacements: [["require('semver')", "require('../../semver/index.js')"], ["require('detect-libc')", "require('../../detect-libc/lib/detect-libc.js')"]] },
  ] as const;

  for (const patch of patches) {
    let content = await readFile(patch.file, "utf-8");
    for (const [oldText, newText] of patch.replacements) {
      if (!content.includes(oldText)) throw new Error(`Missing vendored sharp snippet in ${patch.file}: ${oldText}`);
      content = content.replace(oldText, newText);
    }
    await Bun.write(patch.file, content);
  }
}

function ripgrepAddonPath(root: string, platformArch: string): string {
  return join(root, "crates", "ripgrep", ripgrepAddonName(platformArch));
}

async function openTuiLibraryPath(root: string, platformArch: string): Promise<string> {
  const packageDir = join(root, "node_modules", "@opentui", `core-${platformArch}`);
  const ext = nativeLibraryExt(platformArch);
  const entry = (await readdir(packageDir)).find((name) => isOpenTuiLibrary(name, ext));
  if (!entry) throw new Error(`Missing OpenTUI native library for ${platformArch} in ${packageDir}`);
  return join(packageDir, entry);
}

export function nativeLibraryExt(platformArch: string): ".dylib" | ".so" | ".dll" {
  if (platformArch.startsWith("darwin-")) return ".dylib";
  if (platformArch.startsWith("win32-")) return ".dll";
  return ".so";
}

function isOpenTuiLibrary(entry: string, ext: ".dylib" | ".so" | ".dll"): boolean {
  return entry === `libopentui${ext}`
    || entry === `opentui${ext}`
    || (entry.startsWith("libopentui-") && entry.endsWith(ext))
    || (entry.startsWith("opentui-") && entry.endsWith(ext));
}
