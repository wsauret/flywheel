import { bunContainerProbe, parseProcStat, procExited, processStart, unixProcessFacts, type ContainerProbe, type ManagedContainer } from "./process-container.js"

/** The mark that every process an owned command starts carries, so that
 *  ending the command reaches the processes that left its process group.
 *
 *  On macOS and Linux a process group holds a command's processes only while
 *  they stay in it: `setsid`, `set -m`, and a double fork each leave it, and
 *  a process whose parent exits is no longer a child of anything the command
 *  runs. The environment does not change that way. Each owned launch names
 *  its container in this variable, and every process the command starts
 *  inherits it, in whatever group or session it runs. The kernel keeps the
 *  environment that each process started with, so the mark is read from the
 *  kernel and never from a program.
 *
 *  A launch that starts an owned container of its own names that container
 *  instead. Strict launches also retain ancestor tokens so an outer end waits
 *  for nested owned work. A persistent process or guardian carries neither
 *  its starter's mark nor strict context.
 *
 *  macOS withholds the environment of its own platform programs, such as
 *  `sleep` and `tail`, even from their user. Such a process belongs to the
 *  command while its parent does, which the kernel answers until the parent
 *  exits. A process that clears its environment, and a platform program whose
 *  parent exited before the command ended, are the ways out that remain.
 *
 *  Windows uses its job objects for containment and the strict context for
 *  propagation to nested guarded launches.
 *
 *  Because the mark has these ways out, a decision that needs proof that a
 *  settled command left nothing running asks `mayHaveSurvivingDescendant`,
 *  which reads parents and starts rather than marks. */
export const CONTAINER_MARK_VARIABLE = "FLYWHEEL_CONTAINER"
export const STRICT_DESCENDANT_SETTLEMENT_VARIABLE = "FLYWHEEL_STRICT_DESCENDANT_SETTLEMENT"

/** Requires descendant settlement for this process's subsequent guarded launches.
 *  The requirement crosses owned process boundaries, including explicit launch
 *  environments. Persistent processes and guardians remain outside this policy.
 *  Call before creating launchers. Repeated calls preserve inherited ancestry. */
export function enableStrictDescendantSettlement(): void {
  process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] ??= "/"
}

/** Whether this process inherited or explicitly enabled strict settlement. */
export function strictDescendantSettlementRequired(): boolean {
  return process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] !== undefined
}

/** The environment a launch starts its process with. */
interface Environment {
  readonly [name: string]: string | undefined
}

/** `env`, or this process's environment, with the mark of container `token`. */
export function markedEnvironment(env: Environment | undefined, token: string, strict = strictDescendantSettlementRequired()): Environment {
  // Encoded tokens separated by slashes retain every strict ancestor when a
  // nested launch replaces its ordinary mark. An outer end can therefore wait
  // for nested detached work even when it ends that work's immediate owner.
  const ancestry = process.env[STRICT_DESCENDANT_SETTLEMENT_VARIABLE] ?? "/"
  return {
    ...(env ?? process.env),
    [CONTAINER_MARK_VARIABLE]: token,
    ...(strict ? { [STRICT_DESCENDANT_SETTLEMENT_VARIABLE]: `${ancestry}${encodeURIComponent(token)}/` } : {}),
  }
}

/** `env`, or this process's environment, without a container mark: for a
 *  process that outlives the container that started it. */
export function unmarkedEnvironment(env: Environment | undefined): Environment {
  return { ...(env ?? process.env), [CONTAINER_MARK_VARIABLE]: undefined, [STRICT_DESCENDANT_SETTLEMENT_VARIABLE]: undefined }
}

/** The mark this process carries, when an owned launch started it. */
export function ownContainerMark(): string | undefined {
  const mark = process.env[CONTAINER_MARK_VARIABLE]
  return mark === undefined || mark.length === 0 ? undefined : mark
}

/** One read of the process table, from the platform's kernel surface. */
interface ProcessTable {
  readonly pids: readonly number[]
  group(pgid: number): readonly number[]
  children(pid: number): readonly number[]
  environment(pid: number): readonly string[] | undefined
}

function readTable(probe: ContainerProbe): ProcessTable | undefined {
  const procfs = probe.procfs
  if (procfs !== undefined) {
    const pids = procfs.listPids()
    if (pids === undefined) return undefined
    const children = new Map<number, number[]>()
    const groups = new Map<number, number[]>()
    for (const pid of pids) {
      const read = procfs.readStat(pid)
      const stat = read.kind === "content" ? parseProcStat(read.text) : undefined
      // A process that exited and waits to be reaped holds nothing, and its
      // environment reads empty, as a withheld one does.
      if (stat === undefined || procExited(stat)) continue
      children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), pid])
      groups.set(stat.pgid, [...(groups.get(stat.pgid) ?? []), pid])
    }
    return {
      pids,
      group: (pgid) => groups.get(pgid) ?? [],
      children: (pid) => children.get(pid) ?? [],
      environment(pid) {
        const read = procfs.readEnviron(pid)
        return read.kind === "content" ? read.text.split("\0").filter((entry) => entry.length > 0) : undefined
      },
    }
  }
  const libproc = probe.libproc
  const pids = libproc?.pids()
  if (libproc === undefined || pids === undefined) return undefined
  return {
    pids,
    group: (pgid) => libproc.group(pgid) ?? [],
    children: (pid) => libproc.children(pid) ?? [],
    environment: (pid) => libproc.environment(pid),
  }
}

type MarkReading = "marked" | "unmarked" | "withheld"

/** What the environment of one process says about a mark. An environment
 *  that cannot be read, or reads as empty, was withheld: every process an
 *  owned launch starts has at least the mark, and macOS returns a platform
 *  program's arguments without its environment. */
function markReading(environment: readonly string[] | undefined, entry: string, strictEntry: string): MarkReading {
  if (environment === undefined || environment.length === 0) return "withheld"
  return environment.includes(entry) || environment.some((value) => value.startsWith(`${STRICT_DESCENDANT_SETTLEMENT_VARIABLE}=`) && value.includes(strictEntry)) ? "marked" : "unmarked"
}

/** Every process other than this one that the command marked `mark`, whose
 *  process group is `pgid`, started, or nothing when the process table did
 *  not answer.
 *
 *  A process belongs to the command when its environment carries the mark,
 *  in whatever group it runs, and when the kernel withholds its environment
 *  and its parent belongs to the command or to its group. A process whose
 *  environment carries no matching mark or strict ancestor is not the
 *  command's: another owner holds it, or it must outlive the command.
 *
 *  With `throughGroup` false, group `pgid` is not the command's, so a child of
 *  one of its members belongs to that group's owner and is never reached. */
function markedProcesses(mark: string, pgid: number, probe: ContainerProbe, throughGroup: boolean): readonly number[] | undefined {
  const table = readTable(probe)
  if (table === undefined) return undefined
  const entry = `${CONTAINER_MARK_VARIABLE}=${mark}`
  const strictEntry = `/${encodeURIComponent(mark)}/`
  const readings = new Map<number, MarkReading>()
  const reading = (pid: number): MarkReading => {
    const known = readings.get(pid)
    if (known !== undefined) return known
    const read = markReading(table.environment(pid), entry, strictEntry)
    readings.set(pid, read)
    return read
  }
  const members = new Set(table.pids.filter((pid) => pid !== process.pid && reading(pid) === "marked"))
  const parents = throughGroup ? [...members, ...table.group(pgid)] : [...members]
  for (let parent = parents.pop(); parent !== undefined; parent = parents.pop()) {
    for (const child of table.children(parent)) {
      if (child === process.pid || members.has(child) || reading(child) !== "withheld") continue
      members.add(child)
      parents.push(child)
    }
  }
  return [...members]
}

/** What the environments of a process group's members say about the launch
 *  that a mark names. `marked`: a member carries the mark. `unmarked`: the
 *  group has members, and each shows an environment without the mark.
 *  `empty`: the group has no member. `unproven`: the process table did not
 *  answer. */
export type GroupMarkReading = "marked" | "unmarked" | "empty" | "unproven"

/** Whether process group `pgid` still holds the launch marked `mark`, read
 *  from its members' environments, or undefined where the kernel cannot tell.
 *
 *  Every process an owned launch starts carries the mark, so a group whose
 *  members all show an environment without it is not the launch's: a process
 *  that took the group's pid after the group emptied leads it. Only Linux can
 *  answer that, and only for a group whose every member shows its
 *  environment. It withholds the environment of a program that cannot be
 *  dumped or that runs set-user-ID, such as `sudo`, and macOS withholds the
 *  environment of its platform programs, such as `/bin/bash`, even from their
 *  user. A withheld environment can be the launch's, so it proves nothing. */
export function groupMarkReading(mark: string, pgid: number, probe: ContainerProbe = bunContainerProbe): GroupMarkReading | undefined {
  if (probe.procfs === undefined) return undefined
  const table = readTable(probe)
  if (table === undefined) return "unproven"
  const members = table.group(pgid).filter((pid) => pid !== process.pid)
  if (members.length === 0) return "empty"
  const entry = `${CONTAINER_MARK_VARIABLE}=${mark}`
  const strictEntry = `/${encodeURIComponent(mark)}/`
  const readings = new Set(members.map((pid) => markReading(table.environment(pid), entry, strictEntry)))
  if (readings.has("marked")) return "marked"
  return readings.has("withheld") ? undefined : "unmarked"
}

/** What ending a command reaches on macOS or Linux: `group`, the container
 *  that process group `pgid` is, and every process the command started
 *  outside it (see `markedProcesses`).
 *
 *  Each signal reads the process table again, before it signals, so a process
 *  that left the group since the last signal is reached too, and so is a
 *  child of one whose parent still runs. A process in the group is left to the
 *  group's own signal, so no process receives one signal twice. A process
 *  outside it is remembered with its start stamp, which a recycled pid cannot
 *  share, and it holds the container until a probe proves it gone: no process
 *  at its pid, or a process with another start. Only a process whose start is
 *  proven the same is signalled.
 *
 *  This is for an owner that ends the command: a stop, an end, a guardian's
 *  sweep, or strict natural-exit settlement. Default natural exit settles the
 *  group alone, so an intentionally detached server keeps running. */
export function markedContainer(group: ManagedContainer, pgid: number, mark: string, probe: ContainerProbe = bunContainerProbe): ManagedContainer {
  return reachingOutside(group, pgid, mark, probe)
}

/** What ending a command reaches once process group `pgid` is proven not to
 *  be its own (see `groupMarkReading`): only the processes it marked outside
 *  that group. Neither the group nor a child of its members is signalled,
 *  because another owner holds them. */
export function markedOutsideGroup(pgid: number, mark: string, probe: ContainerProbe = bunContainerProbe): ManagedContainer {
  return reachingOutside(undefined, pgid, mark, probe)
}

/** Whether a process that a settled command started may still run.
 *
 *  The caller has seen the command's `exited` settle, and `launch.start` is
 *  the `processStart` stamp of the process its launch started, read while
 *  that process ran. `false` proves that no process the command started
 *  still runs. `true` proves nothing, and a false positive is acceptable.
 *  Work handed to a service, such as `launchctl`, `open`, `systemd-run`, or
 *  WMI, is not a descendant and is outside its reach.
 *
 *  - Windows: `false`. `exited` settles only when the job is empty, and the
 *    job holds every descendant.
 *  - macOS: reads of the process table, of every user, because a `sudo`
 *    child runs as root, until one read is settled (see the scan loop).
 *    Every descendant started after the launch. Once `exited` settled, no
 *    ancestor of a descendant that is older than the launch still runs, and
 *    macOS has no subreaper, so the parents of a surviving descendant reach
 *    launchd (pid 1) through processes newer than
 *    the launch. The kernel's unique id grows through one boot, so a newer
 *    process has a larger start. A process that launchd started during the
 *    command reads the same way, and a table or chain query that does not
 *    answer proves nothing.
 *  - Linux, when the launch ran as the first process of its own process
 *    namespace (`launch.pidNamespace`): `false`. That namespace's first
 *    process stays in the command's process group, which `exited` proved
 *    empty, and the kernel ends and reaps every process of a namespace
 *    before its first process finishes exiting.
 *  - Linux otherwise: `true`. A subreaper adopts orphans, `/proc` does not
 *    show which processes are subreapers, and an orphan that cleared its
 *    environment carries no mark, so no reading separates it from an
 *    unrelated child of an older process.
 *  - No kernel surface: `true`. */
export function mayHaveSurvivingDescendant(launch: { readonly start: string; readonly pidNamespace: boolean }, probe: ContainerProbe = bunContainerProbe): boolean {
  if (probe.windows !== undefined) return false
  if (probe.procfs !== undefined) return !launch.pidNamespace
  const libproc = probe.libproc
  if (libproc === undefined) return true
  const launched = BigInt(launch.start)
  const walk = (pid: number): "survivor" | "absent" | "older" => {
    let current = libproc.query(pid)
    if (current.kind === "absent") return "absent"
    while (current.kind === "process" && BigInt(current.start) > launched) {
      if (current.ppid === 1) return "survivor"
      current = libproc.query(current.ppid)
    }
    return current.kind === "process" ? "older" : "survivor"
  }
  // A listed process that is gone at its query may have started a child after
  // the listing, which the listing cannot name. A later listing names that
  // child, so a scan proves the answer only when every pid it found gone was
  // already gone in the scan before it: such a process forked nothing after
  // that earlier query. The first scan proves it only with no pid gone. A
  // zombie that nobody reaps stays gone in every scan, so it does not keep
  // the answer open.
  let gone = new Set<number>()
  for (let scan = 0; scan < SURVIVOR_SCANS; scan++) {
    const pids = libproc.pids()
    if (pids === undefined) return true
    const absent = new Set<number>()
    for (const pid of pids) {
      const found = walk(pid)
      if (found === "survivor") return true
      if (found === "absent") absent.add(pid)
    }
    if (isSubset(absent, gone)) return false
    gone = absent
  }
  return true
}

/** The scans of the macOS process table after which a table that keeps
 *  changing proves nothing. */
const SURVIVOR_SCANS = 4

function isSubset(set: ReadonlySet<number>, of: ReadonlySet<number>): boolean {
  for (const value of set) if (!of.has(value)) return false
  return true
}

function reachingOutside(group: ManagedContainer | undefined, pgid: number, mark: string, probe: ContainerProbe): ManagedContainer {
  const escaped = new Map<number, string>()
  let observed = false
  const observe = (): void => {
    observed = true
    for (const pid of markedProcesses(mark, pgid, probe, group !== undefined) ?? []) {
      const facts = unixProcessFacts(pid, probe)
      if (facts.kind === "facts" && facts.pgid !== pgid) escaped.set(pid, facts.start)
    }
  }
  /** The remembered processes still running: `proven` with their start
   *  proven the same, `unproven` with a start that did not answer. A process
   *  proven gone is forgotten. */
  const running = () => {
    const proven: number[] = []
    let unproven = 0
    for (const [pid, start] of escaped) {
      const now = processStart(pid, probe)
      if (now.kind === "unproven") unproven += 1
      else if (now.kind === "process" && now.start === start) proven.push(pid)
      else escaped.delete(pid)
    }
    return { proven, unproven }
  }
  return {
    signal: (signal, cause) => {
      observe()
      group?.signal(signal, cause)
      for (const pid of running().proven) probe.signal(pid, signal, pgid, cause)
    },
    populated: () => {
      if (!observed) observe()
      if (group?.populated() === true) return true
      const left = running()
      return left.proven.length > 0 || left.unproven > 0
    },
  }
}
