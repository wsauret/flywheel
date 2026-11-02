import { runAccountShutdownBarrier } from "./runtime-shutdown.js"
import type { StartupReached } from "../../protocol/startup-steps.js"
import { DebugLog } from "../../infra/debug-log.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { durationMs } from "../../infra/operation-log.js"

const log = Log.create({ service: "account-service" })

/** Who asked for a project to open, which its open record names. */
type ProjectOpenRequester = "client attach" | "browser" | "device wake" | "repository clone" | "replacement continuation" | "capacity wake"
/** Why a project closes, which its close record names. */
type ProjectCloseReason = "idle" | "account service stopping" | "reopen after a failed close"

type AccountProjectState = "opening" | "open" | "closing" | "failed"

interface AccountProjectRuntime {
  dispose(): Promise<void>
}

export interface AccountServiceOptions<Runtime extends AccountProjectRuntime> {
  readonly canonicalizeProjectRoot: (projectRoot: string) => string
  /** Claims the project for this service before it opens and returns the
   *  release, which runs when the project's slot is gone. A claim may wait
   *  for a previous owner to let go; one that rejects refuses the open with
   *  its message. */
  readonly claimProject?: (canonicalProjectRoot: string) => Promise<(() => void) & { readonly exclusive?: boolean; readonly releaseForHandoff?: (eligible: () => boolean) => Promise<boolean> }>
  /** The third argument proves that the project claim waited for every predecessor to release. */
  readonly openProject: (canonicalProjectRoot: string, onStartupStep: (reached: StartupReached) => void, exclusiveClaim: boolean, ownership: {
    /** Transfers the runtime to the slot before fallible startup, including a close that joins the open. */
    readonly own: (runtime: Runtime) => void
    readonly releaseForHandoff?: (eligible: () => boolean) => Promise<boolean>
  }) => Promise<Runtime>
  readonly recordTrustedAttach: (canonicalProjectRoot: string) => Promise<void>
  readonly flushWriters?: () => Promise<void>
  readonly closeSharedResources?: () => Promise<void>
  readonly startHub?: (service: AccountService<Runtime>) => { readonly stop: () => void }
}

export interface AccountService<Runtime extends AccountProjectRuntime> {
  /** Join one canonical project opening. The reporter receives the latest step it reached and updates until this open settles. */
  open(projectRoot: string, requester?: ProjectOpenRequester, onStartupStep?: (reached: StartupReached) => void): Promise<Runtime>
  close(projectRoot: string, reason?: ProjectCloseReason): Promise<void>
  state(projectRoot: string): AccountProjectState | undefined
  project(projectRoot: string): ProjectSlot<Runtime> | undefined
  /** Every project this service holds a slot for, by canonical root. */
  slots(): ReadonlyMap<string, ProjectSlot<Runtime>>
  watch(listener: (projectRoot: string, project: ProjectSlot<Runtime> | undefined) => void): () => void
  /** Admits project opens. A service starts with admission not yet open: an
   *  open requested then waits before its slot is published, so it claims and
   *  opens nothing, is not a project that is opening, and is not joined by
   *  `dispose`. The account service opens admission once its start is
   *  confirmed, because an open can convert the project's durable state
   *  (ARCH-RUNTIME-015). Answers whether this call opened admission: a later call, and
   *  any call once admission closed, admits nothing. */
  openAdmission(): boolean
  /** Stops the hub at once and refuses every new project open and every open
   *  that waits for admission, waiting on nothing. `dispose` begins with it; a
   *  shutdown calls it first so a successor can bind the fixed hub address
   *  while this service drains. Idempotent. */
  closeAdmission(): void
  dispose(): Promise<void>
}

export type ProjectSlot<Runtime> =
  | { readonly state: "opening"; readonly opening: Promise<Runtime> }
  | { readonly state: "open"; readonly runtime: Runtime }
  | { readonly state: "closing"; readonly closing: Promise<void> }
  | { readonly state: "failed"; readonly error: unknown; readonly runtime?: Runtime }

type OpeningProjectSlot<Runtime> = Extract<ProjectSlot<Runtime>, { state: "opening" }> & {
  runtime?: Runtime
  reached?: StartupReached
  readonly stepListeners: Set<(reached: StartupReached) => void>
}
type OwnedProjectSlot<Runtime> = Exclude<ProjectSlot<Runtime>, { state: "opening" }> | OpeningProjectSlot<Runtime>

/** Owns account admission and one project-runtime state machine per canonical root. */
export function createAccountService<Runtime extends AccountProjectRuntime>(options: AccountServiceOptions<Runtime>): AccountService<Runtime> {
  const projects = new Map<string, OwnedProjectSlot<Runtime>>()
  const claims = new Map<string, () => void>()
  const listeners = new Set<(projectRoot: string, project: ProjectSlot<Runtime> | undefined) => void>()
  let admission: "starting" | "open" | "closed" = "starting"
  // Settles when admission leaves `starting`, either way; each open that
  // waits for it then asks again.
  const admissionDecided = Promise.withResolvers<void>()
  let disposal: Promise<void> | undefined
  let hub: { readonly stop: () => void } | undefined
  const openAdmission = (): boolean => {
    if (admission !== "starting") return false
    admission = "open"
    admissionDecided.resolve()
    return true
  }
  const closeAdmission = (): void => {
    admission = "closed"
    admissionDecided.resolve()
    hub?.stop()
    hub = undefined
  }
  const transition = (root: string, slot: OwnedProjectSlot<Runtime> | undefined): void => {
    if (slot === undefined) projects.delete(root)
    else projects.set(root, slot)
    // The claim lives exactly as long as the slot holds a runtime or is about
    // to: a closed project and a failed open that kept nothing release it.
    if (slot === undefined || (slot.state === "failed" && slot.runtime === undefined)) {
      claims.get(root)?.()
      claims.delete(root)
    }
    for (const listener of listeners) listener(root, slot)
    DebugLog.record({ type: "runtime.account_project.lifecycle", payload: { projectRoot: root, state: slot?.state ?? "closed" } })
  }

  const awaitOpening = (slot: OpeningProjectSlot<Runtime>, onStartupStep?: (reached: StartupReached) => void): Promise<Runtime> => {
    if (!onStartupStep) return slot.opening
    slot.stepListeners.add(onStartupStep)
    if (slot.reached) onStartupStep(slot.reached)
    return slot.opening.finally(() => { slot.stepListeners.delete(onStartupStep) })
  }
  const openCanonical = (root: string, requester?: ProjectOpenRequester, onStartupStep?: (reached: StartupReached) => void): Promise<Runtime> => {
    if (admission === "closed") return Promise.reject(new Error("Account service is closing"))
    if (admission === "starting") return admissionDecided.promise.then(() => openCanonical(root, requester, onStartupStep))
    const current = projects.get(root)
    if (current?.state === "opening") return awaitOpening(current, onStartupStep)
    if (current?.state === "open") return Promise.resolve(current.runtime)
    if (current?.state === "closing") return current.closing.then(() => openCanonical(root, requester, onStartupStep))
    if (current?.state === "failed" && current.runtime) return closeCanonical(root, "reopen after a failed close").then(() => openCanonical(root, requester, onStartupStep))

    const started = performance.now()
    const openingCompletion = Promise.withResolvers<Runtime>()
    const opening = openingCompletion.promise
    DebugLog.record({ type: "account.project.open.accepted", payload: { projectRoot: root } })
    // The slot is published before the open runs, so a claim or open that
    // fails synchronously still finds the slot it must mark failed.
    const slot: OpeningProjectSlot<Runtime> = { state: "opening", opening, stepListeners: new Set() }
    transition(root, slot)
    const waiting = awaitOpening(slot, onStartupStep)
    void (async (): Promise<void> => {
      try {
        const pendingClaim = options.claimProject?.(root)
        const claim = pendingClaim ? await pendingClaim : undefined
        claims.set(root, claim ?? (() => {}))
        const runtime = await options.openProject(root, (reached) => {
          slot.reached = reached
          for (const listener of slot.stepListeners) listener(reached)
        }, claim?.exclusive === true, {
          own: (owned) => { slot.runtime = owned },
          releaseForHandoff: claim?.releaseForHandoff,
        })
        slot.runtime = runtime
        await options.recordTrustedAttach(root)
        const latest = projects.get(root)
        if (latest?.state === "opening" && latest.opening === opening) {
          transition(root, { state: "open", runtime })
          DebugLog.record({ type: "account.project.open.ready", payload: { projectRoot: root } })
        }
        log.info("project opened", { projectRoot: root, requester, durationMs: durationMs(started) })
        openingCompletion.resolve(runtime)
      } catch (error) {
        log.error("project open failed", { projectRoot: root, requester, durationMs: durationMs(started), error: errorMessage(error), errorDetail: errorDetail(error) })
        let releaseError: unknown
        if (slot.runtime) {
          try {
            await slot.runtime.dispose()
            slot.runtime = undefined
          } catch (cause) {
            releaseError = cause
          }
        }
        const latest = projects.get(root)
        if (latest?.state === "opening" && latest.opening === opening) {
          transition(root, { state: "failed", error, ...(slot.runtime === undefined ? {} : { runtime: slot.runtime }) })
        }
        openingCompletion.reject(releaseError === undefined
          ? error
          : new AggregateError([error, releaseError], "Project open and rollback release failed", { cause: error }))
      } finally {
        slot.stepListeners.clear()
        slot.reached = undefined
      }
    })()
    return waiting
  }

  const closeCanonical = (root: string, reason?: ProjectCloseReason): Promise<void> => {
    const current = projects.get(root)
    if (!current) return Promise.resolve()
    if (current.state === "closing") return current.closing
    let source: Promise<Runtime>
    let retainedRuntime: Runtime | undefined
    if (current.state === "opening") {
      // The opener finishes rollback before rejecting. A joined close inherits
      // any runtime that rollback could not release.
      source = current.opening.catch((error: unknown) => {
        retainedRuntime = current.runtime
        throw error
      })
    } else if (current.state === "open") {
      retainedRuntime = current.runtime
      source = Promise.resolve(current.runtime)
    } else {
      if (!current.runtime) return Promise.resolve()
      retainedRuntime = current.runtime
      source = Promise.resolve(current.runtime)
    }
    const started = performance.now()
    const closingCompletion = Promise.withResolvers<void>()
    const closing = closingCompletion.promise
    void source
      .then((runtime) => {
        retainedRuntime = runtime
        return runtime.dispose()
      })
      .then(() => {
        const latest = projects.get(root)
        if (latest?.state === "closing" && latest.closing === closing) transition(root, undefined)
        log.info("project closed", { projectRoot: root, reason, durationMs: durationMs(started) })
        closingCompletion.resolve()
      }, (error) => {
        log.error("project close failed", { projectRoot: root, reason, durationMs: durationMs(started), error: errorMessage(error), errorDetail: errorDetail(error) })
        const latest = projects.get(root)
        if (latest?.state === "closing" && latest.closing === closing) {
          transition(root, { state: "failed", error, ...(retainedRuntime === undefined ? {} : { runtime: retainedRuntime }) })
        }
        closingCompletion.reject(error)
      })
    transition(root, { state: "closing", closing })
    return closing
  }

  const service: AccountService<Runtime> = {
    open(projectRoot, requester, onStartupStep) { return openCanonical(options.canonicalizeProjectRoot(projectRoot), requester, onStartupStep) },
    close(projectRoot, reason) { return closeCanonical(options.canonicalizeProjectRoot(projectRoot), reason) },
    state(projectRoot) { return projects.get(options.canonicalizeProjectRoot(projectRoot))?.state },
    project(projectRoot) { return projects.get(options.canonicalizeProjectRoot(projectRoot)) },
    slots() { return projects },
    watch(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    openAdmission,
    closeAdmission,
    dispose() {
      disposal ??= (async () => {
        closeAdmission()
        const openings = [...projects.values()].flatMap((slot) => slot.state === "opening" ? [slot.opening.catch(() => undefined)] : [])
        const result = await runAccountShutdownBarrier({
          closeAdmission,
          joinOpenings: () => Promise.all(openings).then(() => {}),
          flushWriters: options.flushWriters ?? (() => Promise.resolve()),
          projectBarriers: [...projects.keys()].map((root) => () => closeCanonical(root, "account service stopping")),
          closeSharedResources: options.closeSharedResources ?? (() => Promise.resolve()),
        })
        if (result.kind === "blocked") throw result.error
      })()
      return disposal
    },
  }
  hub = options.startHub?.(service)
  return service
}
