import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { runKill, type KillDependencies } from "../../../src/cli/kill.js"
import { Log } from "../../../src/infra/log.js"
import type { ProcessAccountHome } from "../../../src/infra/process-account-home.js"
import { accountServeRecordPath, accountServeSocketPath, accountServeStartLockPath } from "../../../src/infra/paths.js"
import type { ProcessRow } from "../../../src/infra/process-table.js"

const OWN_HOME = "/Users/me"
const OTHER_HOME = "/Users/test-home"
const own = { userDataRoot: "/nowhere", accountHome: OWN_HOME }

/** Two account homes on one machine: this account's installed service and dev
 *  serve, a test home's installed service and dev serve, one Flywheel process
 *  whose home nothing proves, a host whose home nothing proves with a guardian
 *  that names this home, and a service of another user. */
const rows: readonly ProcessRow[] = [
  { pid: 10, ppid: 1, argv: ["/Users/me/.local/bin/flywheel", "serve"] },
  { pid: 20, ppid: 1, argv: ["/usr/bin/bun", "--conditions=browser", "/repo/scripts/dev.ts", "serve"] },
  { pid: 21, ppid: 20, argv: ["/usr/bin/bun", "/repo/src/cli/index.ts", "--internal-role=guardian"] },
  { pid: 30, ppid: 1, argv: ["/Users/test-home/.flywheel/versions/1.0.0/abc/flywheel-bin", "serve"] },
  { pid: 40, ppid: 1, argv: ["/usr/bin/bun", "/repo/scripts/dev.ts", "serve"] },
  { pid: 50, ppid: 1, argv: ["/opt/flywheel/flywheel-bin", "--headless"] },
  { pid: 60, ppid: 1, argv: ["/opt/flywheel/flywheel-bin", "ide"] },
  { pid: 61, ppid: 60, argv: ["/opt/flywheel/flywheel-bin", "--internal-role=guardian"] },
  { pid: 70, ppid: 1, argv: ["/home/other/.flywheel/versions/1.0.0/abc/flywheel-bin", "serve"] },
]

const homes: ReadonlyMap<number, ProcessAccountHome> = new Map([
  [10, { kind: "home", home: OWN_HOME }],
  [20, { kind: "home", home: OWN_HOME }],
  [21, { kind: "home", home: OWN_HOME }],
  [30, { kind: "home", home: OTHER_HOME }],
  [40, { kind: "home", home: OTHER_HOME }],
  [50, { kind: "unproven", reason: "its environment could not be read" }],
  [60, { kind: "unproven", reason: "its environment names no absolute HOME" }],
  [61, { kind: "home", home: OWN_HOME }],
  [70, { kind: "other-user" }],
])

/** The pids a run listed to stop, and the pids it named as left running. */
function listing(printed: readonly string[]): { readonly stopped: readonly number[]; readonly left: readonly number[] } {
  const pid = (line: string) => Number(line.trim().split(/\s+/)[0])
  const leftAt = printed.findIndex((line) => line.startsWith("Left running"))
  const rowsIn = (lines: readonly string[]) => lines.filter((line) => line.startsWith("  ")).map(pid)
  return leftAt < 0
    ? { stopped: rowsIn(printed), left: [] }
    : { stopped: rowsIn(printed.slice(0, leftAt)), left: rowsIn(printed.slice(leftAt)) }
}

/** Every host seam faked, so no test can reach a real process or wait. */
function fakeDependencies(printed: string[]): Partial<KillDependencies> {
  return {
    listProcesses: async () => rows,
    containerFor: () => ({ signal() {}, populated: () => false }),
    isFlywheelCheckout: (root) => root === "/repo",
    selfPid: 999,
    sleep: async () => {},
    isProcessAlive: () => false,
    probeRendezvous: async () => ({ kind: "absent", code: "ENOENT" }),
    accountHomeOf: (row) => homes.get(row.pid) ?? { kind: "unproven", reason: "no fixture" },
    print: (line) => { printed.push(line) },
    hostGraceMs: 0,
    guardianSweepMs: 0,
  }
}

/** A process table that answers `tables` in order, the last one for every
 *  later read. */
function reads(...tables: readonly (readonly ProcessRow[])[]): KillDependencies["listProcesses"] {
  let next = 0
  return async () => tables[Math.min(next++, tables.length - 1)]
}

/** A dev serve of this account home, as the process table lists it. */
function devServe(pid: number): ProcessRow {
  return { pid, ppid: 1, argv: ["/usr/bin/bun", "/repo/scripts/dev.ts", "serve"] }
}

/** A process outside Flywheel, as the process table lists it. */
function stranger(pid: number): ProcessRow {
  return { pid, ppid: 1, argv: ["/bin/sleep", "600"] }
}

/** A dev lane with a stale identity record and a start lock that an earlier
 *  build wrote for `holder`, which names no identity. */
function laneHeldBy(holder: number) {
  temporaryRoot = mkdtempSync(join(tmpdir(), "flywheel-kill-"))
  const userDataRoot = join(temporaryRoot, ".flywheel")
  const record = accountServeRecordPath(userDataRoot, "dev")
  mkdirSync(join(record, ".."), { recursive: true })
  writeFileSync(record, JSON.stringify({ pid: 424242, version: "stale", protocolVersion: 1 }))
  const lockPath = accountServeStartLockPath(userDataRoot, "dev")
  writeFileSync(lockPath, JSON.stringify({ pid: holder, owner: "old" }))
  return { userDataRoot, record, lockPath }
}

/** The start locks a "flywheel kill settled" record names as reclaimed. */
interface SettledReclaims {
  readonly reclaimedStartLocks: readonly ({ readonly lane: "installed" | "dev"; readonly pid: number } | { readonly lane: "installed" | "dev"; readonly entry: "empty" | "malformed" })[]
}

/** Runs `run` and checks the one "flywheel kill settled" record it writes
 *  against `expected`. */
async function expectSettled(run: () => Promise<void>, expected: SettledReclaims): Promise<void> {
  const info = spyOn(Log.create({ service: "kill" }), "info").mockImplementation(() => {})
  try {
    await run()
    const settled = info.mock.calls.filter(([message]) => message === "flywheel kill settled")
    expect(settled).toHaveLength(1)
    expect(settled[0]?.[1]).toMatchObject(expected)
  } finally {
    info.mockRestore()
  }
}

const RECLAIMED_OWN = `Reclaimed the dev start lock from pid ${process.pid}, which is not a Flywheel process of this account home.`

let temporaryRoot: string | undefined
afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

test("the reset stops only its own account home's processes and names the ones whose home is not proven", async () => {
  const printed: string[] = []
  expect(await runKill(["--dry-run"], own, fakeDependencies(printed))).toBe(0)
  expect(listing(printed)).toEqual({ stopped: [10, 20, 21], left: [50, 60, 61] })
  expect(printed.find((line) => line.trim().startsWith("50"))).toContain("its environment could not be read")
  // A host left standing keeps its guardian, the backstop for what it owns.
  expect(printed.find((line) => line.trim().startsWith("61"))).toContain("its host's account home is not proven")
  // Another user's process is not this account's to stop or to name.
  expect(printed.some((line) => line.trim().startsWith("70"))).toBe(false)
  expect(printed.at(-1)).toBe("Would stop 3 Flywheel processes of the account home /Users/me.")
})

test("`kill all` stops the Flywheel processes of every account home, proven or not", async () => {
  const printed: string[] = []
  expect(await runKill(["all", "--dry-run"], own, fakeDependencies(printed))).toBe(0)
  expect(listing(printed)).toEqual({ stopped: [10, 20, 21, 30, 40, 50, 60, 61, 70], left: [] })
  expect(printed.at(-1)).toBe("Would stop 9 Flywheel processes.")
})

test("the scoped reset signals no process of another account home", async () => {
  const signalled: number[] = []
  const deps = {
    ...fakeDependencies([]),
    containerFor: ({ pid }: { readonly pid: number }) => {
      let populated = true
      return { signal: () => { populated = false; signalled.push(pid) }, populated: () => populated }
    },
  }
  expect(await runKill([], own, deps)).toBe(0)
  expect(signalled).toEqual([10, 20, 21])
})

test("labels the live process list as pending and confirms only after cleanup", async () => {
  const events: string[] = []
  const deps = {
    ...fakeDependencies(events),
    containerFor: ({ pid }: { readonly pid: number }) => {
      let populated = true
      return {
        signal: () => {
          populated = false
          events.push(`finished cleanup for ${pid}`)
        },
        populated: () => populated,
      }
    },
  }

  expect(await runKill(["all"], own, { ...deps, listProcesses: async () => rows.slice(0, 3) })).toBe(0)

  expect(events[0]).toBe("Stopping 3 Flywheel processes:")
  expect(events.slice(1, 4).map((line) => Number(line.trim().split(/\s+/)[0]))).toEqual([10, 20, 21])
  expect(events.slice(4, -1)).toEqual(["finished cleanup for 10", "finished cleanup for 20", "finished cleanup for 21"])
  expect(events.at(-1)).toBe("Stopped 3 Flywheel processes.")
})

test("a lane name narrows the reset to that lineage: source checkouts or installed builds", async () => {
  const source: string[] = []
  expect(await runKill(["dev", "--dry-run"], own, fakeDependencies(source))).toBe(0)
  expect(listing(source)).toEqual({ stopped: [20, 21], left: [] })
  expect(source.at(-1)).toBe("Would stop 2 Flywheel processes of the account home /Users/me in the dev lane.")

  const installed: string[] = []
  expect(await runKill(["installed", "--dry-run"], own, fakeDependencies(installed))).toBe(0)
  expect(listing(installed)).toEqual({ stopped: [10], left: [50, 60, 61] })
  expect(installed.at(-1)).toBe("Would stop 1 Flywheel process of the account home /Users/me in the installed lane.")

  const everyHome: string[] = []
  expect(await runKill(["all", "dev", "--dry-run"], own, fakeDependencies(everyHome))).toBe(0)
  expect(listing(everyHome)).toEqual({ stopped: [20, 21, 40], left: [] })
  expect(everyHome.at(-1)).toBe("Would stop 3 Flywheel processes in the dev lane.")
})

// A planned replacement hands a command's supervisor over, so the supervisor
// outlives the runtime that launched it, and the reset must still find it.
test("finds a source checkout's command supervisor in the dev lane, and no other repository's file of its name", async () => {
  const printed: string[] = []
  const supervisors: readonly ProcessRow[] = [
    { pid: 30, ppid: 1, argv: ["/usr/bin/bun", "/repo/node_modules/.cache/flywheel/owned-command-supervisor-0123456789abcdef.js", "--lifetime", "guarded", "--", "bash", "/s.sh"] },
    // Linux re-enters the running executable through its process identity.
    { pid: 31, ppid: 1, argv: ["/proc/self/exe", "/repo/src/infra/owned-command-supervisor.ts", "--lifetime", "guarded", "--", "bash", "/s.sh"] },
    { pid: 32, ppid: 1, argv: ["/usr/bin/bun", "/other/node_modules/.cache/flywheel/owned-command-supervisor-0123456789abcdef.js"] },
  ]

  const ownHome = (): ProcessAccountHome => ({ kind: "home", home: OWN_HOME })
  expect(await runKill(["dev", "--dry-run"], own, { ...fakeDependencies(printed), listProcesses: async () => supervisors, accountHomeOf: ownHome })).toBe(0)

  expect(listing(printed)).toEqual({ stopped: [30, 31], left: [] })
  expect(printed.filter((line) => line.startsWith("  ")).map((line) => line.trim().split(/\s+/)[1])).toEqual(["command-supervisor", "command-supervisor"])
})

test("a lane name clears only that lane's stale rendezvous", async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "flywheel-kill-"))
  const userDataRoot = join(temporaryRoot, ".flywheel")
  for (const lane of ["installed", "dev"] as const) {
    const record = accountServeRecordPath(userDataRoot, lane)
    mkdirSync(join(record, ".."), { recursive: true })
    writeFileSync(record, JSON.stringify({ pid: 424242, version: "test", protocolVersion: 1 }))
  }
  const printed: string[] = []
  expect(await runKill(["all", "dev"], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: async () => [] })).toBe(0)
  expect(existsSync(accountServeRecordPath(userDataRoot, "dev"))).toBe(false)
  expect(existsSync(accountServeRecordPath(userDataRoot, "installed"))).toBe(true)
  expect(printed).toEqual(["No Flywheel processes are running in the dev lane."])
})

test("a lane whose start lock a live serve holds keeps its rendezvous", async () => {
  // A serve between its liveness probe and its identity publication has no
  // record and no socket; only the start lock says the lane is starting. The
  // reset used to remove that lock by path and clear the lane anyway.
  temporaryRoot = mkdtempSync(join(tmpdir(), "flywheel-kill-"))
  const userDataRoot = join(temporaryRoot, ".flywheel")
  const record = accountServeRecordPath(userDataRoot, "dev")
  mkdirSync(join(record, ".."), { recursive: true })
  writeFileSync(record, JSON.stringify({ pid: 424242, version: "stale", protocolVersion: 1 }))
  writeFileSync(accountServeStartLockPath(userDataRoot, "dev"), JSON.stringify({ pid: process.pid, owner: "starting-serve" }))
  const printed: string[] = []
  // The table read again for the lock names its holder a dev serve of this
  // home, which launchd or a client may have started after the first read.
  const deps = fakeDependencies(printed)
  const accountHomeOf = deps.accountHomeOf ?? (() => ({ kind: "unproven", reason: "no fixture" }))
  expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, {
    ...deps,
    listProcesses: reads([], [devServe(process.pid)]),
    accountHomeOf: (row) => row.pid === process.pid ? { kind: "home", home: OWN_HOME } : accountHomeOf(row),
  })).toBe(0)
  expect(existsSync(record)).toBe(true)
  expect(readFileSync(accountServeStartLockPath(userDataRoot, "dev"), "utf8")).toContain("starting-serve")
})

test("a start lock left by a dead serve is reclaimed and the lane cleared", async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "flywheel-kill-"))
  const userDataRoot = join(temporaryRoot, ".flywheel")
  const record = accountServeRecordPath(userDataRoot, "dev")
  mkdirSync(join(record, ".."), { recursive: true })
  writeFileSync(record, JSON.stringify({ pid: 424242, version: "stale", protocolVersion: 1 }))
  const lockPath = accountServeStartLockPath(userDataRoot, "dev")
  writeFileSync(lockPath, JSON.stringify({ pid: 4_000_000, owner: "dead-serve" }))
  const printed: string[] = []
  expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: async () => [] })).toBe(0)
  expect(existsSync(record)).toBe(false)
  expect(existsSync(lockPath)).toBe(false)
  expect(printed).toEqual(["No Flywheel processes of the account home /Users/me are running in the dev lane."])
})

test("a start lock whose holder the process table proves is not a Flywheel process of this home is reclaimed, named, and the lane cleared", async () => {
  // An earlier build's record, which names no identity, of a pid that a
  // process outside Flywheel now holds.
  const { userDataRoot, record, lockPath } = laneHeldBy(process.pid)
  const printed: string[] = []
  // The first read finds this home's dev serve and its guardian; the read
  // again for the lock finds a process outside Flywheel under the holder's pid.
  await expectSettled(async () => {
    expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: reads(rows, [stranger(process.pid)]) })).toBe(0)
  }, { reclaimedStartLocks: [{ lane: "dev", pid: process.pid }] })
  expect(existsSync(lockPath)).toBe(false)
  expect(existsSync(record)).toBe(false)
  expect(printed).toContain(RECLAIMED_OWN)
})

// A person clears a stuck start lock with `flywheel kill` once the start that
// refused it has exited, so no Flywheel process runs at all.
test("a start lock reclaimed while no Flywheel process runs is named and recorded", async () => {
  const { userDataRoot, lockPath } = laneHeldBy(process.pid)
  const printed: string[] = []
  await expectSettled(async () => {
    expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: reads([], [stranger(process.pid)]) })).toBe(0)
  }, { reclaimedStartLocks: [{ lane: "dev", pid: process.pid }] })
  expect(existsSync(lockPath)).toBe(false)
  expect(printed).toEqual(["No Flywheel processes of the account home /Users/me are running in the dev lane.", RECLAIMED_OWN])
})

// A pid that runs now but that the fresh read does not list started after
// the read, and a service manager restarts a serve at any moment, so that
// process may be a serve that took the lock since.
test("a start lock whose holder started after the fresh read is kept", async () => {
  const { userDataRoot, record, lockPath } = laneHeldBy(process.pid)
  expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, {
    ...fakeDependencies([]),
    listProcesses: async () => [],
    isProcessAlive: (pid) => pid === process.pid,
  })).toBe(0)
  expect(readFileSync(lockPath, "utf8")).toContain('"old"')
  expect(existsSync(record)).toBe(true)
})

// A proof names the holder only when the lock protocol removed its record.
test("names no reclaimed start lock when its holder released the lock before the claim", async () => {
  const { userDataRoot, lockPath } = laneHeldBy(process.pid)
  const printed: string[] = []
  await expectSettled(async () => {
    expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, {
      ...fakeDependencies(printed),
      listProcesses: reads([], [devServe(process.pid)]),
      // The holder, a serve of another user's home, releases the lock while
      // the reset proves it: the lock is free by the time the claim reads it.
      accountHomeOf: () => {
        rmSync(lockPath, { force: true })
        return { kind: "other-user" }
      },
    })).toBe(0)
  }, { reclaimedStartLocks: [] })
  expect(printed).toEqual(["No Flywheel processes of the account home /Users/me are running in the dev lane."])
})

// The refused start tells the person to run the reset, so the reset must
// clear the damaged lock that refused it.
test("a start lock that names no holder is removed, named, and the lane cleared once no account service of this home runs in the lane", async () => {
  for (const [bytes, words] of [["", "is empty"], ["garbage", "holds bytes that are not a lock record"]] as const) {
    const { userDataRoot, record, lockPath } = laneHeldBy(4_000_000)
    writeFileSync(lockPath, bytes)
    const printed: string[] = []
    // A dev serve of another home, and an installed serve of this home, do
    // not hold this home's dev lane.
    await expectSettled(async () => {
      expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: reads([], [rows[0]!, rows[4]!]) })).toBe(0)
    }, { reclaimedStartLocks: [{ lane: "dev", entry: bytes === "" ? "empty" : "malformed" }] })
    expect(existsSync(lockPath)).toBe(false)
    expect(existsSync(record)).toBe(false)
    expect(printed).toContain(`Removed the dev start lock ${lockPath}, which named no holder: the lock record ${words}.`)
    rmSync(temporaryRoot!, { recursive: true, force: true })
  }
})

// A serve whose lock record was damaged in place still holds the lock.
test("a start lock that names no holder is kept while an account service of this home, or of a home not proven, runs in the lane", async () => {
  for (const home of [{ kind: "home", home: OWN_HOME }, { kind: "unproven", reason: "its environment could not be read" }] as const) {
    const { userDataRoot, record, lockPath } = laneHeldBy(4_000_000)
    writeFileSync(lockPath, "")
    const printed: string[] = []
    expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, {
      ...fakeDependencies(printed),
      listProcesses: reads([], [devServe(4242)]),
      accountHomeOf: (row) => row.pid === 4242 ? home : { kind: "unproven", reason: "no fixture" },
    })).toBe(0)
    expect(existsSync(lockPath)).toBe(true)
    expect(existsSync(record)).toBe(true)
    expect(printed.at(-1)).toBe(`The dev lane's rendezvous was not cleared, because its start lock ${lockPath} is taken: the lock record is empty.`)
    rmSync(temporaryRoot!, { recursive: true, force: true })
  }
})

test("a dry run clears nothing, a start lock included", async () => {
  const { userDataRoot, record, lockPath } = laneHeldBy(process.pid)
  const printed: string[] = []
  expect(await runKill(["dev", "--dry-run"], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: reads([], [stranger(process.pid)]) })).toBe(0)
  expect(readFileSync(lockPath, "utf8")).toContain('"old"')
  expect(existsSync(record)).toBe(true)
  expect(printed).toEqual(["No Flywheel processes of the account home /Users/me are running in the dev lane."])
})

// A lane whose directory the file system refuses to write keeps its
// rendezvous, and the reset says why instead of stopping before the other
// lanes. Mode 0500 refuses the start lock only to a process without root's
// override.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a lane whose start lock the file system refuses is named with the reason, and the next lane is cleared", async () => {
  const { userDataRoot, record } = laneHeldBy(4_000_000)
  const installed = join(accountServeRecordPath(userDataRoot, "installed"), "..")
  mkdirSync(installed, { recursive: true })
  chmodSync(installed, 0o500)
  const printed: string[] = []
  try {
    expect(await runKill([], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: async () => [] })).toBe(0)
  } finally {
    chmodSync(installed, 0o700)
  }
  expect(printed.slice(1)).toEqual([expect.stringMatching(/^The installed lane's rendezvous was not cleared: EACCES: .*\.$/)])
  expect(existsSync(record)).toBe(false)
})

// A reset that leaves a lane as it was says so, with the reason and what a
// person does about it, instead of reading as a lane it cleared.
test.skipIf(process.platform === "win32")("a socket whose probe proves nothing stays, and the reset names it with the reason and the remedy", async () => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "flywheel-kill-"))
  const userDataRoot = join(temporaryRoot, ".flywheel")
  const socketPath = accountServeSocketPath(userDataRoot, "dev")
  mkdirSync(join(socketPath, ".."), { recursive: true })
  writeFileSync(socketPath, "")
  const probed: string[] = []
  const printed: string[] = []
  expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, {
    ...fakeDependencies(printed),
    listProcesses: async () => [],
    probeRendezvous: async (path) => { probed.push(path); return { kind: "unknown", code: "EACCES" } },
  })).toBe(0)
  expect(existsSync(socketPath)).toBe(true)
  expect(probed).toEqual([socketPath])
  expect(printed.slice(1)).toEqual([
    `The dev lane's address ${socketPath} was kept: a connection to it failed with EACCES, which proves neither a running service nor its absence. Fix its permissions so that you can connect to it, or remove the file.`,
  ])
})

test("a lane whose start lock an earlier release's fresh empty claim keeps is named with the reason and left as it is", async () => {
  const { userDataRoot, record, lockPath } = laneHeldBy(4_000_000)
  const claimPath = `${lockPath}.reclaim.${createHash("sha256").update("old").digest("hex")}`
  writeFileSync(claimPath, "")
  const printed: string[] = []
  expect(await runKill(["dev"], { userDataRoot, accountHome: OWN_HOME }, { ...fakeDependencies(printed), listProcesses: async () => [] })).toBe(0)
  expect(existsSync(lockPath)).toBe(true)
  expect(existsSync(claimPath)).toBe(true)
  expect(existsSync(record)).toBe(true)
  expect(printed.slice(1)).toEqual([
    `The dev lane's rendezvous was not cleared, because its start lock ${lockPath} is taken: reclaim claim '${basename(claimPath)}' is empty, the shape an earlier release leaves, and is removed once it is proven 10 minutes old.`,
  ])
})

test("a word that is not a lane is a usage error", async () => {
  const printed: string[] = []
  expect(await runKill(["prod"], own, fakeDependencies(printed))).toBe(2)
  expect(printed[0]).toContain("Usage: flywheel kill [all] [installed|dev]")
})
