import { describe, expect, it, jest, spyOn } from "bun:test"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { RuntimeCallTimeout } from "../../../../src/protocol/runtime-client-deadlines.js"
import type { FrontendEvent, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { createRuntimeUiPatchSequencer, type RuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { sessionCursor, type RuntimeCursorIdentity, type RuntimePosition, type RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createFamilyIntake, type FamilyIntakeAcceptance } from "../../../../src/protocol/client/family-intake.js"

interface Snapshot {
  readonly snapshotPosition: RuntimePosition
  readonly cursors?: readonly RuntimeCursorIdentity[]
}

function summary(id: string): SessionCatalogRow {
  return {
    id,
    kind: "chat",
    title: id,
    lifecycleState: "active",
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-01-01T00:00:00.000Z",
    executionCwd: "/project",
    totalsLoading: true,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: PromiseWithResolvers<T>["reject"]
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function sessionUpdate(sequencer: RuntimeUiPatchSequencer<RuntimeUiPatch>, id: string): RuntimeUiPatch {
  return sequencer.publish({ cursor: sessionCursor(id), payload: { kind: "session.updated", row: summary(id) } })
}

function receiverHarness(options: {
  accept?: (patch: RuntimeUiPatch) => FamilyIntakeAcceptance<string> | null
  connectedScope?: () => string | null
  onInvalidate?: (scope: string, reason: string) => void
} = {}) {
  const applied: RuntimePosition[] = []
  const snapshots: Snapshot[] = []
  const snapshotRequests: ReturnType<typeof deferred<Snapshot>>[] = []
  const signals: AbortSignal[] = []

  const receiver = createFamilyIntake<string, Snapshot>({
    accept: options.accept ?? ((patch) => patch.cursor.scope === "session" && patch.cursor.domain === "session" ? { cursor: patch.cursor, scope: "sessions", patch } : null),
    scopeKey: (scope) => scope,
    connectedScope: options.connectedScope,
    loadSnapshot: (_scope, signal) => {
      signals.push(signal)
      const request = deferred<Snapshot>()
      snapshotRequests.push(request)
      return request.promise
    },
    applySnapshot(snapshot) {
      snapshots.push(snapshot)
      return { snapshotPosition: snapshot.snapshotPosition, clearHeld: true, cursors: snapshot.cursors }
    },
    applyPayload(patch) {
      applied.push(patch.position)
    },
    onInvalidate: options.onInvalidate,
  })

  return {
    applied,
    snapshots,
    snapshotRequests,
    signals,
    receiver,
    emit: (event: FrontendEvent) => receiver.handle(event),
  }
}

const laneBreak: FrontendEvent = { type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } } }

describe("createFamilyIntake", () => {
  it("a lane break aborts the reads in flight, voids each scope, and reads nothing until the next lane", () => {
    const invalidated: string[] = []
    const harness = receiverHarness({ connectedScope: () => "sessions", onInvalidate: (scope, reason) => { invalidated.push(`${scope}:${reason}`) } })
    void harness.receiver.resnapshot("sessions")
    harness.emit(laneBreak)
    expect(harness.signals[0]?.aborted).toBe(true)
    expect(invalidated).toEqual(["sessions:reconnect_required"])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.lane()
    expect(harness.snapshotRequests).toHaveLength(2)
    // One lane reads once: a second notice of the same lane joins its read.
    harness.receiver.lane()
    expect(harness.snapshotRequests).toHaveLength(2)
    harness.receiver.dispose()
  })

  it("handles global invalidation before cursor filtering and coalesces continuous recovery", async () => {
    const harness = receiverHarness({ connectedScope: () => "sessions", accept: () => null })
    const invalidate = (position: number) => harness.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
    invalidate(1)
    for (let position = 2; position < 1000; position++) invalidate(position)
    expect(harness.snapshotRequests).toHaveLength(1)
    expect(harness.signals[0]?.aborted).toBe(false)
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 1 })
    await Promise.resolve()
    expect(harness.snapshots).toHaveLength(1)
    expect(harness.snapshotRequests).toHaveLength(2)
    harness.snapshotRequests[1]!.resolve({ snapshotPosition: 999 })
    await Promise.resolve()
    expect(harness.snapshots).toHaveLength(2)
    harness.receiver.dispose()
  })

  it("replaces an overflowed recovery batch with one fresh snapshot after the read settles", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    for (let position = 1; position <= 300; position += 1) {
      harness.emit({ type: "patch", patch: { cursor: sessionCursor("s1"), position, prevPosition: position - 1, payload: { kind: "session.removed" } } })
    }
    expect(harness.snapshotRequests).toHaveLength(1)
    expect(harness.signals[0]?.aborted).toBe(false)
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 0 })
    await Promise.resolve()
    expect(harness.snapshotRequests).toHaveLength(2)
    expect(harness.applied).toEqual([])
    expect(harness.snapshots.map((snapshot) => snapshot.snapshotPosition)).toEqual([0])
    harness.snapshotRequests[1]!.resolve({ snapshotPosition: 300 })
    await pending
    harness.emit({ type: "patch", patch: { cursor: sessionCursor("s1"), position: 301, prevPosition: 300, payload: { kind: "session.removed" } } })
    expect(harness.applied).toEqual([301])
    harness.receiver.dispose()
  })

  it("reads again after a read an invalidation overtook fails, so the invalidation's read is never lost", async () => {
    const harness = receiverHarness({ connectedScope: () => "sessions", accept: () => null })
    const pending = harness.receiver.resnapshot("sessions")
    harness.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 1, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.snapshotRequests[0]!.reject(new Error("Executor generation changed during status read"))
    await Promise.resolve()
    expect(harness.snapshotRequests).toHaveLength(2)
    harness.snapshotRequests[1]!.resolve({ snapshotPosition: 1 })
    await pending
    expect(harness.snapshots.map((snapshot) => snapshot.snapshotPosition)).toEqual([1])
    harness.receiver.dispose()
  })

  it("bounds retained payload bytes even when only one patch arrives", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    harness.emit({ type: "patch", patch: {
      cursor: sessionCursor("s1"), position: 1, prevPosition: 0,
      payload: { kind: "session.updated", row: { ...summary("s1"), title: "x".repeat(2 * 1024 * 1024) } },
    } })
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 0 })
    await Promise.resolve()
    expect(harness.snapshotRequests).toHaveLength(2)
    expect(harness.applied).toEqual([])
    harness.snapshotRequests[1]!.resolve({ snapshotPosition: 1 })
    await pending
    harness.receiver.dispose()
  })

  it("replays held patches in position order without a redundant gap read", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    for (const position of [12, 11]) {
      harness.emit({ type: "patch", patch: { cursor: sessionCursor("s1"), position, prevPosition: position - 1, payload: { kind: "session.removed" } } })
    }
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 10 })
    await pending
    expect(harness.applied).toEqual([11, 12])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.dispose()
  })

  it("duplicate held deliveries do not consume the recovery budget", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    const patch = { cursor: sessionCursor("s1"), position: 1, prevPosition: 0, payload: { kind: "session.removed" } } satisfies RuntimeUiPatch
    for (let repeat = 0; repeat < 300; repeat += 1) harness.emit({ type: "patch", patch })
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 0 })
    await pending
    expect(harness.applied).toEqual([1])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.dispose()
  })

  it("cancels the follow-on read and resolves the original overflow caller on disposal", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    for (let position = 1; position <= 65; position += 1) {
      harness.emit({ type: "patch", patch: { cursor: sessionCursor("s1"), position, prevPosition: position - 1, payload: { kind: "session.removed" } } })
    }
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 0 })
    await Promise.resolve()
    expect(harness.snapshotRequests).toHaveLength(2)
    harness.receiver.dispose()
    await pending
    expect(harness.signals[1]?.aborted).toBe(true)
    harness.snapshotRequests[1]!.resolve({ snapshotPosition: 65 })
    await Promise.resolve()
    expect(harness.snapshots.map((snapshot) => snapshot.snapshotPosition)).toEqual([0])
    expect(harness.applied).toEqual([])
  })

  it("whole-family coverage accepts same-cursor predecessors below a cross-cursor watermark", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const harness = receiverHarness()
    sessionUpdate(sequencer, "a")
    const b = sessionUpdate(sequencer, "b")
    harness.receiver.adoptSnapshot({ snapshotPosition: b.position, clearHeld: true })
    const next = sessionUpdate(sequencer, "a")
    harness.emit({ type: "patch", patch: next })
    harness.emit({ type: "patch", patch: b })
    expect(harness.applied).toEqual([next.position])
    expect(harness.snapshotRequests).toHaveLength(0)
    harness.receiver.dispose()
  })

  it("concrete and batch seeds neither replace the family baseline nor erase sibling positions", () => {
    const harness = receiverHarness({
      accept: (patch) => patch.cursor.scope === "session" ? { cursor: patch.cursor, scope: patch.cursor.sessionId, patch } : null,
    })
    harness.receiver.adoptSnapshot({ snapshotPosition: 2, clearHeld: true })
    harness.receiver.adoptSnapshot({ snapshotPosition: 4, cursors: [sessionCursor("a")] })
    harness.receiver.adoptSnapshot({ snapshotPosition: 8, cursors: [sessionCursor("b"), sessionCursor("c")] })
    harness.emit({ type: "patch", patch: { cursor: sessionCursor("new"), position: 3, prevPosition: 0, payload: { kind: "session.removed" } } })
    harness.emit({ type: "patch", patch: { cursor: sessionCursor("a"), position: 5, prevPosition: 4, payload: { kind: "session.removed" } } })
    harness.emit({ type: "patch", patch: { cursor: sessionCursor("missing"), position: 10, prevPosition: 7, payload: { kind: "session.removed" } } })
    expect(harness.applied).toEqual([3, 5])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.adoptSnapshot({ snapshotPosition: 0, cursors: [sessionCursor("low")] })
    harness.emit({ type: "patch", patch: { cursor: sessionCursor("covered"), position: 3, prevPosition: 1, payload: { kind: "session.removed" } } })
    expect(harness.applied).toEqual([3, 5, 3])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.dispose()
  })

  it("applies an in-order accepted patch once and advances the held position", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const harness = receiverHarness()
    const first = sessionUpdate(sequencer, "s1")
    const second = sessionUpdate(sequencer, "s1")

    harness.emit({ type: "patch", patch: first })
    harness.emit({ type: "patch", patch: second })

    expect(harness.applied).toEqual([first.position, second.position])
    harness.receiver.dispose()
  })

  it("treats a stale patch as a no-op", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const harness = receiverHarness()
    const patch = sessionUpdate(sequencer, "s1")

    harness.emit({ type: "patch", patch })
    harness.emit({ type: "patch", patch })

    expect(harness.applied).toEqual([patch.position])
    expect(harness.snapshotRequests).toHaveLength(0)
    harness.receiver.dispose()
  })

  it("starts exactly one async resnapshot for accepted patches with a bad prevPosition", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const harness = receiverHarness()
    sessionUpdate(sequencer, "s1")
    const gap = sessionUpdate(sequencer, "s1")

    harness.emit({ type: "patch", patch: gap })
    harness.emit({ type: "patch", patch: gap })

    expect(harness.applied).toEqual([])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.dispose()
  })

  it("an invalidation supersedes an in-flight snapshot instead of being held behind it", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const invalidated: string[] = []
    const harness = receiverHarness({ onInvalidate: (_scope, reason) => { invalidated.push(reason) } })
    sessionUpdate(sequencer, "s1")
    const gap = sessionUpdate(sequencer, "s1")

    // Gap starts a snapshot; the invalidation must not wait behind it (its
    // anchor may be exactly the state the invalidation voids).
    harness.emit({ type: "patch", patch: gap })
    expect(harness.snapshotRequests).toHaveLength(1)
    const invalidation = sequencer.publish({ cursor: sessionCursor("s1"), payload: { kind: "runtime.invalidate", reason: "rebase" } })
    harness.emit({ type: "patch", patch: invalidation })

    expect(invalidated).toEqual(["rebase"])
    expect(harness.signals[0]?.aborted).toBe(true)
    expect(harness.snapshotRequests).toHaveLength(2)

    // Adopting the replacement snapshot applies later patches normally.
    harness.snapshotRequests[1]!.resolve({ snapshotPosition: invalidation.position })
    harness.receiver.dispose()
  })

  it("drops an invalidation already reflected in the adopted baseline", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const invalidated: string[] = []
    const harness = receiverHarness({
      onInvalidate: (_scope, reason) => { invalidated.push(reason) },
    })
    const invalidation = sequencer.publish({ cursor: sessionCursor("s1"), payload: { kind: "runtime.invalidate", reason: "rebase" } })

    // The adopted baseline postdates the invalidation, so the resident
    // state was seeded from post-invalidation authority already.
    harness.receiver.adoptSnapshot({ snapshotPosition: invalidation.position, cursors: [sessionCursor("s1")] })
    harness.emit({ type: "patch", patch: invalidation })

    expect(invalidated).toEqual([])
    expect(harness.snapshotRequests).toHaveLength(0)
    harness.receiver.dispose()
  })

  it("ignores unrelated domain patches before classification or resnapshot", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const harness = receiverHarness()
    const patch = sequencer.publish({ cursor: outputCursor("s1"), payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [] } } })

    harness.emit({ type: "patch", patch })

    expect(harness.applied).toEqual([])
    expect(harness.snapshotRequests).toHaveLength(0)
    harness.receiver.dispose()
  })

  it("treats a cursor mismatch inside a cursor-scoped receiver as a gap", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const harness = receiverHarness({
      accept: (patch) => patch.cursor.scope === "session" ? { cursor: sessionCursor("expected"), scope: "expected", patch } : null,
    })

    harness.emit({ type: "patch", patch: sessionUpdate(sequencer, "other") })

    expect(harness.applied).toEqual([])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.dispose()
  })

  it("reseeds from the lane's read before applying patches on the new baseline", async () => {
    const order: string[] = []
    const harness = receiverHarness({ connectedScope: () => "sessions" })
    const before = { cursor: sessionCursor("s1"), prevPosition: 0, position: 1, payload: { kind: "session.removed" } } satisfies RuntimeUiPatch
    const after = { cursor: sessionCursor("s1"), prevPosition: 10, position: 11, payload: { kind: "session.removed" } } satisfies RuntimeUiPatch

    harness.emit({ type: "patch", patch: before })
    harness.receiver.lane()
    harness.emit({ type: "patch", patch: after })
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 10, cursors: [sessionCursor("s1")] })
    await Promise.resolve()
    order.push(...harness.snapshots.map((snapshot) => `snapshot:${snapshot.snapshotPosition}`))
    order.push(`apply:${harness.applied.at(-1)}`)

    expect(harness.applied).toEqual([1, 11])
    expect(order).toEqual(["snapshot:10", "apply:11"])
    harness.receiver.dispose()
  })

  it("folds repeated gaps into the first unresolved snapshot request", () => {
    const sequencer = createRuntimeUiPatchSequencer()
    const harness = receiverHarness({ connectedScope: () => "sessions" })
    sessionUpdate(sequencer, "s1")
    const gap = sessionUpdate(sequencer, "s1")

    harness.receiver.lane()
    harness.emit({ type: "patch", patch: gap })
    harness.emit({ type: "patch", patch: gap })

    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.dispose()
  })

  it("replays patches that arrive while an async resnapshot is in flight", async () => {
    const harness = receiverHarness()
    const staleAfterSnapshot = { cursor: sessionCursor("s1"), prevPosition: 1, position: 2, payload: { kind: "session.removed" } } satisfies RuntimeUiPatch
    const nextAfterSnapshot = { cursor: sessionCursor("s1"), prevPosition: 10, position: 11, payload: { kind: "session.removed" } } satisfies RuntimeUiPatch

    harness.emit({ type: "patch", patch: staleAfterSnapshot })
    harness.emit({ type: "patch", patch: nextAfterSnapshot })

    expect(harness.snapshotRequests).toHaveLength(1)
    expect(harness.applied).toEqual([])

    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 10, cursors: [sessionCursor("s1")] })
    await Promise.resolve()

    expect(harness.applied).toEqual([11])
    expect(harness.snapshotRequests).toHaveLength(1)
    harness.receiver.dispose()
  })

  it("returns one awaitable request that resolves after held patches replay", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    const duplicate = harness.receiver.resnapshot("sessions")
    const patch = { cursor: sessionCursor("s1"), prevPosition: 10, position: 11, payload: { kind: "session.removed" } } satisfies RuntimeUiPatch

    harness.emit({ type: "patch", patch })
    expect(duplicate).toBe(pending)
    expect(harness.applied).toEqual([])
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 10, cursors: [sessionCursor("s1")] })
    await pending

    expect(harness.applied).toEqual([11])
    harness.receiver.dispose()
  })

  it("resolves obsolete callers when snapshot work is cancelled", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    harness.receiver.cancelSnapshot("sessions")

    await expect(pending).resolves.toBeUndefined()
    expect(harness.signals[0]!.aborted).toBe(true)
    harness.receiver.dispose()
  })

  it("still rejects genuine snapshot load failures", async () => {
    const harness = receiverHarness()
    const pending = harness.receiver.resnapshot("sessions")
    harness.snapshotRequests[0]!.reject(new Error("snapshot failed"))

    await expect(pending).rejects.toThrow("snapshot failed")
    harness.receiver.dispose()
  })

  it("retries a timed-out first snapshot after backoff without a new lane", async () => {
    jest.useFakeTimers()
    const h = receiverHarness({ connectedScope: () => "sessions" })
    try {
      h.receiver.lane()
      h.snapshotRequests[0]!.reject(RuntimeCallTimeout.forDeadline(5_000))
      await Promise.resolve()
      expect(h.snapshots).toEqual([])
      expect(jest.getTimerCount()).toBe(1)
      jest.runOnlyPendingTimers()
      await Promise.resolve()
      expect(h.snapshotRequests).toHaveLength(2)
      h.snapshotRequests[1]!.resolve({ snapshotPosition: 20 })
      await Promise.resolve()
      expect(h.snapshots).toEqual([{ snapshotPosition: 20 }])
    } finally { h.receiver.dispose(); jest.useRealTimers() }
  })

  it("schedules no retry for a snapshot lost with its lane", async () => {
    const clock = spyOn(globalThis, "setTimeout")
    const h = receiverHarness()
    try {
      const pending = h.receiver.resnapshot("sessions")
      h.snapshotRequests[0]!.reject(new RuntimeLaneLost(new Error("lane ended")))
      await expect(pending).rejects.toThrow("lane ended")
      expect(clock).not.toHaveBeenCalled()
    } finally { h.receiver.dispose(); clock.mockRestore() }
  })

  it("cancels backoff at a lane break or disposal and reads immediately on the next lane", async () => {
    jest.useFakeTimers()
    try {
      for (const boundary of ["lane", "dispose"] as const) {
        const h = receiverHarness({ connectedScope: () => "sessions" })
        try {
          h.receiver.lane()
          h.snapshotRequests[0]!.reject(RuntimeCallTimeout.forDeadline(5_000))
          await Promise.resolve()
          expect(jest.getTimerCount()).toBe(1)
          if (boundary === "lane") h.emit(laneBreak)
          else h.receiver.dispose()
          expect(jest.getTimerCount()).toBe(0)
          expect(h.snapshotRequests).toHaveLength(1)
          if (boundary === "lane") {
            h.receiver.lane()
            expect(h.snapshotRequests).toHaveLength(2)
          }
        } finally { h.receiver.dispose() }
      }
    } finally { jest.useRealTimers() }
  })

  it("discards a read of a lane that broke, even when it answers after the next lane's read", async () => {
    const harness = receiverHarness({ connectedScope: () => "sessions" })

    harness.receiver.lane()
    harness.emit(laneBreak)
    harness.receiver.lane()
    harness.snapshotRequests[1]!.resolve({ snapshotPosition: 20, cursors: [sessionCursor("s1")] })
    await Promise.resolve()
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 10, cursors: [sessionCursor("s1")] })
    await Promise.resolve()

    expect(harness.snapshots.map((snapshot) => snapshot.snapshotPosition)).toEqual([20])
    harness.receiver.dispose()
  })

  it("aborts in-flight snapshot work on disposal", async () => {
    const harness = receiverHarness({ connectedScope: () => "sessions" })

    harness.receiver.lane()
    expect(harness.signals[0]!.aborted).toBe(false)
    harness.receiver.dispose()
    expect(harness.signals[0]!.aborted).toBe(true)
    harness.snapshotRequests[0]!.resolve({ snapshotPosition: 1, cursors: [sessionCursor("s1")] })
    await Promise.resolve()

    expect(harness.snapshots).toEqual([])
  })
})
