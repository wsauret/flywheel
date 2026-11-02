import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLATFORM_ARCH = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
export const ASSET = `flywheel-${PLATFORM_ARCH}.tar.gz`;
export const ROOT = `flywheel-${PLATFORM_ARCH}`;
// The release server also publishes a Windows asset for native Windows runs.
export const WINDOWS_ROOT = "flywheel-win32-x64";
export const WINDOWS_ASSET = `${WINDOWS_ROOT}.tar.gz`;

/** One archive holding a marker installer that records the tag it came from. */
export function buildArchive(tag: string, customizeArchive: (rootDir: string) => void = () => {}): Uint8Array {
  const stage = mkdtempSync(join(tmpdir(), "flywheel-archive-"));
  const rootDir = join(stage, ROOT);
  mkdirSync(join(rootDir, "build"), { recursive: true });
  writeFileSync(join(rootDir, "build", "flywheel-bin"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(rootDir, "build", "flywheel-bin"), 0o755);
  writeFileSync(join(rootDir, "install.sh"), `#!/bin/sh\nprintf '%s' "${tag}" > "$FLYWHEEL_TEST_MARKER"\n`);
  chmodSync(join(rootDir, "install.sh"), 0o755);
  customizeArchive(rootDir);
  const archive = join(stage, ASSET);
  // A leading `C:` in an absolute name makes tar try a remote host.
  const tar = Bun.spawnSync(["tar", "-czf", ASSET, ROOT], { cwd: stage, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (tar.exitCode !== 0) throw new Error(`could not build the fixture archive: ${tar.stderr.toString()}`);
  const bytes = new Uint8Array(readFileSync(archive));
  rmSync(stage, { recursive: true, force: true });
  return bytes;
}

/** A tar written by hand. Real `tar` normalizes the names an adversary would
 *  send, so the admission corpus is assembled byte by byte. `type` is the
 *  ustar typeflag: 0 a file, 5 a directory, 1 a hard link, 2 a symlink, 3 a
 *  character device, 6 a FIFO. */
function tarEntry(name: string, type: string, content: string, mode = 0o644): Uint8Array {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const header = new Uint8Array(512);
  const field = (offset: number, value: string, length: number): void => {
    header.set(encoder.encode(value).subarray(0, length), offset);
  };
  const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, "0")}\0`;
  field(0, name, 100);
  field(100, octal(mode, 8), 8);
  field(108, octal(0, 8), 8);
  field(116, octal(0, 8), 8);
  field(124, octal(data.length, 12), 12);
  field(136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  field(156, type, 1);
  field(257, "ustar", 6);
  field(263, "00", 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  field(148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
  const block = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  block.set(header);
  block.set(data, 512);
  return block;
}

export function tarball(entries: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(entries.reduce((total, entry) => total + entry.length, 0) + 1024);
  let at = 0;
  for (const entry of entries) {
    bytes.set(entry, at);
    at += entry.length;
  }
  return Bun.gzipSync(bytes);
}

/** The entries of an archive that installs. A corpus case is this payload plus
 *  one entry, so the only reason a case may install is the entry under test. */
export function payloadEntries(tag: string): readonly Uint8Array[] {
  return [
    tarEntry(`${ROOT}/`, "5", "", 0o755),
    tarEntry(`${ROOT}/build/`, "5", "", 0o755),
    tarEntry(`${ROOT}/build/flywheel-bin`, "0", "#!/bin/sh\nexit 0\n", 0o755),
    tarEntry(`${ROOT}/install.sh`, "0", `#!/bin/sh\nprintf '%s' "${tag}" > "$FLYWHEEL_TEST_MARKER"\n`, 0o755),
  ];
}

/** The same archive for the Windows installer: the build payload and the
 *  archive's own PowerShell installer, which records the tag it came from. */
export function windowsPayloadEntries(tag: string): readonly Uint8Array[] {
  return [
    tarEntry(`${WINDOWS_ROOT}/`, "5", "", 0o755),
    tarEntry(`${WINDOWS_ROOT}/build/`, "5", "", 0o755),
    tarEntry(`${WINDOWS_ROOT}/build/flywheel-bin.exe`, "0", "binary\n"),
    tarEntry(`${WINDOWS_ROOT}/install.ps1`, "0", `Set-Content -LiteralPath $env:FLYWHEEL_TEST_MARKER -Value "${tag}" -NoNewline\n`),
  ];
}

/** The archive-admission corpus, stated once for whichever root the installer
 *  under test expects. It is the corpus src/infra/update/archive-entry.ts
 *  refuses, so one entry admitted anywhere would be admitted everywhere. */
export function admissionCorpus(root: string): readonly (readonly [string, Uint8Array, string])[] {
  return [
    ["a dot component", tarEntry(`${root}/build/./extra`, "0", "x"), "a dot or an empty component"],
    ["a parent component", tarEntry(`${root}/build/../../escape`, "0", "x"), "a dot or an empty component"],
    ["an empty component", tarEntry(`${root}//extra`, "0", "x"), "a dot or an empty component"],
    ["a backslash", tarEntry(`${root}/build\\extra`, "0", "x"), "a backslash"],
    ["an absolute name", tarEntry("/etc/flywheel-planted", "0", "x"), "is absolute"],
    ["a drive-letter name", tarEntry("C:/windows/flywheel-planted", "0", "x"), "is absolute"],
    ["a name outside the root", tarEntry("elsewhere/flywheel-planted", "0", "x"), "outside its"],
    ["a repeated path", tarEntry(`${root}/`, "5", "", 0o755), "one path"],
    ["a path repeated across a trailing slash", tarEntry(root, "5", "", 0o755), "one path"],
    ["a symlink entry", tarEntry(`${root}/link`, "2", ""), "not a regular file or a directory"],
    ["a hard-link entry", tarEntry(`${root}/second-name`, "1", ""), "not a regular file or a directory"],
    ["a character-device entry", tarEntry(`${root}/dev`, "3", ""), "not a regular file or a directory"],
    ["a FIFO entry", tarEntry(`${root}/pipe`, "6", ""), "not a regular file or a directory"],
  ];
}
