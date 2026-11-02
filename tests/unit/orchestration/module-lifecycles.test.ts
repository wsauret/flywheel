import { expect, test } from "bun:test"
import { asAsyncEventReadSurface, type AsyncGuardedEventWriter } from "../../../src/infra/event-store-types.js"
import type { LauncherScope } from "../../../src/infra/process-supervisor.js"
import { NO_CAPABILITY_ACCESS } from "../../../src/orchestration/agent-runtime/tools/types.js"
import { installedWorkspaceMigrations, prepareDefinitionReconciliation, recoverSessionHistory, runModuleMaintenance, type FirstPartyModule } from "../../../src/orchestration/modules.js"
import type { ToolHistorySummary } from "../../../src/orchestration/module-seams.js"
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js"

function owner(id: string, hooks: Partial<Pick<FirstPartyModule, "sessionHistory" | "maintenance" | "definitionReconciliation" | "workspaceMigrations">>): FirstPartyModule {
  return { id, dependencies: [], availability: { kind: "available" }, contributions: [], observers: [], transformers: [], gates: [], ...hooks }
}
const directories = { userDataRoot: "/scratch/module-lifecycle/.flywheel", accountHome: "/scratch/module-lifecycle", projectRoot: "/scratch/module-lifecycle/project", executionCwd: "/scratch/module-lifecycle/project" }
const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
const writer: AsyncGuardedEventWriter = {
  async append() { throw new Error("unexpected append") },
  async appendBatch() { throw new Error("unexpected append") },
  async appendGuarded() { throw new Error("unexpected append") },
  async appendBatchGuarded() { throw new Error("unexpected append") },
  async pruneSupersededEvents() { throw new Error("unexpected prune") },
}
const launcher: LauncherScope = {
  async spawnOwned() { throw new Error("unexpected process") },
  async adoptOwned() { throw new Error("unexpected adoption") },
  open() { return this },
  async close() { return { settled: true } },
}
function emptyHistory() {
  return { replay: async () => ({ position: 0, summaries: new Map(), changedToolUseIds: new Set<string>(), measure: async (run: ToolHistorySummary) => run }) }
}

test("history recovery joins every installed owner's admitted work before reporting all failures", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failures = [new Error("first recovery"), new Error("second recovery")]
  let finished = false
  let settled = false
  let error: unknown
  const catalog = [
    owner("first", { sessionHistory: { createToolSummaryReader: emptyHistory, async recover() { throw failures[0] } } }),
    owner("second", { sessionHistory: { createToolSummaryReader: emptyHistory, async recover() {
      started.resolve()
      await release.promise
      finished = true
      throw failures[1]
    } } }),
  ]
  const completed = recoverSessionHistory({ sessionId: "session", reader, projectionReader: reader, writer, projectRoot: directories.projectRoot }, catalog)
    .catch((cause: unknown) => { error = cause }).finally(() => { settled = true })
  await started.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  await completed
  expect(finished).toBe(true)
  expect(error).toBeInstanceOf(AggregateError)
  if (error instanceof AggregateError) expect(error.errors).toEqual(failures)
})

test("maintenance joins matching owners through failure and carries the owner's cancellation signal", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const failures = [new Error("first maintenance"), new Error("second maintenance")]
  let settled = false
  let skippedPhaseRan = false
  let observedAbort = false
  let error: unknown
  const catalog = [
    owner("first", { maintenance: [{ phase: "after-store", async run() { throw failures[0] } }] }),
    owner("second", { maintenance: [{ phase: "after-store", async run(input) {
      expect(input.signal).toBe(controller.signal)
      started.resolve()
      await release.promise
      observedAbort = input.signal.aborted
      throw failures[1]
    } }, { phase: "before-store", async run() { skippedPhaseRan = true } }] }),
  ]
  const completed = runModuleMaintenance("after-store", { directories, launcher, reader, writer, signal: controller.signal }, catalog)
    .catch((cause: unknown) => { error = cause }).finally(() => { settled = true })
  await started.promise
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  await completed
  expect(observedAbort).toBe(true)
  expect(skippedPhaseRan).toBe(false)
  expect(error).toBeInstanceOf(AggregateError)
  if (error instanceof AggregateError) expect(error.errors).toEqual(failures)
})

test("definition preparation waits for every owner and each later pass runs every prepared callback", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failure = new Error("prepare failed")
  let settled = false
  let error: unknown
  const completed = prepareDefinitionReconciliation({ directories, capabilities: NO_CAPABILITY_ACCESS }, [
    owner("failed", { definitionReconciliation: { async prepare() { throw failure } } }),
    owner("pending", { definitionReconciliation: { async prepare() { started.resolve(); await release.promise; return undefined } } }),
  ]).catch((cause: unknown) => { error = cause }).finally(() => { settled = true })
  await started.promise
  await Promise.resolve()
  expect(settled).toBe(false)
  release.resolve()
  await completed
  expect(error).toBeInstanceOf(AggregateError)
  if (error instanceof AggregateError) expect(error.errors).toEqual([failure])
  const calls: string[] = []
  const reconcile = await prepareDefinitionReconciliation({ directories, capabilities: NO_CAPABILITY_ACCESS }, [
    owner("first", { definitionReconciliation: { async prepare() { return () => { calls.push("first"); throw new Error("first callback") } } } }),
    owner("second", { definitionReconciliation: { async prepare() { return () => { calls.push("second"); throw new Error("second callback") } } } }),
  ])
  await expect(reconcile()).rejects.toThrow(AggregateError)
  await expect(reconcile(reader)).rejects.toThrow(AggregateError)
  expect(calls).toEqual(["first", "second", "first", "second"])
})

test("migration order collisions are refused before any migration runs", () => {
  let ran = false
  const migration = { phase: "stored-facts", order: 7, label: "probe", run() { ran = true } } as const
  const catalog = [owner("first", { workspaceMigrations: [migration] }), owner("second", { workspaceMigrations: [migration] })]
  expect(() => installedWorkspaceMigrations("stored-facts", false, catalog)).toThrow("order 7 is declared twice")
  expect(ran).toBe(false)
})
