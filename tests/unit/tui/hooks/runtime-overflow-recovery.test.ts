import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { cursorKey, type RuntimeCursorIdentity, type RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createOrderedPatchReceiver } from "../../../../src/tui/hooks/create-ordered-patch-receiver.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"

for (const domain of ["session", "status"] as const) {
  test(`${domain} invalidation snapshots then synchronously publishes a dropped successor`, async () => {
    await createRoot(async (dispose) => {
      const bus = createRuntimeUiBus({ maxPendingDeliveries: 1 })
      const cursor = { scope: "session", domain, sessionId: "a" } as const
      const barrier = { scope: "session", domain: "session", sessionId: "barrier" } as const
      let authoritative = 0
      let resident = 0
      const snapshots: number[] = []
      const delivered: RuntimeUiPatch[] = []
      const receiver = createOrderedPatchReceiver<string, { value: number; snapshotPosition: number }>({
        client: {
          subscribe(listener) {
            bus.addListener(listener)
            return () => bus.removeListener(listener)
          },
          // No lane opens: only the invalidations read.
          onLane: fakeLanes({ open: false }).onLane,
        },
        accept: (patch) => cursorKey(patch.cursor) === cursorKey(cursor) ? { cursor, scope: "a", patch } : null,
        scopeKey: (scope) => scope,
        loadSnapshot() {
          const snapshot = { value: authoritative, snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor }) }
          snapshots.push(snapshot.value)
          // The snapshot captures the old value before the callback's next
          // publish. The current marker is still pending until this returns.
          if (snapshots.length === 1) publish()
          return Promise.resolve(snapshot)
        },
        applySnapshot(snapshot) {
          resident = snapshot.value
          return { snapshotPosition: snapshot.snapshotPosition, cursors: [cursor] }
        },
        applyPayload() { resident = 1 },
      })
      bus.addListener((event) => {
        if (event.type !== "patch") return
        if (cursorKey(event.patch.cursor) === cursorKey(cursor)) delivered.push(event.patch)
        // This marker was queued before the successor. The first marker has
        // completed, but its successor must still coalesce this further drop.
        else if (event.patch.payload.kind === "runtime.invalidate") publish()
      })
      function publish(): void {
        authoritative += 1
        bus.publish({ cursor, payload: { kind: domain === "session" ? "session.removed" : "status.removed" } })
      }
      try {
        publish()
        publish()
        bus.publish({ cursor: barrier, payload: { kind: "session.removed" } })
        await bus.drain()
        expect(snapshots).toEqual([2, 4])
        expect(resident).toBe(4)
        expect(delivered.map((patch) => patch.payload.kind)).toEqual([
          `${domain}.removed`, "runtime.invalidate", "runtime.invalidate",
        ])
        expect(delivered[2]!.position).toBeGreaterThan(delivered[1]!.position)
      } finally {
        receiver.dispose()
        dispose()
        await bus.clear()
      }
    })
  })
}

test("two subscribers receive independent latest cursors with one queued marker per cursor", async () => {
  const bus = createRuntimeUiBus({ maxPendingDeliveries: 1 })
  const cursors: readonly RuntimeCursorIdentity[] = [
    { scope: "session", domain: "status", sessionId: "a" },
    { scope: "session", domain: "status", sessionId: "b" },
  ]
  const deliveries: RuntimeUiPatch[][] = [[], []]
  for (const delivered of deliveries) bus.addListener((event) => {
    if (event.type === "patch") delivered.push(event.patch)
  })
  try {
    for (const cursor of [cursors[0]!, cursors[0]!, cursors[0]!, cursors[1]!, cursors[1]!]) {
      bus.publish({ cursor, payload: { kind: "status.removed" } })
    }
    await bus.drain()
    expect(deliveries[0]).toEqual(deliveries[1])
    expect(deliveries[0]!.map((patch) => [cursorKey(patch.cursor), patch.payload.kind])).toEqual([
      [cursorKey(cursors[0]!), "status.removed"],
      [cursorKey(cursors[0]!), "runtime.invalidate"],
      [cursorKey(cursors[1]!), "runtime.invalidate"],
    ])
  } finally {
    await bus.clear()
  }
})
