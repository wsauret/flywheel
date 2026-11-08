import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { EventReaderService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createWorkflowHosts } from "../../../../src/orchestration/modules/workflows/host-collection.js"
import * as runnerModule from "../../../../src/orchestration/workflow-host/runner.js"
import type { WorkflowRunner, WorkflowResult } from "../../../../src/orchestration/workflow-host/runner-types.js"
import { createSessionStoreTestContext } from "./_session-store-fixtures.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { makeWorkflowDeps } from "../workflow-host/_workflow-controller-fixtures.js"
import { parseSchema } from "../../../helpers/schema-assertions.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { plainAgentTree } from "../../../helpers/workflow-view.js"

const dirs = temporaryDirectories()
let context: ReturnType<typeof createSessionStoreTestContext>
let hosts: ReturnType<typeof createWorkflowHosts>
let factory: ReturnType<typeof spyOn<typeof runnerModule, "createWorkflowRunner">>
let calls: string[]
let done: PromiseWithResolvers<WorkflowResult>
let disposing: PromiseWithResolvers<void>
let disposeWait: Promise<void> | undefined
let disposeError: Error | undefined

beforeEach(() => {
  context = createSessionStoreTestContext()
  calls = []
  done = Promise.withResolvers<WorkflowResult>()
  disposing = Promise.withResolvers<void>()
  disposeWait = undefined
  disposeError = undefined
  const runner: WorkflowRunner = {
    sessionId: "workflow",
    prepare: async () => null,
    run: () => done.promise,
    readQueue: async () => ({ attempts: [], tree: plainAgentTree([]), cursor: 0, status: "running", mutationLog: [] }),
    abort: async (cause) => { calls.push(`abort:${cause}`); done.resolve({ completed: false, attemptsCompleted: 0, attemptsTotal: 0, cost: 0, tokens: 0 }) },
    dispose: async () => {
      calls.push("dispose"); disposing.resolve(); await disposeWait
      // oxlint-disable-next-line no-throw-literal -- boundary: preserve the fixture's Error identity for disposal failure assertions.
      if (disposeError) throw disposeError
    },
    resume: async () => true,
    continueCapacity: () => new Set(),
    interrupt: async () => false,
    interruption: () => undefined,
    cut: async () => undefined,
    handBack: async () => ({ kind: "not_parked" }),
    continueHeldMessages: async () => {},
    interruptForReplacement: async () => false,
    interruptPlannedCut: async () => "ended",
    stepModuleRuntimes: async () => undefined,
    stepBackgroundTasks: () => undefined,
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    terminateBackgroundWork: (id) => { calls.push(`terminate:${id}`) },
    compact: async () => false,
    applyProjectionEvent: () => {},
    recallQueuedMessage: async () => null,
  }
  factory = spyOn(runnerModule, "createWorkflowRunner").mockImplementation(() => runner)
  hosts = createWorkflowHosts({
    runtime: context.runtime,
    projectionReader: context.runtime.runSync(EventReaderService),
    attachChildProjection: async () => { throw new Error("No agent starts in a collection lifecycle test") },
  })
})

afterEach(async () => {
  await hosts.disposeAll(() => "runtime").catch(() => {})
  factory.mockRestore()
  await context.cleanup()
})

function options() {
  const root = dirs("workflow-host-lifecycle-")
  const reader = context.runtime.runSync(EventReaderService)
  const deps = makeWorkflowDeps()
  return {
    sessionId: "workflow", description: "Workflow", startMode: "launch" as const,
    projectRoot: root, executionCwd: root,
    manager: createSessionManager({ projectRoot: root, executionCwd: root, projectionReader: reader, writer: context.runtime.runSync(EventStoreWriterService) }),
    workflow: parseSchema(WorkflowDefinitionSchema, { id: "test", name: "Test", phases: [{ phase: "work", name: "Work", brief: "Do work.", writes: [] }] }),
    workflowDeps: { ...deps, definitionRevision: deps.definitions.captureRevision() },
    recall: async () => ({ hits: [] }),
  }
}

it("rejects a second start while an aggregate host is live", async () => {
  const input = options()
  await hosts.start(input)
  expect(hosts.isRunning(input.sessionId)).toBe(true)
  await expect(hosts.start(input)).rejects.toThrow("already has a live or draining host")
  await hosts.abort(input.sessionId, "person")
})

it("claims one host for concurrent start and resume", async () => {
  const input = options()
  const result = await Promise.allSettled([hosts.start(input), hosts.start({ ...input, startMode: "operator_resume" })])
  expect(result.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"])
  expect(factory).toHaveBeenCalledTimes(1)
})

it("disposes a prepared host before rejecting a publication failure", async () => {
  const release = Promise.withResolvers<void>()
  disposeWait = release.promise
  const starting = hosts.start({ ...options(), onPrepared: () => { throw new Error("publication rejected") } })
  await disposing.promise
  expect(hosts.isRunning("workflow")).toBe(false)
  release.resolve()
  await expect(starting).rejects.toThrow("publication rejected")
})

it("holds removal until acknowledgement and disposal both finish", async () => {
  const release = Promise.withResolvers<void>()
  disposeWait = release.promise
  await hosts.start({ ...options(), onRunnerDone: () => { calls.push("acknowledged") } })
  let settled = false
  const aborting = hosts.abort("workflow", "person").then((result) => { settled = true; return result })
  await disposing.promise
  expect(calls).toEqual(["abort:person", "acknowledged", "dispose"])
  expect(settled).toBe(false)
  release.resolve()
  expect(await aborting).toBe(true)
  expect(hosts.allIds()).toEqual([])
})

it("releases a host when disposal fails and surfaces the error", async () => {
  disposeError = new Error("runner disposal failed")
  await hosts.start(options())
  await expect(hosts.abort("workflow", "person")).rejects.toThrow("runner disposal failed")
  expect(hosts.allIds()).toEqual([])
})

it("disposes and releases a host when acknowledgement fails", async () => {
  await hosts.start({ ...options(), onRunnerDone: () => { throw new Error("acknowledgement failed") } })
  await expect(hosts.abort("workflow", "person")).rejects.toThrow("acknowledgement failed")
  expect(calls).toContain("dispose")
  expect(hosts.allIds()).toEqual([])
})

it("routes background termination to the exact aggregate host", async () => {
  await hosts.start(options())
  hosts.get("missing")?.terminateBackgroundWork("target")
  hosts.get("workflow")?.terminateBackgroundWork("target")
  expect(calls).toEqual(["terminate:target"])
})

it("removes a completed host only after durable acknowledgement and disposal", async () => {
  const release = Promise.withResolvers<void>()
  disposeWait = release.promise
  const finished = Promise.withResolvers<void>()
  hosts.onChange(() => { if (!hosts.allIds().length) finished.resolve() })
  await hosts.start({ ...options(), onRunnerDone: () => { calls.push("acknowledged") } })
  done.resolve({ completed: true, attemptsCompleted: 1, attemptsTotal: 1, cost: 0, tokens: 0 })
  await disposing.promise
  expect(hosts.allIds()).toEqual(["workflow"])
  release.resolve()
  await finished.promise
  expect(calls).toEqual(["acknowledged", "dispose"])
})

it("disposeAll aborts all aggregate hosts with the cause it names for each and refuses new starts", async () => {
  const input = options()
  await hosts.start(input)
  await hosts.disposeAll((id) => id === input.sessionId ? "replacement" : "runtime")
  expect(calls).toContain("abort:replacement")
  expect(calls).toContain("dispose")
  await expect(hosts.start(input)).rejects.toThrow("closed")
})
