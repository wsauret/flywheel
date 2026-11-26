import assert from "node:assert/strict"
import test from "node:test"
import { decodeRuntimeEventFrame } from "../../../../../src/protocol/client/runtime/runtime-event-intake.js"
import { runtimeUiPatchFixtures } from "../../runtime-ui-patch-fixtures.js"

function changesFrame(position: number, prevPosition: number) {
  return {
    type: "patch",
    patch: {
      cursor: { scope: "session", domain: "changes", sessionId: "session-a" },
      position,
      prevPosition,
      payload: { kind: "changes.changed" },
    },
  }
}

test("accepts known patch frames without changing their cursor positions", () => {
  const before = changesFrame(4, 3)
  const after = changesFrame(6, 5)

  assert.deepEqual(decodeRuntimeEventFrame(before), { kind: "frame", frame: before })
  assert.deepEqual(
    decodeRuntimeEventFrame({
      type: "patch",
      patch: {
        cursor: { scope: "session", domain: "changes", sessionId: "session-a" },
        position: 5,
        prevPosition: 4,
        payload: { kind: "future.changed", body: "must not be reported" },
      },
    }),
    {
      kind: "unsupported",
      diagnostic: {
        kind: "unsupported_patch",
        cursor: { scope: "session", domain: "changes", sessionId: "session-a" },
        payloadKind: "future.changed",
      },
    },
  )
  assert.deepEqual(decodeRuntimeEventFrame(after), { kind: "frame", frame: after })
})

test("accepts every status union leaf as a known direct discriminator", () => {
  const status = {
    activity: "idle",
    activityStartedAt: 1,
    settledOutputPosition: null,
    connectionState: "connected",
    activeSubagentCount: 0,
    waitingOnBackgroundWork: false,
    activeBackgroundCommands: [],
    activeForegroundBashToolCallIds: [],
    processorHeldToolCallIds: [],
    startedAt: 1,
    streamingStartedAt: null,
    accumulatedActiveMs: 0,
    compactionStartedAt: null,
    replyWaits: [],
  }
  for (const payload of [{ kind: "status.updated", status }, { kind: "status.removed" }]) {
    const frame = {
      type: "patch",
      patch: {
        cursor: { scope: "session", domain: "status", sessionId: "session-a" },
        position: 1,
        prevPosition: 0,
        payload,
      },
    }
    assert.deepEqual(decodeRuntimeEventFrame(frame), { kind: "frame", frame })
  }
})

test("accepts every canonical patch fixture without changing its wire fields", () => {
  for (const patch of runtimeUiPatchFixtures) {
    const frame = { type: "patch", patch } as const
    assert.deepEqual(decodeRuntimeEventFrame(frame), { kind: "frame", frame })
  }
})

test("skips unsupported event and patch discriminators with metadata only", () => {
  assert.deepEqual(decodeRuntimeEventFrame({ type: "runtime.future", body: "private" }), {
    kind: "unsupported",
    diagnostic: { kind: "unsupported_event", eventType: "runtime.future" },
  })
  assert.deepEqual(decodeRuntimeEventFrame({
    type: "patch",
    patch: {
      cursor: { scope: "future", domain: "changes" },
      payload: { kind: "changes.changed", body: "private" },
    },
  }), {
    kind: "unsupported",
    diagnostic: {
      kind: "unsupported_patch",
      cursor: { scope: "future", domain: "changes" },
      payloadKind: "changes.changed",
    },
  })
  assert.deepEqual(decodeRuntimeEventFrame({
    type: "patch",
    patch: {
      cursor: { scope: "session", domain: "future", sessionId: "session-a" },
      payload: { kind: "changes.changed", body: "private" },
    },
  }), {
    kind: "unsupported",
    diagnostic: {
      kind: "unsupported_patch",
      cursor: { scope: "session", domain: "future", sessionId: "session-a" },
      payloadKind: "changes.changed",
    },
  })
})

test("skips a patch of an unknown kind by its discriminators alone, and reports only the cursor descriptor", () => {
  assert.deepEqual(decodeRuntimeEventFrame({
    type: "patch",
    patch: {
      cursor: { scope: "session", domain: "changes", future: "private" },
      payload: { kind: "future.changed" },
    },
  }), {
    kind: "unsupported",
    diagnostic: {
      kind: "unsupported_patch",
      cursor: { scope: "session", domain: "changes" },
      payloadKind: "future.changed",
    },
  })
})

test("rejects malformed known frames", () => {
  assert.throws(() => decodeRuntimeEventFrame({ ...changesFrame(4, 3), patch: { ...changesFrame(4, 3).patch, position: "4" } }))
  assert.throws(() => decodeRuntimeEventFrame({ type: "patch", patch: { ...changesFrame(4, 3).patch, cursor: { scope: 7, domain: "changes" } } }))
  assert.throws(() => decodeRuntimeEventFrame({ type: "patch", patch: { ...changesFrame(4, 3).patch, payload: { kind: 7 } } }))
  assert.throws(() => decodeRuntimeEventFrame({ type: 7 }))
  assert.throws(() => decodeRuntimeEventFrame(null))
  assert.throws(() => decodeRuntimeEventFrame({
    type: "patch",
    patch: {
      cursor: { scope: "session", domain: "status", sessionId: "session-a" },
      position: 1,
      prevPosition: 0,
      payload: { kind: "status.updated" },
    },
  }))
  assert.throws(() => decodeRuntimeEventFrame({
    type: "patch",
    patch: {
      cursor: { scope: "session", domain: "changes", sessionId: "session-a" },
      position: 1,
      prevPosition: 0,
      payload: { kind: "session.added" },
    },
  }))
  assert.throws(() => decodeRuntimeEventFrame({ type: "patch", patch: {} }))
})

test("accepts the connected frame, which carries nothing beside its type", () => {
  const frame = { type: "runtime.connected" } as const
  assert.deepEqual(decodeRuntimeEventFrame(frame), { kind: "frame", frame })
})
