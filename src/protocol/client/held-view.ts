import type { AttachedRuntimeClient } from "../app-service-types.js"
import { cursorKey, isGlobalRuntimeInvalidation, type RuntimeCursorIdentity, type RuntimePosition, type RuntimeUiPatchPayload } from "../runtime-ui-protocol-types.js"
import { createReadRetry } from "./background-reads.js"
import { createCursorIntake, isLaneBreak } from "./cursor-intake.js"

/** One whole view the runtime publishes on one cursor, held live.
 *
 *  A whole-view domain carries the complete view in every patch, so a patch
 *  replaces what is held and a gap or an invalidation reads the view again.
 *  The view is read once for each lane, when the lane opens: a lane break
 *  voids the cursor and reads nothing, because the next lane's read answers
 *  for it. A read that fails with its lane is silent; the next lane reads
 *  again. Other failures retry with backoff, and the last view stays. */
export interface HeldView<View> {
  /** The last view read or published, or undefined until the first one. */
  readonly view: View | undefined
  /** Settles once the first read has answered or failed. */
  readonly ready: Promise<void>
  /** Reads the view again now, as after a write this client made. */
  refresh(): Promise<void>
  dispose(): void
}

/** How a held view got its value: from a read, or from a published patch. */
export type HeldViewSource = "read" | "patch"

export interface HeldViewOptions<View> {
  readonly client: Pick<AttachedRuntimeClient, "subscribe" | "onLane"> & Partial<Pick<AttachedRuntimeClient, "query">>
  readonly cursor: RuntimeCursorIdentity
  /** Reads the whole view and the cursor position it answers at. */
  readonly read: () => Promise<{ readonly view: View; readonly position: RuntimePosition }>
  /** The whole view a payload carries, or undefined for any other payload.
   *  `position` is the patch's own position, for a view that records it. */
  readonly adopt: (payload: RuntimeUiPatchPayload, position: RuntimePosition) => View | undefined
  readonly changed: (view: View, source: HeldViewSource) => void
  /** Names the view in a read failure's diagnostic. */
  readonly label: string
  readonly onDiagnostic?: (message: string, cause: unknown) => void
}

export function createHeldView<View>(options: HeldViewOptions<View>): HeldView<View> {
  const key = cursorKey(options.cursor)
  let view: View | undefined
  let generation = 0
  let disposed = false
  let laneOpen = true
  const first = Promise.withResolvers<void>()
  const makeRetry = () => createReadRetry({ query: options.client.query ?? options.read }, options.label, () => { void refresh() }, (cause) => options.onDiagnostic?.(`${options.label} read failed`, cause))
  let retry = makeRetry()

  const intake = createCursorIntake({
    cursor: options.cursor,
    onApply(patch) {
      const next = options.adopt(patch.payload, patch.position)
      if (next === undefined) return
      view = next
      retry.succeeded()
      options.changed(next, "patch")
    },
    onRecover() { void refresh() },
  })

  async function refresh(): Promise<void> {
    if (disposed) return
    const read = ++generation
    intake.beginRead()
    try {
      const answer = await retry.read(() => disposed || read !== generation ? Promise.resolve(undefined) : options.read())
      if (disposed || read !== generation || answer === undefined) return
      view = answer.view
      retry.succeeded()
      options.changed(answer.view, "read")
      // Seeding applies the patches held while the read was out, which are
      // newer than the view it answered with.
      intake.seed(answer.position)
    } catch (cause) {
      if (!disposed && laneOpen && read === generation) retry.failed(cause)
    } finally {
      first.resolve()
    }
  }

  const unsubscribe = options.client.subscribe((event) => {
    if (disposed || event.type !== "patch") return
    if (isLaneBreak(event.patch)) {
      laneOpen = false
      generation += 1
      retry.dispose()
      intake.reset()
      return
    }
    if (!isGlobalRuntimeInvalidation(event.patch) && cursorKey(event.patch.cursor) !== key) return
    // Every patch carries the whole view, so a gap gains nothing by waiting
    // to close: the read answers with the same whole view at once.
    if (intake.accept(event.patch) === "gap" && intake.heldPosition !== null) void refresh()
  })
  const stopLanes = options.client.onLane(() => {
    laneOpen = true
    retry.dispose()
    retry = makeRetry()
    void refresh()
  })

  return {
    get view() { return view },
    ready: first.promise,
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      generation += 1
      retry.dispose()
      stopLanes()
      unsubscribe()
      intake.reset()
      first.resolve()
    },
  }
}
