import type { AttachedRuntimeClient, FrontendEvent } from "../app-service-types.js"
import { cursorKey, isRuntimeInvalidationPayload } from "../runtime-ui-protocol-types.js"
import { isLaneBreak } from "./cursor-intake.js"

/** The half of a connection that a per-session reader listens on: its patches
 *  and its lane openings. */
export type ResidentLanes = Pick<AttachedRuntimeClient, "subscribe" | "onLane">

/** Which sessions a client keeps resident, and when each one reads.
 *
 *  A client keeps the views of the sessions a person returns to, so that a
 *  return paints what it kept instead of waiting for a read. This owns the
 *  membership of that set and the lanes its readers listen on: a client
 *  supplies the per-session bundle (its transcript store, its other
 *  per-session views, whatever its toolkit projects from them), attaches
 *  every reader in it to the lanes `use` hands the bundle, and drops the
 *  bundle when told to.
 *
 *  Membership is least recently used. A retained session, which a surface
 *  shows, is never evicted. A pinned session, such as one the catalog lists
 *  as active, is exempt from the idle limit, stretches the capacity to the
 *  pinned count, and leaves only after every session that is not pinned.
 *
 *  Dormancy is the other half, when the client asks for it. Hidden residents
 *  keep applying live patches while the lane that carries them holds. When
 *  the lane breaks, every resident that no surface shows goes dormant, and so
 *  does a resident whose last surface lets it go before the next lane opens.
 *  A dormant resident's readers hear the lane break, which voids what they
 *  hold, and nothing after it: no patch and no lane opening reaches them, so
 *  they read nothing, and the sessions a person sees read first on the next
 *  lane. A dormant resident wakes when a surface retains it. Its readers then
 *  hear every rebase withheld from them, so a reader whose coordinates moved
 *  replaces its window instead of merging into it, and then the open lane,
 *  so each reader reads what it holds again, exactly as when a lane opens.
 *
 *  A client that holds runtime resources for its residents, such as runners
 *  or details, holds them for the awake residents only. After a lane break it
 *  asks the runtime for nothing on behalf of a session that no surface shows,
 *  until a surface shows it again. Such holds derive from `awake` and follow
 *  `onAwakeChange`. */
export interface Residency<Bundle> {
  /** The bundle of a resident session. Reading it is not a use. */
  get(sessionId: string): Bundle | undefined
  /** Resident sessions, least recently used first. */
  ids(): readonly string[]
  /** Resident sessions that are not dormant, least recently used first.
   *  Without dormancy, every resident session. */
  awake(): readonly string[]
  /** Calls `listener` after one or more residents go dormant or wake: at a
   *  lane break, at a `release` while no lane is open, and at a `retain`
   *  that wakes a session. A change of membership is not one: the caller
   *  makes it with `use` or `evict`. Returns the stop. */
  onAwakeChange(listener: () => void): () => void
  /** Makes the session resident and its most recent use, then evicts what
   *  the policy no longer keeps. `create` makes the bundle of a session that
   *  is not resident yet, and receives the lanes its readers attach to. The
   *  session just used is never evicted by its own use. A use does not wake a
   *  dormant session; only `retain` does. Throws after `dispose`. */
  use(sessionId: string, create: (lanes: ResidentLanes) => Bundle): Bundle
  /** Keeps the session resident until the handle is released, and wakes it
   *  when it is dormant. The session need not be resident yet. Releasing the
   *  last handle evicts what the policy no longer keeps. */
  retain(sessionId: string): { release(): void }
  retained(sessionId: string): boolean
  /** Evicts the session at once, whatever retains it: its row left the
   *  catalog or its detail is gone. */
  evict(sessionId: string): void
  /** Evicts every session and stops listening on the lanes. */
  dispose(): void
}

export interface ResidencyOptions<Bundle> {
  /** How many sessions stay resident when no pin stretches it. */
  readonly capacity: number
  /** How long a session that is not pinned stays resident unused. Unbounded
   *  when absent. */
  readonly idleMs?: number
  readonly pinned?: () => ReadonlySet<string>
  readonly now?: () => number
  /** The connection every resident reads through. */
  readonly lanes: ResidentLanes
  /** True: a lane break makes hidden residents dormant, as described on
   *  `Residency`. False: residents read on every lane, and `use` hands each
   *  bundle `lanes` itself. */
  readonly dormancy: boolean
  /** Receives a bundle that left the set, to dispose of it. */
  readonly onEvict: (bundle: Bundle, sessionId: string) => void
}

/** What the readers of one resident listen to, and what was kept from them. */
interface Readers {
  dormant: boolean
  readonly listeners: Set<(event: FrontendEvent) => void>
  readonly laneListeners: Set<(lane: number) => void>
  /** The latest rebase withheld while dormant, by cursor. */
  readonly withheld: Map<string, FrontendEvent>
}

interface Resident<Bundle> {
  readonly bundle: Bundle
  readonly readers: Readers
  lastUsed: number
}

export function createResidency<Bundle>(options: ResidencyOptions<Bundle>): Residency<Bundle> {
  const now = options.now ?? (() => Date.now())
  const pinned = options.pinned ?? (() => new Set<string>())
  // Insertion order is recency order: a use moves its session to the end.
  const residents = new Map<string, Resident<Bundle>>()
  const retainers = new Map<string, Set<object>>()
  const retained = (id: string): boolean => (retainers.get(id)?.size ?? 0) > 0
  const awakeListeners = new Set<() => void>()
  const awakeChanged = (): void => { for (const listener of Array.from(awakeListeners)) listener() }
  // The open lane, or 0 from a lane break until the next lane opens.
  let lane = 0
  let disposed = false

  function evict(id: string): void {
    const resident = residents.get(id)
    if (resident === undefined) return
    residents.delete(id)
    options.onEvict(resident.bundle, id)
  }

  /** Two passes, so a pinned session leaves only after every other one: a
   *  pinned session is one the person can return to at any time, so only
   *  capacity removes it, never the idle limit. */
  function sweep(exempt?: string): void {
    const idleCutoff = options.idleMs === undefined ? Number.NEGATIVE_INFINITY : now() - options.idleMs
    const pins = pinned()
    const capacity = Math.max(options.capacity, pins.size)
    for (const evictPinned of [false, true]) {
      for (const [id, resident] of residents) {
        const idle = !evictPinned && resident.lastUsed < idleCutoff
        if (residents.size <= capacity && !idle) break
        if (id === exempt || retained(id) || pins.has(id) !== evictPinned) continue
        evict(id)
      }
    }
  }

  function wake(readers: Readers): void {
    if (!readers.dormant) return
    readers.dormant = false
    const withheld = Array.from(readers.withheld.values())
    readers.withheld.clear()
    for (const event of withheld) for (const listener of readers.listeners) listener(event)
    if (lane !== 0) for (const listener of Array.from(readers.laneListeners)) listener(lane)
    awakeChanged()
  }

  // Both fan-outs copy the residents, and a lane opening copies its
  // listeners, as the connection does: a reader that a call makes attaches
  // after the event and hears the open lane when it attaches, so it must not
  // hear either again.
  function deliver(event: FrontendEvent): void {
    const laneBreak = event.type === "patch" && isLaneBreak(event.patch)
    if (laneBreak) lane = 0
    let slept = false
    for (const [id, { readers }] of Array.from(residents)) {
      if (laneBreak && !retained(id) && !readers.dormant) {
        readers.dormant = true
        slept = true
      }
      if (laneBreak || !readers.dormant) {
        for (const listener of readers.listeners) listener(event)
      } else if (event.type === "patch" && isRuntimeInvalidationPayload(event.patch.payload) && event.patch.payload.reason === "rebase") {
        readers.withheld.set(cursorKey(event.patch.cursor), event)
      }
    }
    if (slept) awakeChanged()
  }

  function open(next: number): void {
    lane = next
    for (const { readers } of Array.from(residents.values())) {
      if (!readers.dormant) for (const listener of Array.from(readers.laneListeners)) listener(next)
    }
  }

  function lanesOf(readers: Readers): ResidentLanes {
    return {
      subscribe(listener) {
        readers.listeners.add(listener)
        return () => { readers.listeners.delete(listener) }
      },
      onLane(listener) {
        readers.laneListeners.add(listener)
        if (lane !== 0 && !readers.dormant) listener(lane)
        return () => { readers.laneListeners.delete(listener) }
      },
    }
  }

  // One listener on each half of the connection fans out to every resident,
  // so the lane state has one owner whatever the number of readers.
  const stopEvents = options.dormancy ? options.lanes.subscribe(deliver) : undefined
  const stopLanes = options.dormancy ? options.lanes.onLane(open) : undefined

  return {
    get: (id) => residents.get(id)?.bundle,
    ids: () => [...residents.keys()],
    awake: () => [...residents].flatMap(([id, { readers }]) => readers.dormant ? [] : [id]),
    onAwakeChange(listener) {
      awakeListeners.add(listener)
      return () => { awakeListeners.delete(listener) }
    },
    use(id, create) {
      if (disposed) throw new Error("A residency cannot take a session after it is disposed.")
      let resident = residents.get(id)
      if (resident === undefined) {
        const readers: Readers = { dormant: false, listeners: new Set(), laneListeners: new Set(), withheld: new Map() }
        resident = { bundle: create(options.dormancy ? lanesOf(readers) : options.lanes), readers, lastUsed: 0 }
      }
      residents.delete(id)
      resident.lastUsed = now()
      residents.set(id, resident)
      sweep(id)
      return resident.bundle
    },
    retain(id) {
      const token = {}
      const owners = retainers.get(id) ?? new Set<object>()
      owners.add(token)
      retainers.set(id, owners)
      const resident = residents.get(id)
      if (resident !== undefined) wake(resident.readers)
      let released = false
      return {
        release() {
          if (released) return
          released = true
          owners.delete(token)
          if (owners.size === 0 && retainers.get(id) === owners) retainers.delete(id)
          sweep()
          // Hidden while no lane is open: the session waits for a surface, so
          // the sessions a person sees read first on the next lane.
          const kept = residents.get(id)
          if (options.dormancy && lane === 0 && kept !== undefined && !retained(id) && !kept.readers.dormant) {
            kept.readers.dormant = true
            awakeChanged()
          }
        },
      }
    },
    retained,
    evict,
    dispose() {
      disposed = true
      stopEvents?.()
      stopLanes?.()
      awakeListeners.clear()
      for (const id of residents.keys()) evict(id)
    },
  }
}
