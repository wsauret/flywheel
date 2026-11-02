import { existsSync } from "node:fs"
import type { ServeLane } from "../../infra/cli-subprocess.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { isProcessAlive } from "../../infra/process-liveness.js"
import type { ReplacementHandoff, ReplacementHandoffStore } from "./account-project-registry.js"
import { restartBackoffMs } from "./project-executor-generations.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS } from "./runtime-shutdown.js"
import type { SuccessorRows } from "./project-executor-protocol.js"
import { projectServingPids } from "./project-serving-lane.js"

const log = Log.create({ service: "replacement-handoffs" })

/** One project's half of a handoff, as its executor answers it. */
interface HandoffComposition {
  handoff(kind: "interrupt_for_replacement" | "continue_after_replacement", handoffId: string): Promise<readonly string[]>
}

/** One open project as both halves of a handoff reach it. */
interface HandoffProject {
  readonly composition: HandoffComposition
  readonly holdClient: () => () => void
  /** Whether a surface holds the project now. */
  readonly held: () => boolean
  /** Serves the project's browser endpoint, at the project's own address
   *  when that is free, which is the one address a browser page redials. */
  readonly openBrowser: () => Promise<string>
}

export interface ReplacementHandoffsOptions {
  readonly lane: ServeLane
  readonly registry: ReplacementHandoffStore
  /** Every project that is open now, by its root. */
  readonly openProjects: () => ReadonlyMap<string, HandoffProject>
  /** Opens a project, or answers the one that is open. */
  readonly open: (projectRoot: string) => Promise<HandoffProject>
  /** Whether the account holds `projectRoot` awake for the phone now. */
  readonly awakeForPhone: (projectRoot: string) => boolean
  /** Holds a continued project awake for the phone until it closes, because
   *  the previous build held it awake for the phone while it handed commands
   *  over there. */
  readonly holdAwakeForPhone: (projectRoot: string) => Promise<void>
  /** The wait before a continuation's next attempt after `failures` failures
   *  in a row. Defaults to the executor restart backoff. */
  readonly retryDelayMs?: (failures: number) => number
  /** The longest wait for a predecessor that still serves a named project.
   *  Defaults to the account's drain bound. */
  readonly predecessorBoundMs?: number
}

export interface ReplacementHandoffs {
  /** The predecessor's half of a planned replacement (ARCH-RUNTIME-032): records the
   *  row of `handoffId`, before its first await, and cuts the running work of
   *  every open project under it. */
  handOff(handoffId: string): Promise<void>
  /** Adds `projectRoot` to the row this service recorded. An executor that
   *  serves while the handoff exists joins before it hears the handoff, so
   *  work admitted after the cut is continued too. */
  join(projectRoot: string): Promise<void>
  /** A project's executor stopped after the cut and counted the rows the
   *  handoff holds there for the successor: a continuation row per session
   *  to resume and a handover row per command to adopt. A project with none,
   *  which no surface held at the cut, leaves the row, so the successor
   *  opens only projects with work to continue, a command to adopt, or a
   *  surface to serve again (PI-REMOTE-013). A project the phone held awake
   *  at the cut that hands commands over is named as held awake too.
   *  Answers true only when the recorded row still names the project. */
  stopped(projectRoot: string, rows: SuccessorRows): Promise<boolean>
  /** Synchronously reads whether this service's persisted handoff still names the project. */
  recoveryPending(projectRoot: string): boolean
  /** Predecessors whose handoff still names this project, excluding our own. */
  predecessorPids(projectRoot: string): readonly number[]
  /** The successor's half, run once after the service listens: one
   *  continuation duty for each project a predecessor's row names, which
   *  retries until that project serves again and has continued. Resolves
   *  once every duty has ended. */
  continueAll(): Promise<void>
  /** Ends every continuation duty; the rows stay for the next start. */
  dispose(): void
}

/** The account's two halves of a planned replacement, over the handoff rows
 *  in the account store and the executors of the projects they name. */
export function createReplacementHandoffs(options: ReplacementHandoffsOptions): ReplacementHandoffs {
  const { lane, registry } = options
  const retryDelayMs = options.retryDelayMs ?? restartBackoffMs
  const predecessorBoundMs = options.predecessorBoundMs ?? ACCOUNT_DRAIN_HARD_EXIT_MS
  // The handoffs this process recorded. It never continues one of them: the
  // work they name runs here until this process stops. A successor started
  // through execve has the same pid and an empty set, so it continues the
  // rows its previous image left.
  const recorded = new Set<string>()
  const disposal = new AbortController()

  // Row writes are read-modify-write, so they run one at a time: two
  // projects of one handoff never lose each other's update.
  let rowWrites = Promise.resolve()
  const writeRow = (write: () => Promise<void>): Promise<void> => {
    const next = rowWrites.then(write)
    rowWrites = next.catch(() => {})
    return next
  }

  // The row this service recorded, which only this service writes while it
  // lives: a successor waits for this process to stop serving the projects
  // it names before it reads the row. `heldAtCut` is the projects a surface
  // held at the cut, which stay named with no work to continue: a browser
  // page redials only its project's own address, so the successor must
  // serve the project again for the page to find it. `awakeAtCut` is the
  // projects the phone held awake at the cut; one that hands commands over
  // joins `phoneAwakeRoots`, which the successor holds awake the same way.
  let own: {
    readonly handoffId: string
    readonly requestedAt: number
    readonly projectRoots: Set<string>
    readonly heldAtCut: ReadonlySet<string>
    readonly awakeAtCut: ReadonlySet<string>
    readonly phoneAwakeRoots: Set<string>
  } | undefined
  const recordOwn = (): Promise<void> => {
    const row = own
    if (row === undefined) return Promise.resolve()
    const snapshot = { handoffId: row.handoffId, requestedAt: row.requestedAt, predecessorPid: process.pid, projectRoots: [...row.projectRoots], phoneAwakeRoots: [...row.phoneAwakeRoots] }
    return writeRow(() => registry.recordReplacementHandoff(lane, snapshot))
  }

  /** The row names every project open at the cut before any is cut, so a
   *  crash mid-way still leaves the successor what was cut. It is written
   *  even with no project open, because a project that opens before this
   *  service stops joins it. */
  const handOff = async (handoffId: string): Promise<void> => {
    const open = options.openProjects()
    recorded.add(handoffId)
    own = {
      handoffId,
      requestedAt: Date.now(),
      projectRoots: new Set(open.keys()),
      heldAtCut: new Set([...open].flatMap(([root, project]) => project.held() ? [root] : [])),
      awakeAtCut: new Set([...open.keys()].filter((root) => options.awakeForPhone(root))),
      phoneAwakeRoots: new Set(),
    }
    await recordOwn()
    const interrupted = await Promise.all([...open].map(async ([root, { composition }]) => {
      try {
        return (await composition.handoff("interrupt_for_replacement", handoffId)).length
      } catch (error) {
        log.warn("a project could not interrupt its work for the replacement; its stop interrupts what still runs", { projectRoot: root, error: errorMessage(error) })
        return 0
      }
    }))
    log.info("replacement handed off", { handoffId, projects: open.size, interrupted: interrupted.reduce((sum, count) => sum + count, 0) })
  }

  const join = (projectRoot: string): Promise<void> => {
    if (own === undefined || own.projectRoots.has(projectRoot)) return Promise.resolve()
    own.projectRoots.add(projectRoot)
    return recordOwn()
  }

  const recoveryPending = (projectRoot: string): boolean => {
    const row = own
    return row !== undefined && registry.replacementHandoffs(lane).some((candidate) => candidate.handoffId === row.handoffId && candidate.projectRoots.includes(projectRoot))
  }

  // Each project's stop narrows the row as it happens, while this service
  // still serves that project, so the row is final before the successor,
  // which waits for this process to stop serving the named projects, reads
  // it. A project whose stop never answers, after a crash or at its stop's
  // deadline, stays named, and a service that dies first leaves the whole row.
  const stopped = async (projectRoot: string, rows: SuccessorRows): Promise<boolean> => {
    if (own === undefined) return false
    if (rows.handovers > 0 && own.awakeAtCut.has(projectRoot)) {
      own.phoneAwakeRoots.add(projectRoot)
      await recordOwn()
    } else if (rows.continuations + rows.handovers === 0 && !own.heldAtCut.has(projectRoot) && own.projectRoots.delete(projectRoot)) {
      await recordOwn()
    }
    return recoveryPending(projectRoot)
  }

  /** Removes `root` from a predecessor's row, and retires the row once it names no project. */
  const settle = (handoffId: string, root: string): Promise<void> => writeRow(async () => {
    const row = registry.replacementHandoffs(lane).find((candidate) => candidate.handoffId === handoffId)
    if (row === undefined) return
    const remaining = row.projectRoots.filter((candidate) => candidate !== root)
    if (remaining.length === 0) await registry.retireReplacementHandoff(lane, handoffId)
    else {
      await registry.recordReplacementHandoff(lane, {
        handoffId, requestedAt: row.requestedAt, predecessorPid: row.predecessorPid, projectRoots: remaining,
        phoneAwakeRoots: row.phoneAwakeRoots.filter((candidate) => candidate !== root),
      })
    }
  })

  /** The predecessors' rows that still name `root`, oldest first. */
  const pendingFor = (root: string): readonly ReplacementHandoff[] =>
    registry.replacementHandoffs(lane).filter((handoff) => !recorded.has(handoff.handoffId) && handoff.projectRoots.includes(root))

  /** One attempt to continue every row that names `root`: each row's own
   *  predecessor is waited for, then the project is opened with its browser
   *  endpoint and held while its executor adopts the commands each row
   *  handed over and resumes the work each row authorized. The executor
   *  resumes a session only while its work still
   *  waits where the runtime interrupted it, which the session's
   *  conversation records, and retires the session's row once that resume
   *  has settled, so an attempt that repeats a continuation resumes nothing
   *  twice. A project the phone held awake under the previous build while
   *  that build handed its commands over is held awake the same way here
   *  (PI-REMOTE-009). The release returns the project to its idle grace: a
   *  surface that reattaches within it holds the project, and a project
   *  that nothing holds and no work keeps closes, as any idle project does
   *  (PI-REMOTE-013). */
  const continueOnce = async (root: string): Promise<void> => {
    for (const handoff of pendingFor(root)) await awaitPredecessor(handoff, lane, predecessorBoundMs, disposal.signal)
    // Read again: a predecessor narrows its row before it stops serving.
    const pending = pendingFor(root)
    if (pending.length === 0) return
    const project = await options.open(root)
    const release = project.holdClient()
    try {
      await project.openBrowser()
      for (const handoff of pending) {
        const resumed = await project.composition.handoff("continue_after_replacement", handoff.handoffId)
        const awake = handoff.phoneAwakeRoots.includes(root)
        log.info("replacement continued in a project", { projectRoot: root, handoffId: handoff.handoffId, resumed: resumed.length, awakeForPhone: awake })
        if (awake) await options.holdAwakeForPhone(root)
        await settle(handoff.handoffId, root)
      }
    } finally {
      release()
    }
  }

  /** The one continuation duty of `root` for this service's life: it retries
   *  a failed attempt, the project's open, its browser endpoint, or its
   *  executor's resume, on the restart backoff until the project has
   *  continued, and warns only when the reason changes. A project whose
   *  directory is gone has nothing to continue and leaves the row. */
  const duty = async (root: string): Promise<void> => {
    let failures = 0
    let reported: string | undefined
    while (!disposal.signal.aborted && pendingFor(root).length > 0) {
      if (!existsSync(root)) {
        log.warn("a project the replacement named no longer exists; there is nothing to continue", { projectRoot: root })
        for (const handoff of pendingFor(root)) await settle(handoff.handoffId, root)
        return
      }
      try {
        await continueOnce(root)
        failures = 0
      } catch (error) {
        if (disposal.signal.aborted) return
        failures += 1
        const reason = errorMessage(error)
        if (reason !== reported) log.warn("a project could not continue the replacement's work yet; it is retried", { projectRoot: root, error: reason })
        reported = reason
        await abortableSleep(retryDelayMs(failures), disposal.signal)
      }
    }
  }

  const continueAll = async (): Promise<void> => {
    const left = registry.replacementHandoffs(lane).filter((handoff) => !recorded.has(handoff.handoffId))
    // A row whose projects all stopped with nothing to continue names none.
    for (const handoff of left) if (handoff.projectRoots.length === 0) await writeRow(() => registry.retireReplacementHandoff(lane, handoff.handoffId))
    const roots = new Set(left.flatMap((handoff) => handoff.projectRoots))
    await Promise.all([...roots].map((root) => duty(root)))
  }

  return { handOff, join, stopped, recoveryPending, predecessorPids: (root) => pendingFor(root).map((row) => row.predecessorPid), continueAll, dispose: () => disposal.abort() }
}

/** Waits while the process that left `handoff` still serves a project the
 *  row names, so no project has two owners. A pid that serves none of them
 *  is not that predecessor, even while alive: it may be a reused pid, so an
 *  old row never delays a new handoff. The wait ends at `boundMs`, the
 *  account's drain bound, by which the predecessor's own drain watchdog has
 *  ended it. The successor never signals the pid: a pid read from a record
 *  can by then name an unrelated process, and nothing here proves it does
 *  not. A row this pid left was left by this process's previous image,
 *  replaced through execve, which is gone. */
async function awaitPredecessor(handoff: ReplacementHandoff, lane: ServeLane, boundMs: number, signal: AbortSignal): Promise<void> {
  const pid = handoff.predecessorPid
  if (pid === process.pid) return
  const serving = (): boolean => isProcessAlive(pid) && handoff.projectRoots.some((root) => projectServingPids(root, lane).includes(pid))
  const deadline = Date.now() + boundMs
  while (serving()) {
    if (Date.now() >= deadline) {
      log.warn("the previous service still holds a project past its own shutdown bound; its pid is stopped or names another process, so the successor continues without it", { pid })
      return
    }
    await abortableSleep(100, signal)
    if (signal.aborted) return
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  const slept = Promise.withResolvers<void>()
  const done = (): void => {
    clearTimeout(timer)
    signal.removeEventListener("abort", done)
    slept.resolve()
  }
  const timer = setTimeout(done, milliseconds)
  signal.addEventListener("abort", done, { once: true })
  return slept.promise
}
