import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { ReplacementBlocker } from "./replacement-blockers.js"

const log = Log.create({ service: "project-runtime" })

export interface ProjectRuntimeOptions {
  /** The project this runtime serves, which its records name. */
  readonly projectRoot: string
  readonly idleGraceMs: number
  /** What keeps this project from closing: empty means idle. */
  readonly blockers: () => Promise<readonly ReplacementBlocker[]>
  /** Closes the idle project. A close that fails is logged here: the
   *  account keeps the project's slot failed, and the next open or close of
   *  the project runs its dispose again, which asks each shutdown owner that
   *  did not settle again, such as an executor whose recovery failed. */
  readonly onIdle: () => Promise<void>
  readonly closeEndpoint: () => Promise<void>
  readonly closeTransports: () => Promise<void>
  readonly runShutdownBarrier: () => Promise<void>
  readonly transportDisposeGraceMs?: number
  readonly onTransportDisposeTimeout?: () => void
}

export interface ProjectRuntime {
  holdClient(): () => void
  /** A hold the service takes on behalf of a client that is away and
   *  expected back, such as one whose session holds wait out their grace
   *  (ARCH-RUNTIME-024). A closing project waits for no client, so it takes none. */
  holdIfOpen(): (() => void) | undefined
  /** Whether any hold is registered on the project now: a surface attached
   *  to it, or a hold the service takes on a surface's behalf. */
  held(): boolean
  liveWorkChanged(): void
  dispose(): Promise<void>
}

/** Runs a presentation-only disposal for its grace period. The durable runtime barrier remains authoritative. */
async function disposeProjectTransportWithGrace(
  dispose: () => Promise<void>,
  graceMs: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), graceMs)
    timer.unref?.()
  })
  const outcome = await Promise.race([dispose().then(() => "settled" as const, () => "settled" as const), timeout])
  if (timer) clearTimeout(timer)
  if (outcome === "timeout") onTimeout()
}

/** Owns one project's endpoint, transport clients, live-work idle grace, and shutdown barrier. */
export function createProjectRuntime(options: ProjectRuntimeOptions): ProjectRuntime {
  let clients = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let disposal: Promise<void> | undefined
  let disposalStep = 0

  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  // Nothing waits on an idle close, so its failure, such as a failed
  // recovery rerun, is recorded here and never ends the account service.
  const closeIdle = (): void => {
    void options.onIdle().catch((error: unknown) => {
      log.error("idle project close failed; the next open or close of the project runs it again", { projectRoot: options.projectRoot, error: errorMessage(error) })
    })
  }

  // Running work defers an idle close for as long as it runs, and the check
  // repeats every grace period: the first deferral of an idle stretch records
  // what held the project open, and the close itself records when it happens.
  let deferring = false
  const arm = (): void => {
    clear()
    if (disposed || clients > 0 || options.idleGraceMs <= 0) {
      deferring = false
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      void options.blockers().then((blockers) => {
        if (disposed || clients > 0) return
        if (blockers.length > 0) {
          if (!deferring) log.info("idle project close deferred by running work", { projectRoot: options.projectRoot, blockers: blockers.map((blocker) => blocker.reason) })
          deferring = true
          arm()
        } else closeIdle()
      }, () => arm())
    }, options.idleGraceMs)
    timer.unref?.()
  }

  const dispose = (): Promise<void> => {
    disposed = true
    clear()
    disposal ??= (async () => {
      if (disposalStep === 0) {
        await options.closeEndpoint()
        disposalStep = 1
      }
      if (disposalStep === 1) {
        if (options.transportDisposeGraceMs === undefined) {
          await options.closeTransports()
        } else {
          await disposeProjectTransportWithGrace(
            options.closeTransports,
            options.transportDisposeGraceMs,
            options.onTransportDisposeTimeout ?? (() => {}),
          )
        }
        disposalStep = 2
      }
      if (disposalStep === 2) {
        await options.runShutdownBarrier()
        disposalStep = 3
      }
    })().catch((error) => {
      disposal = undefined
      throw error
    })
    return disposal
  }

  // Each change between held and not held is recorded, because a stop
  // decides the project's empty chats by it (ARCH-RUNTIME-024).
  const holdClient = (): () => void => {
    if (disposed) throw new Error("Project runtime is closing")
    clients += 1
    if (clients === 1) log.info("project held", { projectRoot: options.projectRoot, held: true })
    clear()
    let held = true
    return () => {
      if (!held) return
      held = false
      clients -= 1
      if (clients > 0) return
      log.info("project held", { projectRoot: options.projectRoot, held: false })
      arm()
    }
  }

  arm()
  return {
    holdClient,
    holdIfOpen: () => disposed ? undefined : holdClient(),
    held: () => clients > 0,
    liveWorkChanged: arm,
    dispose,
  }
}
