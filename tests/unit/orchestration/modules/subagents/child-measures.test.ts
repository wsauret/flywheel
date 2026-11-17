import { afterEach, beforeEach, expect, test } from "bun:test"
import { join } from "node:path"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type EventStore } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { attachProjectionFoldCache, openProjectionFoldCache, type FoldCacheSlot, type ProjectionFoldCache } from "../../../../../src/infra/projection-fold-cache.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { createChildMeasureReader } from "../../../../../src/orchestration/modules/subagents/history/child-measures.js"
import { buildSubagentCompleted } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

type FoldToSave = Parameters<FoldCacheSlot["save"]>[0]

const temporaryDirectory = temporaryDirectories()
let store: EventStore
let cache: ProjectionFoldCache
const childSessionId = "child"

beforeEach(() => {
  const directory = temporaryDirectory("child-measures-")
  store = createSqliteEventStore(resolveEventStoreDbFile(directory))
  cache = openProjectionFoldCache(join(directory, "folds.sqlite"), "build-a", { afterFacts: 1, quietMs: 0 })
})
afterEach(() => {
  cache.close()
  store.close()
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
function completion(): string {
  const { payload } = buildSubagentCompleted({ childRunId: "run", status: "completed", isError: false, content: "done", durationMs: 1 })
  return store.append({ aggregateId: `session:${childSessionId}`, sessionId: childSessionId, type: "subagent.completed", version: 5, actor: "flywheel", timestamp: 12, payload }).id
}

/** One process's reader, with the fold cache attached. With `held`, the
 *  reader writes no fold: the first fold that it asks to save resolves
 *  `held`, so the test decides when that fold is written. */
function processReader(held?: PromiseWithResolvers<FoldToSave>) {
  const local = asAsyncEventReadSurface(store)
  // Each page read from the start of the history: a fold rebuilt, not restored.
  const historyReads: unknown[] = []
  const reader: AsyncEventStateReadSurface = {
    ...local,
    readPage: (...args) => {
      if (args[2] === 0) historyReads.push(args[0])
      return local.readPage(...args)
    },
  }
  attachProjectionFoldCache([reader], !held ? cache : {
    ...cache,
    slot: (role, key) => ({ ...cache.slot(role, key), save: async (fold) => { held.resolve(fold); return false } }),
  }, "executor")
  return { reader, historyReads }
}

test("an earlier measure keeps its count after a later catch-up adds calls, and a saved copy of the earlier fold folds on to the same count", async () => {
  const held = Promise.withResolvers<FoldToSave>()
  const first = createChildMeasureReader(processReader(held).reader)
  call("first", "request-1")
  const completed = completion()
  expect(await first.read(childSessionId, undefined)).toEqual({ toolCount: 1 })
  const earlier = await held.promise

  call("second", "request-2")
  call("third", "request-3")
  expect(await first.read(childSessionId, undefined)).toEqual({ toolCount: 3 })
  expect(await first.read(childSessionId, completed)).toEqual({ toolCount: 1 })

  // The cache can write the earlier fold after the later catch-up appended
  // to the index it shares. Folding on from that copy refolds the later
  // calls, counts each once, and reads each call's own identity when its
  // follow-up arrives.
  expect(await cache.slot("executor", `subagent-measure:${childSessionId}`).save(earlier)).toBe(true)
  first.dispose()
  const restarted = processReader()
  const restored = createChildMeasureReader(restarted.reader)
  expect(await restored.read(childSessionId, undefined)).toEqual({ toolCount: 3 })
  expect(await restored.read(childSessionId, completed)).toEqual({ toolCount: 1 })
  expect(restarted.historyReads).toEqual([])
  call("fourth", "request-4")
  output("fourth", "request-4")
  expect(await restored.read(childSessionId, undefined)).toEqual({ toolCount: 4 })
  restored.dispose()
})
