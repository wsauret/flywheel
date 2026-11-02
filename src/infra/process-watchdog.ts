import { createBoundedWorkerSpawner, embeddedWorkerSpawnerSource } from "./bounded-worker-spawner.js"
import { HARD_EXIT_CLOCK_URL } from "./hard-exit-clock.js"
import { threadProcessProbeSource, type ThreadProcessProbe } from "./owned-subprocess-backend.js"
import { terminationRecordLine, type TerminationDecision } from "./process-container.js"
import { terminateWorker } from "./worker-termination.js"
import { withDeadline } from "./with-deadline.js"
import { Log } from "./log.js"

const log = Log.create({ service: "process-watchdog" })

const PARENT_CHECK_MS = 2_000
const DEFAULT_HARD_EXIT_MS = 30_000
/** How long a dispose acknowledgement is waited for before the Worker is
 *  terminated regardless. */
const DISPOSE_ACKNOWLEDGE_MS = 500
const spawnProcessWatchdogWorker = createBoundedWorkerSpawner("process-watchdog")

type ProcessWatchdogMessage =
  | { readonly kind: "init"; readonly processPid: number; readonly parentPid: number; readonly containerPid: number; readonly hardExitMs: number }
  | { readonly kind: "arm"; readonly armedBy: string }
  | { readonly kind: "dispose" }

interface ProcessWatchdogWorker {
  postMessage(message: ProcessWatchdogMessage, transfer?: readonly unknown[]): void
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  addEventListener(type: "open" | "close", listener: () => void, options?: { once: boolean }): void
  terminate(): void
}

/** Watches this process only. External processes are contained by the process
 *  guardian, which survives a crash of this process; the watchdog's hard-exit
 *  clock covers a bounded shutdown of the host itself. */
export interface ProcessWatchdog {
  /** Starts the hard-exit clock. `armedBy` names what began the shutdown,
   *  such as "account stop", and the clock's termination decision names it
   *  as evidence. The default is "host requested shutdown". */
  arm(armedBy?: string): void
  dispose(): Promise<void>
}

interface ProcessWatchdogOptions {
  readonly processPid?: number
  readonly parentPid?: number
  /** The pid of the process that leads the watched process's container, which
   *  the clock's termination decision names as `container`. A process that a
   *  command supervisor launched passes that supervisor's pid, so the process
   *  that drains the supervisor's output matches the decision to its launch.
   *  The default is the watched process's own pid: a lone process is its own
   *  container. */
  readonly containerPid?: number
  readonly hardExitMs?: number
  /** Fired once on the main thread when the spawning parent process vanishes,
   *  so the host can attempt its ordered graceful exit. The Worker's hard-exit
   *  clock is already armed by then - this callback races it, never gates it. */
  readonly onParentDeath?: () => void
  readonly createWorker?: () => ProcessWatchdogWorker
}

let installed: ProcessWatchdog | null = null

/** A separate Bun Worker owns the hard-exit clock. Renderer/runtime cleanup can
 * block either application thread, but it cannot stop this thread from asking
 * the OS to terminate the process after the bounded durability window. The
 * same Worker watches the spawning terminal process, so a lost terminal still
 * arms the deadline even when the TUI thread is wedged before handling SIGHUP.
 *
 * Exported because the real-I/O integration test must construct an isolated
 * watchdog with a short deadline. The installed singleton cannot safely test
 * the hard-exit invariant without terminating the test runner. */
export function createProcessWatchdog(options: ProcessWatchdogOptions = {}): ProcessWatchdog {
  const worker = (options.createWorker ?? createWorker)()
  const onParentDeath = options.onParentDeath
  let acknowledgeDispose = (): void => {}
  const disposeAcknowledged = new Promise<void>((resolve) => { acknowledgeDispose = resolve })
  worker.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data
    if (typeof data !== "object" || data === null || !("kind" in data)) return
    if (data.kind === "parent-died") onParentDeath?.()
    if (data.kind === "disposed") acknowledgeDispose()
  })
  const processPid = options.processPid ?? process.pid
  const hardExitMs = options.hardExitMs ?? DEFAULT_HARD_EXIT_MS
  worker.postMessage({
    kind: "init",
    processPid,
    parentPid: options.parentPid ?? process.ppid,
    containerPid: options.containerPid ?? processPid,
    hardExitMs,
  }, [])
  let armed = false
  let disposed = false

  return {
    arm(armedBy = "host requested shutdown") {
      if (armed || disposed) return
      armed = true
      log.info("process watchdog armed", { senderPid: process.pid, targetPid: processPid, hardExitMs, armedBy, caller: new Error("process watchdog armed").stack?.split("\n").slice(1, 5).join("\n") })
      worker.postMessage({ kind: "arm", armedBy }, [])
    },
    async dispose() {
      if (disposed) return
      disposed = true
      worker.postMessage({ kind: "dispose" }, [])
      // A project executor and the account service dispose their watchdog
      // last and then end by returning, so the bound must clear its timer
      // once the acknowledgement arrives.
      await withDeadline(disposeAcknowledged, DISPOSE_ACKNOWLEDGE_MS).catch(() => undefined)
      await terminateWorker(worker)
    },
  }
}

export function installProcessWatchdog(onParentDeath?: () => void, hardExitMs?: number): void {
  if (installed) throw new Error("process watchdog is already installed")
  installed = createProcessWatchdog({ onParentDeath, hardExitMs })
}

export function armProcessWatchdog(): void {
  installed?.arm()
}


function createWorker(): ProcessWatchdogWorker {
  const probe = threadProcessProbeSource()
  const source = `${probe.imports} import { writeSync } from "node:fs"; (${processWatchdogThread.toString()})(${PARENT_CHECK_MS}, ${probe.expression}, ${embeddedWorkerSpawnerSource("hard-exit-clock")}, ${JSON.stringify(HARD_EXIT_CLOCK_URL)}, (text) => writeSync(2, text), ${terminationRecordLine.toString()})`
  const workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
  const worker = spawnProcessWatchdogWorker(workerUrl, {
    name: "flywheel-process-watchdog",
    ref: false,
    smol: true,
  })
  worker.addEventListener("open", () => URL.revokeObjectURL(workerUrl), { once: true })
  return worker
}

/** What the watchdog thread uses of its hard-exit clock's Worker. */
interface HardExitClock {
  postMessage(message: HardExitClockArm, transfer: readonly unknown[]): void
  addEventListener(type: "close", listener: () => void, options: { once: boolean }): void
  terminate(): void
}

/** The clock's one message: once `delayMs` passes, write `decision` on fd 2,
 *  then kill `target`. */
interface HardExitClockArm {
  readonly target: number
  readonly delayMs: number
  readonly decision: string
}

/** The watchdog Worker's body, serialized into its source, so it closes over
 *  nothing outside itself. `terminationLine` is `terminationRecordLine`,
 *  serialized with it.
 *
 *  @public
 *  `tests/helpers/process-watchdog-thread.ts` runs it on the test thread with
 *  a scripted probe and a clock that never fires. Knip does not trace tests
 *  into the production project, so this export is not dead. */
export function processWatchdogThread(
  parentCheckMs: number,
  probe: ThreadProcessProbe,
  spawnHardExitClock: (specifier: string, options?: WorkerOptions) => HardExitClock,
  clockUrl: string,
  writeDiagnostic: (text: string) => void,
  terminationLine: (decision: TerminationDecision) => string,
): void {
  let processPid = 0
  let parentPid = 0
  let containerPid = 0
  let parentIdentity: string | undefined
  let hardExitMs = 0
  let hardExitClock: HardExitClock | undefined
  let armed = false

  // The parent is lost only on proof: the kernel reports it exited, or its pid
  // now holds another process. The first identity that answers is the one
  // every later answer is compared with, so a parent nobody could identify at
  // init can still be proven replaced later. An identity nobody could read
  // falls back to signal zero, where only ESRCH proves the pid free.
  const parentIsAlive = (): boolean => {
    const current = probe.identify(parentPid)
    if (current.kind === "absent") return false
    if (current.kind === "process") {
      parentIdentity ??= current.identity
      return current.identity === parentIdentity
    }
    try {
      process.kill(parentPid, 0)
      return true
    } catch (error) {
      return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
    }
  }

  // The clock thread is created at init and stays idle until an arm message
  // starts its countdown. Spawning it lazily at arm time crashed the whole
  // process on Linux: arming happens during shutdown, shutdown is exactly when
  // a harness or user may have deleted the process's working directory, and
  // Bun panics (CurrentWorkingDirectoryUnlinked, SIGILL) when a Worker starts
  // with an unlinked cwd - even for a data: URL. At init the cwd still exists.
  const ensureClock = (): void => {
    if (hardExitClock || processPid <= 0 || hardExitMs <= 0) return
    hardExitClock = spawnHardExitClock(clockUrl, { name: "flywheel-hard-exit-clock", ref: false, smol: true })
  }

  // The clock records the decision to kill only when the bound expires, just
  // before the kill, so a clock disposed in time records nothing. The
  // decision does not go through recordTermination: a process that loads the
  // process supervisor routes that to its own log file, and the process that
  // launched this one reads only this one's stderr. Answers whether this call
  // armed the clock.
  const arm = (armedBy: string): boolean => {
    if (armed || !hardExitClock || processPid <= 0 || hardExitMs <= 0) return false
    armed = true
    const decision = terminationLine({ senderPid: process.pid, container: containerPid, target: processPid, signal: "SIGKILL", reason: "shutdown bound expired", evidence: { boundMs: hardExitMs, armedBy } })
    hardExitClock.postMessage({ target: processPid, delayMs: hardExitMs, decision }, [])
    return true
  }

  addEventListener("message", (event: MessageEvent<ProcessWatchdogMessage>) => {
    const message = event.data
    if (message.kind === "arm") {
      arm(message.armedBy)
      return
    }
    if (message.kind === "dispose") {
      const clock = hardExitClock
      hardExitClock = undefined
      if (!clock) {
        postMessage({ kind: "disposed" })
        return
      }
      clock.addEventListener("close", () => postMessage({ kind: "disposed" }), { once: true })
      clock.terminate()
      return
    }
    processPid = message.processPid
    parentPid = message.parentPid
    containerPid = message.containerPid
    const initial = probe.identify(parentPid)
    parentIdentity = initial.kind === "process" ? initial.identity : undefined
    hardExitMs = message.hardExitMs
    ensureClock()
    if (parentPid <= 1) return
    const parentCheck = setInterval(() => {
      if (parentIsAlive()) return
      clearInterval(parentCheck)
      postMessage({ kind: "parent-died" })
      // The host records its own request to arm ("process watchdog armed");
      // this thread records the arming it decided itself.
      if (!arm("parent process lost")) return
      try {
        writeDiagnostic(JSON.stringify({ type: "log.info", payload: { service: "process-watchdog", message: "hard-exit clock armed", senderPid: process.pid, targetPid: processPid, parentPid, hardExitMs, armedBy: "parent process lost" } }) + "\n")
      } catch { /* The parent may have closed the diagnostic pipe. */ }
    }, parentCheckMs)
  })
}
