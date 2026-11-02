import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { createBackgroundIndexController, type BackgroundIndexController, type BackgroundIndexState } from "../../protocol/client/background-index.js"

export interface BackgroundIndexView {
  readonly state: Accessor<BackgroundIndexState>
  /** Reads the background index of `sessionId` while the modal shows it. */
  show(sessionId: string): void
  /** Stops reading it: the index is read only while a client shows it. */
  hide(): void
}

/** The terminal's receiver of the `background` domain. It holds a
 *  controller of the shared client core only while the background modal
 *  shows a session's index. */
export function createBackgroundIndexIntake(deps: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
}): BackgroundIndexView {
  const [state, setState] = createSignal<BackgroundIndexState>({ status: "idle" })
  let shown: { readonly controller: BackgroundIndexController; readonly stop: () => void } | undefined
  function hide(): void {
    shown?.stop()
    shown?.controller.dispose()
    shown = undefined
    setState({ status: "idle" })
  }
  function show(sessionId: string): void {
    if (shown?.controller.sessionId === sessionId) return
    hide()
    const controller = createBackgroundIndexController({ client: deps.client, sessionId })
    shown = { controller, stop: controller.onChange(() => setState(controller.snapshot)) }
    void controller.start()
  }
  onCleanup(hide)
  return { state, show, hide }
}
