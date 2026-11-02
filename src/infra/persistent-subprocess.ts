import { randomUUID } from "node:crypto"
import { close, closeSync, statSync, writeSync } from "node:fs"
import { promisify } from "node:util"

import { markedEnvironment, unmarkedEnvironment, strictDescendantSettlementRequired } from "./container-mark.js"

import { emptyContainers, unixProcessIdentity, windowsProcessIdentity, windowsContainer, bunContainerProbe, type ProcessIdentity } from "./process-container.js"
import { encodeSupervisorWord } from "./command-handover.js"
import { commandSupervisorArgv } from "./owned-command-policy.js"
import {
  createPersistentSpool,
  readPersistentSpool,
  recordSpoolHolders,
  removePersistentSpool,
  spoolHolder,
  sweepPersistentSpools,
  type PersistentRead,
  type PersistentSpool,
  type SpoolHolder,
  type SpoolHolders,
  type WritablePersistentSpool,
} from "./persistent-spool.js"
import { withDeadline } from "./with-deadline.js"
import { drainSupervisorDiagnostics } from "./process-diagnostic-reader.js"

interface PersistentEnvironment {
  readonly [name: string]: string | undefined
}

interface PersistentLaunchRequest {
  readonly command: readonly string[]
  readonly cwd: string | undefined
  readonly env: PersistentEnvironment | undefined
  readonly stdin: "ignore"
  readonly stdoutFd: number
  readonly stderrFd: number
  readonly detached: true
}

interface PersistentChild {
  readonly pid: number
  readonly exited: Promise<number>
  readonly kill?: (signal?: NodeJS.Signals) => void
  unref(): void
}

interface PosixPersistentChild extends PersistentChild {
  readonly control: {
    readonly drained: Promise<void>
    write(word: string): Promise<void>
    close(): Promise<void>
  }
}

interface PersistentPlatformBase {
  /** Synchronous, so a launch reaches its spawn in the caller's turn. */
  createSpool(): WritablePersistentSpool
  /** Asynchronous, so the host's event loop turns between the spawn and the
   *  work that follows it, and a launch never holds the loop for its whole
   *  length. */
  closeSpool(spool: WritablePersistentSpool): Promise<void>
  /** Replaces the record of the processes that hold the spool. */
  holdSpool(directory: string, holders: SpoolHolders): void
  removeSpool(directory: string): void
  /** Removes the spools of earlier launches that nobody holds any more. It
   *  never rejects. */
  sweepSpools(): Promise<void>
  /** The start identity of the process `pid` now. */
  inspect(pid: number): Promise<ProcessIdentity>
  cleanup(child: PersistentChild, spool: WritablePersistentSpool): void
  spoolBytes(path: string): number
  now(): number
}

interface UnsupportedPersistentSubprocessPlatform {
  readonly kind: "unsupported"
}

export interface PosixPersistentSubprocessPlatform extends PersistentPlatformBase {
  readonly kind: "posix"
  launch(request: PersistentLaunchRequest): Promise<PosixPersistentChild>
  waitForSupervisorExit(child: PersistentChild, timeoutMs: number): Promise<boolean>
}

export interface WindowsPersistentSubprocessPlatform extends PersistentPlatformBase {
  readonly kind: "windows"
  launch(request: PersistentLaunchRequest): Promise<PersistentChild>
  stopContainer(pid: number, identity: string): Promise<PersistentStopOutcome | void>
}

type PersistentSubprocessPlatform =
  | UnsupportedPersistentSubprocessPlatform
  | PosixPersistentSubprocessPlatform
  | WindowsPersistentSubprocessPlatform

export interface PersistentLaunchData {
  readonly cwd?: string
  readonly env?: PersistentEnvironment
  /** The command supervises its own lifetime and process tree, as Flywheel's
   *  own runtime does: it is launched detached with the retained spools but
   *  without the command supervisor in front of it, so no second process
   *  starts ahead of it. A stop then signals the process itself and waits
   *  for its own ordered exit, and there is no process group to settle. */
  readonly selfManaged?: boolean
}

export interface PersistentLaunchOptions extends PersistentLaunchData {
  readonly platform?: PersistentSubprocessPlatform
}

export interface PersistentProcessMetadata {
  readonly startedAtMs: number
  readonly status: "running" | "exited"
  readonly stdoutBytes: number
  readonly stderrBytes: number
}

type PersistentStopOutcome = "terminated" | "unsettled"

export interface PersistentSubprocess {
  readonly pid: number
  readonly command: readonly string[]
  readonly spool: PersistentSpool
  readonly exited: Promise<number>
  metadata(): PersistentProcessMetadata
  read(stream: "stdout" | "stderr", offset: number, maxBytes: number): PersistentRead
  /** Requests termination of the captured process container. */
  stop(): Promise<PersistentStopOutcome>
  /** Surrenders host management without terminating the process. Its
   *  retained output stays while the process runs and is removed once it has
   *  exited, because nobody can read it after this call. */
  release(): void
}

const closeDescriptor = promisify(close)

const supportedPlatformBase: Omit<PersistentPlatformBase, "inspect"> & Pick<PosixPersistentSubprocessPlatform, "launch"> = {
  createSpool: () => createPersistentSpool(),
  async closeSpool(spool) {
    await Promise.all([closeDescriptor(spool.stdoutFd), closeDescriptor(spool.stderrFd)])
  },
  holdSpool: recordSpoolHolders,
  removeSpool: removePersistentSpool,
  sweepSpools: () => sweepPersistentSpools(),
  async launch(request) {
    const child = Bun.spawn({
      cmd: [...request.command],
      cwd: request.cwd,
      env: request.env,
      stdio: [request.stdin, request.stdoutFd, request.stderrFd, "pipe"],
      detached: request.detached,
      windowsHide: true,
    })
    const controlFd: unknown = child.stdio[3]
    if (typeof controlFd !== "number") {
      child.kill("SIGKILL")
      await child.exited
      throw new Error("persistent supervisor control authority is unavailable")
    }
    let controlClosed = false
    const diagnostics = drainSupervisorDiagnostics(Bun.file(controlFd).stream(), child.pid)
    const control = {
      drained: diagnostics.done,
      async write(word: string) {
        writeSync(controlFd, `${word}\n`)
      },
      async close() {
        if (controlClosed) return
        controlClosed = true
        await diagnostics.release()
        closeSync(controlFd)
      },
    }
    return { pid: child.pid, exited: child.exited, control, kill: (signal) => { child.kill(signal) }, unref: () => { child.unref() } }
  },
  cleanup(child, spool) {
    try { child.kill?.("SIGKILL") } catch { /* the child may have exited before identity was read */ }
    removePersistentSpool(spool.directory)
  },
  spoolBytes: (path) => statSync(path).size,
  now: Date.now,
}

const persistentSubprocessPlatform: PersistentSubprocessPlatform = process.platform === "win32"
  ? {
      ...supportedPlatformBase,
      kind: "windows",
      async launch(request) {
        const child = Bun.spawn({ cmd: [...request.command], cwd: request.cwd, env: request.env, stdio: [request.stdin, request.stdoutFd, request.stderrFd], detached: request.detached, windowsHide: true })
        return { pid: child.pid, exited: child.exited, kill: (signal) => { child.kill(signal) }, unref: () => { child.unref() } }
      },
      async inspect(pid) { return windowsProcessIdentity(pid) },
      async stopContainer(pid, expectedIdentity) { return await stopWindowsContainer(pid, expectedIdentity) },
    }
  : process.platform === "darwin" || process.platform === "linux"
    ? {
        ...supportedPlatformBase,
        kind: "posix",
        async inspect(pid) { return unixProcessIdentity(pid) },
        // The account service and the commands that launch it end by
        // returning, so a timer left armed after the exit would hold them
        // open for the rest of the stop grace. `withDeadline` clears it.
        async waitForSupervisorExit(child, timeoutMs) {
          return await withDeadline(child.exited, timeoutMs).then(() => true, () => false)
        },
      }
    : { kind: "unsupported" }

/** Starts an explicitly authorized process that can outlive Flywheel. Unsupported hosts fail before filesystem or launch effects. */
export async function launchPersistentSubprocess(command: readonly string[], options: PersistentLaunchOptions = {}): Promise<PersistentSubprocess> {
  const platform = options.platform ?? persistentSubprocessPlatform
  if (platform.kind === "unsupported") throw new Error(`persistent processes are not supported on ${process.platform}`)
  if (command.length === 0) throw new Error("persistent process command is empty")
  const startedAtMs = platform.now()

  // Nothing before the spawn yields: whatever the caller runs next, even a
  // long synchronous import, starts after this process is already starting.
  const spool = platform.createSpool()
  const supervised = platform.kind === "posix" && options.selfManaged !== true
  // A persistent process outlives the container of the process that starts
  // it, so it never carries that container's mark. A supervised one is a
  // container of its own, and its stop reaches what it started by its own
  // mark. Windows has no marks: a job object holds its members.
  const persistentEnv = platform.kind === "posix" || strictDescendantSettlementRequired() ? unmarkedEnvironment(options.env) : options.env
  const env = supervised ? markedEnvironment(persistentEnv, `persistent:${randomUUID()}`, false) : persistentEnv
  let child: PersistentChild
  let control: PosixPersistentChild["control"] | undefined
  try {
    const launchedCommand = supervised
      ? commandSupervisorArgv(command, { lifetime: "persistent", killGraceMs: WINDOWS_STOP_GRACE_MS, container: { kind: "process-group" } })
      : command
    if (platform.kind === "posix") {
      const launched = await platform.launch({ command: launchedCommand, cwd: options.cwd, env, stdin: "ignore", stdoutFd: spool.stdoutFd, stderrFd: spool.stderrFd, detached: true })
      child = launched
      // A self-managed command reads no admission; its control end closes at once.
      if (supervised) control = launched.control
      else void launched.control.close()
    } else {
      child = await platform.launch({ command: launchedCommand, cwd: options.cwd, env, stdin: "ignore", stdoutFd: spool.stdoutFd, stderrFd: spool.stderrFd, detached: true })
    }
  } catch (error) {
    try { await platform.closeSpool(spool) } catch { /* preserve the launch error */ }
    throw error
  }
  // The launcher holds the spool because it reads it, and the child holds it
  // because it writes it. Both are recorded before a supervised payload is
  // admitted, so from here on a launcher that dies leaves a spool that a
  // sweep can still prove free once the writer is gone too.
  let writer: SpoolHolder
  let identity: string | undefined
  try {
    await platform.closeSpool(spool)
    const [launcherIdentity, writerIdentity] = await Promise.all([platform.inspect(process.pid), platform.inspect(child.pid)])
    if (platform.kind === "windows") {
      // A Windows stop acts only on the process this identity names.
      if (writerIdentity.kind !== "process") throw new Error("persistent process identity could not be proven")
      identity = writerIdentity.identity
    }
    writer = spoolHolder(child.pid, writerIdentity)
    platform.holdSpool(spool.directory, { launcher: spoolHolder(process.pid, launcherIdentity), writer })
  } catch (error) {
    if (control !== undefined) void control.close()
    platform.cleanup(child, spool)
    throw error
  }

  if (supervised) {
    const channel = control
    if (channel === undefined) throw new Error("persistent supervisor control authority is unavailable")
    try {
      await channel.write(encodeSupervisorWord({ kind: "go" }))
    } catch (error) {
      try { await channel.close() } catch { /* preserve admission failure */ }
      await child.exited
      platform.cleanup(child, spool)
      throw error
    }
  }
  let released = false
  let status: PersistentProcessMetadata["status"] = "running"
  let stopping: Promise<PersistentStopOutcome> | undefined
  const exited = control === undefined ? child.exited : child.exited.then(async (code) => {
    await control?.drained
    await control?.close()
    status = "exited"
    return code
  })
  if (control === undefined) void exited.then(() => { status = "exited" })

  const stop = (): Promise<PersistentStopOutcome> => {
    if (released) return Promise.reject(new Error("persistent process was released"))
    if (stopping) return stopping
    const operation = platform.kind === "posix"
      ? (async (): Promise<PersistentStopOutcome> => {
          if (supervised) {
            const channel = control
            if (channel === undefined) throw new Error("persistent supervisor control authority is unavailable")
            await channel.write(encodeSupervisorWord({ kind: "stop" }))
          } else {
            child.kill?.("SIGTERM")
          }
          return await platform.waitForSupervisorExit({ ...child, exited }, WINDOWS_STOP_GRACE_MS + SUPERVISOR_EXIT_MARGIN_MS)
            ? "terminated"
            : "unsettled"
        })()
      : (async (): Promise<PersistentStopOutcome | void> => {
      const inspectedNow = await platform.inspect(child.pid)
      if (inspectedNow.kind === "absent") return "unsettled"
      // An identity nobody could read proves neither that the pid still holds
      // this process nor that it holds another, so the stop refuses with that
      // reason and ends nothing.
      if (inspectedNow.kind === "unproven") throw new Error("the process could not be identified")
      if (inspectedNow.identity !== identity) throw new Error("process identity changed")
      return await platform.stopContainer(child.pid, identity)
    })()
    const shared = operation.then((outcome) => outcome ?? "terminated").finally(() => {
      if (stopping === shared) stopping = undefined
    })
    stopping = shared
    return shared
  }

  const removeReleasedSpool = (): void => {
    try {
      platform.removeSpool(spool.directory)
    } catch {
      // A file a descendant still holds open can refuse removal on Windows;
      // a later sweep removes the spool once it can.
    }
  }
  void platform.sweepSpools()

  return {
    pid: child.pid,
    command: [...command],
    spool: { directory: spool.directory, stdoutPath: spool.stdoutPath, stderrPath: spool.stderrPath },
    exited,
    metadata() {
      return {
        startedAtMs,
        status,
        stdoutBytes: platform.spoolBytes(spool.stdoutPath),
        stderrBytes: platform.spoolBytes(spool.stderrPath),
      }
    },
    read(stream, offset, maxBytes) {
      return readPersistentSpool(stream === "stdout" ? spool.stdoutPath : spool.stderrPath, offset, maxBytes)
    },
    stop,
    release() {
      if (released) return
      released = true
      if (control !== undefined) void control.close()
      child.unref()
      // This launcher reads the spool no more. A writer that already exited
      // leaves nobody to hold it, and one that still runs holds it alone from
      // now on. Whoever sees that writer exit removes the spool: this process
      // while it runs, and otherwise the next persistent launch's sweep.
      if (status === "exited") {
        removeReleasedSpool()
        return
      }
      try {
        platform.holdSpool(spool.directory, { writer })
      } catch {
        // The record still names this launcher, and a sweep proves its exit too.
      }
      void exited.then(removeReleasedSpool, removeReleasedSpool)
    },
  }
}

const WINDOWS_STOP_GRACE_MS = 5_000
/** How long a POSIX stop waits for the supervisor beyond the grace it spends
 *  on its own escalation, so a supervisor that used the whole grace can still
 *  exit and report. */
const SUPERVISOR_EXIT_MARGIN_MS = 250

/** Ends the tree of a Windows persistent process whose identity is still the
 *  one launched. The tree is settled like any container, through one bounded
 *  escalation that ends each member through a handle whose creation time was
 *  checked, so the stop is `terminated` only when every member is proven gone. */
async function stopWindowsContainer(pid: number, expectedIdentity: string): Promise<PersistentStopOutcome> {
  const initial = windowsProcessIdentity(pid)
  if (initial.kind === "absent") return "unsettled"
  if (initial.kind === "unproven") throw new Error("the process could not be identified")
  if (initial.identity !== expectedIdentity) throw new Error("process identity changed")
  const tree = windowsContainer(pid, bunContainerProbe, expectedIdentity)
  const settlement = await emptyContainers([tree], WINDOWS_STOP_GRACE_MS, Bun.sleep, { reason: "persistent process stop" })
  return settlement.kind === "empty" ? "terminated" : "unsettled"
}
