import { Log } from "../../infra/log.js"
import { createBackgroundLane, type BackgroundLane } from "../../infra/ordered-lane.js"
import type { SessionEntry, SessionStore } from "../session-store/types.js"
import type { RuntimeSessionCursorIdentity, RuntimeUiPatch, RuntimeUiPatchInput, RuntimeUiPatchPayload } from "../../protocol/runtime-ui-protocol-types.js"

/** The publish half every per-session view projection shares: an equality-gated
 *  diff against the last published view, one microtask batch, and the
 *  updated/removed payload mint. Domains supply only their cursor, payload
 *  constructors, and equality; the batching policy lives here and nowhere else.
 *
 *  Batching is one microtask per burst: the session store emits a synchronous
 *  notification per mutation, so a single streamed model event can move several
 *  fields in one tick. Publishing on the microtask collapses that burst into at
 *  most one patch per session, and a change that reverts within the tick
 *  publishes nothing. */
export interface SessionViewPublisher<View> {
  /** Diff `view` against the last published view for this session and publish
   *  the difference on the next microtask. `null` means the view is gone and
   *  publishes the removed payload. */
  set(sessionId: string, view: View | null): void
  /** Record `view` as already delivered without publishing. Serving a snapshot
   *  is delivery: the baseline must reflect it so the next `set` publishes the
   *  difference against what receivers actually hold - including a removal for
   *  a view that only ever left the runtime through a snapshot reply. */
  prime(sessionId: string, view: View | null): void
  dispose(): void
}

export interface SessionViewPublisherConfig<View> {
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch | undefined
  readonly cursor: (sessionId: string) => RuntimeSessionCursorIdentity
  readonly payloads: {
    readonly updated: (view: View) => RuntimeUiPatchPayload
    readonly removed: () => RuntimeUiPatchPayload
  }
  readonly same: (a: View, b: View) => boolean
}

export function createSessionViewPublisher<View>(config: SessionViewPublisherConfig<View>): SessionViewPublisher<View> {
  let disposed = false
  let flushQueued = false
  const emittedById = new Map<string, View>()
  const pendingById = new Map<string, View | null>()

  function sameView(a: View | null, b: View | null): boolean {
    if (a === null || b === null) return a === b
    return config.same(a, b)
  }

  function set(sessionId: string, view: View | null): void {
    if (disposed) return
    // A change that reverted to the published view within the batch window
    // cancels its pending patch instead of publishing a no-op.
    if (sameView(emittedById.get(sessionId) ?? null, view)) {
      pendingById.delete(sessionId)
      return
    }
    pendingById.set(sessionId, view)
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flush)
    }
  }

  function prime(sessionId: string, view: View | null): void {
    if (disposed) return
    if (view !== null) emittedById.set(sessionId, view)
    else emittedById.delete(sessionId)
  }

  function flush(): void {
    flushQueued = false
    if (disposed) return
    const pending = [...pendingById]
    pendingById.clear()
    for (const [sessionId, view] of pending) {
      // A prime between enqueue and flush may have delivered this view through
      // a snapshot reply already; re-check so the patch is not duplicated.
      if (sameView(emittedById.get(sessionId) ?? null, view)) continue
      if (view !== null) emittedById.set(sessionId, view)
      else emittedById.delete(sessionId)
      config.publish({
        cursor: config.cursor(sessionId),
        payload: view !== null ? config.payloads.updated(view) : config.payloads.removed(),
      })
    }
  }

  return {
    set,
    prime,
    dispose() {
      disposed = true
      emittedById.clear()
      pendingById.clear()
    },
  }
}

/** A per-session view projection driven by the session store: seed the emitted
 *  baselines from the live entries, re-project a session only when its store
 *  revision moves, and sweep sessions that leave the store. This is the whole
 *  skeleton the status/budget/queue projections share; each domain supplies a
 *  view function and an equality function.
 *
 *  A projection is a store observer, never a Solid computation: delivery to
 *  protocol subscribers must not run inside the store's reactive graph, so the
 *  store's synchronous per-session revision is the only change signal used. */
export interface SessionViewProjection<View> {
  /** The current view of one live session, straight from the store. Null when
   *  the session is not live or has no view in this domain. */
  snapshot(sessionId: string): Promise<View | null>
  /** Push seam for domains whose views also move on non-store triggers (queue
   *  facts arriving by commit push). Same equality gate and batch as sync. */
  set(sessionId: string, view: View | null): void
  /** Records a view a domain delivered through its own snapshot reply, for a
   *  session with no live entry, so its next `set` publishes against it. */
  prime(sessionId: string, view: View | null): void
  /** The view of a live entry. It reuses the view last derived for the
   *  session while the entry's `inputs` stay the same, unless `fresh`. */
  project(sessionId: string, entry: SessionEntry, options?: { readonly fresh?: boolean }): Promise<View | null>
  /** Run domain work on the session's ordered lane, after its seed and every
   *  store sync already queued. A domain that folds pushed facts and then
   *  calls `set` runs here so its publish cannot overtake a sync for the same
   *  session or land before the seed has tracked the session. */
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T>
  /** Resolves once every queued seed, sync, and domain task has finished. */
  settled(): Promise<void>
  dispose(): void
}

/** The members of the session store that a view projection reads. */
export type ViewedSessionStore = Pick<SessionStore, "allIds" | "get" | "revision" | "onChange">

export interface SessionViewProjectionConfig<View> extends SessionViewPublisherConfig<View> {
  readonly sessionStore: ViewedSessionStore
  /** Store subscription label, for change-listener diagnostics. */
  readonly label: string
  /** The domain's view of one live entry; null when the entry has no view in
   *  this domain (a chat session in the queue domain). */
  readonly view: (sessionId: string, entry: SessionEntry) => Promise<View | null> | View | null
  /** The entry values that `view` reads, compared element by element. While
   *  they stay the same, a store change derives nothing and `project` reuses
   *  the last view: most changes of a streaming session move only its
   *  output. Undefined derives the view on every change, for an entry whose
   *  view also reads something no store change shows. A domain whose view
   *  reads such a value derives again through `project` with `fresh` when it
   *  changes. Absent: every change derives. */
  readonly inputs?: (sessionId: string, entry: SessionEntry) => readonly unknown[] | undefined
  /** Called once when a session leaves the store: release domain caches and
   *  name the final view to publish. Absent (or null) publishes the removed
   *  payload; a view keeps the cursor showing durable state (a settled
   *  workflow's stored queue). */
  readonly departed?: (sessionId: string) => Promise<View | null> | View | null
}

const log = Log.create({ service: "session-view-projection" })

export function createSessionViewProjection<View>(config: SessionViewProjectionConfig<View>): SessionViewProjection<View> {
  const publisher = createSessionViewPublisher(config)
  const revisionById = new Map<string, number>()
  const derived = new Map<string, { readonly inputs: readonly unknown[]; readonly view: View | null }>()
  // Sessions with a sync on their lane that has not started: it reads the
  // store when it runs, so a later change needs no second sync.
  const queued = new Set<string>()
  const lanes = new Map<string, BackgroundLane>()
  function lane(sessionId: string): BackgroundLane {
    let current = lanes.get(sessionId)
    if (!current) {
      current = createBackgroundLane(log, config.label, () => { lanes.delete(sessionId) })
      lanes.set(sessionId, current)
    }
    return current
  }

  function sameInputs(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
    return a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => value === b[index])
  }

  function reusable(sessionId: string, inputs: readonly unknown[] | undefined): { readonly view: View | null } | undefined {
    const last = derived.get(sessionId)
    return last !== undefined && sameInputs(last.inputs, inputs) ? last : undefined
  }

  async function project(sessionId: string, entry: SessionEntry, options: { readonly fresh?: boolean } = {}): Promise<View | null> {
    const inputs = config.inputs?.(sessionId, entry)
    const last = options.fresh ? undefined : reusable(sessionId, inputs)
    if (last) return last.view
    // A replacement must not let a change during its await reuse the old view.
    derived.delete(sessionId)
    const view = await config.view(sessionId, entry)
    // An async view can read entry values on either side of its await.
    if (inputs !== undefined && sameInputs(inputs, config.inputs?.(sessionId, entry))) derived.set(sessionId, { inputs, view })
    return view
  }

  // The baseline is the store as it stands at construction: revisions are
  // recorded synchronously so a mutation that lands before the views resolve
  // still reads as a change, and the views themselves resolve on the lane.
  function seed(): void {
    for (const sessionId of config.sessionStore.allIds()) {
      const entry = config.sessionStore.get(sessionId)
      if (!entry) continue
      revisionById.set(sessionId, config.sessionStore.revision(sessionId))
      lane(sessionId).runInBackground("view seed", async () => {
        publisher.prime(sessionId, await project(sessionId, entry))
      })
    }
  }

  /** Whether a change of the session can move its view, read at the change. */
  function moved(sessionId: string): boolean {
    const entry = config.sessionStore.get(sessionId)
    if (!entry) return revisionById.has(sessionId)
    const revision = config.sessionStore.revision(sessionId)
    if (revisionById.get(sessionId) === revision) return false
    if (!reusable(sessionId, config.inputs?.(sessionId, entry))) return true
    revisionById.set(sessionId, revision)
    return false
  }

  async function sync(sessionId: string): Promise<void> {
    queued.delete(sessionId)
    const entry = config.sessionStore.get(sessionId)
    if (!entry) {
      derived.delete(sessionId)
      if (!revisionById.delete(sessionId)) return
      publisher.set(sessionId, await config.departed?.(sessionId) ?? null)
      return
    }
    const revision = config.sessionStore.revision(sessionId)
    if (revisionById.get(sessionId) === revision) return
    revisionById.set(sessionId, revision)
    publisher.set(sessionId, await project(sessionId, entry))
  }

  // Each session orders its work without making another session wait for
  // its output flush.
  seed()
  const unsubscribe = config.sessionStore.onChange((changed) => {
    const ids = changed ?? new Set([...config.sessionStore.allIds(), ...revisionById.keys()])
    for (const sessionId of ids) {
      if (queued.has(sessionId) || !moved(sessionId)) continue
      queued.add(sessionId)
      lane(sessionId).runInBackground("view sync", () => sync(sessionId))
    }
  }, config.label)

  return {
    async snapshot(sessionId) {
      const entry = config.sessionStore.get(sessionId)
      return entry ? config.view(sessionId, entry) : null
    },
    set: publisher.set,
    prime: publisher.prime,
    project,
    run: (sessionId, task) => lane(sessionId).run(task),
    settled: async () => { await Promise.all([...lanes.values()].map((current) => current.settled())) },
    dispose() {
      unsubscribe()
      revisionById.clear()
      derived.clear()
      queued.clear()
      lanes.clear()
      publisher.dispose()
    },
  }
}
