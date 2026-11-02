import * as fs from "node:fs"

import { windowsContainerName } from "./owned-command-supervisor.js"
import { bunContainerProbe, parseProcStat, type ContainerProbe, type ContainerRef } from "./process-container.js"
import { windowsJobApi, type WindowsJob, type WindowsJobApi } from "./windows-job-object.js"
import { windowsProcessApi, type WindowsProcessApi } from "./windows-process-api.js"

/** A container stops for good only once every member has stopped. A member can
 *  start a child between the listing and its own stop, so the listing repeats
 *  until it finds no member it has not stopped, within this many passes. */
const HOLD_PASSES = 4

/** Processor demand and holds for owned command containers (ARCH-TOOLS-051).
 *
 *  A container is a process group led by its command supervisor on macOS and
 *  Linux, and a job object on Windows. Demand is the number of the container's
 *  threads that are ready to run: running, or waiting for a processor.
 *  Processor time cannot serve, because on a saturated machine it measures a
 *  container's share, and the shares of every container add up to the
 *  machine whatever they ask for. A hold leaves the supervisor running so that
 *  it can still answer its owner, end the container, and enforce the
 *  command's deadline. */
export interface ContainerProcessor {
  /** The runnable threads of each given container right now. A container the
   *  kernel did not answer for is absent. */
  demand(containers: readonly ContainerRef[]): ReadonlyMap<string, number>
  /** Stops every member except the supervisor. False when the members could
   *  not be listed or kept starting new ones, in which case whatever was
   *  stopped is resumed again. */
  hold(container: ContainerRef): boolean
  /** Resumes every member this reader stopped, or every member except the
   *  supervisor when this reader stopped none, which also undoes a hold that
   *  an earlier reader left behind. */
  release(container: ContainerRef): void
}

/** What one platform answers for a container. */
export interface ProcessorPlatform {
  demand(containers: readonly ContainerRef[]): ReadonlyMap<string, number>
  /** The container's members, the supervisor included, or nothing when the
   *  listing did not answer. */
  members(container: ContainerRef): readonly number[] | undefined
  /** False when the member could not be stopped. */
  stop(container: ContainerRef, pid: number): boolean
  /** Resumes `stopped`, the members this reader stopped in `container`. */
  resume(container: ContainerRef, stopped: readonly number[]): void
}

export function containerProcessor(platform: ProcessorPlatform | undefined = hostProcessorPlatform()): ContainerProcessor {
  const stopped = new Map<string, number[]>()
  return {
    demand: (containers) => platform?.demand(containers) ?? new Map(),
    hold(container) {
      if (platform === undefined) return false
      const done: number[] = []
      for (let pass = 0; pass < HOLD_PASSES; pass += 1) {
        const members = platform.members(container)
        if (members === undefined) break
        const fresh = members.filter((pid) => pid !== container.pid && !done.includes(pid))
        if (fresh.length === 0) {
          stopped.set(container.token, done)
          return true
        }
        // A member that cannot be stopped, such as one that changed its
        // user, keeps running, so the container is not held at all.
        for (const pid of fresh) {
          if (!platform.stop(container, pid)) {
            platform.resume(container, done)
            return false
          }
          done.push(pid)
        }
      }
      platform.resume(container, done)
      return false
    },
    release(container) {
      if (platform === undefined) return
      const done = stopped.get(container.token) ?? platform.members(container)?.filter((pid) => pid !== container.pid) ?? []
      platform.resume(container, done)
      stopped.delete(container.token)
    },
  }
}

function hostProcessorPlatform(): ProcessorPlatform | undefined {
  if (process.platform === "win32") {
    const jobs = windowsJobApi()
    const processes = windowsProcessApi()
    return jobs === undefined || processes === undefined ? undefined : windowsProcessorPlatform(jobs, processes)
  }
  return bunContainerProbe.procfs || bunContainerProbe.libproc ? posixProcessorPlatform(bunContainerProbe) : undefined
}

/** A process group. */
export function posixProcessorPlatform(
  probe: ContainerProbe,
  signal: (pid: number, name: "SIGSTOP" | "SIGCONT") => boolean = signalPid,
  linuxRunnableThreads: (pid: number) => number = procRunnableThreads,
): ProcessorPlatform {
  const listMembers = memberReader(probe)
  const runnable = probe.libproc ? (pid: number) => probe.libproc?.runnableThreads(pid) ?? 0 : linuxRunnableThreads
  return {
    demand(containers) {
      const groups = listMembers(containers.map((container) => container.pid))
      const demand = new Map<string, number>()
      for (const container of containers) {
        const members = groups.get(container.pid)
        if (members === undefined) continue
        let threads = 0
        for (const pid of members) threads += runnable(pid)
        demand.set(container.token, threads)
      }
      return demand
    },
    members: (container) => listMembers([container.pid]).get(container.pid),
    stop: (_container, pid) => signal(pid, "SIGSTOP"),
    // Continuing the whole group also reaches a member stopped by anything
    // else, which a held command never wants left stopped.
    resume: (container) => { signal(-container.pid, "SIGCONT") },
  }
}

/** A job object. Each use opens the job by name and closes it again: a handle
 *  kept here would keep the job, and so the command, alive after its owners
 *  closed theirs. */
export function windowsProcessorPlatform(jobs: WindowsJobApi, processes: Pick<WindowsProcessApi, "runnableThreads">): ProcessorPlatform {
  const withJob = <T>(container: ContainerRef, use: (job: WindowsJob) => T): T | undefined => {
    const opened = jobs.open(windowsContainerName(container.token))
    if (opened.kind !== "opened") return undefined
    try {
      return use(opened.job)
    } finally {
      opened.job.close()
    }
  }
  return {
    demand(containers) {
      const demand = new Map<string, number>()
      if (containers.length === 0) return demand
      // One snapshot of the system answers every container.
      const runnable = processes.runnableThreads()
      if (runnable === undefined) return demand
      for (const container of containers) {
        const members = withJob(container, (job) => job.pids())
        if (members === undefined) continue
        let threads = 0
        for (const pid of members) threads += runnable.get(pid) ?? 0
        demand.set(container.token, threads)
      }
      return demand
    },
    members: (container) => withJob(container, (job) => job.pids()),
    stop: (container, pid) => withJob(container, (job) => job.suspend(pid)) === true,
    resume: (container, stopped) => { withJob(container, (job) => { for (const pid of stopped) job.resume(pid) }) },
  }
}

/** Lists the members of each process group. A group whose listing did not
 *  answer is absent. */
function memberReader(probe: ContainerProbe): (pgids: readonly number[]) => ReadonlyMap<number, readonly number[]> {
  if (probe.procfs) {
    const procfs = probe.procfs
    // One `/proc` scan answers every group at once.
    return (pgids) => {
      const wanted = new Set(pgids)
      const found = new Map<number, number[]>()
      if (wanted.size === 0) return found
      const pids = procfs.listPids()
      if (pids === undefined) return found
      for (const pgid of wanted) found.set(pgid, [])
      for (const pid of pids) {
        const read = procfs.readStat(pid)
        if (read.kind !== "content") continue
        const stat = parseProcStat(read.text)
        if (stat !== undefined && wanted.has(stat.pgid)) found.get(stat.pgid)?.push(pid)
      }
      return found
    }
  }
  if (probe.libproc) {
    const libproc = probe.libproc
    return (pgids) => {
      const found = new Map<number, readonly number[]>()
      for (const pgid of pgids) {
        const listed = libproc.group(pgid)
        if (listed !== undefined) found.set(pgid, listed)
      }
      return found
    }
  }
  return () => new Map()
}

/** Counts the threads of `pid` in state R, which Linux uses for both running
 *  and waiting for a processor. A process that exited counts none. */
function procRunnableThreads(pid: number): number {
  try {
    let runnable = 0
    for (const thread of fs.readdirSync(`/proc/${pid}/task`)) {
      try {
        if (parseProcStat(fs.readFileSync(`/proc/${pid}/task/${thread}/stat`, "utf8"))?.state === "R") runnable += 1
      } catch {
        // A thread that ended since the listing is not runnable.
      }
    }
    return runnable
  } catch {
    return 0
  }
}

/** False only when the kernel refused the signal. A member that exited
 *  since the listing needs no signal. */
function signalPid(pid: number, name: "SIGSTOP" | "SIGCONT"): boolean {
  try {
    process.kill(pid, name)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
  }
}
