import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { createSessionChangesController, type SessionChangesController, type SessionChangesSnapshot } from "../../protocol/client/session-changes.js"

export interface SessionChangesView {
  readonly controller: SessionChangesController
  readonly snapshot: Accessor<SessionChangesSnapshot>
}

/** Starts once after readiness survives a deferred turn; readiness loss or owner disposal cancels a pending start. */
export function startSessionChangesWhenReady(ready: Accessor<boolean>, start: () => void): void {
  let started = false
  createEffect(() => {
    if (started || !ready()) return
    const timer = setTimeout(() => {
      started = true
      start()
    }, 0)
    onCleanup(() => clearTimeout(timer))
  })
}

/** Adapts the shared controller to Solid. The shell enables acquisition only after its first frame and runtime readiness. */
export function createSessionChangesIntake(deps: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  readonly foregroundId: Accessor<string | undefined>
}) {
  const [view, setView] = createSignal<SessionChangesView>()
  const [enabled, setEnabled] = createSignal(false)
  let disposeOwner: (() => void) | undefined
  const removeOwner = (): void => {
    disposeOwner?.()
    disposeOwner = undefined
    setView(undefined)
  }
  createEffect(on(deps.foregroundId, (sessionId) => {
    removeOwner()
    if (!sessionId) return
    const controller = createSessionChangesController({ client: deps.client, sessionId })
    const [snapshot, setSnapshot] = createSignal(controller.snapshot)
    const unsubscribe = controller.onChange(() => setSnapshot(controller.snapshot))
    disposeOwner = () => { unsubscribe(); controller.dispose() }
    setView({ controller, snapshot })
  }))
  createEffect(on([enabled, view], ([ready, owner]) => {
    if (ready && owner) void owner.controller.start()
  }))
  const unsubscribe = deps.client.subscribe(event => {
    if (event.type === "patch" && event.patch.payload.kind === "session.removed"
      && event.patch.cursor.scope === "session"
      && event.patch.cursor.sessionId === untrack(view)?.controller.sessionId) removeOwner()
  })
  onCleanup(() => { unsubscribe(); removeOwner() })
  return { view, start: () => setEnabled(true) }
}
