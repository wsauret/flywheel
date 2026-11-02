import type { LineConnection } from "../../../src/infra/line-channel.js"
import { watchGuardian, type GuardianReads } from "../../../src/infra/guardian-watch.js"
import type { SupervisedTarget, SupervisorPlatform } from "../../../src/infra/owned-command-supervisor.js"
import type { TerminationCause } from "../../../src/infra/process-container.js"

/** The identity of the supervisor's own container, as its platform reads it. */
export const SUPERVISOR_IDENTITY = "7070 7070 1758800000.000001"

/** Lines a test sends, read one per call as a channel reads them, and
 *  undefined once the test ends them. */
function lineQueue() {
  const lines: string[] = []
  const waiting: Array<(line: string | undefined) => void> = []
  let over = false
  const deliver = (): void => {
    for (let waiter = waiting.shift(); waiter !== undefined; waiter = waiting.shift()) {
      if (lines.length === 0 && !over) {
        waiting.unshift(waiter)
        return
      }
      waiter(lines.shift())
    }
  }
  return {
    next: () => new Promise<string | undefined>((resolve) => { waiting.push(resolve); deliver() }),
    push(line: string) { lines.push(line); deliver() },
    end() { over = true; deliver() },
    over: () => over,
  }
}

/** One connection to the channel a handover names, driven by the test the
 *  way a later owner drives it. */
export interface PeerProbe {
  readonly answers: string[]
  readonly closed: () => boolean
  send(line: string): void
  end(): void
}

function peerConnection() {
  const queue = lineQueue()
  const answers: string[] = []
  let settleEnded: () => void = () => {}
  const ended = new Promise<void>((resolve) => { settleEnded = resolve })
  const finish = (): void => {
    queue.end()
    settleEnded()
  }
  const connection: LineConnection = {
    next: queue.next,
    say: (line) => { if (!queue.over()) answers.push(line) },
    close: finish,
    ended,
    closed: ended,
  }
  const probe: PeerProbe = { answers, closed: queue.over, send: queue.push, end: finish }
  return { connection, probe }
}

/** A supervisor's process as bookkeeping: the launcher's channel, the stop
 *  signals, the guardian watches, the served channel, the live-build
 *  registration and a container without processes. The payload ends on the
 *  first TERM its container gets unless a case says it ignores signals.
 *
 *  A case that names `guardianReads` gets the real guardian watch over those
 *  reads; every other case loses a guardian only when it says so. The payload
 *  reports `usage` once it exited, or no usage when the case names none. */
export function platformProbe(options: { readonly stubborn?: boolean; readonly guardianReads?: GuardianReads; readonly usage?: ReturnType<SupervisedTarget["usage"]> } = {}) {
  const events: string[] = []
  const signals: string[] = []
  /** Each signal the container got, with the cause it was sent for. */
  const decisions: Array<{ readonly signal: string; readonly cause: TerminationCause }> = []
  const launcher = lineQueue()
  const watchLosses = new Map<number, (proof: TerminationCause) => void>()
  let stopSignal: ((signal: NodeJS.Signals) => void) | undefined
  let accept: ((connection: LineConnection) => void) | undefined
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  let running = false
  let settleTarget: () => void = () => {}
  const exited = new Promise<void>((resolve) => { settleTarget = resolve })
  const exitTarget = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!running) return
    running = false
    exitCode = code
    signalCode = signal
    settleTarget()
  }
  const base: Omit<SupervisorPlatform, "ending"> = {
    nextLauncherWord: launcher.next,
    onStopSignal: (listener) => { stopSignal = listener },
    watchGuardian(guardian, onLost) {
      events.push(`watch ${guardian.pid}`)
      watchLosses.set(guardian.pid, onLost)
      const cancelWatch = options.guardianReads === undefined ? () => {} : watchGuardian({ ...guardian, ...options.guardianReads, onLost, intervalMs: 1 })
      return () => {
        cancelWatch()
        if (watchLosses.delete(guardian.pid)) events.push(`cancel ${guardian.pid}`)
      }
    },
    serveChannel(address, onConnection) {
      events.push(`serve ${address}`)
      accept = onConnection
      return { stop: () => { events.push("unserve") } }
    },
    registerLiveBuild(userDataRoot) {
      events.push(`register ${userDataRoot}`)
      return Promise.resolve(() => { events.push("withdraw") })
    },
    suppressDiagnostics: () => { events.push("suppress") },
    containerIdentity: () => SUPERVISOR_IDENTITY,
    establishPriority: () => true,
    start(stdin) {
      events.push(`start ${stdin}`)
      running = true
      return { exited, get exitCode() { return exitCode }, get signalCode() { return signalCode }, usage: () => running ? undefined : options.usage }
    },
    container: {
      signal(signal, cause) {
        signals.push(signal)
        decisions.push({ signal, cause })
        if (options.stubborn !== true) exitTarget(null, signal)
      },
      populated: () => running,
    },
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
  }
  // The probe's container holds the payload alone, so ending it reaches the same processes.
  const platform: SupervisorPlatform = { ...base, ending: base.container }
  return {
    platform,
    events,
    signals,
    decisions,
    say: launcher.push,
    endLauncher: launcher.end,
    /** Delivers a stop signal, as the process would get one. */
    signalStop(signal: NodeJS.Signals) { stopSignal?.(signal) },
    loseGuardian(pid: number) { watchLosses.get(pid)?.({ reason: "guardian exited", evidence: { guardianPid: pid } }) },
    connect(): PeerProbe {
      const peer = peerConnection()
      if (accept === undefined) throw new Error("nothing serves the handover channel")
      accept(peer.connection)
      return peer.probe
    },
    exitTarget,
  }
}

export type PlatformProbe = ReturnType<typeof platformProbe>
