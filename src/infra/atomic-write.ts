import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { replaceFileOnWindows } from "./windows-file-replacement.js";

export function writeFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options?: { mode?: number; durableDirectorySync?: boolean },
): void {
  const tmpPath = `${filePath}.__flywheel__.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });

  const fd = fs.openSync(tmpPath, "wx", options?.mode);
  try {
    try {
      if (options?.mode !== undefined) fs.fchmodSync(fd, options.mode);
      if (typeof content === "string") fs.writeFileSync(fd, content, "utf-8");
      else fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform === "win32") replaceFileOnWindows(tmpPath, filePath);
    else fs.renameSync(tmpPath, filePath);
  } catch (error) {
    unlinkIfPresent(tmpPath);
    throw error;
  }
  if (options?.durableDirectorySync) fsyncDirectory(path.dirname(filePath));
}

/** Make a directory entry durable: a rename or a create inside it survives a
 *  crash only once its parent directory is synced. */
export function fsyncDirectory(directoryPath: string, platform: NodeJS.Platform = process.platform): void {
  // Windows has no portable directory fsync boundary; file durability ends at the file sync.
  if (platform === "win32") return;
  const fd = fs.openSync(directoryPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Appends to a file without the temp+rename dance - appropriate for JSONL
 *  logs where a torn write only risks the single trailing line, and a
 *  parse-and-drop-bad-lines reader (the caller's contract, not this
 *  function's) already tolerates that. Not a substitute for writeFileAtomic
 *  where a torn write must never leave a malformed whole file. */
export function appendFileEnsuringDir(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, content);
}
