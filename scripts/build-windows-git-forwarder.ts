/**
 * Rebuilds the tracked Git forwarder for both Windows release targets.
 * Ordinary commands and release builds verify and copy these assets without a compiler.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launcherSourceSha256, windowsGitForwarderDir, windowsGitForwarderPrebuiltName } from "./binary-native-assets.js";
import { RELEASE_TARGETS } from "./release-contract.js";

const ROOT = resolve(import.meta.dir, "..");
const ZIG_TARGETS = new Map([
  ["win32-x64", "x86_64-windows-gnu"],
  ["win32-arm64", "aarch64-windows-gnu"],
]);

const dir = windowsGitForwarderDir(ROOT);
const source = join(dir, "launcher.c");
const scratch = await mkdtemp(join(tmpdir(), "flywheel-windows-git-forwarder-"));
const files: { [name: string]: { sha256: string; bytes: number } } = {};
try {
  for (const platformArch of RELEASE_TARGETS.filter((target) => target.startsWith("win32-"))) {
    const zigTarget = ZIG_TARGETS.get(platformArch);
    if (zigTarget === undefined) throw new Error(`No zig target for Windows release target ${platformArch}`);
    const name = windowsGitForwarderPrebuiltName(platformArch);
    const output = join(scratch, name);
    const compile = Bun.spawn(["zig", "cc", "-target", zigTarget, "-municode", "-O2", "-s", "-Wall", "-Wextra", "-Werror", "-o", output, source], { cwd: ROOT, stdout: "inherit", stderr: "inherit", windowsHide: true });
    if ((await compile.exited) !== 0) throw new Error(`zig cc failed for ${platformArch} Git forwarder`);
    await copyFile(output, join(dir, name));
    const bytes = await readFile(output);
    files[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const manifest = { version: 1, sourceSha256: await launcherSourceSha256(dir), files };
await writeFile(join(dir, "launcher-prebuilt.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built the Windows Git forwarder in ${dir}\n${Object.entries(files).map(([name, entry]) => `  ${name} ${entry.bytes} bytes ${entry.sha256}`).join("\n")}`);
