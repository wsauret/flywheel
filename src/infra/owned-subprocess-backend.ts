import * as fs from "node:fs"

import type { FileSink } from "bun"

import { encodeSupervisorWord } from "./command-handover.js"
import { namedExitStatus } from "./exit-status.js"
import {
  controlledContainer,
  emptied,
  endAtOnce,
  identifyGuardian,
  reachCommand,
  type ControlledContainer,
  type HandedOverCommand,
  type ReachedCommand,
} from "./owned-command-control.js"
import {
  commandSupervisorArgv,
  type CommandSupervisorPolicy,
  type ContainerPolicy,
} from "./owned-command-policy.js"
import { windowsContainerName, windowsControlChannelName } from "./owned-command-supervisor.js"
import {
  bunContainerProbe,
  unixContainer,
  unixContainerIdentity,
  unixProcessIdentity,
  windowsJobContainer,
  windowsProcessIdentity,
  type ContainerIdentity,
  type ContainerProbe,
  type ContainerRef,
  type ManagedContainer,
  type ProcessIdentity,
  type TerminationCause,
} from "./process-container.js"
import type { StopHold } from "./stop-hold.js"
import { markedContainer, markedEnvironment, strictDescendantSettlementRequired } from "./container-mark.js"
import { createDarwinProcessApi, openLibprocCalls, type DarwinProcessApi } from "./darwin-process-api.js"
import { windowsJobApi, type WindowsJob, type WindowsJobApi, type WindowsJobOpen } from "./windows-job-object.js"
import type { ProcessPriority } from "./process-priority.js"
import { drainSupervisorDiagnostics, type SupervisorDiagnostics } from "./process-diagnostic-reader.js"

/** Platform launches for owned subprocesses.
 *
 *  On macOS and Linux a launch is a per-command supervisor in a fresh process
 *  group: the supervisor leads the container, gates the payload behind the
 *  launcher's admission, and ends the container itself. The launcher therefore
 *  never signals a process group of its own, and the pid it holds is the
 *  container's, which stays valid for exactly as long as the container does.
 *
 *  Windows is the same shape with its own primitives. The container is a job
 *  object, which is what a process group is there: a set the kernel keeps, that
 *  every process a member starts joins by itself, and that one call ends as a
 *  whole. It is created before the supervisor exists and named by the launch's
 *  ownership token, so the guardian reaches it by name with no handle to
 *  inherit and no pid to trust, and Windows ends it itself when the last handle
 *  to it closes. The supervisor's control channel is a named pipe rather than
 *  an inherited descriptor, because a child there can inherit nothing beyond
 *  its three streams; the end of that channel means what the end of the
 *  descriptor means, so the payload is held until ownership is settled on both.
 *
 *  A container that must outlive this process cannot be a job object at all: a
 *  job is reached through a handle, and a handle dies with the process holding
 *  it. That is the one case left with a weaker contract. */

/** The exit status of an owned container, read once when it settles. */
export interface OwnedExitStatus {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** Whose status `code` and `signal` are. `payload`: the supervisor exited
   *  with its container already empty, so its status is the payload's own,
   *  which the supervisor re-raises as its own. `supervisor`: the supervisor
   *  exited while its container still held processes, so it was killed or
   *  crashed, the launcher ended the rest, and the status is the supervisor's
   *  own death. A signal that ends the whole container at once empties it
   *  before the supervisor's exit is seen, so it reads as `payload`. */
  readonly statusOf: "payload" | "supervisor"
}

export interface OwnedChild {
  readonly stdin: FileSink | undefined
  readonly stdout: ReadableStream<Uint8Array> | undefined
  readonly stderr: ReadableStream<Uint8Array> | undefined
  /** Settles once the supervisor has exited and its container is proven
   *  empty, never on the supervisor's exit alone. */
  readonly exited: Promise<OwnedExitStatus>
}

/** The supervisor process as the host spawned it, in Bun's own shape. */
interface HostChild {
  readonly stdin: FileSink | undefined
  readonly stdout: ReadableStream<Uint8Array> | undefined
  readonly stderr: ReadableStream<Uint8Array> | undefined
  readonly exited: Promise<number>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly pid: number
  /** Write end of the control pipe, when the launch asked for one. */
  readonly controlFd: number | undefined
  /** Stops this process waiting for the child, which it no longer owns. */
  unref(): void
}
interface ProcessEnvironment {
  readonly [key: string]: string | undefined
}

interface HostSpawnOptions {
  readonly cwd?: string
  readonly env?: ProcessEnvironment
  readonly detached: boolean
  readonly control: boolean
}

/** The launcher's end of one control channel. A word reaches the child, and
 *  closing it tells the child the launcher is gone - the same two things an
 *  inherited descriptor conveys. */
interface ControlChannel {
  readonly diagnostics?: ReadableStream<Uint8Array>
  say(word: string): void
  /** The supervisor exited, so a peer that never connected never will. The
   *  diagnostics then end, which they cannot do otherwise for a supervisor
   *  that was ended before it ever ran. */
  supervisorExited(): void
  /** Defers transport close until the retained return reader has drained. */
  close(after?: Promise<void>): void
}

/** The platform syscall surface the backends need, injected so launches are
 *  testable on a host that is not the target platform.
 *
 *  A host names the kind of container it can hold, and that name is what
 *  selects a backend: the surfaces each platform needs are required on its own
 *  variant, so a host missing one cannot be built rather than failing at its
 *  first launch. */
interface ProcessHostBase extends ContainerProbe {
  spawn(argv: readonly string[], options: HostSpawnOptions): HostChild
}

export interface ProcessGroupHost extends ProcessHostBase {
  readonly containers: "process-group"
  writeFd(fd: number, text: string): void
  closeFd(fd: number): void
  readFd(fd: number): ReadableStream<Uint8Array>
}

interface JobObjectHost extends ProcessHostBase {
  readonly containers: "job-object"
  /** A Windows child inherits no descriptor, so its channel is opened by name
   *  and the child connects to it. */
  openControlChannel(name: string): ControlChannel
  readonly jobs: WindowsJobApi
}

export type ProcessHost = ProcessGroupHost | JobObjectHost

export interface OwnedLaunchOptions {
  /** Ends marked descendants on natural payload exit. Inherited strict
   *  process policy also requires this and cannot be weakened by omission. */
  readonly onPayloadExit?: "end-descendants"
  readonly diagnostics?: SupervisorDiagnostics
  readonly cwd?: string
  readonly env?: ProcessEnvironment
  readonly priority?: ProcessPriority
  /** Gives the payload EOF from launch, including across handover. The default
   *  inherits stdin or holds it open when handover is enabled. */
  readonly stdin?: "ignore"
  /** The launch may later be handed over to another owner. Only such a
   *  launch's supervisor answers the handover word, and it holds the
   *  payload's stdin itself unless ignored, so this process's exit never ends
   *  that stream. */
  readonly handover?: boolean
  /** The launched process's own owned launches are held by their own
   *  containers alone, never by this launch's. Every POSIX launch already
   *  leads its own session; on Windows this launch's job lets the children of
   *  its members leave it. */
  readonly childrenBreakAway?: boolean
  /** Defers the first signal of every end of this launch (see `StopHold`):
   *  the supervisor's stop or end, the guardian's sweep or generation close,
   *  and this side's own emptying after a supervisor that died. */
  readonly stopHold?: StopHold
}

interface ContainerLaunchOptions extends OwnedLaunchOptions, ContainerPolicy {
  /** The launch's ownership token, which names the container on a platform
   *  whose containers are named. */
  readonly token: string
}

interface OwnedLaunch extends ControlledContainer {
  /** Lets the payload run. Called only after the guardian owns the container. */
  admit(): void
  /** Ends the launch. Before admission the payload never runs; after it the
   *  container is emptied. Repeated calls are the same request. With `end`,
   *  this side ends the container at once (see `ControlledContainer`). */
  stop(end?: TerminationCause): void
}

export interface OwnedProcessBackend {
  launch(command: readonly string[], options: ContainerLaunchOptions): OwnedLaunch
  /** Connects to a handed-over command's channel, which proves its
   *  supervisor alive. Nothing when nothing serves that channel. */
  reach(command: HandedOverCommand, killGraceMs: number): Promise<ReachedCommand | undefined>
  /** Ends what remains of a handed-over command whose channel nothing
   *  serves, and answers whether the container is proven empty. False when
   *  its supervisor may still run: a process still holds the container and
   *  is not proven to be a stranger. `supervisorIdentity` is the identity the
   *  supervisor recorded for its container, when it recorded one. */
  emptyUnserved(command: HandedOverCommand, supervisorIdentity: string | undefined, killGraceMs: number): Promise<boolean>
  /** The container `ref` names, addressed from outside it. */
  container(ref: ContainerRef): ManagedContainer
  /** What ending the command `ref` names reaches: its container, and on
   *  macOS and Linux every process the command started that left it. */
  ending(ref: ContainerRef): ManagedContainer
  /** What `ref` proves about its container: the container's stable identity, a
   *  proven absence, or nothing at all. Comparing identities before signalling
   *  is what keeps a recycled pid from being killed in place of the container
   *  that had it, and the difference between an absence and an unanswerable
   *  probe is what keeps a loaded host from being read as a host with nothing
   *  left to kill. */
  inspect(ref: ContainerRef): ContainerIdentity
  /** Releases whatever this side still holds for `ref`.
   *
   *  A process group needs no such call: it is named by a pid and holding it
   *  costs nothing. A job object is reached through a handle, so on Windows
   *  ownership is literally the handle and this is what surrenders it. Calling
   *  it for a container this side never held does nothing. */
  forget(ref: ContainerRef): void
}

/** Process identity for a thread that cannot import this module.
 *
 *  The process watchdog runs in a Worker built from a Blob, which has no module
 *  resolution, so the primitive travels to it as source text and is evaluated
 *  there. It identifies processes and nothing more: containers are ended by the
 *  process guardian, so this probe carries no kill capability at all. */
export interface ThreadProcessProbe {
  /** A stable identity of `pid`. Comparing identities is what keeps a recycled
   *  pid from being read as the process that had it. */
  identify(pid: number): ProcessIdentity
}

/** The kernel surface the probe reads on this platform. */
type ThreadProbePlatform =
  | { readonly kind: "libproc"; readonly open: () => DarwinProcessApi }
  | { readonly kind: "procfs"; readonly readFile: (path: string, encoding: "utf8") => string }
  | { readonly kind: "none" }

interface ThreadProbeSource {
  readonly imports: string
  readonly expression: string
}

/** The probe as Worker module source for `platform`: the imports it needs,
 *  and an expression that evaluates to it.
 *
 *  The modules the probe reads the kernel through are imported at the top of
 *  the Worker's source and handed in, never required inside the serialized
 *  function: a bundled build rewrites a `require` inside a function into a
 *  helper that exists in the bundle but not in the Worker's source, so the
 *  probe would fail in the installed binary alone. On Windows the probe reads
 *  nothing and answers every question unproven, so the caller asks signal
 *  zero whether the pid still exists at all. */
export function threadProcessProbeSource(platform: NodeJS.Platform = process.platform): ThreadProbeSource {
  const probe = threadProcessProbe.toString()
  if (platform === "darwin") {
    return {
      imports: `import * as threadProbeFfi from "bun:ffi";`,
      expression: `(${probe})({ kind: "libproc", open: () => (${createDarwinProcessApi.toString()})((${openLibprocCalls.toString()})(threadProbeFfi)) })`,
    }
  }
  if (platform === "linux") {
    return {
      imports: `import { readFileSync as threadProbeReadFile } from "node:fs";`,
      expression: `(${probe})({ kind: "procfs", readFile: threadProbeReadFile })`,
    }
  }
  return { imports: "", expression: `(${probe})({ kind: "none" })` }
}

// Self-contained by contract: this function is serialized, so it may close over
// nothing outside its own body.
function threadProcessProbe(platform: ThreadProbePlatform): ThreadProcessProbe {
  const unproven: ProcessIdentity = { kind: "unproven" }
  const absent: ProcessIdentity = { kind: "absent" }
  if (platform.kind === "libproc") {
    let api: DarwinProcessApi | undefined
    try {
      api = platform.open()
    } catch {
      // A library that cannot be opened proves nothing about any process.
      api = undefined
    }
    return {
      identify(pid) {
        const query = api?.query(pid)
        if (query?.kind === "process") return { kind: "process", identity: query.identity }
        return query?.kind === "absent" ? absent : unproven
      },
    }
  }
  if (platform.kind === "procfs") {
    // Duplicates parseProcStat and procExited in process-container.ts: this
    // function is serialized into a Worker source string, so it may close
    // over nothing outside its own body.
    const { readFile } = platform
    return {
      identify(pid) {
        let text: string
        try {
          text = readFile(`/proc/${pid}/stat`, "utf8")
        } catch (err) {
          const code = err instanceof Error && "code" in err ? err.code : undefined
          return code === "ENOENT" || code === "ESRCH" ? absent : unproven
        }
        const close = text.lastIndexOf(")")
        if (close < 0) return unproven
        const fields = text.slice(close + 1).trim().split(/\s+/)
        const state = fields[0]
        const pgid = Number(fields[2] ?? Number.NaN)
        const threads = Number(fields[17] ?? Number.NaN)
        const startTime = fields[19]
        if (state === undefined || !Number.isSafeInteger(pgid) || pgid <= 0 || !Number.isSafeInteger(threads) || startTime === undefined) return unproven
        // An exited process that waits to be reaped runs nothing: absent. A
        // group leader whose own thread ended while other threads still run
        // shows the zombie state too, and that process still runs.
        if (state.startsWith("Z") && threads <= 1) return absent
        return { kind: "process", identity: `${pid} ${pgid} ${startTime}` }
      },
    }
  }
  return { identify: () => unproven }
}

const bunSpawnSurface = {
  spawn(argv: readonly string[], options: HostSpawnOptions): HostChild {
    const cmd = [...argv]
    // Two spawn shapes rather than one dynamic stdio tuple: the control pipe is
    // a different child contract, not an option on the same one.
    //
    // windowsHide: an owned payload's streams belong to the launcher, so it has
    // no console to interact through and never wants one. Windows would give it
    // a fresh console anyway if this process holds none, which is what happens
    // whenever Flywheel is started from anything but a terminal, and on Windows
    // that console is a visible window.
    const proc = options.control
      ? Bun.spawn({ cmd, stdio: ["pipe", "pipe", "pipe", "pipe"], cwd: options.cwd, env: options.env, detached: options.detached, windowsHide: true })
      : Bun.spawn({ cmd, stdio: ["pipe", "pipe", "pipe"], cwd: options.cwd, env: options.env, detached: options.detached, windowsHide: true })
    // Bun types stdio slots past stderr as unknown; a "pipe" slot always
    // yields the parent-side descriptor number.
    const control: unknown = options.control ? proc.stdio[3] : undefined
    return {
      pid: proc.pid,
      controlFd: typeof control === "number" ? control : undefined,
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      get exitCode() { return namedExitStatus(proc.exitCode, proc.signalCode).code },
      get signalCode() { return namedExitStatus(proc.exitCode, proc.signalCode).signal },
      unref: () => { proc.unref() },
    }
  },
}

/** The host this process runs on. Built once, and built as the one variant this
 *  platform can be: a Windows host without job objects is not a host at all, so
 *  it is refused here rather than at the first launch that needed one. */
function bunHost(): ProcessHost {
  const base = { ...bunContainerProbe, ...bunSpawnSurface }
  if (process.platform !== "win32") {
    return {
      ...base,
      containers: "process-group",
      readFd: (fd) => Bun.file(fd).stream(),
      writeFd(fd, text) {
        try {
          fs.writeSync(fd, text)
        } catch {
          // The supervisor can exit before the launcher speaks to it, and a
          // request nobody is left to hear is already satisfied.
        }
      },
      closeFd(fd) {
        fs.closeSync(fd)
      },
    }
  }
  const jobs = windowsJobApi()
  if (jobs === undefined) throw new Error("Windows job objects are unavailable, so no container can be owned")
  return { ...base, containers: "job-object", jobs, openControlChannel: bunControlChannel }
}

const bunProcessHost: ProcessHost = bunHost()

/** A named pipe the launcher listens on and its supervisor connects to.
 *
 *  One connection is expected and one is accepted: the name belongs to a single
 *  launch, so a second peer would be something this side did not start. A word
 *  sent before the supervisor connects is held and delivered on connection,
 *  because admission can be decided before the supervisor has finished
 *  starting. */
function bunControlChannel(name: string): ControlChannel {
  let output!: ReadableStreamDefaultController<Uint8Array>
  let outputEnded = false
  const diagnostics = new ReadableStream<Uint8Array>({ start(controller) { output = controller } })
  let peer: { write(bytes: string): void; end(): void } | undefined
  let pending = ""
  // Held apart from `closed` on purpose. A word spoken before the supervisor
  // connects is worth holding, because the supervisor is still arriving. A word
  // spoken after it disconnected is not: the container it was speaking for is
  // already over.
  let listening = true
  let stopped = false
  const settled = (): void => {
    listening = false
    peer = undefined
    pending = ""
    if (!outputEnded) {
      outputEnded = true
      output.close()
    }
  }
  const server = Bun.listen({
    unix: name,
    socket: {
      open(socket) {
        if (peer !== undefined || !listening) {
          socket.end()
          return
        }
        peer = socket
        if (pending.length > 0) {
          socket.write(pending)
          pending = ""
        }
      },
      // A peer that goes away is a container ending, which is not this side's
      // failure. Bun delivers a failed write to this handler; with no handler
      // bound it surfaces as an unhandled exception attributed to the write's
      // call site, which no `try` around that write can intercept.
      error: settled,
      end: settled,
      close: settled,
      data(_socket, bytes) {
        if (!outputEnded) output.enqueue(bytes.slice())
      },
    },
  })
  return {
    diagnostics,
    say(word) {
      if (!listening) return
      if (peer === undefined) {
        pending += word
        return
      }
      try {
        peer.write(word)
      } catch {
        // The supervisor can exit between the disconnect and this write, and a
        // request nobody is left to hear is already satisfied.
        settled()
      }
    },
    supervisorExited() {
      // A connected peer's pipe ends by itself. With none, nothing else ever
      // ends the diagnostics, and the container's settlement waits on them.
      if (peer === undefined) settled()
    },
    close(after) {
      if (after !== undefined) {
        void after.then(() => { this.close() })
        return
      }
      if (stopped) return
      stopped = true
      // A Windows pipe's peer stays open when only its listener stops.
      peer?.end()
      settled()
      server.stop(true)
    },
  }
}

/** The admission protocol, which is the same on every platform: one word that
 *  lets the payload run, said at most once, and a stop that ends the exchange.
 *  Only what carries the word differs, and that is the channel's business. */
function admission(channel: ControlChannel, diagnosticsDrained: Promise<void>): Pick<OwnedLaunch, "admit" | "stop"> {
  let phase: "pending" | "admitted" | "stopped" = "pending"
  const say = (word: "go" | "stop", next: "admitted" | "stopped"): void => {
    if (phase === "stopped") return
    phase = next
    channel.say(`${encodeSupervisorWord({ kind: word })}\n`)
  }
  return {
    admit() {
      if (phase !== "pending") return
      say("go", "admitted")
    },
    stop() {
      say("stop", "stopped")
      channel.close(diagnosticsDrained)
    },
  }
}

/** A pipe from a supervisor that this side can stop reading while a holder
 *  still reads it. A pipe this process reads keeps it running until the
 *  writer closes it, and the writer of a handed-over command's pipe is no
 *  longer this process's to wait for. A holder's read ends as the pipe's end
 *  once this side lets go. */
interface ReleasablePipe {
  readonly stream: ReadableStream<Uint8Array> | undefined
  /** Stops reading: a holder's pending read ends as the pipe's end. */
  release(): void
}

function releasablePipe(source: ReadableStream<Uint8Array> | undefined): ReleasablePipe {
  if (source === undefined) return { stream: undefined, release: () => {} }
  const reader = source.getReader()
  let released = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read()
      if (chunk.done || released) controller.close()
      else controller.enqueue(chunk.value)
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 })
  return {
    stream,
    release() {
      released = true
      void reader.cancel().catch(() => {})
    },
  }
}

/** A launch's supervisor, whose exit is the status the launcher reports. A
 *  launch that may be handed over reads its supervisor's output through pipes
 *  it can let go of. */
function launchedContainer(
  child: HostChild,
  channel: ControlChannel,
  supervised: ManagedContainer,
  options: Pick<ContainerLaunchOptions, "killGraceMs" | "handover" | "diagnostics" | "stopHold" | "onPayloadExit">,
  letGo: () => void,
): OwnedLaunch {
  // A supervisor that died left its payload unattended, and this side's end
  // of it honors the launch's stop hold as the supervisor's own would.
  const container: ManagedContainer = options.stopHold === undefined ? supervised : { ...supervised, stopHold: options.stopHold }
  const diagnostics = options.onPayloadExit === undefined ? options.diagnostics : {
    ...options.diagnostics,
    context: { ...options.diagnostics?.context, onPayloadExit: options.onPayloadExit },
  }
  const diagnosticsDrained = drainSupervisorDiagnostics(channel.diagnostics, child.pid, diagnostics)
  const control = admission(channel, diagnosticsDrained.done)
  const killGraceMs = options.killGraceMs
  const pipe = (source: ReadableStream<Uint8Array> | undefined): ReleasablePipe => (options.handover === true ? releasablePipe(source) : { stream: source, release: () => {} })
  const stdout = pipe(child.stdout)
  const stderr = pipe(child.stderr)
  return {
    ...controlledContainer({
      pid: child.pid,
      stdio: { stdin: child.stdin, stdout: stdout.stream, stderr: stderr.stream },
      gone: child.exited,
      async settle() {
        channel.supervisorExited()
        await diagnosticsDrained.done
        channel.close()
        const status: OwnedExitStatus = { code: child.exitCode, signal: child.signalCode, statusOf: container.populated() ? "supervisor" : "payload" }
        await emptied({ pid: child.pid, container }, killGraceMs, "command supervisor exited with work left", Bun.sleep)
        return status
      },
      say: (line) => { channel.say(line) },
      stop(end) {
        control.stop()
        if (end !== undefined) endAtOnce(container, end)
      },
      letGo() {
        void diagnosticsDrained.release()
        channel.close()
        stdout.release()
        stderr.release()
        child.unref()
        letGo()
      },
    }),
    admit: control.admit,
  }
}

function descriptorChannel(fd: number | undefined, host: ProcessGroupHost): ControlChannel {
  let closed = false
  const diagnostics = fd === undefined ? undefined : host.readFd(fd)
  return {
    diagnostics,
    say(word) {
      if (!closed && fd !== undefined) host.writeFd(fd, word)
    },
    // The supervisor held the other end of the descriptor from its start, so
    // its exit already ended the diagnostics.
    supervisorExited() {},
    close(after) {
      if (after !== undefined) {
        void after.then(() => { this.close() })
        return
      }
      if (closed) return
      closed = true
      if (fd !== undefined) host.closeFd(fd)
    },
  }
}

export function createOwnedProcessBackend(host: ProcessHost = bunProcessHost): OwnedProcessBackend {
  return host.containers === "job-object" ? windowsBackend(host) : unixBackend(host)
}

export const ownedProcessBackend: OwnedProcessBackend = createOwnedProcessBackend()

/** The policy a launch's supervisor runs under. */
function supervisorPolicy(options: ContainerLaunchOptions, guardianIdentity: string, container: CommandSupervisorPolicy["container"]): CommandSupervisorPolicy {
  return {
    lifetime: "guarded",
    killGraceMs: options.killGraceMs,
    guardianPid: options.guardianPid,
    guardianIdentity,
    container,
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.handover === true ? { handover: true } : {}),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stopHold === undefined ? {} : { stopHold: options.stopHold }),
    ...(options.onPayloadExit === undefined ? {} : { onPayloadExit: options.onPayloadExit }),
  }
}

function unixBackend(host: ProcessGroupHost): OwnedProcessBackend {
  const backend: OwnedProcessBackend = {
    launch(command, input) {
      const options = strictDescendantSettlementRequired() ? { ...input, onPayloadExit: "end-descendants" as const } : input
      const guardianIdentity = identifyGuardian(unixProcessIdentity(options.guardianPid, host))
      const child = host.spawn(commandSupervisorArgv(command, supervisorPolicy(options, guardianIdentity, { kind: "process-group" })), {
        cwd: options.cwd,
        // The supervisor and every process the command starts carry the
        // launch's token, which is how ending the command reaches a process
        // that left its group.
        env: markedEnvironment(options.env, options.token, options.onPayloadExit === "end-descendants"),
        detached: true,
        control: true,
      })
      // A process group is named by a pid, so a handed-over launch has no
      // handle to let go of.
      const group = unixContainer(child.pid, host)
      const settlement = options.onPayloadExit === "end-descendants" ? markedContainer(group, child.pid, options.token, host) : group
      return launchedContainer(child, descriptorChannel(child.controlFd, host), settlement, options, () => {})
    },
    reach: (command, killGraceMs) => reachCommand(command, backend, (pid) => unixProcessIdentity(pid, host), killGraceMs),
    async emptyUnserved(command, supervisorIdentity, killGraceMs) {
      // A group is named by its leader's pid, and no process can take that
      // pid while the group still has a member. So a group whose leader is
      // gone holds only what the supervisor left, and a pid that now leads
      // another group, or no group, means the supervisor's group is empty.
      const identity = unixContainerIdentity(command.pid, host)
      if (identity.kind === "unproven") return false
      if (identity.kind === "container") return supervisorIdentity !== undefined && identity.identity !== supervisorIdentity
      if (identity.kind === "absent") await emptied({ pid: command.pid, container: unixContainer(command.pid, host) }, killGraceMs, "handed-over command supervisor exited with work left", Bun.sleep)
      return true
    },
    container: (ref) => unixContainer(ref.pid, host),
    ending: (ref) => markedContainer(unixContainer(ref.pid, host), ref.pid, ref.token, host),
    inspect: (ref) => unixContainerIdentity(ref.pid, host),
    // A process group is named by a pid, so nothing is held to release.
    forget: () => {},
  }
  return backend
}

function windowsBackend(host: JobObjectHost): OwnedProcessBackend {
  const jobs = host.jobs

  // One handle per container, held from the moment this side takes an interest
  // until it releases. Opening a handle per question would be a correctness
  // bug, not just waste: the container dies with its last handle, so a probe
  // that opened and closed one could be the close that kills it. Only an open
  // that succeeded is held, so every other answer is asked again next time.
  const held = new Map<string, WindowsJob>()
  const holding = (ref: ContainerRef): WindowsJobOpen => {
    const job = held.get(ref.token)
    if (job) return { kind: "opened", job }
    const open = jobs.open(windowsContainerName(ref.token))
    if (open.kind === "opened") held.set(ref.token, open.job)
    return open
  }

  const backend: OwnedProcessBackend = {
    launch(command, input) {
      const options = strictDescendantSettlementRequired() ? { ...input, onPayloadExit: "end-descendants" as const } : input
      const guardianIdentity = identifyGuardian(windowsProcessIdentity(options.guardianPid, host))
      // Created before the supervisor exists, so there is no moment where a
      // running process has no container to be ended through.
      // A job whose members' children leave it is created without that
      // limit: its supervisor sets it once the payload runs inside it, so the
      // payload is never outside its container.
      const job = jobs.create(windowsContainerName(options.token), options.priority === undefined ? {} : { priority: options.priority })
      if (job === undefined) throw new Error("the container for this launch could not be created, so nothing may be launched into it")
      held.set(options.token, job)
      const abandon = (): void => {
        job.terminate()
        job.close()
        held.delete(options.token)
      }
      // Opened before the supervisor starts, so the channel it connects to is
      // already listening and a refusal never races a connection.
      const control = host.openControlChannel(windowsControlChannelName(options.token))
      let child: HostChild
      try {
        child = host.spawn(
          commandSupervisorArgv(command, supervisorPolicy(options, guardianIdentity, {
            kind: "job",
            token: options.token,
            ...(options.childrenBreakAway === true ? { childrenBreakAway: true } : {}),
          })),
          // This process's own job ends its members when this process exits.
          // A command that may be handed over, and one whose stop hold its
          // supervisor must carry past that exit, are launched outside it.
          // Their container job, which the supervisor holds open, carries
          // them across the exit, and the supervisor ends that container
          // itself when this process's channel ends.
          { cwd: options.cwd, env: options.onPayloadExit === "end-descendants" ? markedEnvironment(options.env, options.token, true) : options.env, detached: options.handover === true || options.stopHold !== undefined, control: false },
        )
      } catch (err) {
        control.close()
        abandon()
        throw err
      }
      // The supervisor joins the container before it is told anything, so a
      // generation closed between here and admission ends it while the payload
      // has still never run. Everything it starts afterwards joins by itself;
      // in a job whose members' children leave it, the payload joins before
      // the supervisor lets its children leave.
      if (!job.admit(child.pid)) {
        control.close()
        abandon()
        throw new Error("the supervisor could not be put in its container, so its payload may not run unowned")
      }
      // A handed-over container lives on the supervisor's own handle. This
      // side closes its handle and never ends the job.
      return launchedContainer(child, control, windowsJobContainer(job, child.pid), options, () => { backend.forget({ pid: child.pid, token: options.token }) })
    },
    reach: (command, killGraceMs) => reachCommand(command, backend, (pid) => windowsProcessIdentity(pid, host), killGraceMs),
    async emptyUnserved(command) {
      // A job dies with its last handle, and its members die with it. A job
      // that still opens has a holder that may be its supervisor.
      const reachable = backend.inspect(command).kind !== "absent"
      backend.forget(command)
      return !reachable
    },
    container(ref) {
      const open = holding(ref)
      // A container this side cannot reach is one it can prove nothing about,
      // so it reports itself populated rather than surrendering.
      return open.kind === "opened" ? windowsJobContainer(open.job, ref.pid) : { signal: () => {}, populated: () => true }
    },
    // A job holds every process its members start, so ending it reaches
    // everything the command started.
    ending: (ref) => backend.container(ref),
    inspect(ref) {
      // The name is the identity. A container is created once under a token
      // that is never reused, so reaching it at all proves it is the same one,
      // and no creation time has to be compared. Only a name no container
      // holds proves an absence; an open that failed for another reason
      // proves nothing.
      const open = holding(ref)
      if (open.kind === "opened") return { kind: "container", identity: ref.token }
      return open.kind === "not-found" ? { kind: "absent" } : { kind: "unproven" }
    },
    forget(ref) {
      const job = held.get(ref.token)
      if (job === undefined) return
      held.delete(ref.token)
      job.close()
    },
  }
  return backend
}