import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEventProjection } from "../../../../../src/infra/event-projection.js"
import { asAsyncEventReadSurface, type EventStore } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { CHILD_MEASURE_FOLD, measureBefore } from "../../../../../src/orchestration/modules/subagents/history/child-measures.js"

let directory: string
let store: EventStore
const childSessionId = "child"

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "child-measures-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(directory))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

function call(toolUseId: string, modelRequestId: string): void {
  store.append({
    aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "tool.input.completed", version: 1, actor: "agent", timestamp: 10,
    payload: { toolUseId, toolName: "read", modelRequestId, input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false },
  })
}
function output(toolUseId: string, modelRequestId: string): void {
  store.append({
    aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "tool.execution_output.recorded", version: 1, actor: "flywheel", timestamp: 11,
    payload: { toolUseId, output: "tail", modelRequestId },
  })
}

test("an earlier state keeps its count after a later catch-up adds calls, and a copy of it folds on to the same count", async () => {
  const reader = asAsyncEventReadSurface(store)
  const projection = createEventProjection(reader, { aggregateId: `session:${childSessionId}`, ...CHILD_MEASURE_FOLD })
  call("first", "request-1")
  const earlier = await projection.replay()
  const earlierPosition = projection.getPosition()
  expect(measureBefore(earlier, undefined)).toEqual({ toolCount: 1 })

  call("second", "request-2")
  call("third", "request-3")
  const later = await projection.replay()
  expect(measureBefore(later, undefined)).toEqual({ toolCount: 3 })
  expect(measureBefore(earlier, undefined)).toEqual({ toolCount: 1 })

  // A persisted fold can copy the earlier state after the later catch-up
  // appended to the index it shares. Folding on from that copy refolds the
  // later calls, counts each once, and reads each call's own identity when
  // its follow-up arrives.
  const restored = createEventProjection(reader, {
    aggregateId: `session:${childSessionId}`, ...CHILD_MEASURE_FOLD,
    seed: () => ({ state: structuredClone(earlier), position: earlierPosition }),
  })
  expect(measureBefore(await restored.replay(), undefined)).toEqual({ toolCount: 3 })
  call("fourth", "request-4")
  output("fourth", "request-4")
  expect(measureBefore(await restored.replay(), undefined)).toEqual({ toolCount: 4 })
})
