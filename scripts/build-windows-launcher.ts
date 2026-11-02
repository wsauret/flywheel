/**
 * Builds the Windows launcher once for every Windows release target, with
 * `zig cc` from this or any other host, and records the manifest that every
 * build verifies the tracked executables and their source against.
 *
 * This is not part of any release build: run it only to change the launcher
 * on purpose, then commit `launcher.c`, the executables, and the manifest
 * together. The output is deterministic, so a rebuild of an unchanged source
 * leaves every tracked byte as it was.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launcherSourceSha256, WINDOWS_LAUNCHER_VARIANTS, windowsLauncherDir, windowsLauncherPrebuiltName } from "./binary-native-assets.js";
import { RELEASE_TARGETS } from "./release-contract.js";

const ROOT = resolve(import.meta.dir, "..");
const ZIG_TARGETS = new Map([
  ["win32-x64", "x86_64-windows-gnu"],
  ["win32-arm64", "aarch64-windows-gnu"],
]);

const dir = windowsLauncherDir(ROOT);
const source = join(dir, "launcher.c");
const scratch = await mkdtemp(join(tmpdir(), "flywheel-windows-launcher-"));
const files: { [name: string]: { sha256: string; bytes: number } } = {};
try {
  for (const platformArch of RELEASE_TARGETS.filter((target) => target.startsWith("win32-"))) {
    const zigTarget = ZIG_TARGETS.get(platformArch);
    if (zigTarget === undefined) throw new Error(`No zig target for Windows release target ${platformArch}`);
    for (const variant of WINDOWS_LAUNCHER_VARIANTS) {
      const name = windowsLauncherPrebuiltName(platformArch, variant);
      const output = join(scratch, name);
      // -municode selects wmain. -s leaves out debug information, so the
      // executable has no program database beside it and no path of this host.
      const variantFlags = variant === "service" ? ["-DFLYWHEEL_LAUNCHER_HIDDEN", "-Wl,--subsystem,windows"] : [];
      const compile = Bun.spawn(["zig", "cc", "-target", zigTarget, "-municode", "-O2", "-s", "-Wall", "-Wextra", "-Werror", ...variantFlags, "-o", output, source, "-luserenv"], { cwd: ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true });
      if ((await compile.exited) !== 0) throw new Error(`zig cc failed for ${platformArch} ${variant} launcher`);
      await copyFile(output, join(dir, name));
      const bytes = await readFile(output);
      files[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const manifest = { version: 1, sourceSha256: await launcherSourceSha256(windowsLauncherDir(ROOT)), files };
await writeFile(join(dir, "launcher-prebuilt.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built the Windows launcher in ${dir}\n${Object.entries(files).map(([name, entry]) => `  ${name} ${entry.bytes} bytes ${entry.sha256}`).join("\n")}`);
