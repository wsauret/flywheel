import { describe, expect, setSystemTime, test } from "bun:test"
import * as fs from "node:fs"
import { delimiter, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"

import {
  bootIdentity,
  emptyContainers,
  onTermination,
  ownUnixContainer,
  ownWindowsJobContainer,
  processStart,
  trustedProbeLaunch,
  unixContainer,
  unixContainerIdentity,
  unixProcessIdentity,
  windowsContainer,
  windowsProcessIdentity,
  type ContainerProbe,
  type ManagedContainer,
  type ProcRead,
  type Procfs,
  type TerminationDecision,
} from "../../../src/infra/process-container.js"
import type { DarwinBootSession, DarwinProcessApi, DarwinProcessQuery } from "../../../src/infra/darwin-process-api.js"
import type { WindowsProcessApi, WindowsProcessQuery } from "../../../src/infra/windows-process-api.js"
import { fakePid } from "../../helpers/fake-pid.js"

/** The grace every escalation here is given. One absolute bound covers TERM,
 *  the grace and KILL together, so it is also the total these tests may sleep. */
const GRACE_MS = 20

interface FakeContainer extends ManagedContainer {
  readonly signals: string[]
}

function fakeContainer(emptiesOn?: "SIGTERM" | "SIGKILL" | "start"): FakeContainer {
  const signals: string[] = []
  let empty = emptiesOn === "start"
  return {
    signals,
    signal(signal) {
      signals.push(signal)
      if (signal === emptiesOn) empty = true
    },
    populated: () => !empty,
  }
}

function recordingSleep() {
  const slept: number[] = []
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms)
      await Bun.sleep(ms)
    },
  }
}

describe("container settlement", () => {
  test("signals nothing when every container is already empty", async () => {
    const containers = [fakeContainer("start"), fakeContainer("start")]

    const settlement = await emptyContainers(containers, GRACE_MS, (ms) => Bun.sleep(ms), { reason: "test" })

    expect(settlement).toEqual({ kind: "empty" })
    expect(containers.map((container) => container.signals)).toEqual([[], []])
  })

  test("settles without escalating when the containers take the term", async () => {
    const containers = [fakeContainer("SIGTERM"), fakeContainer("SIGTERM")]

    const settlement = await emptyContainers(containers, GRACE_MS, (ms) => Bun.sleep(ms), { reason: "test" })

    expect(settlement).toEqual({ kind: "empty" })
    expect(containers.map((container) => container.signals)).toEqual([["SIGTERM"], ["SIGTERM"]])
  })

  test("reports the containers that outlived the kill instead of claiming settlement", async () => {
    const containers = [fakeContainer(), fakeContainer("SIGKILL")]

    const settlement = await emptyContainers(containers, GRACE_MS, (ms) => Bun.sleep(ms), { reason: "test" })

    expect(settlement).toEqual({ kind: "unsettled", remaining: 1 })
    expect(containers[0]?.signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  test("spends one absolute grace on the whole escalation, not one grace per phase", async () => {
    const clock = recordingSleep()
    const containers = [fakeContainer(), fakeContainer()]

    const settlement = await emptyContainers(containers, GRACE_MS, clock.sleep, { reason: "test" })

    expect(settlement).toEqual({ kind: "unsettled", remaining: 2 })
    expect(clock.slept.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(GRACE_MS)
  })

  test("keeps an interval to observe the kill in, even when the term spent the whole grace", async () => {
    const signals: string[] = []
    let killed = false
    let probes = 0
    // A container the operating system has not finished tearing down: it is
    // still populated on the probe that follows the kill, and empty on the
    // next one.
    const container: ManagedContainer = {
      signal(signal) {
        signals.push(signal)
        if (signal === "SIGKILL") killed = true
      },
      populated: () => {
        if (!killed) return true
        probes += 1
        return probes <= 1
      },
    }

    // A virtual clock instead of real sleeps: the escalation's deadlines are
    // wall-clock reads, and a real sleep that overshoots on a loaded machine
    // spends the kill-observation slice before the second probe can run.
    const sleep = (ms: number): Promise<void> => {
      setSystemTime(new Date(Date.now() + ms))
      return Promise.resolve()
    }
    try {
      const settlement = await emptyContainers([container], GRACE_MS, sleep, { reason: "test" })

      expect(signals).toEqual(["SIGTERM", "SIGKILL"])
      expect(settlement).toEqual({ kind: "empty" })
    } finally {
      setSystemTime()
    }
  })
})

/** A macOS kernel the test scripted: what one query answers per pid, and the
 *  pids each group listing names. A pid nobody scripted is absent, and a group
 *  nobody scripted is empty. */
function libprocProbe(options: {
  readonly processes?: { readonly [pid: number]: DarwinProcessQuery }
  readonly groups?: { readonly [pgid: number]: readonly number[] | undefined }
  readonly groupExists?: boolean
  readonly signals?: string[]
  readonly boot?: DarwinBootSession
}): ContainerProbe {
  const libproc: DarwinProcessApi = {
    query: (pid) => options.processes?.[pid] ?? { kind: "absent" },
    group: (pgid) => (options.groups !== undefined && pgid in options.groups ? options.groups[pgid] : []),
    pids: () => undefined,
    children: () => undefined,
    executable: () => ({ kind: "unavailable" }),
    processArguments: () => undefined,
    environment: () => undefined,
    bootSession: () => options.boot,
    footprintBytes: () => undefined,
    runnableThreads: () => undefined,
  }
  return {
    signal: (pid, signal) => { options.signals?.push(`${signal} ${pid}`) },
    groupExists: () => options.groupExists ?? true,
    libproc,
  }
}

const RUNNING = (pid: number, pgid: number, uniqueId = 7): DarwinProcessQuery => ({ kind: "process", pgid, ppid: 1, identity: `${pid} ${pgid} ${uniqueId}`, start: String(uniqueId) })

/** The processes scripted membership listings name: two members of the
 *  container under test, a stranger in another group, and a kernel thread. */
const MEMBER = fakePid(1)
const OTHER_MEMBER = fakePid(2)
const STRANGER = fakePid(3)
const KERNEL_THREAD = fakePid(4)

describe("container membership", () => {
  test("releases a group the kernel no longer holds without listing it", () => {
    const probe = libprocProbe({ groups: { 4242: [MEMBER] }, processes: { [MEMBER]: RUNNING(MEMBER, 4242) }, groupExists: false })

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("releases a container whose group listing names no process", () => {
    expect(unixContainer(4242, libprocProbe({ groups: { 4242: [] } })).populated()).toBe(false)
  })

  test("keeps a container that still holds a running member", () => {
    const probe = libprocProbe({ groups: { 4242: [MEMBER] }, processes: { [MEMBER]: RUNNING(MEMBER, 4242) } })

    expect(unixContainer(4242, probe).populated()).toBe(true)
  })

  test("releases a container whose members all exited and wait to be reaped", () => {
    // The listing names an unreaped member, and the query proves it runs nothing.
    const probe = libprocProbe({ groups: { 4242: [MEMBER, OTHER_MEMBER] } })

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("skips a member that moved to another group between the listing and the query", () => {
    const probe = libprocProbe({ groups: { 4242: [MEMBER] }, processes: { [MEMBER]: RUNNING(MEMBER, 5000) } })

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("never counts the calling process as a member of its own container", () => {
    const probe = libprocProbe({ groups: { 4242: [process.pid] }, processes: { [process.pid]: RUNNING(process.pid, 4242) } })

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("keeps a container when the listing or a member query did not answer", () => {
    const unanswered: readonly ContainerProbe[] = [
      libprocProbe({ groups: { 4242: undefined } }),
      libprocProbe({ groups: { 4242: [MEMBER] }, processes: { [MEMBER]: { kind: "unavailable" } } }),
    ]

    for (const probe of unanswered) {
      expect(unixContainer(4242, probe).populated()).toBe(true)
    }
  })

  test("keeps a container when no kernel surface could be opened, rather than reading it as empty", () => {
    const probe: ContainerProbe = { signal: () => {}, groupExists: () => true }

    expect(unixContainer(4242, probe).populated()).toBe(true)
  })
})

describe("container identity", () => {
  test("names the container of a process that leads its own group by the kernel's identity of it", () => {
    const probe = libprocProbe({ processes: { 4242: RUNNING(4242, 4242, 42) } })

    expect(unixContainerIdentity(4242, probe)).toEqual({ kind: "container", identity: "4242 4242 42" })
  })

  test("reports an absence only when the kernel proved the pid runs no process", () => {
    expect(unixContainerIdentity(4242, libprocProbe({}))).toEqual({ kind: "absent" })
  })

  test("proves nothing when the query did not answer", () => {
    expect(unixContainerIdentity(4242, libprocProbe({ processes: { 4242: { kind: "unavailable" } } }))).toEqual({ kind: "unproven" })
  })

  test("proves nothing when no kernel surface could be opened", () => {
    const probe: ContainerProbe = { signal: () => {}, groupExists: () => true }

    expect(unixContainerIdentity(4242, probe)).toEqual({ kind: "unproven" })
    expect(unixProcessIdentity(4242, probe)).toEqual({ kind: "unproven" })
  })

  test("proves the container gone when its pid holds a live process that leads no group", () => {
    // The kernel never gives a pid to a new process while a group with that id
    // exists, so a live non-leader at the pid is proof, not a missing answer.
    expect(unixContainerIdentity(4242, libprocProbe({ processes: { 4242: RUNNING(4242, 100) } }))).toEqual({ kind: "other" })
  })

  test("identifies a process whatever group it is in, and tells an absence from no answer", () => {
    expect(unixProcessIdentity(4242, libprocProbe({ processes: { 4242: RUNNING(4242, 100) } }))).toEqual({ kind: "process", identity: "4242 100 7" })
    expect(unixProcessIdentity(4242, libprocProbe({}))).toEqual({ kind: "absent" })
    expect(unixProcessIdentity(4242, libprocProbe({ processes: { 4242: { kind: "unavailable" } } }))).toEqual({ kind: "unproven" })
  })
})

describe("own container escalation", () => {
  test("records each Windows container request once while signaling every other job member", () => {
    const members = [process.pid, MEMBER, OTHER_MEMBER]
    const signaled: string[] = []
    const container = ownWindowsJobContainer({
      pids: () => members, admit: () => true, letChildrenLeave: () => true, terminate: () => {}, close: () => {},
      suspend: () => false, resume: () => false,
    }, (pid, signal) => { signaled.push(`${signal} ${pid}`) })
    const cause = { reason: "stop requested", evidence: { guardianPid: 7 } }
    const decisions = terminationsOf(() => {
      container.signal("SIGTERM", cause)
      container.signal("SIGKILL", cause)
    })
    expect(signaled).toEqual([`SIGTERM ${MEMBER}`, `SIGTERM ${OTHER_MEMBER}`, `SIGKILL ${MEMBER}`, `SIGKILL ${OTHER_MEMBER}`])
    expect(decisions.map(({ signal, reason, evidence }) => ({ signal, reason, evidence }))).toEqual([
      { signal: "SIGTERM", reason: "stop requested", evidence: { guardianPid: 7, members: 2 } },
      { signal: "SIGKILL", reason: "stop requested", evidence: { guardianPid: 7, members: 2 } },
    ])
  })

  test("delivers TERM through the process group even when no listing answered", () => {
    // The listing is only needed to find members one by one. TERM needs none:
    // the group reaches every member, and the supervisor reads its own copy as
    // part of the escalation it is running.
    const signals: string[] = []
    const container = ownUnixContainer(libprocProbe({ groups: { [process.pid]: undefined }, signals }))

    container.signal("SIGTERM", { reason: "test" })

    expect(signals).toEqual([`SIGTERM -${process.pid}`])
  })

  test("sends KILL to each proven member and never to the supervisor itself", () => {
    const signals: string[] = []
    const probe = libprocProbe({
      groups: { [process.pid]: [process.pid, MEMBER, OTHER_MEMBER] },
      processes: { [process.pid]: RUNNING(process.pid, process.pid), [MEMBER]: RUNNING(MEMBER, process.pid), [OTHER_MEMBER]: RUNNING(OTHER_MEMBER, process.pid) },
      signals,
    })

    ownUnixContainer(probe).signal("SIGKILL", { reason: "test" })

    expect(signals).toEqual([`SIGKILL ${MEMBER}`, `SIGKILL ${OTHER_MEMBER}`])
  })

  test("sends no KILL while membership is unproven, and stays owned", () => {
    const signals: string[] = []
    const container = ownUnixContainer(libprocProbe({ groups: { [process.pid]: undefined }, signals }))

    container.signal("SIGKILL", { reason: "test" })

    expect(signals).toEqual([])
    expect(container.populated()).toBe(true)
  })
})

/** One row of a scripted Windows process table. Its creation time defaults to
 *  its pid, so an identity is predictable; `query` is the answer a process
 *  that refuses examination gives instead of one. */
interface WindowsRow {
  readonly pid: number
  readonly parentPid: number
  readonly created?: bigint
  readonly query?: "denied" | "unavailable"
}

/** The Windows kernel surface, driven by which pids are currently alive:
 *  `absent` falls out of a pid the table no longer holds. `now` is the
 *  snapshot time, later than every default creation time, and `terminated`
 *  records each kill as the pid and the creation time it was asked for. */
function windowsProbe(
  alive: () => readonly WindowsRow[] | undefined,
  options: { readonly now?: bigint; readonly terminated?: string[] } = {},
): ContainerProbe {
  const query = (pid: number): WindowsProcessQuery => {
    const rows = alive()
    if (rows === undefined) return { kind: "unavailable" }
    const row = rows.find((candidate) => candidate.pid === pid)
    if (row === undefined) return { kind: "absent" }
    return row.query === undefined ? { kind: "process", createdFileTime: row.created ?? BigInt(pid) } : { kind: row.query }
  }
  const windows: WindowsProcessApi = {
    query,
    list: alive,
    now: () => options.now ?? 1_000_000n,
    terminate: (pid, createdFileTime) => {
      options.terminated?.push(`${pid} ${createdFileTime}`)
      return { kind: "ended" }
    },
    workingSetBytes: () => undefined,
    commitBytes: () => undefined,
    runnableThreads: () => undefined,
    environment: () => undefined,
  }
  return { signal: () => {}, groupExists: () => true, windows }
}

/** The termination decisions `run` records. */
function terminationsOf(run: () => void): readonly TerminationDecision[] {
  const decisions: TerminationDecision[] = []
  const stop = onTermination((decision) => { decisions.push(decision) })
  try {
    run()
  } finally {
    stop()
  }
  return decisions
}

describe("Windows tree container", () => {
  const ROOT = { pid: 4242, parentPid: 1 }
  const CHILD = { pid: 4243, parentPid: 4242 }
  const GRANDCHILD = { pid: 4244, parentPid: 4243 }

  test("reads an identity from the creation time, so a recycled pid cannot pass as the original", () => {
    const probe = windowsProbe(() => [ROOT])

    expect(windowsProcessIdentity(4242, probe)).toEqual({ kind: "process", identity: "4242|4242" })
    expect(windowsProcessIdentity(9999, probe)).toEqual({ kind: "absent" })
  })

  test("admits the whole descendant closure, not just the root's children", () => {
    let alive: readonly WindowsRow[] = [ROOT, CHILD, GRANDCHILD]
    const container = windowsContainer(4242, windowsProbe(() => alive), "4242|4242")

    expect(container.populated()).toBe(true)
    // Only the grandchild survives: it was admitted through its parent, so the
    // container it belongs to is still owned.
    alive = [GRANDCHILD]
    expect(container.populated()).toBe(true)
  })

  test("proves an admitted tree gone only when every admitted member is", () => {
    let alive: readonly WindowsRow[] = [ROOT, CHILD]
    const container = windowsContainer(4242, windowsProbe(() => alive), "4242|4242")

    expect(container.populated()).toBe(true)
    alive = []
    expect(container.populated()).toBe(false)
  })

  test("never admits a process created before the parent it names", () => {
    // The row names the root's pid as its parent, but it is older than the
    // root: its parent was an earlier process that held the same number.
    const stranger = { pid: 4000, parentPid: 4242, created: 100n }
    let alive: readonly WindowsRow[] = [ROOT, stranger]
    const container = windowsContainer(4242, windowsProbe(() => alive), "4242|4242")

    expect(container.populated()).toBe(true)
    alive = [stranger]
    expect(container.populated()).toBe(false)
  })

  test("never admits a process created after the snapshot, whose pid was reused after the table was read", () => {
    const late = { pid: 4244, parentPid: 4242, created: 6_000n }
    let alive: readonly WindowsRow[] = [ROOT, CHILD, late]
    const terminated: string[] = []
    const container = windowsContainer(4242, windowsProbe(() => alive, { now: 5_000n, terminated }), "4242|4242")

    const decisions = terminationsOf(() => container.signal("SIGKILL", { reason: "test" }))

    expect(terminated).toEqual(["4242 4242", "4243 4243"])
    expect(decisions.map((decision) => decision.target)).toEqual(["windows tree members 4242,4243"])
    alive = [late]
    expect(container.populated()).toBe(false)
  })

  test("reads a member whose pid another process now holds as gone", () => {
    let alive: readonly WindowsRow[] = [ROOT, CHILD]
    const container = windowsContainer(4242, windowsProbe(() => alive), "4242|4242")

    expect(container.populated()).toBe(true)
    alive = [{ pid: 4243, parentPid: 1, created: 9_999n }]
    expect(container.populated()).toBe(false)
  })

  test("ends each member through the creation time it was admitted with, a descendant that outlived the root included", () => {
    const stranger = { pid: 4000, parentPid: 4242, created: 100n }
    let alive: readonly WindowsRow[] = [ROOT, CHILD, GRANDCHILD, stranger]
    const terminated: string[] = []
    const container = windowsContainer(4242, windowsProbe(() => alive, { terminated }), "4242|4242")

    const decisions = terminationsOf(() => container.signal("SIGTERM", { reason: "test" }))

    // Windows has no graceful signal, so the term is already the kill, and it
    // reaches each member alone rather than a bare pid and whatever is below it.
    expect(terminated).toEqual(["4242 4242", "4243 4243", "4244 4244"])
    expect(decisions.map((decision) => decision.target)).toEqual(["windows tree members 4242,4243,4244"])
    // The root exited on its own and its child kept running: the child is still
    // this container's, so the next signal reaches it without the root.
    alive = [CHILD, stranger]
    terminated.length = 0
    expect(terminationsOf(() => container.signal("SIGKILL", { reason: "test" })).map((decision) => decision.target)).toEqual(["windows tree members 4243"])
    expect(terminated).toEqual(["4243 4243"])
  })

  test.each(["denied", "unavailable"] as const)("keeps a tree owned and ends nothing while a candidate's query answers %s, after the root exited too", (answer) => {
    let alive: readonly WindowsRow[] = [ROOT, { ...CHILD, query: answer }]
    const terminated: string[] = []
    const container = windowsContainer(4242, windowsProbe(() => alive, { terminated }), "4242|4242")

    expect(container.populated()).toBe(true)
    const decisions = terminationsOf(() => {
      container.signal("SIGTERM", { reason: "test" })
      container.signal("SIGKILL", { reason: "test" })
    })

    // A process whose creation time cannot be read cannot be proven to be a
    // descendant, so the tree it may belong to is neither ended nor released,
    // and the root's own exit proves nothing about it.
    expect(terminated).toEqual([])
    expect(decisions).toEqual([])
    expect(container.populated()).toBe(true)
    alive = [{ ...CHILD, query: answer }]
    expect(container.populated()).toBe(true)
    expect(terminationsOf(() => container.signal("SIGKILL", { reason: "test" }))).toEqual([])
    expect(terminated).toEqual([])
  })

  test("admits a candidate once its creation time proves it a descendant, though the root exited meanwhile", () => {
    let alive: readonly WindowsRow[] = [ROOT, { ...CHILD, query: "denied" }]
    const terminated: string[] = []
    const container = windowsContainer(4242, windowsProbe(() => alive, { terminated }), "4242|4242")

    expect(container.populated()).toBe(true)
    alive = [CHILD]
    expect(container.populated()).toBe(true)
    const decisions = terminationsOf(() => container.signal("SIGKILL", { reason: "test" }))
    expect(terminated).toEqual(["4243 4243"])
    expect(decisions.map((decision) => decision.target)).toEqual(["windows tree members 4243"])
  })

  test.each([
    ["exits", []],
    ["answers a creation time earlier than its parent's", [{ pid: 4243, parentPid: 4242, created: 100n }]],
  ] as const)("drops a candidate that %s, so the tree reads empty once the root exited", (_name, rows) => {
    let alive: readonly WindowsRow[] = [ROOT, { ...CHILD, query: "denied" }]
    const container = windowsContainer(4242, windowsProbe(() => alive), "4242|4242")

    expect(container.populated()).toBe(true)
    alive = rows
    expect(container.populated()).toBe(false)
  })

  test("keeps ownership when the table cannot be read at all", () => {
    // A walk that failed proved nothing, and an owner may not surrender a
    // container on no evidence.
    let alive: readonly WindowsRow[] | undefined = [ROOT, CHILD]
    const container = windowsContainer(4242, windowsProbe(() => alive), "4242|4242")

    expect(container.populated()).toBe(true)
    alive = undefined
    expect(container.populated()).toBe(true)
  })

  test("refuses a root whose identity is not the one admitted", () => {
    expect(() => windowsContainer(4242, windowsProbe(() => [ROOT]), "4242|different").populated())
      .toThrow("process identity changed")
  })

  test("reports an absent root as an empty container", () => {
    expect(windowsContainer(4242, windowsProbe(() => [CHILD]), "4242|4242").populated()).toBe(false)
  })

  test("keeps a container owned when no Windows surface can be asked", () => {
    const probe: ContainerProbe = { signal: () => {}, groupExists: () => true }

    expect(windowsProcessIdentity(4242, probe)).toEqual({ kind: "unproven" })
    expect(windowsContainer(4242, probe, "4242|4242").populated()).toBe(true)
  })
})

/** A probe program the running platform ships, with arguments this case only
 *  passes through. What is under test is how a probe is resolved and what
 *  environment it is given, not which process tool a platform provides. */
const PROBE_ARGV: readonly string[] = process.platform === "win32"
  ? ["tasklist", "/FI", "PID eq 4242"]
  : ["pgrep", "-g", "4242"]

describe("probe launches", () => {
  test("runs a probe from an operating system program instead of resolving it on PATH", () => {
    const launch = trustedProbeLaunch(PROBE_ARGV)

    expect(isAbsolute(launch.argv[0] ?? "")).toBe(true)
    expect(fs.existsSync(launch.argv[0] ?? "")).toBe(true)
    expect(launch.argv.slice(1)).toEqual(PROBE_ARGV.slice(1))
  })

  test("fails closed when no trusted directory contains the probe", () => {
    expect(() => trustedProbeLaunch(["powershell.exe"], { trustedDirs: ["/trusted"], exists: () => false }))
      .toThrow("trusted probe program is unavailable: powershell.exe")
  })

  test("asks no process question through a shell host", async () => {
    // One budget covers every probe only because every probe is its own
    // program. A shell-hosted probe costs most of a second in start-up alone,
    // which no budget sized for `ps` can cover; a probe that timed out proved
    // nothing, and nothing proven is what makes the guardian refuse to own a
    // container it was asked to adopt. Windows reads the kernel instead.
    const source = await Bun.file(fileURLToPath(new URL("../../../src/infra/process-container.ts", import.meta.url))).text()

    expect(source).not.toContain("Get-CimInstance")
    expect(source).not.toContain("powershell")
    expect(trustedProbeLaunch(PROBE_ARGV).timeoutMs).toBeGreaterThan(0)
  })

  test("suppresses the console a probe would otherwise allocate", () => {
    // The guardian runs detached, so it holds no console of its own. Windows
    // gives a console program whose parent holds none a fresh console, and on
    // Windows 11 that console is a visible terminal window. A probe asks an
    // internal question and must never open one.
    expect(trustedProbeLaunch(PROBE_ARGV).windowsHide).toBe(true)
  })

  test("gives a probe an environment no inherited PATH can reach into", () => {
    const launch = trustedProbeLaunch(PROBE_ARGV)

    expect(launch.env.PATH?.split(delimiter).every((dir) => isAbsolute(dir))).toBe(true)
    expect(launch.env.PATH).not.toBe(process.env.PATH)
    expect(Object.keys(launch.env)).not.toContain("HOME")
  })
})

/** A procfs the test scripted: stat text per pid, the listing, and the
 *  boot_id read. */
function fakeProcfs(stats: { readonly [pid: number]: ProcRead }, pids?: readonly number[], bootId: ProcRead = { kind: "absent" }): Procfs {
  return {
    readStat: (pid) => stats[pid] ?? { kind: "absent" },
    readEnviron: () => ({ kind: "unreadable" }),
    listPids: () => pids ?? Object.keys(stats).map(Number),
    bootId: () => bootId,
  }
}

const STAT = (pid: number, comm: string, state: string, pgid: number, start = "12345", threads = 1): ProcRead => ({
  kind: "content",
  // /proc/<pid>/stat: pid (comm) state ppid pgrp session tty tpgid flags ...
  // num_threads is field 20 and starttime is field 22.
  text: `${pid} (${comm}) ${state} 1 ${pgid} ${pgid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 ${threads} 0 ${start} 0 0`,
})

function procProbe(procfs: Procfs): ContainerProbe {
  return { signal: () => {}, groupExists: () => true, procfs }
}

describe("procfs container identity", () => {
  test("names the container of a group leader without running any program", () => {
    const probe = procProbe(fakeProcfs({ 4242: STAT(4242, "bash", "S", 4242) }))

    expect(unixContainerIdentity(4242, probe)).toEqual({ kind: "container", identity: "4242 4242 12345" })
  })

  test("parses a command name that contains spaces and parentheses", () => {
    const probe = procProbe(fakeProcfs({ 4242: { kind: "content", text: `4242 (a) b) (c) S 1 4242 4242 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0` } }))

    expect(unixContainerIdentity(4242, probe)).toEqual({ kind: "container", identity: "4242 4242 777" })
  })

  test("reports an absence when the stat entry is gone", () => {
    expect(unixContainerIdentity(4242, procProbe(fakeProcfs({})))).toEqual({ kind: "absent" })
  })

  test("reads an exited process that waits to be reaped as absent", () => {
    const probe = procProbe(fakeProcfs({ 4242: STAT(4242, "bash", "Z", 4242) }))

    expect(unixContainerIdentity(4242, probe)).toEqual({ kind: "absent" })
    expect(unixProcessIdentity(4242, probe)).toEqual({ kind: "absent" })
  })

  test("reads a zombie group leader whose other threads still run as present", () => {
    // The leader's own thread ended, which shows the zombie state, but the
    // process still runs on its other threads.
    const probe = procProbe(fakeProcfs({ 4242: STAT(4242, "bash", "Z", 4242, "12345", 3) }))

    expect(unixContainerIdentity(4242, probe)).toEqual({ kind: "container", identity: "4242 4242 12345" })
    expect(unixProcessIdentity(4242, probe)).toEqual({ kind: "process", identity: "4242 4242 12345" })
  })

  test("proves the container gone when its pid holds a live process that leads no group", () => {
    expect(unixContainerIdentity(4242, procProbe(fakeProcfs({ 4242: STAT(4242, "bash", "S", 100) })))).toEqual({ kind: "other" })
  })

  test("proves nothing about an unreadable entry or a malformed stat", () => {
    const cases: readonly Procfs[] = [
      fakeProcfs({ 4242: { kind: "unreadable" } }),
      fakeProcfs({ 4242: { kind: "content", text: "not a stat line" } }),
      fakeProcfs({ 4242: STAT(4242, "bash", "S", 4242, "12345", Number.NaN) }),
    ]

    for (const procfs of cases) {
      expect(unixContainerIdentity(4242, procProbe(procfs))).toEqual({ kind: "unproven" })
    }
  })
})

describe("procfs container membership", () => {
  test("releases a container whose group holds nothing", () => {
    const probe = procProbe(fakeProcfs({ [STRANGER]: STAT(STRANGER, "other", "S", STRANGER) }))

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("releases a container when the host also runs kernel threads (pgrp 0)", () => {
    // A real Linux host always lists kthreadd and friends. Their stat rows are
    // valid but hold pgrp 0, and treating them as unparseable left every scan
    // unproven, so every owned command burned its whole kill grace.
    const probe = procProbe(fakeProcfs({ [KERNEL_THREAD]: STAT(KERNEL_THREAD, "kthreadd", "S", 0) }))

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("keeps a container that still holds a live member", () => {
    const probe = procProbe(fakeProcfs({ [MEMBER]: STAT(MEMBER, "sleep", "S", 4242) }))

    expect(unixContainer(4242, probe).populated()).toBe(true)
  })

  test("never counts the calling process as a member of its own container", () => {
    const probe = procProbe(fakeProcfs({ [process.pid]: STAT(process.pid, "bun", "S", 4242) }))

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("releases a container whose members all exited and wait to be reaped", () => {
    const probe = procProbe(fakeProcfs({ [MEMBER]: STAT(MEMBER, "sleep", "Z", 4242) }))

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("keeps a container whose zombie member still runs other threads", () => {
    const probe = procProbe(fakeProcfs({ [MEMBER]: STAT(MEMBER, "server", "Z", 4242, "12345", 4) }))

    expect(unixContainer(4242, probe).populated()).toBe(true)
  })

  test("skips an entry that vanished between the listing and the read", () => {
    const probe = procProbe(fakeProcfs({ [MEMBER]: { kind: "absent" } }, [MEMBER]))

    expect(unixContainer(4242, probe).populated()).toBe(false)
  })

  test("keeps a container when the listing failed or a member could not be read", () => {
    const unproven: readonly Procfs[] = [
      { readStat: () => ({ kind: "absent" }), readEnviron: () => ({ kind: "absent" }), listPids: () => undefined, bootId: () => ({ kind: "absent" }) },
      fakeProcfs({ [MEMBER]: { kind: "unreadable" } }, [MEMBER]),
    ]

    for (const procfs of unproven) {
      expect(unixContainer(4242, procProbe(procfs)).populated()).toBe(true)
    }
  })
})

describe("process start stamp", () => {
  test("reads the libproc unique id, the /proc starttime, and the Windows creation time", () => {
    expect(processStart(4242, libprocProbe({ processes: { 4242: RUNNING(4242, 100, 42) } }))).toEqual({ kind: "process", start: "42" })
    expect(processStart(4242, procProbe(fakeProcfs({ 4242: STAT(4242, "bash", "S", 100, "777") })))).toEqual({ kind: "process", start: "777" })
    expect(processStart(4242, windowsProbe(() => [{ pid: 4242, parentPid: 1 }]))).toEqual({ kind: "process", start: "4242" })
  })

  test("reads a free pid and an exit that waits to be reaped as absent, as the identity does", () => {
    const absent: readonly ContainerProbe[] = [
      libprocProbe({}),
      procProbe(fakeProcfs({})),
      procProbe(fakeProcfs({ 4242: STAT(4242, "bash", "Z", 4242) })),
      windowsProbe(() => []),
    ]

    for (const probe of absent) expect(processStart(4242, probe)).toEqual({ kind: "absent" })
  })

  test("proves nothing when the kernel did not answer or no kernel surface can be asked", () => {
    const unanswered: readonly ContainerProbe[] = [
      libprocProbe({ processes: { 4242: { kind: "unavailable" } } }),
      procProbe(fakeProcfs({ 4242: { kind: "unreadable" } })),
      procProbe(fakeProcfs({ 4242: { kind: "content", text: "not a stat line" } })),
      windowsProbe(() => undefined),
      { signal: () => {}, groupExists: () => true },
    ]

    for (const probe of unanswered) expect(processStart(4242, probe)).toEqual({ kind: "unproven" })
  })
})

describe("host boot identity", () => {
  const BOOT = "2507fc47f1c3430b8bc31e1bc9887e94"

  test("reads the macOS boot session and the Linux boot_id as 32 lowercase hex characters", () => {
    expect(bootIdentity(libprocProbe({ boot: { kind: "boot", id: BOOT } }))).toEqual({ kind: "boot", id: BOOT })
    expect(bootIdentity(procProbe(fakeProcfs({}, [], { kind: "content", text: "2507fc47-f1c3-430b-8bc3-1e1bc9887e94\n" })))).toEqual({ kind: "boot", id: BOOT })
  })

  test("reads a kernel that names no boot as none, and Windows, whose creation time is absolute, as none", () => {
    expect(bootIdentity(libprocProbe({ boot: { kind: "none" } }))).toEqual({ kind: "none" })
    expect(bootIdentity(procProbe(fakeProcfs({}, [], { kind: "absent" })))).toEqual({ kind: "none" })
    expect(bootIdentity(windowsProbe(() => []))).toEqual({ kind: "none" })
  })

  test("proves nothing when the boot could not be read or did not decode, or no kernel surface can be asked", () => {
    const unanswered: readonly ContainerProbe[] = [
      libprocProbe({}),
      procProbe(fakeProcfs({}, [], { kind: "unreadable" })),
      procProbe(fakeProcfs({}, [], { kind: "content", text: "not a boot id\n" })),
      { signal: () => {}, groupExists: () => true },
    ]

    for (const probe of unanswered) expect(bootIdentity(probe)).toEqual({ kind: "unproven" })
  })
})
