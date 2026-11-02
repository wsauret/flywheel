import { describe, expect, test } from "bun:test"

import { processAccountHome, type AccountHomeReaders } from "../../../src/infra/process-account-home.js"
import type { ProcessRow } from "../../../src/infra/process-table.js"

const SELF_UID = 501

const row = (pid: number, uid?: number): ProcessRow => ({ pid, ppid: 1, argv: ["flywheel-bin"], ...(uid === undefined ? {} : { uid }) })

function readers(platform: NodeJS.Platform, environments: { readonly [pid: number]: readonly string[] } = {}, canonicalHome: (home: string) => string = (home) => home): AccountHomeReaders {
  // The live form resolves with the host's path rules; these homes are
  // already in their final form on the platform each case names.
  return { platform, environment: (pid) => environments[pid], canonicalHome, selfUid: SELF_UID }
}

describe("a process's account home", () => {
  test("is the HOME its environment names", () => {
    const posix = readers("darwin", { 7: ["PATH=/usr/bin", "HOME=/Users/test-home"] })
    expect(processAccountHome(row(7), posix)).toEqual({ kind: "home", home: "/Users/test-home" })
  })

  test("is not proven when the environment cannot be read or names no usable HOME", () => {
    const posix = readers("linux", { 8: ["PATH=/usr/bin"], 9: ["HOME="], 10: ["HOME=relative/home"] })
    expect(processAccountHome(row(7), posix)).toEqual({ kind: "unproven", reason: "its environment could not be read" })
    expect(processAccountHome(row(8), posix)).toEqual({ kind: "unproven", reason: "its environment names no absolute HOME" })
    expect(processAccountHome(row(9), posix)).toEqual({ kind: "unproven", reason: "its environment names no absolute HOME" })
    expect(processAccountHome(row(10), posix)).toEqual({ kind: "unproven", reason: "its environment names no absolute HOME" })
  })

  test("is not proven when the HOME it names cannot be resolved", () => {
    const posix = readers("darwin", { 7: ["HOME=/dev/null"] }, () => { throw new Error("account home is not a directory") })
    expect(processAccountHome(row(7), posix)).toEqual({ kind: "unproven", reason: "its HOME could not be resolved" })
  })

  test("belongs to another user when its environment is refused and the kernel names another owner", () => {
    const posix = readers("linux", { 10: ["HOME=/home/me"] })
    expect(processAccountHome(row(7, 502), posix)).toEqual({ kind: "other-user" })
    // The same owner, or no owner stated, proves nothing about the refusal.
    expect(processAccountHome(row(8, SELF_UID), posix)).toEqual({ kind: "unproven", reason: "its environment could not be read" })
    expect(processAccountHome(row(9), posix)).toEqual({ kind: "unproven", reason: "its environment could not be read" })
    // A readable environment decides whoever owns the process, as it does for root.
    expect(processAccountHome(row(10, 502), posix)).toEqual({ kind: "home", home: "/home/me" })
  })

  test("on Windows, is HOME or else USERPROFILE, with names in any case, as the process itself derives it", () => {
    const windows = readers("win32", {
      7: [String.raw`=C:=C:\Work`, String.raw`USERPROFILE=C:\Users\Jo`, String.raw`Home=C:\Users\Jo Smith\iso-home`],
      8: [String.raw`USERPROFILE=C:\Users\Jo`, "HOME="],
      9: [String.raw`HOME=\iso-home`],
      10: [String.raw`PATH=C:\Windows`],
    })
    expect(processAccountHome(row(7), windows)).toEqual({ kind: "home", home: String.raw`C:\Users\Jo Smith\iso-home` })
    expect(processAccountHome(row(8), windows)).toEqual({ kind: "home", home: String.raw`C:\Users\Jo` })
    // A path without a drive resolves against the process's own drive.
    expect(processAccountHome(row(9), windows)).toEqual({ kind: "unproven", reason: "its environment names no absolute HOME" })
    expect(processAccountHome(row(10), windows)).toEqual({ kind: "unproven", reason: "its environment names no absolute HOME" })
    expect(processAccountHome(row(11), windows)).toEqual({ kind: "unproven", reason: "its environment could not be read" })
  })
})
