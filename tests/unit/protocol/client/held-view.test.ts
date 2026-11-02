import { describe, expect, jest, spyOn, test } from "bun:test"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { RuntimeCallTimeout } from "../../../../src/protocol/runtime-client-deadlines.js"
import { createHeldView } from "../../../../src/protocol/client/held-view.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { updatesCursor, type UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"

const update = (revision: number): UpdateStatusView => ({ revision, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "idle" } })

function harness(options: { readonly open?: boolean } = {}) {
  const sequencer = createRuntimeUiPatchSequencer()
  const cursor = updatesCursor()
  const lanes = fakeLanes(options)
  const listeners = new Set<(event: FrontendEvent) => void>()
  const reads: Array<PromiseWithResolvers<{ view: UpdateStatusView; position: number }>> = []
  const changes: Array<{ revision: number; source: string }> = []
  const diagnostics: string[] = []
  const held = createHeldView<UpdateStatusView>({
    client: { onLane: lanes.onLane, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
    cursor,
    read: () => {
      const read = Promise.withResolvers<{ view: UpdateStatusView; position: number }>()
      reads.push(read)
      return read.promise
    },
    adopt: (payload) => (payload.kind === "update.changed" ? payload.update : undefined),
    changed: (view, source) => { changes.push({ revision: view.revision, source }) },
    label: "update status",
    onDiagnostic: (message) => { diagnostics.push(message) },
  })
  const emit = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  return {
    held,
    lanes,
    reads,
    changes,
    diagnostics,
    emit,
    publish: (view: UpdateStatusView) => emit({ type: "patch", patch: sequencer.publish({ cursor, payload: { kind: "update.changed", update: view } }) }),
    position: () => sequencer.snapshotPosition({ kind: "cursor", cursor }),
    /** Publishes one patch that no listener receives. */
    skip: (view: UpdateStatusView) => { sequencer.publish({ cursor, payload: { kind: "update.changed", update: view } }) },
  }
}

describe("held view", () => {
  test("reads nothing before a lane opens, reads once when it opens, and a patch replaces the view", async () => {
    const h = harness({ open: false })
    expect(h.reads).toHaveLength(0)
    h.lanes.open()
    expect(h.reads).toHaveLength(1)
    h.reads[0]!.resolve({ view: update(1), position: h.position() })
    await h.held.ready
    h.publish(update(2))
    expect(h.held.view).toEqual(update(2))
    expect(h.changes).toEqual([{ revision: 1, source: "read" }, { revision: 2, source: "patch" }])
  })

  test("a lane break reads nothing, and the next lane reads once", async () => {
    const h = harness()
    h.reads[0]!.resolve({ view: update(1), position: h.position() })
    await h.held.ready
    h.lanes.end()
    h.emit(LANE_BREAK)
    expect(h.reads).toHaveLength(1)
    h.lanes.open()
    expect(h.reads).toHaveLength(2)
    // The last view stays while the lane's read is out.
    expect(h.held.view).toEqual(update(1))
  })

  test("a read that fails with its lane is silent, and any other failure is reported", async () => {
    const h = harness()
    h.reads[0]!.reject(new RuntimeLaneLost(new Error("the project could not open")))
    await h.held.ready
    expect(h.diagnostics).toEqual([])
    h.lanes.open()
    h.reads[1]!.reject(new Error("the runtime could not read updates"))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.diagnostics).toEqual(["update status read failed"])
    h.held.dispose()
  })

  test("a timed-out first read fills the view after backoff without a new lane", async () => {
    jest.useFakeTimers()
    const h = harness()
    try {
      h.reads[0]!.reject(RuntimeCallTimeout.forDeadline(5_000))
      await h.held.ready
      expect(h.held.view).toBeUndefined()
      expect(jest.getTimerCount()).toBe(1)
      jest.runOnlyPendingTimers()
      await Promise.resolve()
      expect(h.reads).toHaveLength(2)
      h.reads[1]!.resolve({ view: update(2), position: h.position() })
      await Promise.resolve()
      expect(h.held.view).toEqual(update(2))
      expect(h.diagnostics).toEqual(["update status read failed"])
    } finally { h.held.dispose(); jest.useRealTimers() }
  })

  test("a read lost with its lane schedules no retry", async () => {
    const clock = spyOn(globalThis, "setTimeout")
    const h = harness()
    try {
      h.reads[0]!.reject(new RuntimeLaneLost(new Error("lane ended")))
      await h.held.ready
      expect(clock).not.toHaveBeenCalled()
      expect(h.diagnostics).toEqual([])
    } finally { h.held.dispose(); clock.mockRestore() }
  })

  test("a lane break or disposal cancels backoff, and the next lane reads immediately", async () => {
    jest.useFakeTimers()
    try {
      for (const boundary of ["lane", "dispose"] as const) {
        const h = harness()
        try {
          h.reads[0]!.reject(RuntimeCallTimeout.forDeadline(5_000))
          await h.held.ready
          expect(jest.getTimerCount()).toBe(1)
          if (boundary === "lane") {
            h.lanes.end()
            h.emit(LANE_BREAK)
            expect(h.reads).toHaveLength(1)
          } else h.held.dispose()
          expect(jest.getTimerCount()).toBe(0)
          if (boundary === "lane") {
            h.lanes.open()
            expect(h.reads).toHaveLength(2)
          }
        } finally { h.held.dispose() }
      }
    } finally { jest.useRealTimers() }
  })

  test("a gap reads again at once, and a patch that arrives while that read is out lands on top of its answer", async () => {
    const h = harness()
    h.reads[0]!.resolve({ view: update(1), position: h.position() })
    await h.held.ready
    // One patch the client never sees opens a gap before the next one.
    h.skip(update(2))
    h.publish(update(3))
    expect(h.reads).toHaveLength(2)
    const answeredAt = h.position()
    h.publish(update(4))
    h.reads[1]!.resolve({ view: update(3), position: answeredAt })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.held.view).toEqual(update(4))
    expect(h.changes.at(-1)).toEqual({ revision: 4, source: "patch" })
  })

  test("an overflow invalidation reads again at once", async () => {
    const h = harness()
    h.reads[0]!.resolve({ view: update(1), position: h.position() })
    await h.held.ready
    h.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: h.position() + 1, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
    expect(h.reads).toHaveLength(2)
  })
})
