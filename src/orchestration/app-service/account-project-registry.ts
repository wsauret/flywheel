import { randomUUID } from "node:crypto"
import { existsSync, watch as watchDirectory } from "node:fs"
import { dirname } from "node:path"

import { canonicalPathWithMissingTail } from "../../infra/canonical-path.js"
import { errorMessage } from "../../infra/error-message.js"
import type { ServeLane } from "../../infra/cli-subprocess.js"
import { Log } from "../../infra/log.js"
import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js"
import { asAsyncEventReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { accountEventStoreDbFile } from "../../infra/paths.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { createRuntimeEventStore } from "../../infra/sqlite-event-store.js"
import { parseAccountProjectFact } from "./account-project-facts.js"

const AGGREGATE_ID = "account-project-registry"
const FACT_TYPE = "account.project.registration.updated"
const HANDOFF_IN_FLIGHT_KIND = "account.replacement_handoff"
const CAPACITY_WAKE_IN_FLIGHT_KIND = "account.capacity_wake"

const log = Log.create({ service: "account-project-registry" })

/** What a planned replacement leaves its successor (ARCH-RUNTIME-032): the projects
 *  the successor serves again, each of which may hold work to continue or
 *  had a surface attached at the cut, and the process that must stop
 *  serving them before any of them opens again. It never lists sessions;
 *  each project's continuation rows are the one list of what to resume.
 *  In-flight state, not history: written before the replacement interrupts,
 *  naming every open project, joined by each project that serves during the
 *  drain, narrowed at each project's stop to the projects with work to
 *  continue or a surface attached at the cut, rewritten without each
 *  project the successor has continued, retired once it names none, and
 *  absent after an unexpected exit. `phoneAwakeRoots` names the projects the
 *  phone held awake at the cut that handed commands over, which the
 *  successor holds awake the same way. */
export interface ReplacementHandoff {
  readonly version: 2
  readonly handoffId: string
  readonly requestedAt: number
  readonly predecessorPid: number
  readonly projectRoots: readonly string[]
  readonly phoneAwakeRoots: readonly string[]
}

interface AccountProject {
  readonly id: string
  readonly projectRoot: string
  readonly label: string
  readonly lastAttachedAt: number
}

export interface AccountProjectRegistry {
  list(): Promise<readonly AccountProject[]>
  record(input: { readonly projectRoot: string; readonly label: string; readonly lastAttachedAt?: number }): Promise<AccountProject>
  forget(projectRoot: string): Promise<void>
  watch(listener: (projects: readonly AccountProject[]) => void): () => void
  dispose(): Promise<void>
}

/** The account store's handoff rows, which only the serving process reads
 *  and writes; account modules see the project registry alone. */
export interface ReplacementHandoffStore {
  /** The handoffs a predecessor serving `lane` left, oldest first. A row of
   *  a shape this release cannot read is reported and left in place. */
  replacementHandoffs(lane: ServeLane): readonly ReplacementHandoff[]
  /** Records, or rewrites, one handoff of `lane`. */
  recordReplacementHandoff(lane: ServeLane, handoff: Omit<ReplacementHandoff, "version">): Promise<void>
  retireReplacementHandoff(lane: ServeLane, handoffId: string): Promise<void>
}

/** The time the account opens a project to continue its capacity waits
 *  (ARCH-SESSIONS-039): the earliest continue time its executor last
 *  reported. In-flight state, not history: rewritten at each report and
 *  retired when the project reports none. */
export interface CapacityWake {
  readonly projectRoot: string
  readonly at: number
}

/** The account store's capacity wake rows, one per project of a lane,
 *  which only the serving process reads and writes. */
export interface CapacityWakeStore {
  /** The wakes the lane holds. A row of a shape this release cannot read is
   *  reported and left in place. */
  capacityWakes(lane: ServeLane): readonly CapacityWake[]
  /** Records the project's wake, or retires it for null. */
  recordCapacityWake(lane: ServeLane, projectRoot: string, at: number | null): Promise<void>
}

interface AccountProjectRegistryOptions {
  readonly userDataRoot: string
  readonly now?: () => number
}

type Registration =
  | { readonly status: "known"; readonly project: AccountProject }
  | { readonly status: "forgotten"; readonly id: string; readonly projectRoot: string }

interface RegistryState {
  readonly registrations: ReadonlyMap<string, Registration>
}

/** Owns the account-scoped project fact writer and its cross-process replay projection. */
export function createAccountProjectRegistry(options: AccountProjectRegistryOptions): AccountProjectRegistry & ReplacementHandoffStore & CapacityWakeStore {
  const store = createRuntimeEventStore(accountEventStoreDbFile(options.userDataRoot))
  const reader = asAsyncEventReadSurface(store)
  const now = options.now ?? Date.now
  const projection = heldProjection(reader, "account-project-registration", () => createEventProjection(reader, {
    name: "account-project-registry",
    aggregateId: AGGREGATE_ID,
    factTypes: [FACT_TYPE],
    initialState: (): RegistryState => ({ registrations: new Map() }),
    reduce: reduceRegistration,
  }))
  const watchers = new Set<(projects: readonly AccountProject[]) => void>()
  let disposed = false
  let refreshPending: ReturnType<typeof setTimeout> | undefined

  const current = (): readonly AccountProject[] =>
    [...projection.getState().registrations.values()]
      .filter((registration): registration is Extract<Registration, { status: "known" }> => registration.status === "known")
      .map((registration) => registration.project)

  const publish = (): void => {
    const projects = current()
    for (const watcher of watchers) watcher(projects)
  }

  const replay = async (): Promise<void> => {
    const previous = projection.getPosition()
    await projection.replay()
    if (projection.getPosition() !== previous) publish()
  }

  const unsubscribe = store.onStored((events) => {
    const previous = projection.getPosition()
    void projection.apply(events).then(() => {
      if (projection.getPosition() !== previous) publish()
    })
  })
  const dbFile = accountEventStoreDbFile(options.userDataRoot)
  const fileWatcher = watchDirectory(dirname(dbFile), (_event, file) => {
    if (file !== null && !String(file).startsWith("flywheel.sqlite")) return
    if (refreshPending) clearTimeout(refreshPending)
    refreshPending = setTimeout(() => {
      refreshPending = undefined
      // A refresh the directory watch starts has no caller to answer, so its
      // failure is logged here. The store can be unreadable because its
      // directory is gone, such as a harness home that another run removed:
      // the service then retires on its build tick, and a later read fails
      // to its own caller.
      if (!disposed) void replay().catch((error: unknown) => {
        log.warn("the account project registry could not refresh from its store", { error: errorMessage(error) })
      })
    }, 25)
    refreshPending.unref?.()
  })
  fileWatcher.on("error", () => {})
  fileWatcher.unref()

  async function append(payload: RegistrationPayload): Promise<void> {
    for (;;) {
      await replay()
      const result = await store.appendGuarded({
          aggregateId: AGGREGATE_ID,
          type: FACT_TYPE,
          version: 1,
          timestamp: now(),
          actor: "system",
          sessionId: "account",
          payload,
          expectedSeq: store.aggregateSeq(AGGREGATE_ID) + 1,
      })
      if (result.kind === "stored") return
    }
  }

  async function forget(projectRootInput: string): Promise<void> {
    const projectRoot = canonicalPathWithMissingTail(projectRootInput)
    await replay()
    const existing = projection.getState().registrations.get(projectRoot)
    if (!existing || existing.status === "forgotten") return
    await append({ status: "forgotten", projectRoot, id: existing.project.id })
    // SAFETY: createRuntimeEventStore opens SQLite, whose writer implements keyed pruning.
    store.pruneSupersededKeyedEvents!(AGGREGATE_ID, FACT_TYPE, "$.projectRoot")
  }

  return {
    // A project whose directory is gone is forgotten at the read that finds
    // it gone, so no surface offers it and no open makes its directory again.
    async list() {
      await replay()
      const gone = current().filter((project) => !existsSync(project.projectRoot))
      for (const project of gone) {
        log.info("forgetting a registered project whose directory is gone", { projectId: project.id })
        await forget(project.projectRoot)
      }
      return current()
    },
    async record(input) {
      const projectRoot = canonicalPathWithMissingTail(input.projectRoot)
      for (;;) {
        await replay()
        const existing = projection.getState().registrations.get(projectRoot)
        const attachedAt = input.lastAttachedAt ?? now()
        if (existing?.status === "known" && existing.project.lastAttachedAt >= attachedAt) return existing.project
        const id = existing === undefined ? randomUUID() : existing.status === "known" ? existing.project.id : existing.id
        const result = await store.appendGuarded({
            aggregateId: AGGREGATE_ID,
            type: FACT_TYPE,
            version: 1,
            timestamp: attachedAt,
            actor: "system",
            sessionId: "account",
            payload: { status: "known", projectRoot, id, label: input.label, lastAttachedAt: attachedAt },
            expectedSeq: store.aggregateSeq(AGGREGATE_ID) + 1,
        })
        if (result.kind === "stored") {
          const recorded = projection.getState().registrations.get(projectRoot)
          if (recorded?.status !== "known") throw new Error(`Stored account project did not project: ${projectRoot}`)
          // SAFETY: createRuntimeEventStore opens SQLite, whose writer implements keyed pruning.
          store.pruneSupersededKeyedEvents!(AGGREGATE_ID, FACT_TYPE, "$.projectRoot")
          return recorded.project
        }
      }
    },
    forget,
    watch(listener) {
      watchers.add(listener)
      return () => { watchers.delete(listener) }
    },
    replacementHandoffs(lane) {
      return store.readInFlight(handoffScope(lane), HANDOFF_IN_FLIGHT_KIND).flatMap((row) => {
        const handoff = decodeReplacementHandoff(row.key, row.payload)
        if (handoff) return [handoff]
        log.warn("replacement handoff row has a shape this release cannot read; it is left in place", { lane, key: row.key, version: String(row.payload.version) })
        return []
      })
    },
    async recordReplacementHandoff(lane, handoff) {
      const stored: ReplacementHandoff = { version: 2, ...handoff, projectRoots: [...handoff.projectRoots], phoneAwakeRoots: [...handoff.phoneAwakeRoots] }
      // SAFETY: createRuntimeEventStore opens SQLite, whose writer implements in-flight cells.
      await store.putInFlight!(handoffScope(lane), HANDOFF_IN_FLIGHT_KIND, handoff.handoffId, stored)
    },
    async retireReplacementHandoff(lane, handoffId) {
      // SAFETY: createRuntimeEventStore opens SQLite, whose writer implements in-flight cells.
      await store.dropInFlight!(handoffScope(lane), HANDOFF_IN_FLIGHT_KIND, handoffId)
    },
    capacityWakes(lane) {
      return store.readInFlight(handoffScope(lane), CAPACITY_WAKE_IN_FLIGHT_KIND).flatMap((row) => {
        const { payload } = row
        const known = Object.keys(payload).sort().join(",") === "at,projectRoot,version"
        if (known && payload.version === 1 && payload.projectRoot === row.key && typeof payload.at === "number" && Number.isSafeInteger(payload.at)) {
          return [{ projectRoot: row.key, at: payload.at }]
        }
        log.warn("capacity wake row has a shape this release cannot read; it is left in place", { lane, key: row.key, version: String(payload.version) })
        return []
      })
    },
    async recordCapacityWake(lane, projectRoot, at) {
      // SAFETY: createRuntimeEventStore opens SQLite, whose writer implements in-flight cells.
      if (at === null) await store.dropInFlight!(handoffScope(lane), CAPACITY_WAKE_IN_FLIGHT_KIND, projectRoot)
      // SAFETY: as above.
      else await store.putInFlight!(handoffScope(lane), CAPACITY_WAKE_IN_FLIGHT_KIND, projectRoot, { version: 1, projectRoot, at })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      watchers.clear()
      unsubscribe()
      if (refreshPending) clearTimeout(refreshPending)
      fileWatcher.close()
      await store.close()
    },
  }
}

type RegistrationPayload =
  | { readonly status: "known"; readonly projectRoot: string; readonly id: string; readonly label: string; readonly lastAttachedAt: number }
  | { readonly status: "forgotten"; readonly projectRoot: string; readonly id: string }

function reduceRegistration(state: RegistryState, event: StoredFact): RegistryState {
  const fact = parseProjectionFact(event, parseAccountProjectFact)
  const registrations = new Map(state.registrations)
  const payload = fact.payload
  registrations.set(payload.projectRoot, payload.status === "known"
    ? { status: "known", project: { id: payload.id, projectRoot: payload.projectRoot, label: payload.label, lastAttachedAt: payload.lastAttachedAt } }
    : { status: "forgotten", id: payload.id, projectRoot: payload.projectRoot })
  return { registrations }
}

/** Each lane keeps its own handoffs and capacity wakes: a successor
 *  consumes only what a predecessor of its own lane left. */
function handoffScope(lane: ServeLane): string {
  return `serve:${lane}`
}

/** Reads one stored handoff; undefined for a shape this release does not know.
 *
 *  Remove the version 1 conversion after 2026-12-25. A version 1 row, which
 *  a build before the command handover wrote, names no project held awake
 *  for the phone. A handoff row lives only from a predecessor's cut to its
 *  successor's continuation, so by then no store still carries one. */
function decodeReplacementHandoff(key: string, value: { readonly [key: string]: unknown }): ReplacementHandoff | undefined {
  const keys = Object.keys(value).sort().join(",")
  const expected = value.version === 1
    ? "handoffId,predecessorPid,projectRoots,requestedAt,version"
    : "handoffId,phoneAwakeRoots,predecessorPid,projectRoots,requestedAt,version"
  if (
    keys !== expected
    || (value.version !== 1 && value.version !== 2)
    || value.handoffId !== key
    || typeof value.handoffId !== "string"
    || typeof value.requestedAt !== "number"
    || typeof value.predecessorPid !== "number"
    || !Number.isSafeInteger(value.predecessorPid)
    || value.predecessorPid <= 0
  ) return undefined
  const projectRoots = projectRootList(value.projectRoots)
  const phoneAwakeRoots = value.version === 1 ? [] : projectRootList(value.phoneAwakeRoots)
  if (projectRoots === undefined || phoneAwakeRoots === undefined) return undefined
  return { version: 2, handoffId: value.handoffId, requestedAt: value.requestedAt, predecessorPid: value.predecessorPid, projectRoots, phoneAwakeRoots }
}

function projectRootList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const roots = value.filter((root): root is string => typeof root === "string" && root.length > 0)
  return roots.length === value.length ? roots : undefined
}
