import { describe, expect, test } from "bun:test"

import {
  parseProcTable,
  parsePsTable,
  parseWindowsProcessJson,
  splitWindowsCommandLine,
} from "../../../src/infra/process-table.js"

describe("the ps process table", () => {
  test("reads pid, parent, group, owner, and the space-joined command of every row", () => {
    const text = [
      "    1     0     1     0 /sbin/launchd",
      "28846     1 28846   501 /Users/alice/.bun/bin/bun --conditions=browser /Users/alice/example-project/scripts/dev.ts --project-root /Users/alice/example-project ide --idle-timeout 1",
      "28848 28846 28848   501 /Users/alice/.bun/bin/bun /Users/alice/example-project/src/cli/index.ts --internal-role=guardian",
      "",
    ].join("\n")
    expect(parsePsTable(text)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, uid: 0, argv: ["/sbin/launchd"] },
      { pid: 28846, ppid: 1, pgid: 28846, uid: 501, argv: ["/Users/alice/.bun/bin/bun", "--conditions=browser", "/Users/alice/example-project/scripts/dev.ts", "--project-root", "/Users/alice/example-project", "ide", "--idle-timeout", "1"] },
      { pid: 28848, ppid: 28846, pgid: 28848, uid: 501, argv: ["/Users/alice/.bun/bin/bun", "/Users/alice/example-project/src/cli/index.ts", "--internal-role=guardian"] },
    ])
  })

  test("skips a row it cannot read rather than inventing a process", () => {
    expect(parsePsTable("garbage\n  12  1  12  501 /bin/sleep 5\n")).toEqual([{ pid: 12, ppid: 1, pgid: 12, uid: 501, argv: ["/bin/sleep", "5"] }])
  })
})

describe("the /proc process table", () => {
  test("reads exact argv from cmdline, parent and group from stat, and the effective owner from status", () => {
    const rows = parseProcTable([
      { pid: 7, stat: "7 (bun) S 1 7 7 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1234 0 0", cmdline: "/usr/bin/bun\0/home/w/My Repos/example-project/scripts/dev.ts\0ide\0", status: "Name:\tbun\nUid:\t1000\t1001\t1001\t1001\nGid:\t1000\t1000\t1000\t1000\n" },
      { pid: 8, stat: "8 (kworker/0:1) S 2 0 0 0 -1 69238880 0 0 0 0 0 0 0 0 20 0 1 0 5 0 0", cmdline: "", status: "Uid:\t0\t0\t0\t0\n" },
      { pid: 9, stat: "9 (bun) S 1 9 9 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1234 0 0", cmdline: "/usr/bin/bun\0", status: "Name:\tbun\n" },
    ])
    expect(rows).toEqual([
      { pid: 7, ppid: 1, pgid: 7, uid: 1001, argv: ["/usr/bin/bun", "/home/w/My Repos/example-project/scripts/dev.ts", "ide"] },
      // A status without an owner line states no owner.
      { pid: 9, ppid: 1, pgid: 9, argv: ["/usr/bin/bun"] },
    ])
  })
})

describe("the Windows process table", () => {
  test("splits a command line the way the Windows runtime does", () => {
    expect(splitWindowsCommandLine(String.raw`"C:\Users\Jo Smith\.flywheel\versions\1.0.0\abc\flywheel-bin.exe" --project-root "C:\Work\my proj" ide`))
      .toEqual([String.raw`C:\Users\Jo Smith\.flywheel\versions\1.0.0\abc\flywheel-bin.exe`, "--project-root", String.raw`C:\Work\my proj`, "ide"])
    expect(splitWindowsCommandLine("flywheel-bin.exe  --internal-role=guardian")).toEqual(["flywheel-bin.exe", "--internal-role=guardian"])
  })

  test("reads one object or an array of objects and skips rows without a command line", () => {
    const one = parseWindowsProcessJson(JSON.stringify({ ProcessId: 4, ParentProcessId: 0, CommandLine: null }))
    expect(one).toEqual([])
    const many = parseWindowsProcessJson(JSON.stringify([
      { ProcessId: 100, ParentProcessId: 4, CommandLine: String.raw`"C:\a\flywheel-bin.exe" ide` },
      { ProcessId: 101, ParentProcessId: 100, CommandLine: String.raw`"C:\a\flywheel-bin.exe" --internal-role=guardian` },
    ]))
    expect(many).toEqual([
      { pid: 100, ppid: 4, argv: [String.raw`C:\a\flywheel-bin.exe`, "ide"] },
      { pid: 101, ppid: 100, argv: [String.raw`C:\a\flywheel-bin.exe`, "--internal-role=guardian"] },
    ])
  })

  test("a table that is not JSON proves nothing", () => {
    expect(parseWindowsProcessJson("not json")).toBeUndefined()
  })
})
