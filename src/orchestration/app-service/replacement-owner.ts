import { randomUUID } from "node:crypto"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { SourceChange } from "../../infra/source-snapshot.js"
import type { BuildFallbackTrigger } from "../update/build-fallback.js"
import { PLANNED_CUT_LIMIT_MS } from "../session/planned-session-continuation.js"
import { delaysReplacement, sameBlockers, type ReplacementBlocker } from "./replacement-blockers.js"

const log = Log.create({ service: "replacement-owner" })

/** How long the owner waits before it asks the projects again on its own
 *  while a replacement is requested. The projects report their own changes,
 *  so this only covers a report that was lost with its channel. */
const REPOLL_MS = 5_000

/** The account's one replacement state (PI-REMOTE-012, ARCH-RUNTIME-031). It lives
 *  here and nowhere else: every executor learns it from the value this owner
 *  last published, and no client ever sees it. The owner never refuses work,
 *  never asks a person anything, and shows nothing. It waits only for what
 *  the cut cannot carry across, an admitted call that has not returned and a
 *  project that is opening or recovering. It never waits for a shell command
 *  of any owner: the stop hands each running command to the successor, which
 *  adopts it, and the cut interrupts the rest for the successor to resume.
 *  - `none`: the current build serves; nothing waits.
 *  - `requested`: a successor waits, and `blockers` names every call and
 *    every opening or recovering project that delays it. New work is
 *    admitted as usual.
 *  - `draining`: nothing delays it any more. The handoff `handoffId` has
 *    begun: its row is recorded, the running work is being cut under it, and
 *    the service stops once the cut settles or its limit passes, so the
 *    successor can take over. Every executor that serves from then on hears this id,
 *    and its stop gives work admitted after the cut the same continuation
 *    authority and hands over every running command. A drain is not
 *    cancelled. */
export type ReplacementState =
  | { readonly kind: "none" }
  | { readonly kind: "requested"; readonly blockers: readonly ReplacementBlocker[] }
  | { readonly kind: "draining"; readonly handoffId: string }

export interface ReplacementOwnerDeps {
  /** Every blocker across every open project, as they stand now. */
  readonly blockers: () => Promise<readonly ReplacementBlocker[]>
  /** Records the handoff `handoffId` the successor consumes and interrupts
   *  the running work of every open project under it. Called once, when
   *  nothing delays the replacement, and its row is recorded before the
   *  `draining` state that names the id is published. The stop begins once
   *  it settles or the cut limit passes, and a handoff that fails is
   *  reported and still stops. */
  readonly handOff: (handoffId: string) => Promise<void>
  /** Begins the service's stop path. Called once, when the cut settles or
   *  its limit passes. */
  readonly retire: () => void
  readonly repollMs?: number
  readonly cutLimitMs?: number
}

/** What asked for a replacement, and so what the successor is, recorded once
 *  with the request. A newer installed build names both builds. A dev
 *  service's checkout whose source differs from the snapshot the service
 *  runs from names both digests. A build whose project executors could not
 *  open names itself and the proved build its lane returns to. A person's
 *  restart names nothing more: its successor is whatever its lane starts
 *  next, which can be this same build (PI-INTERACTION-048). */
export type ReplacementTrigger =
  | { readonly kind: "newer build installed"; readonly ownBuild: string; readonly installedBuild: string }
  | { readonly kind: "service registration changed" }
  | { readonly kind: "restart requested" }
  | SourceChange
  | BuildFallbackTrigger

export interface ReplacementOwner {
  readonly state: ReplacementState
  /** Asks this service to make way for the successor `trigger` names, which
   *  the request's record states. Answers `busy` while any blocker remains
   *  and `retiring` once the drain has begun. When this call is the one that
   *  starts the drain, `beforeRetire` runs before the stop, so a cutover
   *  client hears the answer before the listener withdraws. */
  request(trigger: ReplacementTrigger, beforeRetire?: () => Promise<void>): Promise<"busy" | "retiring">
  /** A project reports that its blockers may have changed. Nothing is asked
   *  unless a replacement is requested. */
  refresh(): void
  subscribe(listener: (state: ReplacementState) => void): () => void
  dispose(): void
}

/** Settles once `cut` settles or `limitMs` passes, whichever is first, and
 *  never rejects: neither a failed nor an unsettled cut holds the stop. A
 *  turn whose cut has not settled by then already holds its continuation row
 *  and the cut's interrupt, so the stop proceeds without it and runs the
 *  cut's steps only for the work the cut has not reached. */
async function boundedCut(cut: Promise<void>, limitMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<"limit">((resolve) => { timer = setTimeout(() => resolve("limit"), limitMs) })
  try {
    const outcome = await Promise.race([cut.then(() => "settled" as const), limit])
    if (outcome === "limit") log.warn("the cut of the running work did not settle within its limit; the stop proceeds and cuts the work the cut has not reached", { limitMs })
  } catch (error) {
    log.warn("replacement handoff failed; the stop proceeds and unresumed work stays interrupted", { error: errorMessage(error) })
  } finally {
    clearTimeout(timer)
  }
}

export function createReplacementOwner(deps: ReplacementOwnerDeps): ReplacementOwner {
  let state: ReplacementState = { kind: "none" }
  const listeners = new Set<(state: ReplacementState) => void>()
  // Reads overlap when a request and a project report race. Each read takes
  // a ticket, and a result older than the last applied one is dropped rather
  // than publishing a stale list over a fresh one.
  let ticket = 0
  let applied = 0
  // The first read of a fresh request. `requested` is published only after
  // it, because a requested state with no blockers reads as a drain that has
  // begun.
  let opening: Promise<void> | undefined
  let refreshing: Promise<void> | undefined
  let refreshAgain = false
  // The one handoff of this request; every read that finds nothing delaying
  // the replacement joins it, and only the first begins the stop.
  let handingOff: Promise<void> | undefined
  let retiring = false
  let repoll: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const publish = (next: ReplacementState): void => {
    state = next
    for (const listener of listeners) listener(next)
  }

  const clearRepoll = (): void => {
    clearTimeout(repoll)
    repoll = undefined
  }

  const armRepoll = (): void => {
    clearRepoll()
    if (disposed || state.kind !== "requested") return
    repoll = setTimeout(() => { repoll = undefined; refresh() }, deps.repollMs ?? REPOLL_MS)
    repoll.unref?.()
  }

  const readBlockers = async (): Promise<{ readonly ticket: number; readonly blockers: readonly ReplacementBlocker[] } | undefined> => {
    const mine = ++ticket
    try {
      return { ticket: mine, blockers: await deps.blockers() }
    } catch (error) {
      // A project that cannot answer is not idle. The next report or repoll asks again.
      log.warn("replacement blockers could not be read", { error: errorMessage(error) })
      return undefined
    }
  }

  /** Applies one fresh read to the request: when nothing delays the
   *  replacement the drain begins with the handoff, and the stop follows the
   *  cut; else the delaying list is published when it changed. */
  const apply = async (blockers: readonly ReplacementBlocker[], beforeRetire?: () => Promise<void>): Promise<void> => {
    const delaying = blockers.filter(delaysReplacement)
    if (delaying.length === 0) {
      clearRepoll()
      if (!handingOff) {
        const handoffId = randomUUID()
        log.info("replacement drain begins", { handoffId, running: blockers.length })
        // The handoff records its row before its first await, so an executor
        // that hears the published id finds the row to join.
        const cut = deps.handOff(handoffId)
        publish({ kind: "draining", handoffId })
        handingOff = boundedCut(cut, deps.cutLimitMs ?? PLANNED_CUT_LIMIT_MS)
      }
      await handingOff
      if (retiring) return
      retiring = true
      log.info("replacement stop begins")
      try {
        await beforeRetire?.()
      } finally {
        deps.retire()
      }
      return
    }
    if (state.kind !== "requested" || !sameBlockers(state.blockers, delaying)) {
      log.info("replacement held", { blockers: delaying.map((blocker) => ({ project: blocker.projectLabel, session: blocker.sessionId, reason: blocker.reason })) })
      publish({ kind: "requested", blockers: delaying })
    }
    armRepoll()
  }

  const aggregate = async (beforeRetire?: () => Promise<void>): Promise<void> => {
    if (state.kind !== "requested") return
    const read = await readBlockers()
    if (read === undefined) {
      armRepoll()
      return
    }
    if (read.ticket < applied || state.kind !== "requested") return
    applied = read.ticket
    await apply(read.blockers, beforeRetire)
  }

  const refresh = (): void => {
    if (state.kind !== "requested") return
    if (refreshing) {
      refreshAgain = true
      return
    }
    refreshing = aggregate().finally(() => {
      refreshing = undefined
      if (refreshAgain) {
        refreshAgain = false
        refresh()
      }
    })
  }

  // Read through a call so the answer is the state after the awaits above,
  // not the narrowing TypeScript keeps from before them.
  const answer = (): "busy" | "retiring" => state.kind === "draining" ? "retiring" : "busy"

  return {
    get state() { return state },
    async request(trigger, beforeRetire) {
      if (state.kind === "draining") return "retiring"
      if (state.kind === "requested") {
        await aggregate(beforeRetire)
      } else {
        opening ??= (async () => {
          log.info("replacement requested", { trigger: trigger.kind, ...trigger })
          const read = await readBlockers()
          if (read === undefined || state.kind !== "none") return
          applied = read.ticket
          await apply(read.blockers, beforeRetire)
        })().finally(() => { opening = undefined })
        await opening
      }
      return answer()
    },
    refresh,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      clearRepoll()
      listeners.clear()
    },
  }
}
