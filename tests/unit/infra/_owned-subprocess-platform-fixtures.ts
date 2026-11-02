import { join } from "node:path"

import type { ProcessGroupHost, ProcessHost } from "../../../src/infra/owned-subprocess-backend.js"
import { decodeSupervisorWord, writeOutcomeRecord, type CommandHandover } from "../../../src/infra/command-handover.js"
import type { DarwinProcessQuery } from "../../../src/infra/darwin-process-api.js"
import type { WindowsProcessApi } from "../../../src/infra/windows-process-api.js"
import type { WindowsJob, WindowsJobApi } from "../../../src/infra/windows-job-object.js"

// The surfaces a fake host builds, read from the host and job contracts the
// backends accept.
type JobObjectHost = Extract<ProcessHost, { readonly containers: "job-object" }>
type HostSpawnOptions = Parameters<ProcessHost["spawn"]>[1]
type HostChild = ReturnType<ProcessHost["spawn"]>
type WindowsJobLimits = NonNullable<Parameters<WindowsJobApi["create"]>[1]>

export interface RecordedSpawn {
  readonly argv: readonly string[]
  readonly options: HostSpawnOptions
}

export const POLICY = { killGraceMs: 0, guardianPid: 999, token: "owned:test", priority: "background" } as const

export const RUNNING = (pid: number, pgid: number): DarwinProcessQuery => ({ kind: "process", pgid, ppid: 1, identity: `${pid} ${pgid} 7`, start: "7" })

/** The identity a live guardian leading its own group has. Every unix launch
 *  reads it before it starts a container. */
export const GUARDIAN_IDENTITY = "999 999 7"

/** What the fake kernel answers: one query per pid, and the listing of each
 *  process group. A pid it does not know is absent, and a group it does not
 *  know is empty. */
export interface FakeKernel {
  readonly query?: (pid: number) => DarwinProcessQuery
  readonly group?: (pgid: number) => readonly number[] | undefined
}

export const GUARDIAN_KERNEL: FakeKernel = { query: (pid) => (pid === 999 ? RUNNING(999, 999) : { kind: "absent" }) }

/** Which pids the Windows kernel surface reports.
 *
 *  A healthy host by default: the guardian every launch reads before it starts
 *  a container, and the process the fake spawn hands back. A case that wants a
 *  host which cannot answer says so. */
interface WindowsFake {
  readonly rows?: readonly { readonly pid: number; readonly parentPid: number }[]
  readonly created?: { readonly [pid: number]: bigint }
  /** The whole table read failed, which proves nothing about any pid. */
  readonly tableUnreadable?: boolean
}

const LIVE_ROWS: readonly { readonly pid: number; readonly parentPid: number }[] = [
  { pid: 999, parentPid: 1 },
  { pid: 4242, parentPid: 999 },
]
const LIVE_CREATED = { 999: 999n, 4242: 4242n } satisfies { readonly [pid: number]: bigint }

function windowsSurface(fake: WindowsFake): WindowsProcessApi {
  const rows = fake.rows ?? LIVE_ROWS
  const created: { readonly [pid: number]: bigint } = fake.created ?? LIVE_CREATED
  return {
    query(pid) {
      if (fake.tableUnreadable === true) return { kind: "unavailable" }
      if (!rows.some((row) => row.pid === pid)) return { kind: "absent" }
      const when = created[pid]
      return when === undefined ? { kind: "unavailable" } : { kind: "process", createdFileTime: when }
    },
    list: () => (fake.tableUnreadable === true ? undefined : rows),
    // A job-object launch never walks a tree, so it never reads the time or
    // ends a process by pid.
    now: () => { throw new Error("a job-object launch read the time") },
    terminate: () => { throw new Error("a job-object launch ended a process by pid") },
    workingSetBytes: () => undefined,
    commitBytes: () => undefined,
    runnableThreads: () => undefined,
    environment: () => undefined,
  }
}

/** How the fake job API behaves for one case. */
interface JobScript {
  readonly refuseCreate?: boolean
  readonly refuseAdmit?: boolean
  /** A process the container still holds after the payload is gone. */
  readonly survivor?: number
  readonly unreadableMembership?: boolean
  /** The error every open by name fails with, for a container this side may
   *  not open. */
  readonly openFailure?: number
}

interface FakeJob {
  readonly members: number[]
  readonly limits: WindowsJobLimits
  terminated: boolean
  forced: boolean
  /** Handles still open on the job. Windows ends a job whose last handle
   *  closes, because every Flywheel job kills its members on close. */
  handles: number
  closed: boolean
}

/** Job objects as bookkeeping, so container ownership is testable on a host
 *  that has no job objects. */
function fakeJobs(script: JobScript) {
  const created = new Map<string, FakeJob>()
  const opened: string[] = []
  const order: string[] = []

  const handle = (name: string, record: FakeJob): WindowsJob => {
    let open = true
    return {
    admit(pid) {
      order.push(`admit ${pid}`)
      if (script.refuseAdmit === true) return false
      record.members.push(pid)
      if (script.survivor !== undefined) record.members.push(script.survivor)
      return true
    },
    letChildrenLeave() {
      order.push(`let children leave ${name}`)
      return true
    },
    terminate() {
      order.push(`terminate ${name}`)
      record.terminated = true
      // A survivor outlives the first kill, so a case can tell settling on the
      // container apart from settling on the payload.
      record.members.length = script.survivor !== undefined && !record.forced ? 1 : 0
      record.forced = true
    },
    pids: () => (script.unreadableMembership === true || record.closed ? undefined : [...record.members]),

    suspend: () => false,
    resume: () => false,
    close() {
      if (!open) return
      open = false
      order.push(`close ${name}`)
      record.handles -= 1
      if (record.handles > 0) return
      record.closed = true
      record.members.length = 0
    },
    }
  }

  const api: WindowsJobApi = {
    create(name, limits = {}) {
      order.push(`create ${name}`)
      if (script.refuseCreate === true || created.has(name)) return undefined
      const record: FakeJob = { members: [], limits, terminated: false, forced: false, handles: 1, closed: false }
      created.set(name, record)
      return handle(name, record)
    },
    open(name) {
      opened.push(name)
      if (script.openFailure !== undefined) return { kind: "unavailable", code: script.openFailure }
      const record = created.get(name)
      if (record === undefined || record.closed) return { kind: "not-found" }
      record.handles += 1
      return { kind: "opened", job: handle(name, record) }
    },
  }
  return { api, created, opened, order }
}

export function recordingHost(
  kernel: FakeKernel = {},
  script: WindowsFake & JobScript & { readonly exitCode?: number; readonly groupGone?: boolean; readonly supervisorRuns?: boolean; readonly neverConnects?: boolean; readonly diagnostics?: ReadableStream<Uint8Array> } = {},
) {
  const jobs = fakeJobs(script)
  const spawns: RecordedSpawn[] = []
  const calls: string[] = []
  const said: string[] = []
  const channels: string[] = []
  const closedAfter: (Promise<void> | undefined)[] = []
  let exitSupervisor: () => void = () => {}
  const supervisorExited = script.supervisorRuns === true ? new Promise<number>((resolve) => { exitSupervisor = () => { resolve(0) } }) : Promise.resolve(0)
  // One set of recorders, and the two hosts a platform can be. Which host a
  // case passes is which platform it is about; nothing can pair a job-object
  // backend with a host that holds no jobs.
  const base: Omit<ProcessGroupHost, "containers" | "writeFd" | "closeFd" | "readFd"> = {
    windows: windowsSurface(script),
    spawn(argv, options): HostChild {
      spawns.push({ argv, options })
      return {
        pid: 4242,
        controlFd: options.control ? 9 : undefined,
        stdin: undefined,
        // A running supervisor's output pipe stays open for as long as it
        // runs, as a real one does.
        stdout: script.supervisorRuns === true ? new ReadableStream<Uint8Array>() : undefined,
        stderr: undefined,
        exited: supervisorExited,
        exitCode: script.exitCode ?? null,
        signalCode: null,
        unref: () => { calls.push("unref") },
      }
    },
    signal(pid, signal) { calls.push(`kill ${signal} ${pid}`) },
    groupExists: () => script.groupGone !== true,
    libproc: {
      query(pid) {
        calls.push(`query ${pid}`)
        return kernel.query?.(pid) ?? { kind: "absent" }
      },
      group(pgid) {
        calls.push(`group ${pgid}`)
        return kernel.group === undefined ? [] : kernel.group(pgid)
      },
      pids: () => undefined,
      children: () => undefined,
      executable: () => ({ kind: "unavailable" }),
      processArguments: () => undefined,
      environment: () => undefined,
      bootSession: () => undefined,
      footprintBytes: () => undefined,
      runnableThreads: () => undefined,
    },
  }
  const posix: ProcessGroupHost = {
    ...base,
    containers: "process-group",
    writeFd(fd, text) { calls.push(`write ${fd} ${JSON.stringify(text)}`) },
    closeFd(fd) { calls.push(`close ${fd}`) },
    readFd: () => script.diagnostics ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
  }
  const windows: JobObjectHost = {
    ...base,
    containers: "job-object",
    jobs: jobs.api,
    openControlChannel(name) {
      channels.push(name)
      // A pipe no supervisor ever connected to ends only when this side
      // learns that none will, as the real listener's does.
      let unconnected: ReadableStreamDefaultController<Uint8Array> | undefined
      const diagnostics = script.neverConnects === true ? new ReadableStream<Uint8Array>({ start(controller) { unconnected = controller } }) : script.diagnostics
      return {
        diagnostics,
        say: (word) => { said.push(word.trim()) },
        supervisorExited: () => { unconnected?.close(); unconnected = undefined },
        close: (after) => { closedAfter.push(after); said.push("<closed>") },
      }
    },
  }
  return { posix, windows, spawns, calls, jobs, said, channels, closedAfter, exitSupervisor: () => { exitSupervisor() } }
}

/** A handover whose record lives in `dir`, a directory the case owns. */
export function handoverTo(dir: string, channel: string): CommandHandover {
  return { channel, recordPath: join(dir, "command.outcome.json"), userDataRoot: "/scratch/a/.flywheel" }
}

/** Acts as the supervisor that took the handover word: it writes its
 *  acknowledgement once the word has been said. */
export async function acknowledgeOnceSaid(said: () => readonly string[], handover: CommandHandover): Promise<void> {
  while (!said().some((word) => decodeSupervisorWord(word.trim()).kind === "handover")) await Bun.sleep(1)
  writeOutcomeRecord(handover.recordPath, { version: 1, handedOverAtMs: Date.now() })
}
