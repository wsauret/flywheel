import { copyFile, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { platformArchForTarget, resolveNativeAddonStagingPath, staleRipgrepPrebuilts } from "./binary-native-assets.js";
import { recordTrackedNativeAddon } from "./native-addon-fingerprint.js";
import { refreshCargoLicenseLedger } from "./cargo-license-ledger.js";

export interface NativeAddonBuild {
  readonly crate: string;
  readonly addon: string;
  readonly library: string;
}

/** The build configuration of one repository-owned crate, derived from its name. */
export function nativeAddonBuild(crate: string): NativeAddonBuild {
  if (crate !== "ripgrep") throw new Error("--crate must be ripgrep");
  return { crate, addon: `flywheel-${crate}`, library: `flywheel_${crate}` };
}

export async function buildNativeAddon(config: NativeAddonBuild, args = process.argv.slice(2)): Promise<void> {
  const root = join(import.meta.dir, "..");
  const crateDir = join(root, "crates", config.crate);
  const targetArg = args.find((arg) => arg.startsWith("--target="));
  const platformArchArg = args.find((arg) => arg.startsWith("--platform-arch="));
  const outputDirArg = args.find((arg) => arg.startsWith("--output-dir="));
  const explicitTarget = targetArg?.split("=")[1];
  const platformArch = platformArchArg?.split("=")[1] ?? platformArchForTarget(explicitTarget);
  const rustTarget = rustTargetForPlatformArch(platformArch);
  const explicitOutputDir = outputDirArg?.slice("--output-dir=".length);
  const addonName = `${config.addon}.${platformArch}.node`;
  const addonPath = explicitOutputDir === undefined
    ? join(crateDir, addonName)
    : await validatedStagingPath(root, explicitOutputDir, config.addon, platformArch);
  const targetDir = explicitTarget || platformArchArg ? join(crateDir, "target", rustTarget, "release") : join(crateDir, "target", "release");
  const library = nativeLibrary(config.library, platformArch);
  const buildPlan = cargoBuildPlan(platformArch, rustTarget, explicitTarget !== undefined || platformArchArg !== undefined);
  const remaps = rustPathRemaps(await realpath(root));

  console.log(`Building ${config.addon} (${platformArch} / ${rustTarget})...`);
  const build = buildPlan.missingTool && !Bun.which(buildPlan.missingTool)
    ? missingToolFailure(buildPlan, platformArch)
    : Bun.spawn([buildPlan.command, ...buildPlan.args], {
        cwd: crateDir,
        env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: cargoRustFlags(platformArch, remaps, library).join("\x1f") },
        stdout: "inherit",
        stderr: "inherit",
        windowsHide: true,
      });
  if ((await build.exited) !== 0) throw new Error(`${config.addon} native addon build failed`);
  await refreshCargoLicenseLedger(crateDir);

  const stagingDir = await mkdtemp(join(tmpdir(), `${config.addon}-`));
  const stagedAddonPath = join(stagingDir, addonName);
  try {
    await copyFile(join(targetDir, library), stagedAddonPath);
    const leaked = embeddedLocalPaths(await readFile(stagedAddonPath), [...remaps.map(({ from }) => from), homedir()]);
    if (leaked.length > 0) throw new Error(`${config.addon} addon embeds build-machine paths: ${leaked.join(", ")}`);
    if (platformArch.startsWith("darwin-")) {
      const strip = Bun.spawn(["codesign", "--remove-signature", stagedAddonPath], { stdout: "inherit", stderr: "inherit", windowsHide: true });
      if ((await strip.exited) !== 0) throw new Error(`Failed to strip ${config.addon} addon signature`);
      const sign = Bun.spawn(["codesign", "--sign", "-", "--force", stagedAddonPath], { stdout: "inherit", stderr: "inherit", windowsHide: true });
      if ((await sign.exited) !== 0) throw new Error(`Failed to sign ${config.addon} addon`);
      const verify = Bun.spawn(["codesign", "--verify", "--strict", stagedAddonPath], { stdout: "inherit", stderr: "inherit", windowsHide: true });
      if ((await verify.exited) !== 0) throw new Error(`Failed to verify ${config.addon} addon signature`);
    }
    await rm(addonPath, { force: true });
    await rename(stagedAddonPath, addonPath);
    if (outputDirArg === undefined) await recordTrackedNativeAddon(crateDir, platformArch, addonPath);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function validatedStagingPath(root: string, outputDir: string, addon: string, platformArch: string): Promise<string> {
  const destination = resolveNativeAddonStagingPath(root, outputDir, addon, platformArch);
  const physicalDist = await realpath(join(root, "dist"));
  const physicalOutput = await realpath(dirname(destination));
  const fromDist = relative(physicalDist, physicalOutput);
  if (fromDist === "" || fromDist === ".." || fromDist.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromDist)) {
    throw new Error(`Native addon output directory escapes the physical repository dist staging root: ${outputDir}`);
  }
  return join(physicalOutput, `${addon}.${platformArch}.node`);
}

function nativeLibrary(stem: string, platformArch: string): string {
  if (platformArch.startsWith("darwin-")) return `lib${stem}.dylib`;
  if (platformArch.startsWith("win32-")) return `${stem}.dll`;
  if (platformArch.startsWith("linux-")) return `lib${stem}.so`;
  throw new Error(`Unsupported native platform/arch: ${platformArch}`);
}

interface RustTargets { readonly [platformArch: string]: string }

function rustTargetForPlatformArch(platformArch: string): string {
  const targets: RustTargets = {
    "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-gnu", "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64-musl": "aarch64-unknown-linux-musl", "linux-x64-musl": "x86_64-unknown-linux-musl",
    "win32-arm64": "aarch64-pc-windows-msvc", "win32-x64": "x86_64-pc-windows-msvc",
  };
  const target = targets[platformArch];
  if (!target) throw new Error(`Unsupported native platform/arch: ${platformArch}`);
  return target;
}

interface CargoBuildPlan { command: string; args: string[]; missingTool?: string; installHint?: string }
function cargoBuildPlan(platformArch: string, rustTarget: string, explicit: boolean): CargoBuildPlan {
  if (explicit && platformArch.startsWith("win32-") && process.platform !== "win32") return { command: "cargo", args: ["xwin", "build", "--release", "--target", rustTarget], missingTool: "cargo-xwin", installHint: "cargo install cargo-xwin" };
  if (explicit && platformArch.startsWith("linux-") && process.platform !== "linux") return { command: "cargo", args: ["zigbuild", "--release", "--target", rustTarget], missingTool: "cargo-zigbuild", installHint: "cargo install cargo-zigbuild && brew install zig" };
  return { command: "cargo", args: ["build", "--release", ...(explicit ? ["--target", rustTarget] : [])] };
}

interface PathRemap { readonly from: string; readonly to: string }

/** The build-machine directories whose paths rustc would otherwise embed in panic locations and debug info, each with
 *  the fixed alias it becomes. The aliases make a prebuilt identical on every machine and keep the builder's home
 *  directory out of the published bytes. */
export function rustPathRemaps(root: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): readonly PathRemap[] {
  return [
    { from: env["CARGO_HOME"] || join(home, ".cargo"), to: "/cargo" },
    { from: env["RUSTUP_HOME"] || join(home, ".rustup"), to: "/rustup" },
    { from: root, to: "/flywheel" },
  ];
}

/** The complete rustc flag list for one target. Cargo gives CARGO_ENCODED_RUSTFLAGS precedence over RUSTFLAGS, and
 *  cargo-xwin and cargo-zigbuild merge their own target flags into it, so an ambient RUSTFLAGS never changes the bytes.
 *  The encoded form keeps a path that contains a space as one flag. */
export function cargoRustFlags(platformArch: string, remaps: readonly PathRemap[], library: string): string[] {
  const flags = remaps.map(({ from, to }) => `--remap-path-prefix=${from}=${to}`);
  // The Apple linker records the absolute output path as the install name. Node.js opens the addon by its own path,
  // so a relative install name changes nothing at load time.
  if (platformArch.startsWith("darwin-")) flags.push("-C", `link-arg=-Wl,-install_name,@rpath/${library}`);
  // musl targets link the C runtime statically by default, and a statically linked target cannot build a cdylib.
  if (platformArch.endsWith("-musl")) flags.push("-C", "target-feature=-crt-static");
  return flags;
}

/** The local paths that occur anywhere in the built bytes. */
export function embeddedLocalPaths(bytes: Uint8Array, paths: readonly string[]): string[] {
  const contents = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [...new Set(paths)].filter((path) => contents.includes(path));
}
function missingToolFailure(plan: CargoBuildPlan, platformArch: string) {
  console.error(`${plan.missingTool} is required to cross-build ${platformArch.startsWith("win32-") ? "Windows" : "Linux"} native addons from ${process.platform}.`);
  if (plan.installHint) console.error(`Install it with: ${plan.installHint}`);
  return { exited: Promise.resolve(1) };
}

if (import.meta.main) {
  const crate = process.argv.find((arg) => arg.startsWith("--crate="))?.slice("--crate=".length);
  const config = nativeAddonBuild(crate ?? "");
  if (process.argv.includes("--verify")) {
    // Readiness proves every tracked prebuilt verifies from the tree as it is, without cargo.
    const stale = await staleRipgrepPrebuilts(join(import.meta.dir, ".."));
    if (stale.length > 0) throw new Error(`tracked ${config.addon} prebuilts are missing or stale for: ${stale.join(", ")}`);
    console.log(`${config.addon}: every tracked prebuilt verifies`);
  } else await buildNativeAddon(config);
}
