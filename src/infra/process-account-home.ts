import * as fs from "node:fs"
import * as path from "node:path"

import { darwinProcess } from "./darwin-process-api.js"
import { canonicalAccountHome } from "./directory-authorities.js"
import type { ProcessRow } from "./process-table.js"
import { windowsProcessApi } from "./windows-process-api.js"

/** Which account home a running Flywheel process serves, whether it belongs
 *  to another user, or why neither is proven.
 *
 *  A Flywheel process derives its account home once at start from `HOME`,
 *  and on Windows from `USERPROFILE` when `HOME` is empty (ARCH-DIRECTORIES-002). So the
 *  environment the kernel holds for the process is the fact that decides, on
 *  every platform: libproc's `KERN_PROCARGS2` on macOS, `/proc/<pid>/environ`
 *  on Linux, and on Windows the environment block that the process parameters
 *  in the process's PEB name. The kernel gives it only to a process of the
 *  same user. The executable path does not decide, because a test that runs
 *  one home's installed build with another `HOME` serves the other home.
 *
 *  An environment the kernel refuses for a process that the process table
 *  states another user owns belongs to that user: it is not this account's,
 *  and this account could not signal it. Every other read that fails, and
 *  every answer that does not name an absolute home that resolves, is
 *  unproven. A caller that acts on a proven home never acts on a guess. The
 *  reason names only the kind of evidence that was missing, never a value
 *  from the environment. */
export type ProcessAccountHome =
  | { readonly kind: "home"; readonly home: string }
  | { readonly kind: "other-user" }
  | { readonly kind: "unproven"; readonly reason: string }

/** The host facts the answer is read from, injected so each platform's rule
 *  is testable on any host. */
export interface AccountHomeReaders {
  readonly platform: NodeJS.Platform
  /** The environment `pid` holds, or nothing when it cannot be read. */
  readonly environment: (pid: number) => readonly string[] | undefined
  /** The form in which the account home compares equal across processes:
   *  `canonicalAccountHome`, which resolves with the host's own path rules
   *  and throws for a home it cannot resolve. */
  readonly canonicalHome: (home: string) => string
  /** The effective user this side runs as, where the platform has one. */
  readonly selfUid: number | undefined
}

function readProcEnvironment(pid: number): readonly string[] | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry.length > 0)
  } catch {
    return undefined
  }
}

function liveEnvironmentReader(): (pid: number) => readonly string[] | undefined {
  if (process.platform === "darwin") return (pid) => darwinProcess.environment(pid)
  if (process.platform === "win32") return (pid) => windowsProcessApi()?.environment(pid)
  return readProcEnvironment
}

const liveReaders: AccountHomeReaders = {
  platform: process.platform,
  environment: liveEnvironmentReader(),
  canonicalHome: canonicalAccountHome,
  selfUid: process.geteuid?.(),
}

const unproven = (reason: string): ProcessAccountHome => ({ kind: "unproven", reason })

export function processAccountHome(row: ProcessRow, readers: AccountHomeReaders = liveReaders): ProcessAccountHome {
  const environment = readers.environment(row.pid)
  if (environment === undefined) {
    return row.uid !== undefined && readers.selfUid !== undefined && row.uid !== readers.selfUid
      ? { kind: "other-user" }
      : unproven("its environment could not be read")
  }
  const windows = readers.platform === "win32"
  // The first variable that is not empty decides, as `HOME || homedir()` does
  // in the process itself.
  const home = (windows ? ["HOME", "USERPROFILE"] : ["HOME"])
    .map((name) => environmentValue(environment, name, windows))
    .find((value) => value !== undefined && value.length > 0)
  if (home === undefined || !namesAbsoluteHome(home, windows)) return unproven("its environment names no absolute HOME")
  try {
    return { kind: "home", home: readers.canonicalHome(home) }
  } catch {
    // The home was removed, or is not a directory. Neither names a home this
    // side can compare, and one such process must not abort the caller.
    return unproven("its HOME could not be resolved")
  }
}

/** Windows compares variable names without case. */
function environmentValue(environment: readonly string[], name: string, windows: boolean): string | undefined {
  const prefix = `${name}=`
  const entry = environment.find((candidate) => windows ? candidate.slice(0, prefix.length).toUpperCase() === prefix : candidate.startsWith(prefix))
  return entry?.slice(prefix.length)
}

/** A relative home resolves against the process's own directory, and on
 *  Windows a rooted path without a drive against the process's own drive;
 *  this side knows neither, so neither names a home here. */
function namesAbsoluteHome(home: string, windows: boolean): boolean {
  return windows ? path.win32.isAbsolute(home) && path.win32.parse(home).root.length > 1 : path.posix.isAbsolute(home)
}
