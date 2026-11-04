import { describe, expect, test } from "bun:test"
import type { RuntimeCursorIdentity, RuntimeUiPatch, RuntimeUiPatchPayload } from "../../../src/protocol/runtime-ui-protocol-types.js"
import { createCursorIntake, createIntakeRegistry, type RecoveryRequest } from "../../../src/protocol/client/cursor-intake.js"
import { createRuntimeUiPatchSequencer } from "../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"

const CURSOR: RuntimeCursorIdentity = { scope: "session", domain: "output", sessionId: "s1" }

/** A real output-domain payload whose identity rides in the append target's
 *  blockId, so applied order is observable without asserting a fake shape. */
function patch(position: number, prevPosition: number, id = `b${position}`): RuntimeUiPatch {
  return {
    cursor: CURSOR,
    position,
    prevPosition,
    payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: id, contentOffset: 0, text: id }] } },
  }
}

function payloadId(payload: RuntimeUiPatchPayload): string {
  if (payload.kind !== "output.delta") return payload.kind
  const change = payload.delta.blocks[0]
  return change?.kind === "append-content" ? change.blockId : payload.kind
}

function invalidate(position: number, prevPosition: number): RuntimeUiPatch {
  return { cursor: CURSOR, position, prevPosition, payload: { kind: "runtime.invalidate", reason: "overflow" } }
}

/** Collects what a receiver applied and what it asked to recover, plus a hand
 *  driven clock so a gap deadline is exercised without waiting for one. */
function harness(overrides: Partial<Parameters<typeof createCursorIntake>[0]> = {}) {
  const applied: RuntimeUiPatchPayload[] = []
  const recovered: RecoveryRequest[] = []
  let fire: (() => void) | undefined
  const intake = createCursorIntake({
    cursor: CURSOR,
    onApply: (delivered) => applied.push(delivered.payload),
    onRecover: (request) => recovered.push(request),
    setTimer: (run) => {
      fire = run
      // A genuine handle keeps the harness assertion-free; cleared at once so
      // no real timer ever fires in a unit test.
      const timer = setTimeout(() => {}, 0)
      clearTimeout(timer)
      return timer
    },
    clearTimer: () => {
      fire = undefined
    },
    ...overrides,
  })
  const ids = (): string[] => applied.map(payloadId)
  return { intake, applied, recovered, ids, elapseGapDeadline: () => fire?.() }
}

describe("cursor intake", () => {
  test("snapshot coverage accepts an earlier predecessor but still holds a genuinely missing patch", () => {
    const h = harness()
    h.intake.seed(2)
    expect(h.intake.accept(patch(3, 1))).toBe("applied")
    expect(h.intake.accept(patch(3, 1))).toBe("stale")
    expect(h.ids()).toEqual(["b3"])
    const missed = harness()
    missed.intake.seed(2)
    expect(missed.intake.accept(patch(5, 3))).toBe("gap")
    expect(missed.intake.accept(patch(3, 1))).toBe("applied")
    expect(missed.ids()).toEqual(["b3", "b5"])
    expect(missed.intake.pendingCount).toBe(0)
    expect(missed.recovered).toEqual([])
  })

  test("seeding drains covered predecessors in publication order and discards covered patches", () => {
    const h = harness()
    h.intake.accept(patch(5, 3))
    h.intake.accept(patch(3, 1))
    h.intake.accept(patch(1, 0))
    h.intake.seed(2)
    expect(h.ids()).toEqual(["b3", "b5"])
    expect(h.intake.heldPosition).toBe(5)
    expect(h.intake.pendingCount).toBe(0)
    expect(h.recovered).toEqual([])
  })

  test("a new cursor's zero predecessor applies above a nonzero workspace watermark", () => {
    const h = harness()
    h.intake.seed(10)
    expect(h.intake.accept(patch(11, 0))).toBe("applied")
    expect(h.ids()).toEqual(["b11"])
  })

  test("applies contiguous patches and advances the held position", () => {
    const h = harness()
    h.intake.seed(10)
    expect(h.intake.accept(patch(11, 10))).toBe("applied")
    expect(h.intake.accept(patch(12, 11))).toBe("applied")
    expect(h.ids()).toEqual(["b11", "b12"])
    expect(h.intake.heldPosition).toBe(12)
  })

  test("holds an out-of-order patch and replays it once the gap closes", () => {
    const h = harness()
    h.intake.seed(10)
    // 12 arrives before 11. Applying it now would silently skip 11's content.
    expect(h.intake.accept(patch(12, 11))).toBe("gap")
    expect(h.ids()).toEqual([])
    expect(h.intake.pendingCount).toBe(1)

    expect(h.intake.accept(patch(11, 10))).toBe("applied")
    // The held patch replays in position order.
    expect(h.ids()).toEqual(["b11", "b12"])
    expect(h.intake.heldPosition).toBe(12)
    expect(h.intake.pendingCount).toBe(0)
  })

  test("replays a run of held patches in order, not arrival order", () => {
    const h = harness()
    h.intake.seed(10)
    h.intake.accept(patch(14, 13))
    h.intake.accept(patch(12, 11))
    h.intake.accept(patch(13, 12))
    expect(h.ids()).toEqual([])

    h.intake.accept(patch(11, 10))
    expect(h.ids()).toEqual(["b11", "b12", "b13", "b14"])
    expect(h.intake.heldPosition).toBe(14)
  })

  test("reports each applied position after advancing, including sorted held drain", () => {
    const applied: Array<{ id: string; position: number; heldPosition: number | null }> = []
    const intake = createCursorIntake({
      cursor: CURSOR,
      onApply: (delivered) => { applied.push({ id: payloadId(delivered.payload), position: delivered.position, heldPosition: intake.heldPosition }) },
      onRecover: () => {},
    })

    intake.accept(patch(13, 12))
    intake.accept(patch(12, 11))
    intake.seed(10)
    intake.accept(patch(11, 10))

    expect(applied).toEqual([
      { id: "b11", position: 11, heldPosition: 11 },
      { id: "b12", position: 12, heldPosition: 12 },
      { id: "b13", position: 13, heldPosition: 13 },
    ])
  })

  test("recovers when a gap stays open past the deadline", () => {
    const h = harness()
    h.intake.seed(10)
    h.intake.accept(patch(12, 11))
    // Still waiting for the missing patch.
    expect(h.recovered.length).toBe(0)

    h.elapseGapDeadline()
    expect(h.recovered.length).toBe(1)
    expect(h.recovered[0]?.reason).toBe("gap_unclosed")
    expect(h.recovered[0]?.policy).toBe("durable-resnapshot")
    // Held patches are void once recovery is requested.
    expect(h.intake.pendingCount).toBe(0)
  })

  test("does not recover when the gap closed before the deadline", () => {
    const h = harness()
    h.intake.seed(10)
    h.intake.accept(patch(12, 11))
    h.intake.accept(patch(11, 10))
    h.elapseGapDeadline()
    expect(h.recovered.length).toBe(0)
  })

  test("recovers when held patches overflow the bound", () => {
    const h = harness({ maxHeldPatches: 3 })
    h.intake.seed(10)
    for (let position = 12; position <= 15; position += 1) h.intake.accept(patch(position, position - 1))
    expect(h.recovered.length).toBe(1)
    expect(h.recovered[0]?.reason).toBe("held_overflow")
  })

  test("treats a runtime invalidation as recovery, not as an ordinary payload", () => {
    const h = harness()
    h.intake.seed(10)
    h.intake.accept(invalidate(11, 10))
    // An invalidation is not applied to resident state.
    expect(h.ids()).toEqual([])
    expect(h.recovered[0]?.reason).toBe("runtime_invalidated")
  })

  test("a lane break voids the cursor and asks for no read, and the next lane's seed anchors what arrived meanwhile", () => {
    const h = harness()
    h.intake.seed(10)
    h.intake.accept(patch(11, 10))
    expect(h.intake.accept({ cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } })).toBe("applied")
    expect(h.recovered).toEqual([])
    expect(h.intake.heldPosition).toBeNull()
    h.intake.accept(patch(14, 13))
    h.intake.seed(13)
    expect(h.ids()).toEqual(["b11", "b14"])
  })

  test("ignores covered invalidations but recovers a newer one across a missing predecessor", () => {
    const h = harness()
    h.intake.seed(10)
    expect(h.intake.accept(invalidate(9, 8))).toBe("stale")
    expect(h.intake.accept(invalidate(10, 9))).toBe("stale")
    expect(h.recovered).toEqual([])
    expect(h.intake.accept(invalidate(12, 11))).toBe("applied")
    expect(h.recovered.map((request) => request.reason)).toEqual(["runtime_invalidated"])
    expect(h.ids()).toEqual([])
    expect(h.intake.pendingCount).toBe(0)
  })

  test("rejects a patch addressed to a different cursor", () => {
    const h = harness()
    h.intake.seed(10)
    const foreign: RuntimeUiPatch = { ...patch(11, 10), cursor: { scope: "session", domain: "output", sessionId: "other" } }
    expect(h.intake.accept(foreign)).toBe("gap")
    expect(h.ids()).toEqual([])
  })

  test("a duplicate delivery of a held patch does not queue twice", () => {
    const h = harness()
    h.intake.seed(10)
    h.intake.accept(patch(12, 11))
    h.intake.accept(patch(12, 11))
    expect(h.intake.pendingCount).toBe(1)
    h.intake.accept(patch(11, 10))
    expect(h.ids()).toEqual(["b11", "b12"])
  })

  test("recovers when a seed never arrives and held patches overflow", () => {
    // The read behind the seed failed. Without liveness here the cursor buffers
    // every patch forever: it cannot classify a gap with no held position, so
    // nothing would ever ask for recovery again and the pane stays blank on a
    // perfectly healthy socket.
    const h = harness({ maxHeldPatches: 3 })
    for (let position = 11; position <= 15; position += 1) h.intake.accept(patch(position, position - 1))
    expect(h.recovered.length).toBe(1)
    expect(h.recovered[0]?.reason).toBe("held_overflow")
  })

  test("recovers when a seed never arrives within the deadline", () => {
    const h = harness()
    expect(h.intake.accept(patch(11, 10))).toBe("unseeded")
    h.elapseGapDeadline()
    expect(h.recovered.length).toBe(1)
    expect(h.recovered[0]?.reason).toBe("gap_unclosed")
    // The read already out may answer from before the held patch, so its seed
    // still drains it.
    h.intake.seed(10)
    expect(h.ids()).toEqual(["b11"])
  })

  test("does not ask for recovery when the seed arrives in time", () => {
    const h = harness()
    h.intake.accept(patch(11, 10))
    h.intake.seed(10)
    h.elapseGapDeadline()
    expect(h.recovered.length).toBe(0)
    expect(h.ids()).toEqual(["b11"])
  })

  test("reset drops resident position so the next seed re-anchors", () => {
    const h = harness()
    h.intake.seed(10)
    h.intake.accept(patch(11, 10))
    h.intake.reset()
    expect(h.intake.heldPosition).toBe(null)
    expect(h.intake.accept(patch(99, 98))).toBe("unseeded")
  })
})

describe("cursor intake over a publish-on-change sequencer", () => {
  test("suppressed repeats never open a gap", () => {
    const sequencer = createRuntimeUiPatchSequencer({ publishOnChange: true })
    const cursor = { scope: "workspace", domain: "chat_default" } as const
    const value = (kind: "pending" | "none"): RuntimeUiPatchPayload => ({ kind: "chat_default.changed", chatDefault: { kind } })
    const applied: string[] = []
    const recovered: RecoveryRequest[] = []
    let timers = 0
    const intake = createCursorIntake({
      cursor,
      onApply: (delivered) => { if (delivered.payload.kind === "chat_default.changed") applied.push(delivered.payload.chatDefault.kind) },
      onRecover: (request) => recovered.push(request),
      setTimer: () => {
        timers += 1
        const timer = setTimeout(() => {}, 0)
        clearTimeout(timer)
        return timer
      },
      clearTimer: () => {},
    })
    const deliver = (payload: RuntimeUiPatchPayload): void => {
      const published = sequencer.publish({ cursor, payload })
      if (published) intake.accept(published)
    }
    intake.seed(sequencer.snapshotPosition({ kind: "cursor", cursor }))
    deliver(value("pending"))
    deliver(value("pending"))
    // Another cursor advances the global position between this cursor's patches.
    sequencer.publish({ cursor: { scope: "workspace", domain: "git" }, payload: { kind: "git.changed", git: { directories: { "/project": { branch: "main" } } } } })
    deliver(value("none"))
    intake.seed(sequencer.snapshotPosition({ kind: "cursor", cursor }))
    deliver(value("pending"))
    expect(applied).toEqual(["pending", "none", "pending"])
    expect(recovered).toEqual([])
    expect(timers).toBe(0)
  })
})

describe("intake registry", () => {
  test("routes a patch to the receiver bound to its cursor", () => {
    const registry = createIntakeRegistry()
    const applied: string[] = []
    const intake = createCursorIntake({
      cursor: CURSOR,
      onApply: (delivered) => { applied.push(payloadId(delivered.payload)) },
      onRecover: () => {},
    })
    intake.seed(10)
    registry.register(intake, CURSOR)

    expect(registry.deliver(patch(11, 10))).toBe(true)
    expect(applied).toEqual(["b11"])
  })

  test("unregister stops delivery", () => {
    const registry = createIntakeRegistry()
    const intake = createCursorIntake({ cursor: CURSOR, onApply: () => {}, onRecover: () => {} })
    const unregister = registry.register(intake, CURSOR)
    unregister()
    expect(registry.size).toBe(0)
    expect(registry.deliver(patch(11, 10))).toBe(false)
  })
})
