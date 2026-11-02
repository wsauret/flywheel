// Build a distributable tarball: compiled binary + assets + build identity.
//
// Usage:
//   bun run scripts/build-binary.ts                     # current platform
//   bun run scripts/build-binary.ts --target=bun-linux-x64  # cross-compile
//   bun run scripts/build-binary.ts --release           # compile in the publisher inputs (updates, reports)
//
// Output: dist/flywheel-<platform>-<arch>.tar.gz

import { chmod, copyFile, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";
import { $ } from "bun";
import {
  copyNativeAssets,
  ensureTargetNativePackages,
  type NativeProvenance,
  nativeLibraryExt,
  platformArchForTarget,
  TREE_SITTER_WASM_FILES,
  verifyNativeAssets,
} from "./binary-native-assets.js";
import { BINARY_COMPILE_FLAGS, BINARY_ENTRIES, bundledEntryName } from "./binary-entries.js";
import { patchBundleScript } from "./bundle-asset-patch.js";
import { GENERATED_MANIFESTS, manifestRestoreSource } from "./build-manifest.js";
import { patchOpenTuiNativePackageImportFiles, restorePatchedFiles } from "./opentui-native-package-patch.js";
import { BUILD_METADATA_FILE, buildExecutable, computeBuildId } from "../src/infra/update/build-identity.js";
import { stageLegalPayload } from "./legal-payload.js";
import { stageClaudeEngine, verifyClaudeEngine } from "./claude-engine-asset.js";
import { assertEmbeddedBunRuntimeReviewed, checkThirdPartyLicenses } from "./generate-third-party-licenses.js";
import { releaseBuildInputs } from "./release-contract.js";
import { parseRepositoryIdentity } from "../src/infra/update/release-manifest.js";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const FONTS_SRC = join(ROOT, "assets", "fonts", "monaspace-argon");
const WEBVIEW_ROOT = join(ROOT, "webview");
const WEBVIEW_DIST = join(WEBVIEW_ROOT, "dist");

const targetArg = process.argv.find((argument) => argument.startsWith("--target="));
const target = targetArg?.split("=")[1];
const provenanceArg = process.argv.find((argument) => argument.startsWith("--native-provenance="))?.split("=")[1];
if (provenanceArg !== undefined && provenanceArg !== "source-build" && provenanceArg !== "tracked-prebuilt") {
  throw new Error(`Unsupported native provenance: ${provenanceArg}`);
}
// Only the release build commands pass `--release` (ARCH-DISTRIBUTION-034).
// A release build compiles in the repository it updates from and, when the
// official release machine names one, the report endpoint. Every other build,
// a local install included, compiles in neither: it never updates itself and
// sends no report.
const publisher = process.argv.includes("--release") ? releaseBuildInputs(process.env) : undefined;
if (publisher !== undefined) parseRepositoryIdentity(publisher.updateRepository);
console.log(publisher === undefined
  ? "Publisher inputs: none; this build never updates itself and sends no bug reports."
  : `Publisher inputs: updates from ${publisher.updateRepository}; ${publisher.reportEndpoint === undefined ? "no report endpoint, so it sends no bug reports" : "report endpoint compiled in from the release environment"}.`);
const nativeProvenance: NativeProvenance = provenanceArg === "source-build"
  ? { kind: "source-build" }
  : { kind: "tracked-prebuilt" };

const platformArch = platformArchForTarget(target);
/** The platform the build is for, which decides its executable's name and
 *  whether its identity states an execute bit. */
const targetPlatform = platformArch.split("-")[0] ?? process.platform;
const isWindowsTarget = targetPlatform === "win32";
const stagingDir = join(DIST, `flywheel-${platformArch}`);
// The code-split bundle names its chunks by content hash, so every build clears
// its own folder first; dist/ itself also holds archives and other targets' staging.
const bundleDir = join(DIST, `bundle-${platformArch}`);
// Every platform installs one immutable build tree (ARCH-DISTRIBUTION-015), so the archive
// carries the payload as its own directory and the installer beside it.
const payloadDir = join(stagingDir, "build");
const fontsStagingDir = join(payloadDir, "fonts", "monaspace-argon");
const nativeStagingDir = join(payloadDir, "native", platformArch);
const webviewStagingDir = join(payloadDir, "webview");
const binaryName = buildExecutable(targetPlatform);

const assetExts = [".wasm", ".scm", ".dylib", ".so", ".dll", ".node"] as const;
const archiveInstallCommand = isWindowsTarget
  ? `tar -xzf ${archiveName(platformArch)}; cd ${basename(stagingDir)}; .\\install.ps1`
  : `tar xzf ${archiveName(platformArch)} && cd ${basename(stagingDir)} && ./install.sh`;

// Bun's bundler transpiles TypeScript without checking it. Refuse to replace a
// known-good artifact with a binary assembled from an impossible runtime shape.
console.log("Type-checking...");
await $`bun run --cwd ${ROOT} lint:tsc`;

await rm(stagingDir, { recursive: true, force: true });
await rm(bundleDir, { recursive: true, force: true });
await mkdir(nativeStagingDir, { recursive: true });

// Step 0: Apply dependency patches (idempotent, also runs on postinstall).
await $`bun run ${join(ROOT, "scripts", "patch-deps.ts")}`;

// Step 0a: Ensure target-platform native packages exist in node_modules.
// Every bundle must embed its target's native artifacts, and bun install does
// not guarantee they exist: foreign-platform optionals are skipped by their
// os/cpu constraints, and a workspace-configured install skips even the host's.
// Install what the build requires on demand without modifying package.json.
await ensureTargetNativePackages(ROOT, platformArch);

// Step 0b: Snapshot what each generated manifest must be restored to. The
// populate step itself runs inside the bundle try/finally below, so a failed
// build cannot leave generated content in the source tree.
const manifestRestorePoints = new Map<string, string>();
for (const manifest of GENERATED_MANIFESTS) {
  manifestRestorePoints.set(manifest.path, manifestRestoreSource(manifest, await readFile(manifest.path, "utf-8")));
}
interface PackageMetadata {
  readonly version?: unknown
}

const packageMetadata: PackageMetadata = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"))
const packageVersion = typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";

const bundleResult = await (async () => {
  let opentuiPatchOriginals = new Map<string, string>();

  try {
    // Step 1a: Populate the generated manifests with real content.
    console.log("Populating agent manifests...");
    for (const manifest of GENERATED_MANIFESTS) await manifest.write(manifest.path);

    // Step 1b: Statically resolve the @opentui/core native-package import.
    // The bundled binary ships one target's native assets, so OpenTUI's runtime
    // package selection must be pinned to the build target before Bun bundles it.
    console.log("Patching opentui native-package import...");
    opentuiPatchOriginals = await patchOpenTuiNativePackageImportFiles(ROOT, platformArch);
    console.log(`  patched ${opentuiPatchOriginals.size} file(s)`);

    // Step 1c: Bundle with Solid plugin. Code splitting is load-bearing: the
    // CLI entry selects its role through lazy imports, so the guardian and the
    // command supervisor load only their own chunks, and every lane spawn
    // skips parsing the runtime it never uses. One bundle without splitting
    // costs each process ~115 MB RSS and ~200 ms before any role code runs.
    console.log("Bundling...");
    return await Bun.build({
      entrypoints: BINARY_ENTRIES.map((entry) => join(ROOT, entry)),
      outdir: bundleDir,
      naming: { entry: "[name].[ext]" },
      target: "bun",
      splitting: true,
      plugins: [solidPlugin],
      conditions: ["browser"],
      define: {
        "process.env.FLYWHEEL_APP_VERSION": JSON.stringify(packageVersion),
        // The target this build is for, which `buildPlatformArch` states. A
        // musl build is told it is one here; nothing at runtime detects it.
        "process.env.FLYWHEEL_PLATFORM_ARCH": JSON.stringify(platformArch),
        // The publisher inputs, defined in every build, so a binary without
        // one cannot read one from its environment.
        "process.env.FLYWHEEL_UPDATE_REPOSITORY": JSON.stringify(publisher?.updateRepository ?? ""),
        "process.env.FLYWHEEL_REPORT_ENDPOINT": JSON.stringify(publisher?.reportEndpoint ?? ""),
      },
    });
  } finally {
    for (const [manifestPath, source] of manifestRestorePoints) await Bun.write(manifestPath, source);
    await restorePatchedFiles(opentuiPatchOriginals);
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

if (!bundleResult.success) {
  for (const log of bundleResult.logs) console.error(log);
  process.exit(1);
}
console.log(`  ${bundleResult.outputs.length} file(s) bundled`);

// Step 2a: Patch every JavaScript output (the entries and the chunks
// splitting emitted) so native asset references resolve next to the executable
// on disk. An asset reference lives wherever its importer landed. The rewrite
// itself is scripts/bundle-asset-patch.ts.
console.log("Patching asset paths...");
// copyNativeAssets stages these under their canonical names; point the bundle's
// hashed references at them so the hashed duplicates need not ship.
const canonicalAssetNames = new Set([
  `libopentui${nativeLibraryExt(platformArch)}`,
  ...TREE_SITTER_WASM_FILES,
]);
let patchCount = 0;
let attributedChunkImportCount = 0;
const canonicalizedAssets = new Set<string>();
for (const output of bundleResult.outputs) {
  if (!output.path.endsWith(".js")) continue;
  const patched = patchBundleScript(await readFile(output.path, "utf-8"), { platformArch, canonicalAssetNames });
  patchCount += patched.assetReferences;
  attributedChunkImportCount += patched.attributedChunkImports;
  for (const name of patched.canonicalizedAssets) canonicalizedAssets.add(name);
  await Bun.write(output.path, patched.source);
}
if (patchCount === 0) {
  console.error("Asset path patch matched 0 references — bundle output format changed.");
  process.exit(1);
}
console.log(`  patched ${patchCount} asset reference(s), ${attributedChunkImportCount} attributed chunk import(s)`);

// Step 2b: Compile bundle into standalone binary.
console.log("Compiling standalone binary...");
const compileArgs = [
  "bun",
  "build",
  ...BINARY_COMPILE_FLAGS,
  ...BINARY_ENTRIES.map((entry) => `./${bundledEntryName(entry)}`),
  "--outfile",
  join(payloadDir, binaryName),
];
if (target) compileArgs.push(`--target=${target}`);

const compileProc = Bun.spawn(compileArgs, { cwd: bundleDir, stdout: "inherit", stderr: "inherit", windowsHide: true });
const compileExit = await compileProc.exited;
if (compileExit !== 0) {
  console.error("Compile failed");
  process.exit(1);
}

// Bun leaves a malformed LC_CODE_SIGNATURE — strip it, then ad-hoc sign. The
// signature is part of the build's identity, so it is applied here, once, and
// never re-applied to an installed tree: a build directory is immutable.
if (process.platform === "darwin" && platformArch.startsWith("darwin-")) {
  console.log("Signing binary (ad-hoc)...");
  const binaryPath = join(payloadDir, binaryName);
  const strip = Bun.spawn(["codesign", "--remove-signature", binaryPath], {
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  });
  if ((await strip.exited) !== 0) {
    console.error("Failed to strip signature");
    process.exit(1);
  }
  const sign = Bun.spawn(["codesign", "--sign", "-", "--force", binaryPath], {
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  });
  if ((await sign.exited) !== 0) {
    console.error("Ad-hoc signing failed");
    process.exit(1);
  }
}

// Step 3: Copy runtime assets into the native directory referenced by the
// patched bundle and by source-mode dev preflight. Only this build's bundler
// outputs are eligible, and only target-platform native libraries ship.
// Canonicalized assets are skipped — copyNativeAssets stages those bytes under their canonical names.
console.log("Copying native assets...");
await copyNativeAssets(ROOT, nativeStagingDir, platformArch, nativeProvenance);
// The Claude engine ships only in a build: a source run runs the copy that bun installed in node_modules, so the
// per-run native staging of a source run never copies it.
console.log("Staging the Claude engine...");
await stageClaudeEngine(ROOT, nativeStagingDir, platformArch);
// Only a release build is distributed, so only it must embed the runtime that the license bundle documents.
if (publisher !== undefined) assertEmbeddedBunRuntimeReviewed();
await checkThirdPartyLicenses(ROOT);
await stageLegalPayload(ROOT, payloadDir);
const targetLibraryExt = nativeLibraryExt(platformArch);
const foreignLibraryExts = ([".dylib", ".so", ".dll"] as const).filter((ext) => ext !== targetLibraryExt);
const shipsWithBinary = (name: string): boolean => {
  if (!assetExts.some((ext) => name.endsWith(ext))) return false;
  if (canonicalizedAssets.has(name)) return false;
  if (foreignLibraryExts.some((ext) => name.endsWith(ext))) return false;
  return true;
};
let shippedAssetCount = 0;
for (const output of bundleResult.outputs) {
  const name = basename(output.path);
  if (!shipsWithBinary(name)) continue;
  await copyFile(output.path, join(nativeStagingDir, name));
  shippedAssetCount++;
}
console.log(`  ${shippedAssetCount} bundler asset(s) shipped, ${canonicalizedAssets.size} canonicalized`);
await verifyNativeAssets(nativeStagingDir, platformArch);
await verifyClaudeEngine(ROOT, nativeStagingDir, platformArch);

// Step 4: Copy bundled font
console.log("Copying bundled font...");
await rm(fontsStagingDir, { recursive: true, force: true });
await mkdir(fontsStagingDir, { recursive: true });
await cp(FONTS_SRC, fontsStagingDir, { recursive: true, force: true });

// Step 5: Build and stage the shared web client. The build itself never
// clears its output, because a source runtime may be serving it; the release
// build owns a clean output so only this build's files ship.
console.log("Building shared webview...");
await rm(WEBVIEW_DIST, { recursive: true, force: true });
const webviewBuild = Bun.spawn(["bun", "run", "--cwd", WEBVIEW_ROOT, "build"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
  windowsHide: true,
});
const webviewBuildExit = await webviewBuild.exited;
if (webviewBuildExit !== 0) throw new Error(`Webview build failed with exit code ${webviewBuildExit}`);
await rm(webviewStagingDir, { recursive: true, force: true });
await cp(WEBVIEW_DIST, webviewStagingDir, { recursive: true, force: true });

// Step 6: State what this build is. The identity is a digest of the payload
// tree, so the installer can prove that what it places is what was published,
// and two builds of one version are two immutable siblings (ARCH-DISTRIBUTION-015). The
// installer scripts are written after this step, so they are not part of it.
console.log("Computing build identity...");
const buildId = computeBuildId(payloadDir, targetPlatform);
await Bun.write(
  join(payloadDir, BUILD_METADATA_FILE),
  `${JSON.stringify({ version: packageVersion, buildId, asset: archiveName(platformArch) }, null, 2)}\n`,
);

// Step 7: Generate install script
console.log("Generating install script...");
if (isWindowsTarget) {
  await Bun.write(join(stagingDir, "install.ps1"), windowsInstallScript());
  await Bun.write(join(stagingDir, "install.cmd"), windowsInstallCmd());
} else {
  await Bun.write(join(stagingDir, "install.sh"), unixInstallScript(binaryName));
  await chmod(join(stagingDir, "install.sh"), 0o755);
}

// Step 8: Create tarball
console.log("Creating tarball...");
const tarball = archiveName(platformArch);
// Native tar preserves file modes; Bun's libdeflate compresses the complete tar
// faster than tar's streaming zlib, at the cost of buffering the payload.
const tarProc = Bun.spawn(["tar", "-cf", "-", "-C", DIST, basename(stagingDir)], {
  cwd: DIST,
  // macOS tar otherwise writes an AppleDouble `._` entry for every file that
  // carries an extended attribute. Those entries are not in the payload
  // identity, and a non-macOS tar extracts them as files, so the installer
  // refuses the tree. Bun.spawn inherits the startup environment, not later
  // `process.env` writes, so the variable is passed here.
  env: { ...process.env, COPYFILE_DISABLE: "1" },
  stdout: "pipe",
  stderr: "inherit",
  windowsHide: true,
});
const archiveBytes = await new Response(tarProc.stdout).arrayBuffer();
const tarExit = await tarProc.exited;
if (tarExit !== 0) throw new Error(`Tar failed with exit code ${tarExit}`);
await Bun.write(join(DIST, tarball), Bun.gzipSync(archiveBytes, { library: "libdeflate", level: 6 }));

// Summary
const tarballStat = await stat(join(DIST, tarball));
const sizeMB = (tarballStat.size / 1024 / 1024).toFixed(1);
console.log(`\nBuild complete: dist/${tarball} (${sizeMB} MB)`);
console.log(`  Binary:  ${binaryName} (standalone)`);
console.log(`  Native:  native/${platformArch} (${assetExts.map((e) => `*${e}`).join(", ")} + sharp runtime)`);
console.log(`  Font:    Monaspace Argon`);
console.log(`  Build:   ${packageVersion} ${buildId}`);
console.log(`  Install: ${archiveInstallCommand}`);

function archiveName(targetPlatformArch: string): string {
  return `flywheel-${targetPlatformArch}.tar.gz`;
}

/** The archive's own installer. It is an ingress adapter and nothing more: it
 *  locates the payload beside itself and re-enters the binary in its install
 *  role, which owns the layout, the staging, the macOS preparation, and the
 *  activation (ARCH-DISTRIBUTION-014). The PATH line below is the one thing that is the
 *  user's shell rather than the installation, and `FLYWHEEL_NO_MODIFY_PATH`
 *  declines it. It is POSIX sh, because a musl Linux such as Alpine installs
 *  no bash.
 *
 *  An opt-out is required rather than convenient. The Unix side writes a shell
 *  profile under `$HOME`, so a caller that wants no trace of itself can point
 *  `HOME` somewhere disposable. The Windows side writes the account's `Path` in
 *  the registry, which no environment override can redirect, so a caller that
 *  installs to a throwaway directory has no way to decline the PATH entry and
 *  every such run leaves one behind for a directory that no longer exists. */
function unixInstallScript(targetBinaryName: string): string {
  return `#!/bin/sh
set -eu

SCRIPT_DIR="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
PAYLOAD="$SCRIPT_DIR/build"
INSTALL_DIR="\${FLYWHEEL_INSTALL_DIR:-$HOME/.local/bin}"
if [ "\${1:-}" != "--downloaded" ]; then
  if [ -f "$HOME/.flywheel/current/build.json" ]; then
    CURRENT_VERSION="$(awk -F '"' '$2 == "version" && $4 ~ /^[0-9]+\\.[0-9]+\\.[0-9]+$/ { print $4; exit }' "$HOME/.flywheel/current/build.json")"
    printf 'Installed version: %s\\n' "\${CURRENT_VERSION:-unknown}"
  fi
  printf '\\nInstalling flywheel version: ${packageVersion}\\n'
fi

[ -f "$PAYLOAD/${targetBinaryName}" ] || { echo "  the archive holds no build payload" >&2; exit 1; }
[ -x "$PAYLOAD/${targetBinaryName}" ] || { echo "  the build payload is not executable" >&2; exit 1; }

# A tarball downloaded by a browser or Slack carries the macOS quarantine
# attribute, and tar propagates it to every extracted file. Gatekeeper kills a
# quarantined ad-hoc-signed binary before it runs, so the attribute must go
# before the binary is invoked; the binary's own install role clears it again
# on the staged copy it publishes.
if [ "$(uname -s)" = "Darwin" ]; then
  /usr/bin/xattr -dr com.apple.quarantine "$SCRIPT_DIR" 2>/dev/null || true
fi

"$PAYLOAD/${targetBinaryName}" --internal-role=binary-install

if [ -n "\${FLYWHEEL_NO_MODIFY_PATH:-}" ]; then
  echo "  Leaving PATH alone: FLYWHEEL_NO_MODIFY_PATH is set"
elif ! echo "$PATH" | tr ':' '\\n' | grep -qx "$INSTALL_DIR"; then
  SHELL_NAME="$(basename "\${SHELL:-sh}")"
  case "$SHELL_NAME" in
    zsh)  PROFILE="$HOME/.zshrc" ;;
    bash) PROFILE="$HOME/.bashrc" ;;
    *)    PROFILE="$HOME/.profile" ;;
  esac

  echo "" >> "$PROFILE"
  printf 'export PATH="%s:$PATH"\\n' "$INSTALL_DIR" >> "$PROFILE"
  echo "  Added $INSTALL_DIR to PATH in $PROFILE"
  echo "  Open a new terminal to use the updated PATH."
fi

if [ "\${1:-}" = "--downloaded" ]; then exit 0; fi
if [ -t 1 ] && [ -z "\${NO_COLOR:-}" ]; then
  printf '\\n\\033[2m█▀▀▀▀ █    █   █\\033[0m █   █ █   █ █▀▀▀▀ █▀▀▀▀ █\\n'
  printf '\\033[2m█▄▄▄  █     ▀▄▀ \\033[0m █ ▄ █ █▄▄▄█ █▄▄▄  █▄▄▄  █\\n'
  printf '\\033[2m█     █      █  \\033[0m █ █ █ █   █ █     █     █\\n'
  printf '\\033[2m▀     ▀▀▀▀▀  ▀  \\033[0m  ▀ ▀  ▀   ▀ ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀\\n\\n'
else
  printf '\\nFlywheel installed\\n\\n'
fi
printf 'To start:\\n\\n  cd <project>  # Open your project\\n  flywheel      # Start Flywheel\\n\\n'
`;
}

/** The archive's own Windows installer, the counterpart of `install.sh`. It is
 *  an ingress adapter and nothing more: it locates the payload beside itself
 *  and re-enters the build in its install role, which owns the versions tree,
 *  the staging, the activation, the launcher, and the conversion of a flat
 *  installation (ARCH-DISTRIBUTION-014). The PATH entry is the one thing that is the user's
 *  account rather than the installation, and `FLYWHEEL_NO_MODIFY_PATH`
 *  declines it.
 *
 *  The installed version is read the way the launcher finds its build: the
 *  pointer `<account home>\.flywheel\current`, with the account home `HOME`
 *  else `USERPROFILE`. */
function windowsInstallScript(): string {
  return `$ErrorActionPreference = "Stop"
$Downloaded = $args -contains "-Downloaded"

function Fail($Message) {
  Write-Error "  $Message"
  exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Binary = Join-Path (Join-Path $ScriptDir "build") "${binaryName}"
$AccountHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
$InstallDir = if ($env:FLYWHEEL_INSTALL_DIR) { $env:FLYWHEEL_INSTALL_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Flywheel\\bin" } else { Join-Path $AccountHome ".flywheel\\bin" }

# The version the account runs now: the build the pointer names, or the
# metadata a flat installation of an earlier release keeps beside its
# executable. Remove the flat branch after 2026-12-28. Reading it only
# informs the person, so a pointer or metadata that cannot be read says
# "unknown" and never stops the installation.
function Get-InstalledVersion {
  try {
    $pointer = Join-Path $AccountHome ".flywheel\\current"
    $metadata = Join-Path $InstallDir "build.json"
    if (Test-Path -LiteralPath $pointer -PathType Leaf) {
      $metadata = Join-Path (Join-Path (Join-Path $AccountHome ".flywheel") ([System.IO.File]::ReadAllText($pointer).Trim())) "build.json"
    }
    if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) { return $null }
    $version = (Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json).version
  } catch {
    return "unknown"
  }
  if ($version -notmatch '^[0-9]+\\.[0-9]+\\.[0-9]+$') { return "unknown" }
  return $version
}

if (-not $Downloaded) {
  $Installed = Get-InstalledVersion
  if ($Installed) { Write-Host "Installed version: $Installed" }
  Write-Host ""
  Write-Host "Installing flywheel version: ${packageVersion}"
}

if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) { Fail "the archive holds no build payload" }

# The install role reports its own refusal on standard error and in its exit
# code, so its output passes through unchanged.
$ErrorActionPreference = "Continue"
& $Binary --internal-role=binary-install
$InstallExit = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($InstallExit -ne 0) { exit 1 }

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$ExistingPaths = @($UserPath -split ";" | Where-Object { $_ })
if ($env:FLYWHEEL_NO_MODIFY_PATH) {
  Write-Host "  Leaving PATH alone: FLYWHEEL_NO_MODIFY_PATH is set"
} elseif ($ExistingPaths -notcontains $InstallDir) {
  $NewPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
  [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
  $env:Path = "$env:Path;$InstallDir"
  Write-Host "  Added $InstallDir to your user PATH"
}

if ($Downloaded) { return }
if (-not [Console]::IsOutputRedirected -and -not $env:NO_COLOR) {
  Write-Host ""
  Write-Host '█▀▀▀▀ █    █   █' -NoNewline -ForegroundColor DarkGray
  Write-Host ' █   █ █   █ █▀▀▀▀ █▀▀▀▀ █'
  Write-Host '█▄▄▄  █     ▀▄▀ ' -NoNewline -ForegroundColor DarkGray
  Write-Host ' █ ▄ █ █▄▄▄█ █▄▄▄  █▄▄▄  █'
  Write-Host '█     █      █  ' -NoNewline -ForegroundColor DarkGray
  Write-Host ' █ █ █ █   █ █     █     █'
  Write-Host '▀     ▀▀▀▀▀  ▀  ' -NoNewline -ForegroundColor DarkGray
  Write-Host '  ▀ ▀  ▀   ▀ ▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀'
  Write-Host ""
} else {
  Write-Host ""
  Write-Host "Flywheel installed"
  Write-Host ""
}
Write-Host "To start:"
Write-Host ""
Write-Host "  cd <project>  # Open your project"
Write-Host "  flywheel      # Start Flywheel"
Write-Host ""
Write-Host "Installed. Open a new terminal and run: flywheel"
Write-Host ""
`;
}

function windowsInstallCmd(): string {
  return `@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
exit /b %ERRORLEVEL%
`;
}
