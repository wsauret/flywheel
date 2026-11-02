import { extname } from "node:path"
import type { Stats } from "node:fs"

/** The extensions Windows will execute directly. A program is proven runnable
 *  there by naming one of these, and nothing else in the file's metadata says
 *  so. */
const WINDOWS_EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([".exe", ".com", ".bat", ".cmd"])

/** Whether this file may be executed.
 *
 *  POSIX states the answer in a mode bit. Windows keeps no execute bit at all:
 *  `stat` reports the same mode for every regular file, so a mode test there
 *  refuses every program, including one Windows would run. Windows decides by
 *  extension instead, which is what this reads.
 *
 *  The caller proves the path is a regular file; this answers only the
 *  permission question. */
export function isExecutableFile(filePath: string, stats: Stats, platform: string = process.platform): boolean {
  if (platform === "win32") return WINDOWS_EXECUTABLE_EXTENSIONS.has(extname(filePath).toLowerCase())
  return (Number(stats.mode) & 0o111) !== 0
}
