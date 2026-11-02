import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createReadRetry } from "../../../src/protocol/client/background-reads.js"
import { createCursorIntake, type CursorIntake } from "../../../src/protocol/client/cursor-intake.js"
import type { ModuleDomainBinding } from "../../../src/protocol/client/module-domain.js"

/** One module domain's live view, for the session it follows or for the
 *  workspace, built from the domain's registry binding.
 *
 *  Ordering goes through the same intake as the transcript. A view that
 *  silently missed a patch would show stale state while the runtime has
 *  already committed newer; a gap reseeds from the snapshot instead. */
export interface ModuleDomainMonitor<View> {
  readonly view: View | null
  onChange(listener: () => void): () => void
  dispose(): void
}

export interface ModuleDomainMonitorOptions<Domain extends string, Scope extends "session" | "workspace" | "workflow", Patch, View> {
  readonly binding: ModuleDomainBinding<Domain, Scope, Patch, View>
  readonly connection: Pick<RuntimeConnection, "query" | "subscribe" | "onLane">
  /** Required for a session- or workflow-scoped domain. */
  readonly ownerId?: string
}

export function createModuleDomainMonitor<Domain extends string, Scope extends "session" | "workspace" | "workflow", Patch, View>(
  options: ModuleDomainMonitorOptions<Domain, Scope, Patch, View>,
): ModuleDomainMonitor<View> {
  const { binding, connection } = options
  const listeners = new Set<() => void>()
  let view: View | null = null
  let disposed = false
  let work: Promise<void> = Promise.resolve()
  const retry = createReadRetry(connection, binding.domain, () => { void resnapshot() })

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const intake: CursorIntake = createCursorIntake({
    cursor: binding.cursor(options.ownerId),
    onApply: ({ payload }) => {
      if (!binding.isPayload(payload)) return
      view = binding.payloadView(payload, view ?? undefined)
      emit()
    },
    onRecover: () => {
      retry.request()
    },
  })

  function resnapshot(): Promise<void> {
    intake.reset()
    work = work.then(async () => {
      if (disposed) return
      try {
        const snapshot = await retry.read(() => binding.read(connection, options.ownerId))
        if (disposed) return
        view = snapshot.view
        intake.seed(snapshot.snapshotPosition)
        retry.succeeded()
        emit()
      } catch (cause) {
        retry.failed(cause)
      }
    }).catch(() => {})
    return work
  }

  const unsubscribe = connection.subscribe((event) => {
    if (disposed || event.type !== "patch") return
    intake.accept(event.patch)
  })
  // Each lane reads the view, the first among them.
  const stopLanes = connection.onLane(() => {
    retry.expedite()
    if (!disposed) retry.request()
  })

  return {
    get view() {
      return view
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      retry.dispose()
      stopLanes()
      unsubscribe()
      intake.reset()
      listeners.clear()
    },
  }
}
