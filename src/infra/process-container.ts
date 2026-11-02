import * as fs from "node:fs"
import { delimiter, extname, join } from "node:path"

import { darwinProcess, type DarwinProcessApi } from "./darwin-process-api.js"
import type { ProcessDiagnosticPayload } from "./process-diagnostic-reader.js"
import { windowsProcessApi, type WindowsProcessApi, type WindowsProcessQuery } from "./windows-process-api.js"
import type { WindowsJob } from "./windows-job-object.js"
import { redactSecrets } from "./redact-secrets.js"
import { DeadlineExceeded, withDeadline } from "./with-deadline.js"
import { waitForStopHolds, type StopHold } from "./stop-hold.js"

/** Why Flywheel ends a container: the trigger, and the facts it rested on
 *  where the trigger has some, such as the guardian a proof found gone.
 *  `evidence` holds only identities, names, counts and durations, never
 *  content. */
export interface TerminationCause {
  readonly reason: string
  readonly evidence?: { readonly [field: string]: string | number }
}

/** One decision by Flywheel to signal a container: which process decided,
 *  which container it addressed, what the signal reached, and its cause.
 *  `container` names the container the same way on every platform: the pid
 *  of the process that leads it. That is the command supervisor of an owned
 *  launch, the leader of a POSIX process group, or the root of a Windows
 *  tree, and a lone process is its own container. `target` is what the
 *  signal reached: a pid, a negative pid for a whole POSIX group, or a
 *  description of Windows job members. `caller` is a bounded stack of the
 *  call site, which names the decision's code path. */
export interface TerminationDecision extends TerminationCause {
  readonly senderPid: number
  readonly container: number
  readonly target: number | string
  readonly signal: string
  readonly caller?: string
}

const terminationListeners = new Set<(decision: TerminationDecision) => void>()

/** Records one termination decision just before its signal is sent. Records
 *  only process identities, the cause with its evidence, and a bounded call
 *  site, never command arguments. In a process that listens through
 *  `onTermination`, the listeners get the decision. Anywhere else it goes to
 *  stderr as one diagnostic record, which the process that launched this one
 *  drains and reads with `watchContainerTerminations`. */
export function recordTermination(request: Omit<TerminationDecision, "senderPid" | "caller">): void {
  const caller = new Error("termination requested").stack?.split("\n").slice(2, 6).join("\n")
  const decision: TerminationDecision = { senderPid: process.pid, ...request, ...(caller === undefined ? {} : { caller }) }
  if (terminationListeners.size > 0) {
    for (const listener of terminationListeners) {
      try {
        listener(decision)
      } catch {
        // A diagnostic listener must never keep the signal from being sent.
      }
    }
    return
  }
  // Log depends on container probes through private-path setup. Standalone
  // guardians must also record their last signal before the host disappears.
  try {
    fs.writeSync(2, redactSecrets(terminationRecordLine(decision)))
  } catch {
    // The host can close its diagnostic pipe before the guardian sweeps.
  }
}

/** The one diagnostic record line that states `decision` on an output
 *  another process drains, where `watchContainerTerminations` reads it back.
 *  Self-contained, because the process watchdog serializes it into the
 *  source of its Worker, which records its hard-exit clock's decision. */
export function terminationRecordLine(decision: TerminationDecision): string {
  return `${JSON.stringify({ type: "log.info", payload: { service: "process-termination", message: "termination requested", ...decision } })}\n`
}

/** Tells `listener` of every termination decision this process records from
 *  now on. Returns the unsubscribe. */
export function onTermination(listener: (decision: TerminationDecision) => void): () => void {
  terminationListeners.add(listener)
  return () => { terminationListeners.delete(listener) }
}

/** The decision in one diagnostic record that `recordTermination` wrote in
 *  another process, or undefined for any other record. That output is an
 *  external boundary, so a malformed record is not a decision, and evidence
 *  keeps only its string and number fields. */
function readTerminationDecision(payload: ProcessDiagnosticPayload): TerminationDecision | undefined {
  if (payload.service !== "process-termination") return undefined
  const { senderPid, container, target, signal, reason, caller } = payload
  if (typeof senderPid !== "number" || typeof container !== "number" || (typeof target !== "number" && typeof target !== "string")) return undefined
  if (typeof signal !== "string" || typeof reason !== "string") return undefined
  const evidence = readEvidence(payload.evidence)
  return { senderPid, container, target, signal, reason, ...(evidence === undefined ? {} : { evidence }), ...(typeof caller === "string" ? { caller } : {}) }
}

function readEvidence(value: unknown): TerminationCause["evidence"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const fields = Object.entries(value).filter((field): field is [string, string | number] => typeof field[1] === "string" || typeof field[1] === "number")
  return fields.length === 0 ? undefined : Object.fromEntries(fields)
}

export interface ContainerTerminations {
  /** Reads one diagnostic record drained from the container's output. */
  read(payload: ProcessDiagnosticPayload): void
  last(): TerminationDecision | undefined
  dispose(): void
}

/** Follows the termination decisions Flywheel records for the container led
 *  by `container`: the ones this process makes, and the ones the container's
 *  own supervisor writes on the output this process drains and passes to
 *  `read`. `last()` is the latest of them. */
export function watchContainerTerminations(container: number): ContainerTerminations {
  let last: TerminationDecision | undefined
  const note = (decision: TerminationDecision | undefined): void => {
    if (decision?.container === container) last = decision
  }
  const dispose = onTermination(note)
  return {
    read: (payload) => { note(readTerminationDecision(payload)) },
    last: () => last,
    dispose,
  }
}

/** A process container and the one way Flywheel ends one.
 *
 *  A container is the unit a single decision addresses as a whole: on macOS and
 *  Linux a process group, on Windows a job object. Both are sets the kernel
 *  keeps, so membership is never inferred from a snapshot. What
 *  ends ownership is emptiness, never the exit of the process that led it. A
 *  payload can exit while a descendant keeps the group and the payload's
 *  streams alive, and that descendant is still Flywheel's to remove. */

type ContainerSignal = "SIGTERM" | "SIGKILL"

export interface ManagedContainer {
  /** Signals every process the container still holds. `cause` is why the
   *  container is being ended, which its termination decision names. */
  signal(signal: ContainerSignal, cause: TerminationCause): void
  /** True while the container is still owned. Emptiness is proven, never
   *  assumed: a probe that could not answer leaves the container populated,
   *  because an owner may not surrender a container on no evidence. */
  populated(): boolean
  /** The launch's stop hold, when it declared one. */
  readonly stopHold?: StopHold
}

/** How one container is addressed.
 *
 *  Both fields name the same container; which one is the container's identity
 *  is the platform's answer. A process group is named by the pid that leads it,
 *  so POSIX reads `pid`. The kernel keeps that name for as long as any member
 *  remains, after the leader has exited too, and never gives the pid to a new
 *  process while the group holds it. A
 *  Windows job object is named when it is created, so Windows reads `token` and
 *  the container outlives every member. The token is the launch's ownership
 *  token, which is used once and never reused, so on Windows a container's name
 *  is unique for all time and no recycled-identity question arises. */
export interface ContainerRef {
  readonly pid: number
  readonly token: string
}

/** How often an emptying container is re-probed. Short enough that a container
 *  that takes the first signal costs a poll rather than the whole grace. */
const EMPTINESS_POLL_MS = 20

/** How long a trusted program may run when its caller names no budget of its
 *  own, such as a `trustedProbeRun` given no timeout. No probe runs through a
 *  shell host, so each answers in tens of milliseconds. */
const PROBE_TIMEOUT_MS = 500

/** The slice of the grace held back from the term, so a kill always has an
 *  interval to be observed in. Without it a term that spent the whole grace
 *  would leave every container reported as surviving a signal nobody waited
 *  for. */
const KILL_OBSERVATION_MS = 100

/** What one trusted program run answered.
 *
 *  `no-match` is exit 1, which the process tools use for "nothing matched". A
 *  program that timed out or failed proved nothing at all, and the difference
 *  between the two is what keeps a host under load from being read as a host
 *  with no processes left. */
export type ProbeOutcome =
  | { readonly kind: "output"; readonly text: string }
  | { readonly kind: "no-match" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "failed" }

/** One read of a procfs file. `absent` proves the file does not exist, which
 *  for `/proc/<pid>/stat` proves the pid holds no process; `unreadable` proves
 *  nothing. */
export type ProcRead =
  | { readonly kind: "content"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }

/** The procfs a Linux host exposes. Answering from `/proc` needs no external
 *  program, so it works on minimal containers that ship no process tools. */
export interface Procfs {
  readStat(pid: number): ProcRead
  /** `/proc/<pid>/environ`: the environment the process started with, as
   *  NUL-separated entries. Only a process of the same user answers. */
  readEnviron(pid: number): ProcRead
  /** Numeric `/proc` entries, or nothing when the listing itself failed. */
  listPids(): readonly number[] | undefined
  /** `/proc/sys/kernel/random/boot_id`, the UUID the kernel draws at boot. */
  bootId(): ProcRead
}

/** The syscalls a container is built from, injected so container behavior is
 *  testable on a host that is not the target platform.
 *
 *  Every process fact a container decision rests on (identity, group
 *  membership, whether a member still runs) comes from the kernel: `/proc` on
 *  Linux, libproc on macOS, kernel32 on Windows. No such decision starts a
 *  program. A probe with no kernel surface to ask answers every question as
 *  unproven, and never as an absence. */
export interface ContainerProbe {
  /** Signals a pid exactly as given; a negative pid addresses a group.
   *  `container` is the pid that leads the container the signal is part of
   *  ending, and `cause` is why it is being ended; the signal's termination
   *  decision names both. */
  signal(pid: number, signal: ContainerSignal, container: number, cause: TerminationCause): void
  /** Whether the kernel still holds process group `pgid`, an unreaped member
   *  included. Only a proven absence is false: a refusal is a group that
   *  exists and belongs to another user. */
  groupExists(pgid: number): boolean
  /** Present on Linux, which answers process questions through `/proc`. */
  procfs?: Procfs
  /** Present on macOS, which answers process questions through libproc. */
  libproc?: DarwinProcessApi
  /** Present on Windows, which answers process questions through the kernel
   *  rather than through a program. Identity, tree, liveness, and the kill of
   *  a tree member all come from here, so the platform starts no process to
   *  observe or end one. */
  windows?: WindowsProcessApi
}

interface ProcStat {
  readonly state: string
  readonly ppid: number
  readonly pgid: number
  readonly threads: number
  readonly startTime: string
}

/** stat is `pid (comm) state ppid pgrp session ...` with num_threads at field
 *  20 and starttime at field 22. comm may contain spaces and parentheses, so
 *  fields are counted from the last `)`. Kernel threads report pgrp 0; they
 *  are valid rows that can never be members of a userland group, so rejecting
 *  them would leave every scan of a real host unproven. */
export function parseProcStat(text: string): ProcStat | undefined {
  const close = text.lastIndexOf(")")
  if (close < 0) return undefined
  const fields = text.slice(close + 1).trim().split(/\s+/)
  const state = fields[0]
  const ppid = Number(fields[1] ?? Number.NaN)
  const pgid = Number(fields[2] ?? Number.NaN)
  const threads = Number(fields[17] ?? Number.NaN)
  const startTime = fields[19]
  if (state === undefined || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid) || pgid < 0 || !Number.isSafeInteger(threads) || startTime === undefined) return undefined
  return { state, ppid, pgid, threads, startTime }
}

/** Whether the process exited and only waits to be reaped. The zombie state
 *  alone does not prove it: a group leader whose own thread ended while other
 *  threads still run shows that state too, and that process still runs. */
export function procExited(stat: ProcStat): boolean {
  return stat.state.startsWith("Z") && stat.threads <= 1
}

function readProcFile(filePath: string): ProcRead {
  try {
    return { kind: "content", text: fs.readFileSync(filePath, "utf8") }
  } catch (err) {
    const code = err instanceof Error && "code" in err ? err.code : undefined
    return code === "ENOENT" || code === "ESRCH" ? { kind: "absent" } : { kind: "unreadable" }
  }
}

const realProcfs: Procfs = {
  readStat: (pid) => readProcFile(`/proc/${pid}/stat`),
  readEnviron: (pid) => readProcFile(`/proc/${pid}/environ`),
  bootId: () => readProcFile("/proc/sys/kernel/random/boot_id"),
  listPids() {
    try {
      const pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number)
      return pids.length > 0 ? pids : undefined
    } catch {
      return undefined
    }
  },
}

/** Where a probe program may come from. A program is never resolved through
 *  the inherited PATH: one writable entry in front of it would let a program
 *  nobody vetted answer in place of the real one, and whatever reads its
 *  answer would believe it. */
const TRUSTED_PROBE_DIRS: readonly string[] = process.platform === "win32"
  ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32"), join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0")]
  : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

interface ProbeEnvironment {
  readonly [key: string]: string
}

export interface TrustedProbeLaunch {
  readonly argv: readonly string[]
  readonly env: ProbeEnvironment
  /** How long this program may run before it is killed. It belongs to the
   *  launch rather than to the call site, so no caller can ask a question
   *  through a program its budget cannot cover. */
  readonly timeoutMs: number
  /** Windows gives a console program whose parent holds no console a fresh one,
   *  and on Windows 11 that console is a visible terminal window. The guardian
   *  runs detached and holds no console, so every probe it starts would open
   *  one. A probe asks an internal question, so it never gets a window. The
   *  flag has no meaning on other platforms, which ignore it. */
  readonly windowsHide: true
}
/** The environment every probe runs in. It is the whole environment, not an
 *  addition to this process's: a probe needs no configuration, and the fixed
 *  PATH is what a program name falls back to when no trusted directory holds
 *  it. */
const PROBE_ENV: ProbeEnvironment = process.platform === "win32"
  ? { PATH: TRUSTED_PROBE_DIRS.join(delimiter), SYSTEMROOT: process.env.SystemRoot ?? "C:\\Windows", SYSTEMDRIVE: process.env.SystemDrive ?? "C:" }
  : { PATH: TRUSTED_PROBE_DIRS.join(delimiter) }

const probePrograms = new Map<string, string>()

/** How one probe command is launched: the program is bound to a trusted absolute
 * path, or launch construction fails when the host does not provide it. `env`
 * adds to the fixed probe environment for a program that needs to find a
 * service of the session, such as the systemd user manager's bus; the
 * program path stays trusted either way. */
export function trustedProbeLaunch(
  argv: readonly string[],
  options: { readonly trustedDirs?: readonly string[]; readonly exists?: (filePath: string) => boolean; readonly env?: ProbeEnvironment } = {},
): TrustedProbeLaunch {
  const [name, ...rest] = argv
  if (name === undefined) throw new Error("a probe command names no program")
  return {
    argv: [trustedProbeProgram(name, options), ...rest],
    env: options.env === undefined ? PROBE_ENV : { ...PROBE_ENV, ...options.env },
    timeoutMs: PROBE_TIMEOUT_MS,
    windowsHide: true,
  }
}

/** The file names a trusted directory is searched for. A caller names the
 *  program the way an operator would type it, but Windows keeps the extension
 *  on disk: `whoami` is `whoami.exe`, so a bare name matches nothing and every
 *  probe reports the program as unavailable. Only `.exe` is admitted, because a
 *  trusted probe launches a system binary and must never resolve to a `.bat` or
 *  `.cmd` script that happens to sit beside it. */
function probeFileNames(name: string): readonly string[] {
  if (process.platform !== "win32" || extname(name) !== "") return [name]
  return [`${name}.exe`]
}

function trustedProbeProgram(
  name: string,
  options: { readonly trustedDirs?: readonly string[]; readonly exists?: (filePath: string) => boolean },
): string {
  const useCache = options.trustedDirs === undefined && options.exists === undefined
  const known = useCache ? probePrograms.get(name) : undefined
  if (known !== undefined) return known
  const found = (options.trustedDirs ?? TRUSTED_PROBE_DIRS)
    .flatMap((dir) => probeFileNames(name).map((fileName) => join(dir, fileName)))
    .find(options.exists ?? fs.existsSync)
  if (found === undefined) throw new Error(`trusted probe program is unavailable: ${name}`)
  if (useCache) probePrograms.set(name, found)
  return found
}

/** Runs one trusted probe without blocking the host event loop. A timeout kills the probe and waits a bounded interval for its settlement. */
export async function trustedProbeRun(argv: readonly string[], timeoutMs?: number): Promise<ProbeOutcome> {
  const launch = trustedProbeLaunch(argv)
  let task: ReturnType<typeof Bun.spawn>
  try {
    task = Bun.spawn([...launch.argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: launch.env, windowsHide: launch.windowsHide })
  } catch {
    return { kind: "failed" }
  }
  let exitCode: number
  try {
    exitCode = await withDeadline(task.exited, timeoutMs ?? launch.timeoutMs)
  } catch (error) {
    if (!(error instanceof DeadlineExceeded)) return { kind: "failed" }
    await killOverrun(task, "trusted probe timeout")
    return { kind: "timed-out" }
  }
  if (exitCode !== 0) return exitCode === 1 ? { kind: "no-match" } : { kind: "failed" }
  if (!(task.stdout instanceof ReadableStream)) return { kind: "failed" }
  try {
    return { kind: "output", text: (await new Response(task.stdout).text()).trim() }
  } catch {
    return { kind: "failed" }
  }
}

/** What a trusted command answered. `exitCode` is null when the command did
 *  not answer within its budget, or could not start, which proves nothing. */
export interface TrustedCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs one trusted command to completion and answers its exit status and
 *  both of its streams, for a caller that must tell one refusal from another,
 *  such as a service manager command. A timeout kills the command and waits
 *  a bounded interval for its settlement. */
export async function trustedCommandRun(launch: TrustedProbeLaunch, timeoutMs: number): Promise<TrustedCommandResult> {
  let task: Bun.Subprocess<"ignore", "pipe", "pipe">
  try {
    task = Bun.spawn([...launch.argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: launch.env, windowsHide: launch.windowsHide })
  } catch {
    return { exitCode: null, stdout: "", stderr: "" }
  }
  const output = Promise.all([new Response(task.stdout).text(), new Response(task.stderr).text()])
  let exitCode: number
  try {
    exitCode = await withDeadline(task.exited, timeoutMs)
  } catch (error) {
    if (!(error instanceof DeadlineExceeded)) throw error
    await killOverrun(task, "trusted command timeout")
    return { exitCode: null, stdout: "", stderr: "" }
  }
  const [stdout, stderr] = await output
  return { exitCode, stdout, stderr }
}

/** Kills a trusted launch that overran its budget and waits a bounded interval
 *  for the kill to land.
 *
 *  Every trusted run bounds its waits with `withDeadline`, which clears its
 *  timer once the wait settles, and never races an uncancelled `Bun.sleep`. A
 *  CLI command that ends by returning, such as `flywheel kill`, lives until its
 *  last armed timer fires, so a leftover budget timer holds the process open
 *  for the whole budget after the run answered. */
async function killOverrun(task: Bun.Subprocess, reason: string): Promise<void> {
  recordTermination({ container: task.pid, target: task.pid, signal: "SIGKILL", reason })
  try { task.kill("SIGKILL") } catch { /* the launch may have ended at its budget */ }
  await withDeadline(task.exited, KILL_OBSERVATION_MS).catch(() => undefined)
}

export const bunContainerProbe: ContainerProbe = {
  signal(pid, signal, container, cause) {
    recordTermination({ container, target: pid, signal, ...cause })
    signalProcess(pid, signal)
  },
  groupExists(pgid) {
    try {
      // Signal zero performs every check and delivers nothing.
      process.kill(-pgid, 0)
      return true
    } catch (error) {
      return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
    }
  },
  ...(process.platform === "linux" ? { procfs: realProcfs } : {}),
  ...(process.platform === "darwin" ? { libproc: darwinProcess } : {}),
  ...(process.platform === "win32" ? { windows: windowsProcessApi() } : {}),
}

function signalProcess(pid: number, signal: ContainerSignal): void {
  try {
    process.kill(pid, signal)
    // Processor admission may hold members stopped (ARCH-TOOLS-051). A
    // stopped process keeps a TERM pending and cannot act on it, so every TERM
    // continues its target: the payload then gets its grace instead of
    // waiting it out to a KILL. Windows ends suspended processes directly.
    if (signal === "SIGTERM" && process.platform !== "win32") process.kill(pid, "SIGCONT")
  } catch {
    // The container can finish between the probe and the signal.
  }
}

/** The container led by `pid`, addressed from outside it: one signal per group
 *  reaches every member, including a payload that re-parented or ignored the
 *  last one, and a leader that already exited.
 *
 *  A group the kernel no longer holds is proven empty by one syscall. That is
 *  the common answer, because an owner asks after its container settled, and
 *  it keeps the membership listing for a group that still exists. */
export function unixContainer(pid: number, probe: ContainerProbe = bunContainerProbe): ManagedContainer {
  return {
    signal: (signal, cause) => probe.signal(-pid, signal, pid, cause),
    populated: () => unixGroupRuns(pid, probe),
  }
}

/** Whether process group `pgid` still runs a process on macOS or Linux. Only
 *  a group proven empty or gone is false: a membership that did not answer
 *  counts as running, because a reader keeps what it cannot prove it lost. */
export function unixGroupRuns(pgid: number, probe: ContainerProbe = bunContainerProbe): boolean {
  return probe.groupExists(pgid) && unixContainerMembers(pgid, probe).kind !== "empty"
}

/** The container a process found in the process table is ended through, by a
 *  side that did not start it and holds no lease on it: the hard reset.
 *
 *  A group leader is ended as its group, so a child that shares the group goes
 *  with it. A process inside someone else's group is signalled alone, because
 *  that group is not Flywheel's to end, and it is gone only when no process
 *  holds its pid: a probe that could not answer keeps it populated. Windows
 *  has trees rather than groups, and a live process there stands for its own. */
export function processContainer(member: { readonly pid: number; readonly pgid?: number }, probe: ContainerProbe = bunContainerProbe): ManagedContainer {
  if (probe.windows !== undefined) return windowsContainer(member.pid, probe)
  if (member.pgid === member.pid) return unixContainer(member.pid, probe)
  return {
    signal: (signal, cause) => probe.signal(member.pid, signal, member.pid, cause),
    populated: () => unixProcessFacts(member.pid, probe).kind !== "absent",
  }
}

/** What an identity probe proved about one process, whatever container it is
 *  in. Only `absent` proves the process is gone, and only a different
 *  `identity` proves the pid now holds another process. `unproven` is a probe
 *  that did not answer: it never ends or releases work and never reads as an
 *  absence. */
export type ProcessIdentity =
  | { readonly kind: "process"; readonly identity: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unproven" }

const PROCESS_ABSENT = { kind: "absent" } as const satisfies ProcessIdentity
const PROCESS_UNPROVEN = { kind: "unproven" } as const satisfies ProcessIdentity

/** What an identity probe proved about the container a pid names.
 *
 *  `absent` proves the leader is gone, and it is what lets a descendant that
 *  kept the container be cleaned up. `other` proves the container itself is
 *  gone: a live process holds the pid but leads no group, and the kernel never
 *  gives a pid to a new process while a group with that id exists. `unproven`
 *  is a probe that did not answer, which is neither an absence nor a container
 *  this side may address. */
export type ContainerIdentity =
  | { readonly kind: "container"; readonly identity: string }
  | { readonly kind: "absent" }
  | { readonly kind: "other" }
  | { readonly kind: "unproven" }

/** A stable identity of the process `pid` on macOS or Linux.
 *
 *  What makes it stable is the part a recycled pid cannot share: the kernel's
 *  per-boot unique id on macOS, the start time on Linux. Every reader that
 *  must not confuse two processes that shared a number compares this string
 *  rather than the number. */
export function unixProcessIdentity(pid: number, probe: ContainerProbe = bunContainerProbe): ProcessIdentity {
  const facts = unixProcessFacts(pid, probe)
  return facts.kind === "facts" ? { kind: "process", identity: facts.identity } : facts
}

/** What `pid` proves about the container it leads. */
export function unixContainerIdentity(pid: number, probe: ContainerProbe = bunContainerProbe): ContainerIdentity {
  const facts = unixProcessFacts(pid, probe)
  if (facts.kind !== "facts") return facts
  return facts.pgid === pid ? { kind: "container", identity: facts.identity } : { kind: "other" }
}

/** One process's identity: the pid paired with the creation time that keeps a
 *  recycled pid from passing as the process that used to hold the number. A
 *  process that refuses to be examined is not an absence, which is why only
 *  `absent` releases anything. */
function windowsIdentityOf(pid: number, query: WindowsProcessQuery): ProcessIdentity {
  if (query.kind === "absent") return PROCESS_ABSENT
  if (query.kind !== "process") return PROCESS_UNPROVEN
  return { kind: "process", identity: windowsIdentity(pid, query.createdFileTime) }
}

function windowsIdentity(pid: number, createdFileTime: bigint): string {
  return `${pid}|${createdFileTime}`
}

/** A stable identity of the process `pid` on Windows. */
export function windowsProcessIdentity(pid: number, probe: ContainerProbe = bunContainerProbe): ProcessIdentity {
  const api = probe.windows
  // No surface to ask through proves nothing, and nothing proven is not an absence.
  return api === undefined ? PROCESS_UNPROVEN : windowsIdentityOf(pid, api.query(pid))
}

/** What the kernel answers for the start of one process. `start` is the
 *  kernel's start stamp as a decimal: the libproc unique id on macOS, the
 *  `/proc` start time on Linux, and the creation FILETIME on Windows. On macOS
 *  and Linux it counts from the start of the boot, so it names one process
 *  only together with `bootIdentity`. A FILETIME is absolute. Absent and
 *  unproven mean what they mean for `ProcessIdentity`. */
export type ProcessStart =
  | { readonly kind: "process"; readonly start: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unproven" }

/** The start stamp of the process `pid`, from the platform's kernel surface. */
export function processStart(pid: number, probe: ContainerProbe = bunContainerProbe): ProcessStart {
  if (probe.windows !== undefined) {
    const query = probe.windows.query(pid)
    if (query.kind === "process") return { kind: "process", start: String(query.createdFileTime) }
    return query.kind === "absent" ? PROCESS_ABSENT : PROCESS_UNPROVEN
  }
  const facts = unixProcessFacts(pid, probe)
  return facts.kind === "facts" ? { kind: "process", start: facts.start } : facts
}

/** The boot this host runs, as 32 lowercase hex characters. `none` is a
 *  kernel that states it names no boot, and Windows, whose creation FILETIME
 *  is absolute and needs no boot beside it. `unproven` is a read that did not
 *  answer. */
export type BootIdentity =
  | { readonly kind: "boot"; readonly id: string }
  | { readonly kind: "none" }
  | { readonly kind: "unproven" }

const BOOT_NONE = { kind: "none" } as const satisfies BootIdentity
const BOOT_UNPROVEN = { kind: "unproven" } as const satisfies BootIdentity

/** The boot this host runs: `kern.bootsessionuuid` on macOS, and the
 *  `boot_id` UUID on Linux. */
export function bootIdentity(probe: ContainerProbe = bunContainerProbe): BootIdentity {
  if (probe.windows !== undefined) return BOOT_NONE
  if (probe.procfs) return procBootIdentity(probe.procfs.bootId())
  if (probe.libproc) return probe.libproc.bootSession() ?? BOOT_UNPROVEN
  return BOOT_UNPROVEN
}

function procBootIdentity(read: ProcRead): BootIdentity {
  if (read.kind === "absent") return BOOT_NONE
  if (read.kind !== "content") return BOOT_UNPROVEN
  const id = read.text.trim().replaceAll("-", "").toLowerCase()
  return /^[0-9a-f]{32}$/.test(id) ? { kind: "boot", id } : BOOT_UNPROVEN
}

/** One pid a Windows tree holds. A member was admitted with its creation
 *  time, and a pid that holds a process with another creation time is not
 *  that member. A candidate is a row whose parent was a member but whose
 *  creation time could not be read: it may be a descendant, so the tree
 *  keeps it, with the window a descendant's creation time falls in, until a
 *  query proves it one or the other. */
type WindowsTreeEntry =
  | { readonly kind: "member"; readonly created: bigint }
  | { readonly kind: "candidate"; readonly notBefore: bigint; readonly notAfter: bigint }

type WindowsTree = ReadonlyMap<number, WindowsTreeEntry>

/** What one query says of one entry: it still holds the tree, it is gone, or,
 *  for a candidate, the creation time that proves it a member. A query that
 *  did not answer holds the tree, because an owner keeps what it cannot
 *  prove it has lost. */
function readWindowsEntry(query: WindowsProcessQuery, entry: WindowsTreeEntry): WindowsTreeEntry | "gone" {
  if (query.kind === "absent") return "gone"
  if (query.kind !== "process") return entry
  if (entry.kind === "member") return query.createdFileTime === entry.created ? entry : "gone"
  const created = query.createdFileTime
  return created >= entry.notBefore && created <= entry.notAfter ? { kind: "member", created } : "gone"
}

/** The root of the tree at `pid`, the one process an owner named, checked
 *  against the identity the owner admitted when it names one. An empty tree
 *  is a root proven absent, which releases ownership without a table ever
 *  being read. Nothing is a root that did not answer. */
function windowsTreeRoot(pid: number, api: WindowsProcessApi, expectedIdentity: string | undefined): WindowsTree | undefined {
  const query = api.query(pid)
  if (query.kind === "absent") return new Map()
  if (query.kind !== "process") return undefined
  if (expectedIdentity !== undefined && windowsIdentity(pid, query.createdFileTime) !== expectedIdentity) throw new Error("process identity changed")
  return new Map([[pid, { kind: "member", created: query.createdFileTime }]])
}

/** The entries of `admitted` that still hold the tree, with each candidate
 *  whose creation time now proves it a descendant admitted as a member.
 *  Nothing when a member did not answer. */
function survivingEntries(api: WindowsProcessApi, admitted: WindowsTree): WindowsTree | undefined {
  const surviving = new Map<number, WindowsTreeEntry>()
  for (const [pid, entry] of admitted) {
    const query = api.query(pid)
    if (entry.kind === "member" && (query.kind === "denied" || query.kind === "unavailable")) return undefined
    const read = readWindowsEntry(query, entry)
    if (read !== "gone") surviving.set(pid, read)
  }
  return surviving
}

/** The members of a tree that holds no candidate, which is the only tree
 *  that proves who its members are. */
function provenMembers(tree: WindowsTree): ReadonlyMap<number, bigint> | undefined {
  const members = new Map<number, bigint>()
  for (const [pid, entry] of tree) {
    if (entry.kind === "candidate") return undefined
    members.set(pid, entry.created)
  }
  return members
}

/** `tree` grown over one snapshot of the process table, or nothing when the
 *  snapshot did not answer.
 *
 *  A row joins when its parent is a member, which is why a whole snapshot is
 *  read rather than one lookup: a payload can exit while a descendant it
 *  started keeps running, and that descendant is still this side's to remove.
 *  Parenthood alone proves nothing, because the table names a parent by pid
 *  and a pid is recycled. So a row joins only when it was created no earlier
 *  than the member it names, which a process older than its parent cannot be,
 *  and no later than the snapshot, which a pid reused after the table was
 *  read cannot be. The snapshot time is read before the table, so it never
 *  postdates the table. A row whose creation time cannot be read may be a
 *  descendant, so it joins as a candidate with that window rather than be
 *  left out. */
function growWindowsTree(api: WindowsProcessApi, tree: WindowsTree): WindowsTree | undefined {
  if (tree.size === 0) return tree
  const snapshotAt = api.now()
  const table = api.list()
  if (table === undefined) return undefined
  const grown = new Map(tree)
  const refused = new Set<number>()
  // Breadth-first over the snapshot: a row joins once its parent has, so the
  // pass repeats while it is still admitting anything.
  let growing = true
  while (growing) {
    growing = false
    for (const row of table) {
      const parent = grown.get(row.parentPid)
      if (parent?.kind !== "member" || grown.has(row.pid) || refused.has(row.pid)) continue
      const read = readWindowsEntry(api.query(row.pid), { kind: "candidate", notBefore: parent.created, notAfter: snapshotAt })
      if (read === "gone") {
        refused.add(row.pid)
      } else {
        grown.set(row.pid, read)
        // A candidate admits no child, because its own creation time is unknown.
        if (read.kind === "member") growing = true
      }
    }
  }
  return grown
}

export type ProcessFacts =
  | { readonly kind: "facts"; readonly pgid: number; readonly identity: string; readonly start: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unproven" }

/** One process's facts from the platform's kernel surface. The identity is
 *  pid, group, and the part a recycled pid cannot share. A process that exited
 *  and waits to be reaped is absent on both platforms: it runs nothing, holds
 *  nothing, and a signal reaches nothing. */
export function unixProcessFacts(pid: number, probe: ContainerProbe): ProcessFacts {
  if (probe.procfs) return procProcessFacts(pid, probe.procfs)
  if (probe.libproc) return libprocProcessFacts(pid, probe.libproc)
  return PROCESS_UNPROVEN
}

function libprocProcessFacts(pid: number, libproc: DarwinProcessApi): ProcessFacts {
  const query = libproc.query(pid)
  if (query.kind === "process") return { kind: "facts", pgid: query.pgid, identity: query.identity, start: query.start }
  return query.kind === "absent" ? PROCESS_ABSENT : PROCESS_UNPROVEN
}

function procProcessFacts(pid: number, procfs: Procfs): ProcessFacts {
  const read = procfs.readStat(pid)
  if (read.kind === "absent") return PROCESS_ABSENT
  if (read.kind !== "content") return PROCESS_UNPROVEN
  const stat = parseProcStat(read.text)
  if (!stat) return PROCESS_UNPROVEN
  if (procExited(stat)) return PROCESS_ABSENT
  return { kind: "facts", pgid: stat.pgid, identity: `${pid} ${stat.pgid} ${stat.startTime}`, start: stat.startTime }
}

/** The container this process leads, addressed from inside it.
 *
 *  TERM goes to the whole group with one signal, so it reaches every member
 *  whether or not a listing answered, and it never waits on one. It reaches
 *  this process too, which reads its own TERM as part of the escalation it is
 *  already running rather than as a request to stop.
 *
 *  KILL goes to each proven member one at a time, never to the group: a group
 *  KILL would also end the supervisor running the escalation, and a supervisor
 *  killed by its own escalation could no longer report the payload's status or
 *  prove the container is empty. A membership that did not answer sends no
 *  KILL this time and keeps the container owned, so the next escalation asks
 *  again. */
export function ownUnixContainer(probe: ContainerProbe = bunContainerProbe): ManagedContainer {
  const members = (): Membership => unixContainerMembers(process.pid, probe)
  return {
    signal: (signal, cause) => {
      if (signal === "SIGTERM") {
        probe.signal(-process.pid, signal, process.pid, cause)
        return
      }
      const membership = members()
      if (membership.kind !== "members") return
      for (const member of membership.pids) probe.signal(member, signal, process.pid, cause)
    },
    populated: () => members().kind !== "empty",
  }
}

/** The container a Windows job object holds.
 *
 *  This is what an owned launch gets, and it is the platform's real container:
 *  membership is the kernel's, not a walk's, and one call ends the whole set.
 *  Windows has no graceful group signal, so both signals are the same kill; the
 *  escalation above still runs, and simply finds the container already empty on
 *  its first re-probe. `supervisorPid` is the command supervisor the job was
 *  made for, which names the container in a termination record as a process
 *  group's leader names it on POSIX. */
export function windowsJobContainer(job: WindowsJob, supervisorPid: number): ManagedContainer {
  return {
    signal: (signal, cause) => {
      recordTermination({ container: supervisorPid, target: `windows job members ${job.pids()?.join(",") ?? "unproven"}`, signal, ...cause })
      job.terminate()
    },
    // A query that could not answer leaves the container populated: an owner
    // may not surrender a container on no evidence.
    populated: () => (job.pids()?.length ?? 1) > 0,
  }
}

/** The job object this process is in, addressed from inside it through the
 *  handle this process opened on it, or through nothing when it could not.
 *
 *  Members are ended one at a time rather than through the job, for the same
 *  reason a POSIX supervisor never signals its own group: ending the job would
 *  end this process too, and a supervisor killed by its own escalation could no
 *  longer report the payload's status or prove the container is empty. So this
 *  process is never a member it signals, and never a member it counts.
 *
 *  The caller opens the handle once and holds it for the life of the
 *  supervisor. That is also what keeps the container alive while it is being
 *  emptied: a container dies with its last handle, and the launcher may
 *  release its own at any moment. */
export function ownWindowsJobContainer(job: WindowsJob | undefined, signalMember: (pid: number, signal: ContainerSignal) => void = signalProcess): ManagedContainer {
  const others = (): readonly number[] | undefined => job?.pids()?.filter((pid) => pid !== process.pid)
  return {
    signal: (signal, cause) => {
      const members = others()
      if (members === undefined || members.length === 0) return
      recordTermination({ container: process.pid, target: "windows job members", signal, ...cause, evidence: { ...cause.evidence, members: members.length } })
      for (const pid of members) signalMember(pid, signal)
    },
    // A membership this side could not read leaves the container populated: an
    // owner may not surrender a container on no evidence.
    populated: () => (others()?.length ?? 1) > 0,
  }
}

/** The tree below `pid`, as a container addressed by pid alone.
 *
 *  A job object cannot address a container across a restart of this process,
 *  because a job is reached through a handle and a handle dies with the process
 *  holding it. An explicitly authorized survivor is exactly that case, and so
 *  is a process the hard reset found in the process table. The tree is weaker
 *  than a job object in the way a snapshot is weaker than a set the kernel
 *  keeps: a member that re-parents leaves the closure, so membership is an
 *  approximation. Every member carries the creation time it was admitted with,
 *  and that is what keeps a recycled pid from being counted or killed in place
 *  of the member that used to hold the number.
 *
 *  Emptiness is the admitted membership being gone, not the root exiting: a
 *  descendant that outlived the root still holds the container, and so does
 *  a candidate whose creation time could not be read. A signal reads the tree
 *  again from the entries that survive and ends each member through a handle
 *  whose creation time is checked; Windows has no graceful signal, so the
 *  term is already the kill. An observation that proves nothing, a candidate
 *  that remains included, ends nothing and leaves the container owned. */
export function windowsContainer(pid: number, probe: ContainerProbe = bunContainerProbe, expectedIdentity?: string): ManagedContainer {
  const api = probe.windows
  // No surface to ask through proves nothing, so nothing is ended or released.
  if (api === undefined) return { signal: () => {}, populated: () => true }
  // Nothing until the root answered. The root stays admitted when the tree
  // around it did not answer, so a later observation grows from it.
  let admitted: WindowsTree | undefined
  /** The proven members, or nothing when the observation proves nothing. */
  const observe = (): ReadonlyMap<number, bigint> | undefined => {
    const surviving = admitted === undefined ? windowsTreeRoot(pid, api, expectedIdentity) : survivingEntries(api, admitted)
    if (surviving === undefined) return undefined
    admitted = surviving
    const tree = growWindowsTree(api, surviving)
    if (tree === undefined) return undefined
    admitted = tree
    return provenMembers(tree)
  }
  return {
    signal: (signal, cause) => {
      const members = observe()
      if (members === undefined || members.size === 0) return
      recordTermination({ container: pid, target: `windows tree members ${[...members.keys()].join(",")}`, signal, ...cause })
      for (const [member, created] of members) api.terminate(member, created)
    },
    populated: () => {
      if (admitted === undefined) {
        const members = observe()
        return members === undefined || members.size > 0
      }
      return [...admitted].some(([member, entry]) => readWindowsEntry(api.query(member), entry) !== "gone")
    },
  }
}

/** The result of one escalation. `unsettled` is what a bound that expired
 *  before the containers could be proven empty reports: the containers are
 *  still owned, and the caller that still holds the lease is the backstop. */
export type ContainerSettlement =
  | { readonly kind: "empty" }
  | { readonly kind: "unsettled"; readonly remaining: number }

const SETTLED: ContainerSettlement = { kind: "empty" }

/** TERM, one grace shared by every container, then KILL.
 *
 *  One absolute deadline is computed before the first signal and covers the
 *  whole escalation, so ending many containers is bounded exactly like ending
 *  one. The term yields the last slice of that deadline to the kill, because a
 *  kill nobody waits for proves nothing. It returns as soon as the containers
 *  are proven empty, so the common case costs a poll instead of the whole
 *  grace.
 *
 *  Containers that declare a stop hold escalate beside the others: they get
 *  no signal while a hold of theirs stands, at most the longest hold, and
 *  their grace starts after it. So a hold delays only the containers that
 *  declared one, and the whole call stays bounded by the longest hold plus
 *  one grace.
 *
 *  Every pass works from one snapshot: a container is probed once per pass,
 *  and the containers that snapshot left unproven are the ones the next signal
 *  addresses and the ones the result reports. A container proven empty is
 *  never signalled. */
export async function emptyContainers(
  containers: readonly ManagedContainer[],
  killGraceMs: number,
  sleep: (ms: number) => Promise<void>,
  cause: TerminationCause,
): Promise<ContainerSettlement> {
  const held = containers.filter((container) => container.stopHold !== undefined)
  const unheld = containers.filter((container) => container.stopHold === undefined)
  const settlements = await Promise.all([unheld, held].filter((group) => group.length > 0).map((group) => escalate(group, killGraceMs, sleep, cause)))
  const remaining = settlements.reduce((total, settlement) => total + (settlement.kind === "unsettled" ? settlement.remaining : 0), 0)
  return remaining === 0 ? SETTLED : { kind: "unsettled", remaining }
}

async function escalate(
  containers: readonly ManagedContainer[],
  killGraceMs: number,
  sleep: (ms: number) => Promise<void>,
  cause: TerminationCause,
): Promise<ContainerSettlement> {
  let remaining = stillOwned(containers)
  if (remaining.length === 0) return SETTLED
  const heldMs = await waitForStopHolds(remaining, EMPTINESS_POLL_MS, sleep)
  if (heldMs > 0) remaining = stillOwned(remaining)
  if (remaining.length === 0) return SETTLED
  // The decision names the hold that delayed it.
  const decided = heldMs > 0 ? { ...cause, evidence: { ...cause.evidence, stopHeldMs: heldMs } } : cause
  const deadline = Date.now() + killGraceMs
  const termDeadline = deadline - Math.min(KILL_OBSERVATION_MS, Math.floor(killGraceMs / 2))
  for (const container of remaining) container.signal("SIGTERM", decided)
  remaining = await waitUntilEmpty(remaining, termDeadline, sleep)
  if (remaining.length === 0) return SETTLED
  for (const container of remaining) container.signal("SIGKILL", decided)
  remaining = await waitUntilEmpty(remaining, deadline, sleep)
  return remaining.length === 0 ? SETTLED : { kind: "unsettled", remaining: remaining.length }
}

function stillOwned(containers: readonly ManagedContainer[]): readonly ManagedContainer[] {
  return containers.filter((container) => container.populated())
}

/** The containers still owned when the deadline expired, or none once they are
 *  all proven empty. The last snapshot is taken after the deadline rather than
 *  before it, so a signal that lands at the very end of the grace is still
 *  observed. */
async function waitUntilEmpty(
  containers: readonly ManagedContainer[],
  deadline: number,
  sleep: (ms: number) => Promise<void>,
): Promise<readonly ManagedContainer[]> {
  for (;;) {
    const remaining = stillOwned(containers)
    if (remaining.length === 0) return remaining
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) return remaining
    await sleep(Math.min(EMPTINESS_POLL_MS, remainingMs))
  }
}

/** What a membership probe proved about a container. `empty` is the only
 *  outcome that releases ownership; `unproven` is a probe that could not
 *  answer, and an owner keeps what it cannot prove it has lost. */
type Membership =
  | { readonly kind: "empty" }
  | { readonly kind: "members"; readonly pids: readonly number[] }
  | { readonly kind: "unproven" }

const EMPTY: Membership = { kind: "empty" }
const UNPROVEN: Membership = { kind: "unproven" }

/** Members of the container led by `pid`, never including the calling process:
 *  a supervisor asking whether its own container is empty is asking about
 *  everything except itself. */
function unixContainerMembers(pid: number, probe: ContainerProbe): Membership {
  if (probe.procfs) return procContainerMembers(pid, probe.procfs)
  if (probe.libproc) return libprocContainerMembers(pid, probe.libproc)
  return UNPROVEN
}

/** The kernel's own group listing, with each listed pid then asked whether it
 *  still runs in this group. The listing names unreaped members too, and the
 *  query reads each of those as absent: an exited process holds nothing, a
 *  signal reaches nothing, and it keeps no stream open. Counting one as a
 *  member would make a container that is already gone look populated for as
 *  long as nobody reaps it, which is exactly what happens when the thread that
 *  launched it died.
 *
 *  A member that moved to another group since the listing is not one. A query
 *  that did not answer proves nothing, and an owner keeps what it cannot prove
 *  it has lost. */
function libprocContainerMembers(pgid: number, libproc: DarwinProcessApi): Membership {
  const listed = libproc.group(pgid)
  if (listed === undefined) return UNPROVEN
  const members: number[] = []
  for (const candidate of listed) {
    if (candidate === process.pid) continue
    const query = libproc.query(candidate)
    if (query.kind === "unavailable") return UNPROVEN
    if (query.kind === "process" && query.pgid === pgid) members.push(candidate)
  }
  return members.length === 0 ? EMPTY : { kind: "members", pids: members }
}

/** One `/proc` scan answers both group membership and liveness. An entry that
 *  vanished between the listing and the read exited, so it is skipped; an
 *  entry this side could not read proves nothing, and an owner keeps what it
 *  cannot prove it has lost. A process that exited and waits to be reaped
 *  holds nothing (see procExited and libprocContainerMembers). */
function procContainerMembers(pid: number, procfs: Procfs): Membership {
  const pids = procfs.listPids()
  if (pids === undefined) return UNPROVEN
  const members: number[] = []
  for (const candidate of pids) {
    if (candidate === process.pid) continue
    const read = procfs.readStat(candidate)
    if (read.kind === "absent") continue
    if (read.kind !== "content") return UNPROVEN
    const stat = parseProcStat(read.text)
    if (!stat) return UNPROVEN
    if (stat.pgid === pid && !procExited(stat)) members.push(candidate)
  }
  return members.length === 0 ? EMPTY : { kind: "members", pids: members }
}
