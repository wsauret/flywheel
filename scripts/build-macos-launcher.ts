/**
 * Builds the macOS launchd program for the account service once, as a minimal
 * application bundle around a universal Mach-O with one fixed ad-hoc
 * identity, and records the bundle's manifest.
 *
 * The bundle's bytes are the identity macOS privacy consent is granted to, so
 * this is not part of any release build: run it only to change the launcher on
 * purpose, then commit the bundle and manifest together. Every build verifies
 * the tracked bundle against the manifest instead.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import sharp from "sharp";

import { brandTileSvg } from "../src/protocol/client/brand.js";
import { bundleFiles, launcherSourceSha256, MACOS_LAUNCHER_BUNDLE, MACOS_LAUNCHER_IDENTIFIER, macosLauncherDir } from "./binary-native-assets.js";

const ROOT = resolve(import.meta.dir, "..");
const NAME = "Flywheel";

async function run(argv: readonly string[]): Promise<void> {
  const subprocess = Bun.spawn([...argv], { cwd: ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true });
  if ((await subprocess.exited) !== 0) throw new Error(`${argv[0]} failed`);
}

if (process.platform !== "darwin") throw new Error("The macOS launcher builds only on macOS");

const dir = macosLauncherDir(ROOT);
const source = join(dir, "launcher.c");
const bundle = join(dir, MACOS_LAUNCHER_BUNDLE);
const contents = join(bundle, "Contents");
await rm(bundle, { recursive: true, force: true });
await mkdir(join(contents, "MacOS"), { recursive: true });
await mkdir(join(contents, "Resources"), { recursive: true });

const binary = join(contents, "MacOS", NAME);
await run(["clang", "-arch", "arm64", "-arch", "x86_64", "-O2", "-Wall", "-Wextra", "-Werror", "-o", binary, source]);
await chmod(binary, 0o755);

// The icon is the brand tile every other surface shows, rendered at each size
// macOS reads from an icon set; the tile's own rounded corners are the shape
// macOS expects an app icon to bring.
const iconset = join(dir, `${NAME}.iconset`);
await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
for (const [name, size] of [["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128], ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024]] as const) {
  await writeFile(join(iconset, `icon_${name}.png`), await sharp(Buffer.from(brandTileSvg(size, { corners: "rounded" }))).png().toBuffer());
}
await run(["iconutil", "-c", "icns", "-o", join(contents, "Resources", `${NAME}.icns`), iconset]);
await rm(iconset, { recursive: true, force: true });

// LSUIElement keeps the bundle out of the Dock and app switcher: it is a
// background program that happens to carry a name and an icon.
const plist = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
  `<plist version="1.0">`,
  `<dict>`,
  `  <key>CFBundleDevelopmentRegion</key>`, `  <string>en</string>`,
  `  <key>CFBundleDisplayName</key>`, `  <string>${NAME}</string>`,
  `  <key>CFBundleExecutable</key>`, `  <string>${NAME}</string>`,
  `  <key>CFBundleIconFile</key>`, `  <string>${NAME}</string>`,
  `  <key>CFBundleIdentifier</key>`, `  <string>${MACOS_LAUNCHER_IDENTIFIER}</string>`,
  `  <key>CFBundleInfoDictionaryVersion</key>`, `  <string>6.0</string>`,
  `  <key>CFBundleName</key>`, `  <string>${NAME}</string>`,
  `  <key>CFBundlePackageType</key>`, `  <string>APPL</string>`,
  `  <key>CFBundleShortVersionString</key>`, `  <string>1.0</string>`,
  `  <key>CFBundleVersion</key>`, `  <string>1</string>`,
  `  <key>LSMinimumSystemVersion</key>`, `  <string>11.0</string>`,
  `  <key>LSUIElement</key>`, `  <true/>`,
  `</dict>`,
  `</plist>`,
  ``,
].join("\n");
await writeFile(join(contents, "Info.plist"), plist);
await writeFile(join(contents, "PkgInfo"), "APPL????");
await run(["codesign", "--sign", "-", "--force", "--identifier", MACOS_LAUNCHER_IDENTIFIER, bundle]);

const files: { [relativePath: string]: { sha256: string; bytes: number } } = {};
for (const file of await bundleFiles(bundle)) {
  const bytes = await readFile(join(bundle, file));
  files[file] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}
const manifest = {
  version: 2,
  identifier: MACOS_LAUNCHER_IDENTIFIER,
  sourceSha256: await launcherSourceSha256(dir),
  files,
};
await writeFile(join(dir, "launcher-prebuilt.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${bundle}\n${Object.entries(files).map(([file, entry]) => `  ${file} ${entry.bytes} bytes ${entry.sha256}`).join("\n")}`);
