import { describe, expect, test } from "bun:test"

import { CONTAINER_MARK_VARIABLE, STRICT_DESCENDANT_SETTLEMENT_VARIABLE, enableStrictDescendantSettlement, groupMarkReading, markedContainer, markedEnvironment, markedOutsideGroup, mayHaveSurvivingDescendant, unmarkedEnvironment } from "../../../src/infra/container-mark.js"
import { unixContainer, type ContainerProbe, type ProcRead } from "../../../src/infra/process-container.js"
import type { DarwinProcessApi } from "../../../src/infra/darwin-process-api.js"
import type { WindowsProcessApi } from "../../../src/infra/windows-process-api.js"
import { fakePid } from "../../helpers/fake-pid.js"

const MARK = "owned:command"
const MARKED = `${CONTAINER_MARK_VARIABLE}=${MARK}`

/** One process the fake kernel holds. `environment` undefined is an
 *  environment the kernel withholds, as macOS does for its own programs. */
interface FakeProcess {
  readonly ppid: number
  readonly pgid: number
  readonly start: string
  readonly environment?: readonly string[]
  /** The `stat` state; `Z` is a process that exited and waits to be reaped. */
  readonly state?: string
}

/** The process table of one stopped command, whose supervisor leads group
 *  100 and whose payload is 101. The comments in this file name each process
 *  n, and the tables hold it as `fakePid(n)`:
 *  - 201 and 202 are a `set -m` pipeline of platform programs in group 200,
 *    children of the payload, whose environment the kernel withholds;
 *  - 300 is a daemon that detached and whose parent exited;
 *  - 400 is another command's supervisor, which the payload's runtime started;
 *  - 500 is a persistent process the payload started, and 501 its child;
 *  - 600 is a stranger. */
const COMMAND = new Map<number, FakeProcess>([
  [fakePid(100), { ppid: 1, pgid: fakePid(100), start: "100", environment: ["PATH=/bin", MARKED] }],
  [fakePid(101), { ppid: fakePid(100), pgid: fakePid(100), start: "101", environment: ["PATH=/bin", MARKED] }],
  [fakePid(201), { ppid: fakePid(101), pgid: fakePid(200), start: "201" }],
  [fakePid(202), { ppid: fakePid(101), pgid: fakePid(200), start: "202" }],
  [fakePid(300), { ppid: 1, pgid: fakePid(300), start: "300", environment: ["PATH=/bin", MARKED] }],
  [fakePid(400), { ppid: fakePid(101), pgid: fakePid(400), start: "400", environment: ["PATH=/bin", `${CONTAINER_MARK_VARIABLE}=owned:other`] }],
  [fakePid(500), { ppid: fakePid(101), pgid: fakePid(500), start: "500", environment: ["PATH=/bin"] }],
  [fakePid(501), { ppid: fakePid(500), pgid: fakePid(500), start: "501" }],
  [fakePid(600), { ppid: 1, pgid: fakePid(600), start: "600" }],
])

/** A macOS kernel over `table`, which the test changes as processes exit.
 *  `unanswered` names the questions the kernel does not answer: the listing
 *  of every pid, and the query of each pid named. */
function libprocProbe(table: Map<number, FakeProcess>, signals: string[], unanswered: { readonly listing?: boolean; readonly queries?: readonly number[] } = {}): ContainerProbe {
  const pids = (): number[] => [...table.keys()]
  const libproc: DarwinProcessApi = {
    query(pid) {
      if (unanswered.queries?.includes(pid) === true) return { kind: "unavailable" }
      const entry = table.get(pid)
      return entry === undefined ? { kind: "absent" } : { kind: "process", pgid: entry.pgid, ppid: entry.ppid, identity: `${pid} ${entry.pgid} ${entry.start}`, start: entry.start }
    },
    group: (pgid) => pids().filter((pid) => table.get(pid)?.pgid === pgid),
    pids: () => (unanswered.listing === true ? undefined : pids()),
    children: (pid) => pids().filter((child) => table.get(child)?.ppid === pid),
    executable: () => ({ kind: "unavailable" }),
    processArguments: () => undefined,
    // macOS returns a platform program's arguments with no environment at all.
    environment: (pid) => (table.has(pid) ? table.get(pid)?.environment ?? [] : undefined),
    bootSession: () => undefined,
    footprintBytes: () => undefined,
    runnableThreads: () => undefined,
  }
  return {
    signal: (pid, signal) => { signals.push(`${signal} ${pid}`) },
    groupExists: (pgid) => pids().some((pid) => table.get(pid)?.pgid === pgid),
    libproc,
  }
}

/** A Linux kernel over `table`, answered through `/proc`. */
function procfsProbe(table: ReadonlyMap<number, FakeProcess>, signals: string[]): ContainerProbe {
  const read = (text: string | undefined): ProcRead => (text === undefined ? { kind: "absent" } : { kind: "content", text })
  return {
    signal: (pid, signal) => { signals.push(`${signal} ${pid}`) },
    groupExists: (pgid) => [...table.values()].some((entry) => entry.pgid === pgid),
    procfs: {
      listPids: () => [...table.keys()],
      readStat(pid) {
        const entry = table.get(pid)
        // pid (comm) state ppid pgrp session ... num_threads (20) ... starttime (22)
        return read(entry === undefined ? undefined : `${pid} (p) ${entry.state ?? "S"} ${entry.ppid} ${entry.pgid} ${"0 ".repeat(14)}1 0 ${entry.start}`)
      },
      readEnviron(pid) {
        const entry = table.get(pid)
        if (entry === undefined) return { kind: "absent" }
        return entry.environment === undefined ? { kind: "unreadable" } : { kind: "content", text: `${entry.environment.join("\0")}\0` }
      },
      bootId: () => ({ kind: "absent" }),
    },
  }
}

describe("ending a command on macOS and Linux", () => {
  test("reaches every process the command started that left its group, and nothing an owner of its own holds", () => {
    for (const probeOf of [libprocProbe, procfsProbe]) {
      const signals: string[] = []
      const probe = probeOf(new Map(COMMAND), signals)
      const ending = markedContainer(unixContainer(fakePid(100), probe), fakePid(100), MARK, probe)

      ending.signal("SIGTERM", { reason: "stop requested" })

      // The group takes one signal, and each process outside it takes its
      // own: the daemon by its mark, the pipeline by its parent.
      expect(signals.toSorted()).toEqual([`SIGTERM -${fakePid(100)}`, `SIGTERM ${fakePid(201)}`, `SIGTERM ${fakePid(202)}`, `SIGTERM ${fakePid(300)}`].toSorted())
    }
  })

  test("holds the container until each process outside the group is proven gone, and never signals a recycled pid", () => {
    const signals: string[] = []
    const table = new Map(COMMAND)
    const probe = libprocProbe(table, signals)
    const ending = markedContainer(unixContainer(fakePid(100), probe), fakePid(100), MARK, probe)
    ending.signal("SIGTERM", { reason: "stop requested" })
    // The group and the payload's pipeline are gone, and the payload with
    // them, so the daemon is now nobody's child.
    for (const pid of [100, 101, 201, 202]) table.delete(fakePid(pid))

    expect(ending.populated()).toBe(true)

    // The daemon's pid now holds another process.
    table.set(fakePid(300), { ppid: 1, pgid: fakePid(300), start: "999", environment: ["PATH=/bin"] })
    signals.length = 0
    ending.signal("SIGKILL", { reason: "stop requested" })

    expect(signals).toEqual([`SIGKILL -${fakePid(100)}`])
    expect(ending.populated()).toBe(false)
  })
  test("reaches only the launch's processes outside a group that a stranger now leads", () => {
    // A stranger took pid 100 after the launch's group emptied and runs a
    // set-user-ID child, whose environment the kernel withholds. The launch's
    // daemon 300 left the group, and its child 301 shows no environment.
    const table = new Map<number, FakeProcess>([
      [fakePid(100), { ppid: 1, pgid: fakePid(100), start: "900", environment: ["PATH=/bin"] }],
      [fakePid(111), { ppid: fakePid(100), pgid: fakePid(111), start: "111" }],
      [fakePid(300), { ppid: 1, pgid: fakePid(300), start: "300", environment: ["PATH=/bin", MARKED] }],
      [fakePid(301), { ppid: fakePid(300), pgid: fakePid(300), start: "301" }],
    ])
    for (const probeOf of [libprocProbe, procfsProbe]) {
      const signals: string[] = []
      const probe = probeOf(new Map(table), signals)
      const ending = markedOutsideGroup(fakePid(100), MARK, probe)

      ending.signal("SIGTERM", { reason: "guardian recovery" })

      expect(signals.toSorted()).toEqual([`SIGTERM ${fakePid(300)}`, `SIGTERM ${fakePid(301)}`])
      expect(ending.populated()).toBe(true)
    }
  })

  test("reads a leaderless group as not the launch's only when every member that has not exited shows an environment without its mark", () => {
    const table = new Map(COMMAND)
    // The supervisor that led group 100 is gone, and its payload stays.
    table.delete(fakePid(100))
    // Group 700 holds a stranger and a process that exited and waits to be
    // reaped, whose environment reads empty; group 800 holds only the latter.
    table.set(fakePid(701), { ppid: 1, pgid: fakePid(700), start: "701", environment: ["PATH=/bin"] })
    table.set(fakePid(702), { ppid: fakePid(701), pgid: fakePid(700), start: "702", environment: [], state: "Z" })
    table.set(fakePid(801), { ppid: 1, pgid: fakePid(800), start: "801", environment: [], state: "Z" })
    const linux = procfsProbe(table, [])

    expect(groupMarkReading(MARK, fakePid(100), linux)).toBe("marked")
    // A group whose member is another command's carries no mark of this
    // launch, and an exited member does not count.
    expect(groupMarkReading(MARK, fakePid(400), linux)).toBe("unmarked")
    expect(groupMarkReading(MARK, fakePid(700), linux)).toBe("unmarked")
    // The kernel withholds the environment of a program that cannot be
    // dumped or runs set-user-ID, so such a group proves nothing.
    expect(groupMarkReading(MARK, fakePid(200), linux)).toBeUndefined()
    expect(groupMarkReading(MARK, fakePid(800), linux)).toBe("empty")
    expect(groupMarkReading(MARK, fakePid(900), linux)).toBe("empty")
    // macOS withholds its platform programs' environments from their user,
    // so the mark proves nothing about a group there.
    expect(groupMarkReading(MARK, fakePid(100), libprocProbe(table, []))).toBeUndefined()
  })
})

describe("the mark a launch gives", () => {
  test("inherits strict settlement and ancestor marks even with an explicit environment", () => {
    const previous = process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE]
    try {
      enableStrictDescendantSettlement()
      const outer = markedEnvironment({ PATH: "/bin" }, MARK)
      process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] = outer[STRICT_DESCENDANT_SETTLEMENT_VARIABLE]
      const inner = markedEnvironment({ PATH: "/bin", [STRICT_DESCENDANT_SETTLEMENT_VARIABLE]: undefined }, "owned:inner")
      const table = new Map(COMMAND)
      table.set(fakePid(400), { ppid: 1, pgid: fakePid(400), start: "400", environment: Object.entries(inner).map(([name, value]) => `${name}=${value}`) })
      const signals: string[] = []
      const probe = libprocProbe(table, signals)
      markedContainer(unixContainer(fakePid(100), probe), fakePid(100), MARK, probe).signal("SIGTERM", { reason: "stop requested" })
      expect(signals).toContain(`SIGTERM ${fakePid(400)}`)
      expect(unmarkedEnvironment(inner)[STRICT_DESCENDANT_SETTLEMENT_VARIABLE]).toBeUndefined()
      expect(unmarkedEnvironment(inner)[CONTAINER_MARK_VARIABLE]).toBeUndefined()
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, STRICT_DESCENDANT_SETTLEMENT_VARIABLE)
      else process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] = previous
    }
  })
  test("names the launch's container, and a process that must outlive it carries none", () => {
    expect(markedEnvironment({ PATH: "/bin" }, MARK)).toEqual({ PATH: "/bin", [CONTAINER_MARK_VARIABLE]: MARK })
    expect(markedEnvironment({ [CONTAINER_MARK_VARIABLE]: "owned:outer" }, MARK)).toEqual({ [CONTAINER_MARK_VARIABLE]: MARK })
    expect(unmarkedEnvironment({ PATH: "/bin", [CONTAINER_MARK_VARIABLE]: MARK })).toEqual({ PATH: "/bin", [CONTAINER_MARK_VARIABLE]: undefined, [STRICT_DESCENDANT_SETTLEMENT_VARIABLE]: undefined })
  })
})

/** A host after one command settled, whose launch is stamped 100: launchd
 *  (pid 1), and 10, an older process such as the runtime that launched it. */
const SETTLED_LAUNCH = { start: "100", pidNamespace: false }
const BEFORE_LAUNCH: readonly (readonly [number, FakeProcess])[] = [
  [1, { ppid: 0, pgid: 1, start: "1" }],
  [fakePid(10), { ppid: 1, pgid: fakePid(10), start: "10" }],
]
const settledHost = (...after: (readonly [number, FakeProcess])[]): Map<number, FakeProcess> => new Map([...BEFORE_LAUNCH, ...after])

describe("whether a settled command left a process running", () => {
  test("proves on macOS that nothing survives when every process started after the launch descends from an older process", () => {
    // 400 is a new child of the old runtime, and 401 its child.
    const unrelated = settledHost([fakePid(400), { ppid: fakePid(10), pgid: fakePid(400), start: "400" }], [fakePid(401), { ppid: fakePid(400), pgid: fakePid(400), start: "401" }])

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(settledHost(), []))).toBe(false)
    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(unrelated, []))).toBe(false)
  })

  test("finds on macOS a survivor whose chain of processes newer than the launch reaches launchd, with or without the mark", () => {
    const orphan = settledHost([fakePid(300), { ppid: 1, pgid: fakePid(300), start: "300" }])
    // 301, the child of the orphan 300, is listed first.
    const childOfOrphan = settledHost([fakePid(301), { ppid: fakePid(300), pgid: fakePid(300), start: "301" }], [fakePid(300), { ppid: 1, pgid: fakePid(300), start: "300" }])
    const markedSurvivor = settledHost([fakePid(300), { ppid: 1, pgid: fakePid(300), start: "300", environment: ["PATH=/bin", MARKED] }])

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(orphan, []))).toBe(true)
    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(childOfOrphan, []))).toBe(true)
    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(markedSurvivor, []))).toBe(true)
  })

  test("proves nothing on macOS when the process table or a process on a walked chain does not answer", () => {
    const newChild = (parent: number): Map<number, FakeProcess> => settledHost([fakePid(400), { ppid: fakePid(10), pgid: fakePid(400), start: "400" }], [fakePid(401), { ppid: parent, pgid: fakePid(400), start: "401" }])

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(settledHost(), [], { listing: true }))).toBe(true)
    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(newChild(fakePid(400)), [], { queries: [fakePid(400)] }))).toBe(true)
    // The parent 399 is gone between the listing and the walk.
    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, libprocProbe(newChild(fakePid(399)), []))).toBe(true)
  })

  /** A kernel over `table` that runs `onQuery` before it answers each query of a pid. */
  const changingProbe = (table: Map<number, FakeProcess>, onQuery: (pid: number) => void): ContainerProbe => {
    const probe = libprocProbe(table, [])
    const libproc = probe.libproc!
    return { ...probe, libproc: { ...libproc, query: (pid) => { onQuery(pid); return libproc.query(pid) } } }
  }

  test("finds on macOS a survivor that a listed process started after the listing and before it exited", () => {
    // 300 survives the command, starts 301, and exits between the listing and its own query.
    const table = settledHost([fakePid(300), { ppid: 1, pgid: fakePid(300), start: "300" }])
    const probe = changingProbe(table, (pid) => {
      if (pid !== fakePid(300) || !table.has(pid)) return
      table.delete(pid)
      table.set(fakePid(301), { ppid: 1, pgid: fakePid(300), start: "301" })
    })

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, probe)).toBe(true)
  })

  test("proves on macOS that nothing survives once a scan finds gone only the pids the scan before it found gone", () => {
    // 500 is an unreaped zombie that every scan lists and finds gone; 401 exits during the first scan.
    const table = settledHost([fakePid(500), { ppid: fakePid(10), pgid: fakePid(500), start: "50" }], [fakePid(401), { ppid: fakePid(10), pgid: fakePid(401), start: "401" }])
    const zombie = changingProbe(table, (pid) => { if (pid === fakePid(401)) table.delete(pid) })
    const queryZombie = zombie.libproc!.query
    const settled: ContainerProbe = { ...zombie, libproc: { ...zombie.libproc!, query: (pid) => (pid === fakePid(500) ? { kind: "absent" } : queryZombie(pid)) } }

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, settled)).toBe(false)
  })

  test("proves nothing on macOS when every scan finds a new pid gone", () => {
    const table = settledHost()
    let next = 700
    const churning = changingProbe(table, (pid) => {
      if (pid < fakePid(700)) return
      table.delete(pid)
      table.set(fakePid(++next), { ppid: fakePid(10), pgid: fakePid(next), start: String(next) })
    })
    table.set(fakePid(700), { ppid: fakePid(10), pgid: fakePid(700), start: "700" })

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, churning)).toBe(true)
  })

  test("proves nothing on Linux outside a process namespace, because procfs cannot tell an orphan a subreaper adopted from an unrelated child", () => {
    // 10 is a subreaper, and 300 an orphan it adopted with no mark.
    const adopted = settledHost([fakePid(300), { ppid: fakePid(10), pgid: fakePid(300), start: "300", environment: [] }])

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, procfsProbe(adopted, []))).toBe(true)
    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, procfsProbe(settledHost(), []))).toBe(true)
  })

  test("proves on Linux that nothing survives a launch that ran in its own process namespace, whose end the settled group already proved", () => {
    const adopted = settledHost([fakePid(300), { ppid: fakePid(10), pgid: fakePid(300), start: "300", environment: [] }])

    expect(mayHaveSurvivingDescendant({ ...SETTLED_LAUNCH, pidNamespace: true }, procfsProbe(adopted, []))).toBe(false)
  })

  test("proves on Windows that nothing survives without asking the kernel, because the settled job held every descendant", () => {
    const unasked = (): never => { throw new Error("the settled job already proves the answer") }
    const windows: WindowsProcessApi = { query: unasked, list: unasked, now: unasked, terminate: unasked, workingSetBytes: unasked, commitBytes: unasked, runnableThreads: unasked, environment: unasked }

    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, { signal: unasked, groupExists: unasked, windows })).toBe(false)
  })

  test("proves nothing with no kernel surface to ask", () => {
    expect(mayHaveSurvivingDescendant(SETTLED_LAUNCH, { signal: () => undefined, groupExists: () => false })).toBe(true)
  })
})
