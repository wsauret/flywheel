import { describe, expect, it } from "bun:test";

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  nativeAddonSourceSha256,
  recordTrackedNativeAddon,
  trackedNativeAddonIsCurrent,
} from "../../../scripts/native-addon-fingerprint.js";
import {
  TOKENIZER_ASSET_FILE,
  copyNativeAssets,
  hostPlatformArch,
  nativeEnv,
  nativeRuntimePackages,
  platformArchForTarget,
  resolveRipgrepStagingPath,
  resolveNativeAddonStagingPath,
  staleRipgrepPrebuilts,
  launcherSourceSha256,
  macosLauncherDir,
  targetNativePackagesToInstall,
  verifyMacosLauncherAsset,
  verifyNativeAssets,
  verifyTokenizerAsset,
  verifyWindowsLauncherAsset,
  verifyWindowsGitForwarderAsset,
  WINDOWS_LAUNCHER_VARIANTS,
  windowsGitForwarderDir,
  windowsGitForwarderPrebuiltName,
  windowsLauncherDir,
  windowsLauncherPrebuiltName,
} from "../../../scripts/binary-native-assets.js";
import { cargoRustFlags, embeddedLocalPaths, rustPathRemaps } from "../../../scripts/build-native-addon.js";
import { RELEASE_TARGETS } from "../../../scripts/release-contract.js";
import { windowsGitForwarderPath } from "../../../src/infra/native-assets.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

describe("ripgrep staging output boundary", () => {
  const root = resolve("/repo");

  it("derives one addon staging path from the addon stem and platform target", () => {
    expect(resolveNativeAddonStagingPath(root, "dist/native/win32-arm64", "flywheel-ripgrep", "win32-arm64")).toBe(
      join(root, "dist", "native", "win32-arm64", "flywheel-ripgrep.win32-arm64.node"),
    );
  });

  it("refuses lexical escapes and absolute paths outside dist", () => {
    expect(() => resolveRipgrepStagingPath(root, "dist/../crates/ripgrep", "linux-x64")).toThrow(/dist/);
    expect(() => resolveRipgrepStagingPath(root, "/outside/native", "linux-x64")).toThrow(/dist/);
  });
});

describe("tracked native addon provenance", () => {
  it("reuses only binaries that match their production source fingerprint", async () => {
    const root = temporaryDirectory("flywheel-native-fingerprint-");
    const crate = join(root, "crate");
    const source = join(crate, "src");
    const addon = join(crate, "flywheel-test.darwin-arm64.node");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(crate, "Cargo.toml"), "[package]\nname = \"test\"\n");
    writeFileSync(join(crate, "Cargo.lock"), "version = 4\n");
    writeFileSync(join(crate, "build.rs"), "fn main() {}\n");
    writeFileSync(join(source, "lib.rs"), "pub fn value() -> u8 { 1 }\n");
    writeFileSync(addon, "binary-one");

    const originalSource = await nativeAddonSourceSha256(crate);
    expect(originalSource).toBe("04f70fd31174834eb0073ccb9e9ad69bc786b93f1d3f8017c0f0b4430016a236");
    await recordTrackedNativeAddon(crate, "darwin-arm64", addon);
    expect(await trackedNativeAddonIsCurrent(crate, "darwin-arm64", addon)).toBe(true);

    writeFileSync(join(crate, "Cargo.toml"), "[package]\r\nname = \"test\"\r\n");
    writeFileSync(join(crate, "build.rs"), "fn main() {}\r\n");
    writeFileSync(join(source, "lib.rs"), "pub fn value() -> u8 { 1 }\r\n");
    expect(await nativeAddonSourceSha256(crate)).toBe(originalSource);
    expect(await trackedNativeAddonIsCurrent(crate, "darwin-arm64", addon)).toBe(true);

    mkdirSync(join(crate, "tests"));
    writeFileSync(join(crate, "tests", "behavior.rs"), "#[test] fn behavior() {}\n");
    expect(await nativeAddonSourceSha256(crate)).toBe(originalSource);
    expect(await trackedNativeAddonIsCurrent(crate, "darwin-arm64", addon)).toBe(true);

    writeFileSync(addon, "binary-two");
    expect(await trackedNativeAddonIsCurrent(crate, "darwin-arm64", addon)).toBe(false);
    writeFileSync(addon, "binary-one");
    writeFileSync(join(source, "lib.rs"), "pub fn value() -> u8 { 2 }\n");
    expect(await nativeAddonSourceSha256(crate)).not.toBe(originalSource);
    expect(await trackedNativeAddonIsCurrent(crate, "darwin-arm64", addon)).toBe(false);
  });
});

describe("tracked ripgrep prebuilts", () => {
  it("tracks one prebuilt per release target and reports the ones that do not verify", async () => {
    expect(await staleRipgrepPrebuilts("/nowhere")).toEqual([...RELEASE_TARGETS]);
  });

  // The prebuilts are published in the open repository and in every release archive.
  it("embed no path from the machine that built them", () => {
    const root = resolve(import.meta.dir, "../../..");
    const markers = ["/.cargo/", "/.rustup/", "\\.cargo\\", "\\.rustup\\", "/Users/", "/home/", "\\Users\\"];
    for (const platformArch of RELEASE_TARGETS) {
      const addon = readFileSync(join(root, "crates", "ripgrep", `flywheel-ripgrep.${platformArch}.node`));
      expect({ platformArch, leaked: embeddedLocalPaths(addon, markers) }).toEqual({ platformArch, leaked: [] });
    }
  });
});

describe("reproducible native addon flags", () => {
  const home = resolve("/builder home");
  const root = join(home, "flywheel");

  it("remaps the Cargo, rustup, and repository directories on every target", () => {
    const remaps = rustPathRemaps(root, {}, home);
    for (const platformArch of RELEASE_TARGETS) {
      expect(cargoRustFlags(platformArch, remaps, "libflywheel_ripgrep.dylib")).toEqual(expect.arrayContaining([
        `--remap-path-prefix=${join(home, ".cargo")}=/cargo`,
        `--remap-path-prefix=${join(home, ".rustup")}=/rustup`,
        `--remap-path-prefix=${root}=/flywheel`,
      ]));
    }
  });

  it("follows CARGO_HOME and RUSTUP_HOME when they move the toolchain", () => {
    const remaps = rustPathRemaps(root, { CARGO_HOME: "/opt/cargo", RUSTUP_HOME: "/opt/rustup" }, home);
    expect(remaps.map(({ from }) => from)).toEqual(["/opt/cargo", "/opt/rustup", root]);
  });

  it("adds the static C runtime opt-out only for musl and the relative install name only for macOS", () => {
    const remaps = rustPathRemaps(root, {}, home);
    const extras = (platformArch: string) => cargoRustFlags(platformArch, remaps, "libx.dylib").slice(remaps.length);
    expect(extras("linux-x64-musl")).toEqual(["-C", "target-feature=-crt-static"]);
    expect(extras("darwin-arm64")).toEqual(["-C", "link-arg=-Wl,-install_name,@rpath/libx.dylib"]);
    expect(extras("linux-x64")).toEqual([]);
    expect(extras("win32-x64")).toEqual([]);
  });

  it("names every local path that occurs in built bytes", () => {
    const bytes = Buffer.from(`panic at ${join(home, ".cargo")}/registry/src/lib.rs\0/cargo/registry/src/ok.rs`);
    expect(embeddedLocalPaths(bytes, [join(home, ".cargo"), "/rustup", join(home, ".cargo")])).toEqual([join(home, ".cargo")]);
  });
});

describe("binary native asset target mapping", () => {
  it("verifies the universal tokenizer asset against its tracked manifest", async () => {
    const root = resolve(import.meta.dir, "../../..");
    expect(TOKENIZER_ASSET_FILE).toBe("flywheel-tokenizer.wasm.zst");
    await expect(verifyTokenizerAsset(root, join(root, "crates", "tokenizer", TOKENIZER_ASSET_FILE))).resolves.toBeUndefined();

    const temporary = temporaryDirectory("flywheel-tokenizer-asset-");
    const corrupted = join(temporary, TOKENIZER_ASSET_FILE);
    writeFileSync(corrupted, "not the tracked tokenizer");
    await expect(verifyTokenizerAsset(root, corrupted)).rejects.toThrow("compressed");
  });

  it("normalizes Bun Windows targets to npm win32 package names", () => {
    expect(platformArchForTarget("bun-windows-x64")).toBe("win32-x64");
    expect(platformArchForTarget("bun-windows-arm64")).toBe("win32-arm64");
  });

  it("preserves Linux musl target suffixes", () => {
    expect(platformArchForTarget("bun-linux-x64-musl")).toBe("linux-x64-musl");
  });

  // sharp ships libvips beside its addon in the Windows platform package and names the separate libvips package only
  // as a development dependency, so a fresh checkout never installs it and the runtime never needs it.
  it("stages libvips from the package that sharp installs for the target", () => {
    expect(nativeRuntimePackages("win32-x64")).toEqual(["sharp", "@img/colour", "detect-libc", "semver", "@img/sharp-win32-x64"]);
    expect(nativeRuntimePackages("darwin-arm64")).toContain("@img/sharp-libvips-darwin-arm64");
    expect(nativeRuntimePackages("linux-x64-musl")).toContain("@img/sharp-libvips-linuxmusl-x64");
  });

  it("publishes the native asset directory without a package-specific override", () => {
    expect(nativeEnv("C:/flywheel/native")).toEqual({ FLYWHEEL_NATIVE_DIR: "C:/flywheel/native" });
  });

  it("replaces a target package whose version does not match its runtime dependency", async () => {
    const root = temporaryDirectory("flywheel-native-packages-");
    const writePackage = (name: string, version: string, optionalDependencies?: { [key: string]: string }, devDependencies?: { [key: string]: string }) => {
      const packageDir = join(root, "node_modules", ...name.split("/"));
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version, optionalDependencies, devDependencies }));
    };

    writePackage("@opentui/core", "0.5.1", { "@opentui/core-win32-x64": "0.5.1" });
    writePackage("sharp", "0.35.3", {
      "@img/sharp-win32-x64": "0.35.3",
    }, { "@img/sharp-libvips-win32-x64": "1.3.2" });
    writePackage("@opentui/core-win32-x64", "0.2.15");
    writePackage("@img/sharp-win32-x64", "0.35.3");

    expect(await targetNativePackagesToInstall(root, "win32-x64")).toEqual([
      { name: "@opentui/core-win32-x64", version: "0.5.1" },
    ]);
  });
});

describe("native asset staging", () => {
  const repo = resolve(import.meta.dir, "../../..");
  it("requires the native Git forwarder in a Windows build", async () => {
    const nativeDir = temporaryDirectory("flywheel-native-forwarder-missing-");
    await expect(verifyNativeAssets(nativeDir, "win32-x64", repo)).rejects.toThrow("flywheel-git-forwarder.exe");
  });

  it("patches its own copy of a runtime package that the checkout installs as a link, never the linked package", async () => {
    const root = temporaryDirectory("flywheel-native-linked-");
    // A checkout whose packages are links, as a linker that links each
    // package or a copy of the checkout installs them. The linked sharp is a
    // private copy, so a patch through the link changes nothing else.
    const linkedSharp = join(temporaryDirectory("flywheel-native-sharp-"), "sharp");
    cpSync(join(repo, "node_modules", "sharp"), linkedSharp, { recursive: true });
    // Windows links a directory with a junction, which needs no privilege, and a file with a symbolic link.
    const link = (target: string, path: string) => symlinkSync(target, path, process.platform === "win32" ? (statSync(target).isDirectory() ? "junction" : "file") : undefined);
    for (const entry of readdirSync(repo)) {
      if (entry !== ".git" && entry !== "node_modules") link(join(repo, entry), join(root, entry));
    }
    mkdirSync(join(root, "node_modules"));
    for (const entry of readdirSync(join(repo, "node_modules"))) {
      if (entry !== ".cache") link(entry === "sharp" ? linkedSharp : join(repo, "node_modules", entry), join(root, "node_modules", entry));
    }
    const colour = (packageDir: string) => readFileSync(join(packageDir, "dist", "colour.cjs"), "utf8");
    const installed = colour(linkedSharp);
    const nativeDir = temporaryDirectory("flywheel-native-staged-");

    await copyNativeAssets(root, nativeDir, hostPlatformArch(), { kind: "tracked-prebuilt" });

    expect(readFileSync(join(nativeDir, "tree-sitter-python.wasm"))).toEqual(
      readFileSync(join(repo, "node_modules", "@vscode", "tree-sitter-wasm", "wasm", "tree-sitter-python.wasm")),
    );
    expect(colour(linkedSharp)).toBe(installed);
    expect(colour(join(nativeDir, "node_modules", "sharp"))).toContain("require('../../@img/colour/index.cjs')");
    // A fresh checkout's install is enough to stage a complete native runtime on every platform.
    await verifyNativeAssets(nativeDir, hostPlatformArch(), repo);
    // sharp reads its libvips versions from the platform package first, where Windows keeps them, then from the
    // libvips package, where macOS and Linux keep them.
    const utility = readFileSync(join(nativeDir, "node_modules", "sharp", "dist", "utility.cjs"), "utf8");
    const runtimePlatform = ["$", "{runtimePlatform}"].join("");
    expect(utility).toContain(`require(\`../../@img/sharp-${runtimePlatform}/versions.json\`)`);
    expect(utility).toContain(`require(\`../../@img/sharp-libvips-${runtimePlatform}/versions.json\`)`);
  });
});

describe("macOS launcher asset boundary", () => {
  it("tracks a manifest built from the tracked source", async () => {
    const root = resolve(import.meta.dir, "../../..");
    const manifest: unknown = JSON.parse(readFileSync(join(macosLauncherDir(root), "launcher-prebuilt.json"), "utf-8"));
    const recorded = typeof manifest === "object" && manifest !== null && "sourceSha256" in manifest ? manifest.sourceSha256 : undefined;
    expect(recorded).toBe(await launcherSourceSha256(macosLauncherDir(root)));
  });

  it("refuses a launcher bundle whose files drift from the tracked manifest and a source edited without a rebuild", async () => {
    const root = temporaryDirectory("flywheel-launcher-");
    const crate = join(root, "crates", "macos-launcher");
    mkdirSync(crate, { recursive: true });
    writeFileSync(join(crate, "launcher.c"), "int main(void) { return 0; }\n");
    const program = "Contents/MacOS/Flywheel";
    writeFileSync(join(crate, "launcher-prebuilt.json"), JSON.stringify({ version: 2, sourceSha256: await launcherSourceSha256(crate), files: { [program]: { sha256: createHash("sha256").update("abcd").digest("hex"), bytes: 4 } } }));
    const bundle = join(root, "Flywheel.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    await expect(verifyMacosLauncherAsset(root, bundle)).rejects.toThrow("missing Contents/MacOS/Flywheel");
    writeFileSync(join(bundle, program), "abce");
    await expect(verifyMacosLauncherAsset(root, bundle)).rejects.toThrow("digest mismatch");
    writeFileSync(join(bundle, program), "abc");
    await expect(verifyMacosLauncherAsset(root, bundle)).rejects.toThrow("byte length mismatch");
    writeFileSync(join(bundle, program), "abcd");
    await expect(verifyMacosLauncherAsset(root, bundle)).resolves.toBeUndefined();
    writeFileSync(join(bundle, "Contents", "extra"), "x");
    await expect(verifyMacosLauncherAsset(root, bundle)).rejects.toThrow("unlisted file: Contents/extra");
    rmSync(join(bundle, "Contents", "extra"));

    writeFileSync(join(crate, "launcher.c"), "int main(void) { return 1; }\n");
    await expect(verifyMacosLauncherAsset(root, bundle)).rejects.toThrow("bun run build:macos-launcher");
  });
});

describe("Windows launcher asset boundary", () => {
  const peSubsystem = (file: string): number => {
    const bytes = readFileSync(file);
    const peHeader = bytes.readUInt32LE(0x3c);
    return bytes.readUInt16LE(peHeader + 24 + 68);
  };

  it("tracks verified console and windowless executables for each Windows release target", async () => {
    const root = resolve(import.meta.dir, "../../..");
    const windowsTargets = RELEASE_TARGETS.filter((target) => target.startsWith("win32-"));
    const manifest: unknown = JSON.parse(readFileSync(join(windowsLauncherDir(root), "launcher-prebuilt.json"), "utf-8"));
    const listed = typeof manifest === "object" && manifest !== null && "files" in manifest && typeof manifest.files === "object" && manifest.files !== null ? Object.keys(manifest.files) : [];
    expect(listed.sort()).toEqual(windowsTargets.flatMap((platformArch) => WINDOWS_LAUNCHER_VARIANTS.map((variant) => windowsLauncherPrebuiltName(platformArch, variant))).sort());
    for (const platformArch of windowsTargets) {
      for (const variant of WINDOWS_LAUNCHER_VARIANTS) {
        const executable = join(windowsLauncherDir(root), windowsLauncherPrebuiltName(platformArch, variant));
        await expect(verifyWindowsLauncherAsset(root, platformArch, variant, executable)).resolves.toBeUndefined();
        expect(peSubsystem(executable)).toBe(variant === "service" ? 2 : 3);
      }
    }
  });

  it("refuses an executable that drifts from the manifest and a source edited without a rebuild", async () => {
    const root = temporaryDirectory("flywheel-windows-launcher-");
    const crate = join(root, "crates", "windows-launcher");
    mkdirSync(crate, { recursive: true });
    writeFileSync(join(crate, "launcher.c"), "int wmain(void) { return 0; }\n");
    const name = windowsLauncherPrebuiltName("win32-x64");
    const executable = join(crate, name);
    writeFileSync(executable, "abcd");
    const writeManifest = async (): Promise<void> => writeFileSync(join(crate, "launcher-prebuilt.json"), JSON.stringify({
      version: 1,
      sourceSha256: await launcherSourceSha256(crate),
      files: { [name]: { sha256: createHash("sha256").update("abcd").digest("hex"), bytes: 4 } },
    }));
    await writeManifest();
    await expect(verifyWindowsLauncherAsset(root, "win32-x64", "console", executable)).resolves.toBeUndefined();
    await expect(verifyWindowsLauncherAsset(root, "win32-arm64", "console", executable)).rejects.toThrow("no entry for flywheel-launcher.win32-arm64.exe");

    writeFileSync(executable, "abce");
    await expect(verifyWindowsLauncherAsset(root, "win32-x64", "console", executable)).rejects.toThrow("digest mismatch");
    writeFileSync(executable, "abc");
    await expect(verifyWindowsLauncherAsset(root, "win32-x64", "console", executable)).rejects.toThrow("byte length mismatch");
    writeFileSync(executable, "abcd");

    writeFileSync(join(crate, "launcher.c"), "int wmain(void) { return 0; }\r\n");
    await expect(verifyWindowsLauncherAsset(root, "win32-x64", "console", executable)).resolves.toBeUndefined();
    writeFileSync(join(crate, "launcher.c"), "int wmain(void) { return 1; }\n");
    await expect(verifyWindowsLauncherAsset(root, "win32-x64", "console", executable)).rejects.toThrow("bun run build:windows-launcher");
  });
});

describe("Windows Git forwarder asset boundary", () => {
  it("resolves verified console executables with the correct machine type for every Windows release target", async () => {
    const root = resolve(import.meta.dir, "../../..");
    for (const platformArch of RELEASE_TARGETS.filter((target) => target.startsWith("win32-"))) {
      const executable = windowsGitForwarderPath(platformArch);
      expect(executable).toBe(join(windowsGitForwarderDir(root), windowsGitForwarderPrebuiltName(platformArch)));
      await expect(verifyWindowsGitForwarderAsset(root, platformArch, executable)).resolves.toBeUndefined();
      const bytes = readFileSync(executable);
      const peHeader = bytes.readUInt32LE(0x3c);
      expect(bytes.readUInt32LE(peHeader)).toBe(0x00004550);
      expect(bytes.readUInt16LE(peHeader + 4)).toBe(platformArch === "win32-x64" ? 0x8664 : 0xaa64);
      expect(bytes.readUInt16LE(peHeader + 24 + 68)).toBe(3);
    }
  });

  it("rejects stale source and changed executable bytes, including at the final staging boundary", async () => {
    const root = temporaryDirectory("flywheel-git-forwarder-");
    const crate = windowsGitForwarderDir(root);
    mkdirSync(crate, { recursive: true });
    writeFileSync(join(crate, "launcher.c"), "int wmain(void) { return 0; }\n");
    const name = windowsGitForwarderPrebuiltName("win32-x64");
    const executable = join(crate, name);
    writeFileSync(executable, "abcd");
    writeFileSync(join(crate, "launcher-prebuilt.json"), JSON.stringify({
      version: 1,
      sourceSha256: await launcherSourceSha256(crate),
      files: { [name]: { sha256: createHash("sha256").update("abcd").digest("hex"), bytes: 4 } },
    }));
    await expect(verifyWindowsGitForwarderAsset(root, "win32-x64", executable)).resolves.toBeUndefined();
    await expect(verifyWindowsGitForwarderAsset(root, "win32-arm64", executable)).rejects.toThrow("no entry");
    writeFileSync(executable, "abce");
    await expect(verifyWindowsGitForwarderAsset(root, "win32-x64", executable)).rejects.toThrow("digest mismatch");
    writeFileSync(executable, "abc");
    await expect(verifyWindowsGitForwarderAsset(root, "win32-x64", executable)).rejects.toThrow("byte length mismatch");
    const staged = join(root, "native");
    mkdirSync(staged);
    writeFileSync(join(staged, "flywheel-git-forwarder.exe"), "abce");
    await expect(verifyNativeAssets(staged, "win32-x64", root)).rejects.toThrow("Git forwarder digest mismatch");
    writeFileSync(executable, "abcd");
    writeFileSync(join(crate, "launcher.c"), "int wmain(void) { return 0; }\r\n");
    await expect(verifyWindowsGitForwarderAsset(root, "win32-x64", executable)).resolves.toBeUndefined();
    writeFileSync(join(crate, "launcher.c"), "int wmain(void) { return 1; }\n");
    await expect(verifyWindowsGitForwarderAsset(root, "win32-x64", executable)).rejects.toThrow("bun run build:windows-git-forwarder");
  });
});
