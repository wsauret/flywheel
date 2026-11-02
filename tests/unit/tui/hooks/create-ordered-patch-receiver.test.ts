import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createOrderedPatchReceiver } from "../../../../src/tui/hooks/create-ordered-patch-receiver.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"

/** The terminal binding only subscribes the shared family intake and ties it
 *  to the Solid owner; the ordering contract itself is the client core's suite. */
describe("createOrderedPatchReceiver", () => {
  it("feeds the runtime stream to the shared intake and unsubscribes with its owner", async () => {
    let listener: ((event: FrontendEvent) => void) | null = null
    let unsubscribed = false
    const lanes = fakeLanes({ open: false })
    const subscribe: Pick<AttachedRuntimeClient, "subscribe">["subscribe"] = (next) => {
      listener = next
      return () => { unsubscribed = true; listener = null }
    }
    const applied: number[] = []
    const signals: AbortSignal[] = []
    await createRoot(async (dispose) => {
      createOrderedPatchReceiver<string, { snapshotPosition: number }>({
        client: { subscribe, onLane: lanes.onLane },
        accept: (patch) => patch.cursor.scope === "session" ? { cursor: patch.cursor, scope: "sessions", patch } : null,
        scopeKey: (scope) => scope,
        connectedScope: () => "sessions",
        loadSnapshot: (_scope, signal) => { signals.push(signal); return new Promise(() => {}) },
        applySnapshot: (snapshot) => ({ snapshotPosition: snapshot.snapshotPosition, clearHeld: true }),
        applyPayload: (patch) => { applied.push(patch.position) },
      })
      listener?.({ type: "patch", patch: { cursor: sessionCursor("s1"), position: 1, prevPosition: 0, payload: { kind: "session.removed" } } })
      expect(applied).toEqual([1])
      lanes.open()
      expect(signals[0]?.aborted).toBe(false)
      dispose()
    })
    expect(unsubscribed).toBe(true)
    expect(signals[0]?.aborted).toBe(true)
  })
})
