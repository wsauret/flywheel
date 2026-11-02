import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createReadRetry } from "../../../src/protocol/client/background-reads.js"
import { createCursorIntake, isLaneBreak } from "../../../src/protocol/client/cursor-intake.js"
import { rolesCursor, type RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import { isGlobalRuntimeInvalidation, type RuntimePosition, type RuntimeUiPatch } from "../../../src/protocol/runtime-ui-protocol-types.js"

type RoleListener = (view: RoleAssignmentView | undefined) => void

interface HeldRoleReading {
  readonly view: RoleAssignmentView | undefined
  readonly listenerCount: number
  beginRefresh(): number
  owns(generation: number): boolean
  applySnapshot(generation: number, view: RoleAssignmentView | undefined, position: RuntimePosition): void
  accept(patch: RuntimeUiPatch): void
  subscribe(listener: RoleListener): () => void
  dispose(): void
}

export interface HeldRoles {
  get(sessionId: string): RoleAssignmentView | undefined
  subscribe(sessionId: string, listener: RoleListener): () => void
  accept(patch: RuntimeUiPatch): void
  refresh(): void
  dispose(): void
}

/** Current role assignments for child surfaces. One ordered intake belongs to
 * each observed child, while initial and reconnect snapshots batch across all
 * observed children. The final subscriber releases the reading. */
export function createHeldRoles(options: {
  readonly connection: RuntimeConnection
}): HeldRoles {
  const readings = new Map<string, HeldRoleReading>()
  const pending = new Set<string>()
  let refreshQueued = false
  let disposed = false
  const failed = new Set<string>()
  const retry = createReadRetry(options.connection, "child roles", () => { void refreshBatch([...failed]) })

  function createReading(sessionId: string): HeldRoleReading {
    let view: RoleAssignmentView | undefined
    let generation = 0
    let retired = false
    const listeners = new Set<RoleListener>()
    const notify = (): void => {
      for (const listener of listeners) listener(view)
    }
    const intake = createCursorIntake({
      cursor: rolesCursor(sessionId),
      onApply(patch) {
        if (patch.payload.kind === "roles.updated") view = patch.payload.roles
        else if (patch.payload.kind === "roles.removed") view = undefined
        else return
        notify()
      },
      onRecover() { void refreshBatch([sessionId]) },
    })
    return {
      get view() { return view },
      get listenerCount() { return listeners.size },
      beginRefresh() {
        intake.reset()
        return ++generation
      },
      owns(request) { return !retired && request === generation },
      applySnapshot(request, snapshotView, position) {
        if (retired || request !== generation) return
        view = snapshotView
        intake.seed(position)
        notify()
      },
      accept(patch) { if (!retired) intake.accept(patch) },
      subscribe(listener) {
        listeners.add(listener)
        listener(view)
        return () => { listeners.delete(listener) }
      },
      dispose() {
        retired = true
        generation += 1
        listeners.clear()
        intake.reset()
      },
    }
  }

  function scheduleRefresh(sessionId: string): void {
    pending.add(sessionId)
    if (refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      const sessionIds = [...pending]
      pending.clear()
      void refreshBatch(sessionIds)
    })
  }

  async function refreshBatch(sessionIds: readonly string[]): Promise<void> {
    if (disposed) return
    const requests = sessionIds.flatMap((sessionId) => {
      const reading = readings.get(sessionId)
      return reading === undefined ? [] : [{ sessionId, reading, generation: reading.beginRefresh() }]
    })
    if (requests.length === 0) return
    try {
      const snapshot = await options.connection.query({ type: "roleSnapshot", sessionIds: requests.map(({ sessionId }) => sessionId) })
      const views = new Map(snapshot.views.map(({ sessionId, view }) => [sessionId, view ?? undefined]))
      for (const request of requests) {
        if (readings.get(request.sessionId) !== request.reading || !request.reading.owns(request.generation)) continue
        failed.delete(request.sessionId)
        request.reading.applySnapshot(request.generation, views.get(request.sessionId), snapshot.snapshotPosition)
      }
      if (failed.size === 0) retry.succeeded()
    } catch (cause) {
      if (!disposed) {
        const current = requests.filter(request => readings.get(request.sessionId) === request.reading && request.reading.owns(request.generation))
        for (const request of current) failed.add(request.sessionId)
        if (current.length > 0) retry.failed(cause)
      }
    }
  }

  return {
    get: (sessionId) => readings.get(sessionId)?.view,
    subscribe(sessionId, listener) {
      if (disposed) return () => {}
      let reading = readings.get(sessionId)
      if (reading === undefined) {
        reading = createReading(sessionId)
        readings.set(sessionId, reading)
        scheduleRefresh(sessionId)
      }
      const unsubscribe = reading.subscribe(listener)
      return () => {
        unsubscribe()
        if (reading.listenerCount > 0 || readings.get(sessionId) !== reading) return
        reading.dispose()
        readings.delete(sessionId)
        pending.delete(sessionId)
        failed.delete(sessionId)
        if (failed.size === 0) retry.succeeded()
      }
    },
    accept(patch) {
      if (disposed) return
      if (isGlobalRuntimeInvalidation(patch)) {
        // A lane break voids every reading; the next lane reads them.
        if (isLaneBreak(patch)) for (const reading of readings.values()) reading.accept(patch)
        else void refreshBatch([...readings.keys()])
        return
      }
      if (patch.cursor.scope !== "session" || patch.cursor.domain !== "roles") return
      readings.get(patch.cursor.sessionId)?.accept(patch)
    },
    refresh() {
      if (!disposed) void refreshBatch([...readings.keys()])
    },
    dispose() {
      disposed = true
      retry.dispose()
      pending.clear()
      for (const reading of readings.values()) reading.dispose()
      readings.clear()
    },
  }
}
