import { describe, expect, test } from "bun:test"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"

function input(sessionId = "s1"): RuntimeUiPatchInput {
  return { cursor: { scope: "session", domain: "session", sessionId }, payload: { kind: "session.removed" } }
}

function sessionIdOf(event: FrontendEvent): string | undefined {
  return event.type === "patch" && event.patch.cursor.scope === "session" ? event.patch.cursor.sessionId : undefined
}

describe("RuntimeUiBus", () => {
  test("overflow does not turn the query-only domain into a live recovery stream", async () => {
    const bus = createRuntimeUiBus({ maxPendingDeliveries: 1 })
    const events: FrontendEvent[] = []
    bus.addListener((event) => { events.push(event) })
    try {
      const admitted = bus.publish(input())
      bus.publish({
        cursor: { scope: "workspace", domain: "runtime" },
        payload: { kind: "runtime.invalidate", reason: "reconnect_required" },
      })
      await bus.drain()
      expect(events).toEqual([{ type: "patch", patch: admitted }])
    } finally {
      await bus.clear()
    }
  })

  test("publish synchronously mints and returns an ordered patch", () => {
    const bus = createRuntimeUiBus()
    const patch = bus.publish(input())

    expect(patch.position).toBeGreaterThan(patch.prevPosition)
    expect(patch.cursor).toEqual({ scope: "session", domain: "session", sessionId: "s1" })
    expect(patch.payload).toEqual({ kind: "session.removed" })
    bus.clear()
  })

  test("a patch published immediately after subscription acquisition is delivered", async () => {
    const bus = createRuntimeUiBus()
    const events: FrontendEvent[] = []
    const listener = (event: FrontendEvent) => events.push(event)

    bus.addListener(listener)
    const patch = bus.publish(input("s2"))
    await bus.drain()

    expect(events).toEqual([{ type: "patch", patch }])
    bus.clear()
  })

  test("listener failures are isolated and the subscriber receives the next patch", async () => {
    const bus = createRuntimeUiBus()
    const received: string[] = []
    let first = true
    bus.addListener((event) => {
      const sessionId = sessionIdOf(event)
      if (sessionId === undefined) return
      received.push(sessionId)
      if (first) {
        first = false
        throw new Error("boom")
      }
    })
    bus.addListener((event) => {
      const sessionId = sessionIdOf(event)
      if (sessionId !== undefined) received.push(`other:${sessionId}`)
    })

    bus.publish(input("a"))
    bus.publish(input("b"))
    await bus.drain()

    expect(received).toEqual(["a", "other:a", "b", "other:b"])
    bus.clear()
  })

  test("burst deliveries reach every listener in publish order, and a removed listener still receives what was published to it", async () => {
    const bus = createRuntimeUiBus()
    const received: string[] = []
    const removed: string[] = []
    const removedListener = (event: FrontendEvent) => { const sessionId = sessionIdOf(event); if (sessionId !== undefined) removed.push(sessionId) }
    bus.addListener((event) => { const sessionId = sessionIdOf(event); if (sessionId !== undefined) received.push(sessionId) })
    bus.addListener(removedListener)

    const expected = Array.from({ length: 1100 }, (_, i) => `burst-${i}`)
    for (const sessionId of expected) bus.publish(input(sessionId))
    bus.removeListener(removedListener)
    bus.publish(input("after-removal"))
    await bus.drain()

    expect(received).toEqual([...expected, "after-removal"])
    expect(removed).toEqual(expected)
    await bus.clear()
  })

  test("clear delivers none of the patches still queued", async () => {
    const bus = createRuntimeUiBus()
    const received: FrontendEvent[] = []
    bus.addListener((event) => { received.push(event) })

    bus.publish(input("a"))
    bus.publish(input("b"))
    await bus.clear()

    expect(received).toEqual([])
  })

  test("durable overload emits cursor invalidations instead of growing pending forever", async () => {
    const bus = createRuntimeUiBus({ maxPendingDeliveries: 2 })
    const received: string[] = []
    const invalidated: string[] = []
    bus.addListener((event) => {
      if (event.type !== "patch" || event.patch.cursor.scope !== "session") return
      if (event.patch.payload.kind === "runtime.invalidate") invalidated.push(event.patch.cursor.sessionId)
      else received.push(event.patch.cursor.sessionId)
    })

    for (const sessionId of ["a", "b", "c", "d"]) bus.publish(input(sessionId))
    await bus.drain()

    expect(received).toEqual(["a", "b"])
    expect(invalidated).toEqual(["c", "d"])
    bus.clear()
  })

  test("the overflow invalidation rides the ordered lane after the queued backlog, once per cursor", async () => {
    const bus = createRuntimeUiBus({ maxPendingDeliveries: 1 })
    const order: string[] = []
    bus.addListener((event) => {
      if (event.type !== "patch" || event.patch.cursor.scope !== "session") return
      order.push(`${event.patch.payload.kind}:${event.patch.cursor.sessionId}`)
    })

    bus.publish(input("a"))
    // Both overflowing publishes hit the SAME cursor: exactly one invalidation
    // is minted, and it is delivered AFTER the queued patch for `a` -- in
    // publish order, not out-of-band ahead of the backlog it supersedes.
    bus.publish(input("b"))
    bus.publish(input("b"))
    await bus.drain()

    expect(order).toEqual(["session.removed:a", "runtime.invalidate:b"])
    bus.clear()
  })
})
