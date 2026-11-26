import { afterEach, describe, expect, it } from "bun:test"
import { contentEvidence } from "../../../../src/infra/substrate/runtime-facts/content-evidence.js"
import { EventReaderService } from "../../../../src/infra/substrate/store/event-store-effect.js"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/control/children/child-session-reconciliation.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js"
import { redactMessage } from "../../../../src/orchestration/session/conversation/redact-message.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/persistence/session-fact-writer.js"
import { recordChildWorkflowStartFailure } from "../../../../src/orchestration/session/control/children/child-workflow-result.js"
import { liveWorkflowControl, liveWorkflowControls } from "../../../../src/orchestration/session/control/live-session-control.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { createWorkflowLaunchLifecycle } from "../../../../src/orchestration/workflow-host/lifecycle/launch-lifecycle.js"
import { prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/lifecycle/publish.js"
import type { WorkflowHosts } from "../../../../src/orchestration/workflow-host/host-collection.js"
import { createWorkflowHosts } from "../../../../src/orchestration/modules/workflows/host-collection.js"
import { workflowRunReader } from "../../../../src/orchestration/module-contract/module-catalog.js"
import { childSessionProjectionAttachment } from "../../../../src/orchestration/session-store/child-session-projection.js"
import type { WorkflowDefinition } from "../../../../src/workflows/schema/workflow-schema.js"
import type { WorkflowDeps } from "../../../../src/orchestration/agent-runtime/runner/workflow-deps.js"
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema/schema.js"
import { captureRuntimeConfigRequest } from "../../../../src/orchestration/config/request-config.js"
import { readWorkflowControl } from "../../../../src/workflows/vm/recovery/recovery-fold.js"
import { createSupervisorTestContext, disposeSupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { cleanupProjectRoots, createCapabilities, createDeps, makeWorkflowDeps, noConversationRecall, until } from "./_workflow-controller-fixtures.js"
import { capabilityAccessFor } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { newTestRunner } from "../../../helpers/agent-runner"
import { refusingLauncher } from "../../../helpers/launcher-fake"
import { asModelClient } from "../agent-runtime/_model-client"
import { loadedWorkflow } from "../../../helpers/workflow-files.js"

const contexts: ReturnType<typeof createSupervisorTestContext>[] = []
const hosts: WorkflowHosts[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.disposeAll(() => "runtime")
  cleanupProjectRoots()
  for (const ctx of contexts.splice(0)) {
    await ctx.sessionStore.disposeAll()
    await disposeSupervisorTestContext(ctx)
  }
})

/** A launched run of `options.workflow` on `options.workflowDeps`, by default a zero-agent workflow over an empty list.
 *  `options.beforeStart` runs after publication, before the host starts the run. */
async function workflowRun(firstReport: "pending" | "fails" | "delayed", resumeStartFailure = false, summary?: string, options: { readonly workflow?: WorkflowDefinition; readonly workflowDeps?: WorkflowDeps; readonly beforeStart?: () => void } = {}) {
  const ctx = createSupervisorTestContext()
  contexts.push(ctx)
  const reader = ctx.runtime.runSync(EventReaderService)
  const parentSessionId = await ctx.manager.createChat({ id: "parent", name: "Parent" })
  const parent = await ctx.manager.read(parentSessionId)
  if (parent?.kind !== "chat") throw new Error("missing parent")
  const workflow = options.workflow ?? loadedWorkflow({
    id: "empty-list", name: "Empty list",
    input: { fields: { items: { type: "list", description: "Targets", max: 1, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "Target" } } } } } },
    phases: [{ phase: "work", over: "input.items", brief: "Do the work.", writes: [] }],
  })
  const base = options.workflowDeps ?? makeWorkflowDeps()
  const definitionRevision = base.definitions.captureRevision()
  const prepared = await prepareWorkflowLaunch({
    workflow, description: "No targets", deps: base, authProfileId: "default", projectRoot: ctx.baseDir, definitionRevision,
    ...options.workflow === undefined ? { input: { items: resumeStartFailure ? [{ id: "one" }] : [] } } : {},
  })
  const input = { workflow_definition_id: workflow.id, description: "No targets", summary: "No targets" }
  const evidence = contentEvidence(JSON.stringify(input))
  const writer = createSessionFactWriter({ sessionId: parentSessionId, writer: ctx.store })
  await writer.record({
    type: "tool.input.completed", version: 1, actor: "agent",
    payload: {
      toolUseId: "launch", toolName: "workflow", input,
      inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
      executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request",
    },
  })
  writer.dispose()
  await ctx.manager.publishWorkflow({
    id: "child", ...prepared, ...(summary === undefined ? {} : { summary }),
    launchedFrom: { parentSessionId, conversationId: parent.conversationId, workflowDefinitionId: workflow.id, toolUseId: "launch", description: "No targets" },
    facts: prepared.workflowFacts,
  })
  // The parent is a live chat whose one conversation writer commits each
  // offered completion in turn and retires its hold, as its runner does.
  let commits = Promise.resolve()
  const commitNotification = async ({ key, text }: { key?: string; text: string }) => {
    const tree = key === undefined ? undefined : await tryOpenConversationTree({ conversationId: parent.conversationId, sessionId: parentSessionId, store: reader, writer: ctx.store })
    if (!tree || key === undefined) return false
    const [append] = await tree.prepareMessagesAppend([{ id: key, message: redactMessage({ kind: "user", content: text, replyRequired: true }, false) }])
    tree.dispose()
    if (append) await ctx.store.appendBatch([{ ...append, inFlight: [{ op: "drop", kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, key }] }])
    return true
  }
  const reconcile = () => reconcileChildSessionCompletions({
    parentSessionId, reader, projectionReader: reader, writer: ctx.store,
    deliverNotification: (notification) => {
      const committed = commits.then(() => commitNotification(notification))
      commits = committed.then(() => {}, () => {})
      return committed
    },
  })
  if (resumeStartFailure) {
    await recordChildWorkflowStartFailure({
      parentSessionId, reader, projectionReader: reader, writer: ctx.store, toolUseId: "launch", childSessionId: "child", workflowDefinitionId: workflow.id,
    })
    // The parent reads the start failure before the person resumes the run.
    await reconcile()
  }
  const resumed = Promise.withResolvers<void>()
  const continueRun = Promise.withResolvers<void>()
  let reconcilePriorFailure = resumeStartFailure
  const projectionReader = {
    ...reader,
    readSlice: async (slice: Parameters<typeof reader.readSlice>[0]) => {
      if (reconcilePriorFailure && slice.aggregateId === "workflow:child" && liveWorkflowControl(reader, "child")) {
        reconcilePriorFailure = false
        await reconcile()
        resumed.resolve()
        await continueRun.promise
      }
      return reader.readSlice(slice)
    },
  }
  const reported = Promise.withResolvers<void>()
  const releaseReport = Promise.withResolvers<void>()
  let reports = 0
  const workflowHosts = createWorkflowHosts({ runtime: ctx.runtime, projectionReader: resumeStartFailure ? projectionReader : reader, attachChildProjection: childSessionProjectionAttachment(ctx.sessionStore) })
  hosts.push(workflowHosts)
  const lifecycle = createWorkflowLaunchLifecycle(createDeps({
    ...ctx, workflowHosts, projectRoot: ctx.baseDir, executionCwd: ctx.baseDir,
    eventReader: reader, projectionReader: reader, eventWriter: ctx.store,
    reconcileChildSessionCompletions: async () => {
      reports += 1
      if (reports > 1) return reconcile()
      if (firstReport === "delayed") await releaseReport.promise
      if (firstReport === "fails") throw new Error("parent writer unavailable")
      return { reconciledCount: 0, workflowAggregateReads: 0, durableTerminalChildSessionIds: [] }
    },
  }))
  const tracking = await lifecycle.track("child", workflow.name, "new")
  options.beforeStart?.()
  const ended = Promise.withResolvers<void>()
  const names: { label: string; shortLabel: string }[] = []
  await workflowHosts.start({
    sessionId: "child", description: "No targets", workflow, startMode: resumeStartFailure ? "operator_resume" : "launch",
    projectRoot: ctx.baseDir, executionCwd: ctx.baseDir, manager: ctx.manager,
    workflowDeps: { ...base, definitionRevision }, recall: noConversationRecall,
    onSessionName: (labels) => { names.push(labels) },
    onCoreCompleted: async (id, result) => {
      try { return await lifecycle.notifyOriginCoreCompleted(id, result) }
      finally { reported.resolve() }
    },
    onRunnerDone: async (id, result) => { await lifecycle.handleRunnerDone(id, result); ended.resolve() },
    onRunnerError: async (id, error) => { await lifecycle.handleRunnerError(id, error); ended.resolve() },
  })
  return { ctx, workflowHosts, reader, lifecycle, tracking, resumed: resumed.promise, continueRun: continueRun.resolve, reported: reported.promise, releaseReport: releaseReport.resolve, ended: ended.promise, reconcile, reports: () => reports, names }
}

function abortReasons(run: Awaited<ReturnType<typeof workflowRun>>) {
  return run.ctx.store.read({ aggregateId: "workflow:child", types: ["workflow.aborted"] }).map(({ payload }) => payload.reason)
}

describe("workflow durable completion ownership", () => {
  it("does not release a resumed run for acknowledgement of its earlier start failure", async () => {
    const run = await workflowRun("fails", true)
    try {
      await run.resumed
      expect(run.ctx.store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
      run.continueRun()
      await run.reported
      await Bun.sleep(0)
      // The parent's committed notice of the start failure does not release the resumed run.
      expect(liveWorkflowControls(run.reader).map(control => control.workflowId)).toContain("child")
      expect(run.ctx.store.read({ aggregateId: "session:parent", types: ["workflow.tool_result.corrected"] })).toHaveLength(0)
      await run.reconcile()
      await run.ended
      // The resumed agent has no worker that hands off, so the run fails.
      expect(await run.tracking.done).toMatchObject({ status: "failed" })
      expect(liveWorkflowControl(run.reader, "child")).toBeUndefined()
      expect(run.ctx.store.read({ aggregateId: "session:parent", types: ["workflow.tool_result.corrected"] })).toHaveLength(1)
      expect(run.ctx.store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    } finally {
      run.continueRun()
      await run.workflowHosts.disposeAll(() => "runtime")
    }
  })

  it.each(["pending", "fails"] as const)("keeps a zero-agent run owed after reconciliation %s until a normal reconciliation acknowledges it", async (firstReport) => {
    const run = await workflowRun(firstReport)
    try {
      await run.reported
      await Bun.sleep(0)
      expect(liveWorkflowControls(run.reader).map(control => control.workflowId)).toContain("child")
      expect(run.workflowHosts.isRunning("child")).toBe(true)
      expect(run.reports()).toBe(1)
      expect(run.ctx.store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })).toHaveLength(0)

      expect((await run.reconcile()).durableTerminalChildSessionIds).toEqual(["child"])
      await run.ended
      expect(await run.tracking.done).toMatchObject({ status: "completed" })
      expect(liveWorkflowControl(run.reader, "child")).toBeUndefined()
      expect(run.ctx.store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] })).toHaveLength(1)
      expect(run.ctx.store.readInFlight("parent", QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    } finally {
      await run.workflowHosts.disposeAll(() => "runtime")
    }
  })

  it("ends a terminal run when the parent acknowledges a control revision that a later fact advanced after completion", async () => {
    const run = await workflowRun("pending")
    try {
      await run.reported
      const terminal = await readWorkflowControl(run.reader, "child")
      expect(terminal.status).toBe("completed")
      // Another writer records on the workflow's aggregate after the terminal
      // commit, before the parent's sweep reads the control it acknowledges.
      await run.ctx.store.append({
        aggregateId: "workflow:child", sessionId: "child", type: "budget.stream.completed", version: 2, actor: "flywheel",
        timestamp: Date.now(), payload: { budgetStreamId: "after-completion" },
      })
      const control = await readWorkflowControl(run.reader, "child")
      expect(control.aggregateSeq).toBe(terminal.aggregateSeq + 1)
      liveWorkflowControl(run.reader, "child")?.acknowledgeCompletion?.(control.aggregateSeq)
      await run.ended
      expect(liveWorkflowControl(run.reader, "child")).toBeUndefined()
    } finally {
      await run.workflowHosts.disposeAll(() => "runtime")
    }
  })

  it("keeps Stop available without an agent and answers its call before teardown joins a delayed parent report", async () => {
    const run = await workflowRun("delayed")
    try {
      await until(() => run.reports() === 1, "the zero-agent completion report")
      expect(liveWorkflowControls(run.reader).map(control => control.workflowId)).toContain("child")
      await run.lifecycle.stopLaunch("child", "person")
      expect(await run.tracking.done).toMatchObject({ status: "stopped" })
      await until(() => abortReasons(run).length > 0, "the Stop's abort")
      expect(abortReasons(run)).toEqual(["Workflow stopped by a person"])
      expect(run.ctx.store.read({ aggregateId: "session:parent", types: ["tool.result.recorded"] }).map(({ payload }) => payload.outcome)).toEqual(["stopped"])
      run.releaseReport()
      await run.ended
      expect(liveWorkflowControl(run.reader, "child")).toBeUndefined()
    } finally {
      run.releaseReport()
      await run.workflowHosts.disposeAll(() => "runtime")
    }
  })

  it("joins disposal while a terminal run still waits for parent acknowledgement, and records a replacement's pause as no Stop", async () => {
    const run = await workflowRun("pending")
    await run.reported
    expect(liveWorkflowControls(run.reader).map(control => control.workflowId)).toContain("child")
    await run.workflowHosts.disposeAll(() => "replacement")
    expect(liveWorkflowControl(run.reader, "child")).toBeUndefined()
    expect(abortReasons(run)).toEqual(["Workflow paused for a runtime replacement"])
  })
})

// The subagents table belongs to the subagents module, so the kernel config type does not declare it; a returned
// value, unlike an inline literal, is not checked for excess properties.
function configWith(disabled_types: readonly string[]) {
  return { ...CONFIG_DEFAULTS, subagents: { disabled_types } }
}

describe("workflow agents and agent types", () => {
  // The run is published with every agent type on; the live configuration turns the reviewer type off before the
  // host starts the agent, as a person's change after launch admission does.
  it("never starts an agent as a persona whose type was turned off after launch", async () => {
    const workflow = loadedWorkflow({
      id: "review", name: "Review", phases: [{ phase: "review", persona: "reviewer-code-quality", brief: "Review the change.", writes: [] }],
    })
    const base = makeWorkflowDeps()
    let disabled: readonly string[] = []
    let built = 0
    const workflowDeps = {
      ...base,
      captureRuntimeConfig: () => captureRuntimeConfigRequest({ revision: 0, config: configWith(disabled), warnings: [], diagnostics: [], sourceIdentity: "test", status: { kind: "valid" } }, "default"),
      createAgent: (options: Parameters<typeof base.createAgent>[0]) => { built += 1; return base.createAgent(options) },
    }
    const run = await workflowRun("pending", false, "Review", { workflow, workflowDeps, beforeStart: () => { disabled = ["reviewer"] } })
    try {
      await run.reported
      await run.reconcile()
      await run.ended
      expect(await run.tracking.done).toMatchObject({ status: "failed" })
      expect(JSON.stringify(run.ctx.store.read({ aggregateId: "workflow:child" }).map(({ payload }) => payload))).toContain("agent type reviewer is turned off. Remove it from subagents.disabled_types in flywheel.toml to turn it on")
      expect(built).toBe(0)
    } finally {
      await run.workflowHosts.disposeAll(() => "runtime")
    }
  })
})

describe("a workflow agent's learning", () => {
  // The run admits every module, learning included, under a capability boundary, and the live configuration
  // keeps the default review interval of 10 model calls, which the agent passes before its handoff.
  it("starts no learning review for an agent that completes after more model calls than the review interval", async () => {
    const workflow = loadedWorkflow({
      id: "work", name: "Work", phases: [{ phase: "work", brief: "Do the work.", writes: [] }],
    })
    const base = makeWorkflowDeps()
    const purposes: string[] = []
    let requests = 0
    const respond = (): ProviderStreamEvent[] => requests <= 10
      ? [{ kind: "tool_use", toolCall: { id: `read-${requests}`, name: "read", input: { file_path: "missing.txt" } } }, { kind: "done", stopReason: "tool_use" }]
      : [{ kind: "tool_use", toolCall: { id: "handoff-1", name: "handoff", input: { summary: "done" } } }, { kind: "done", stopReason: "tool_use" }]
    const workflowDeps: WorkflowDeps = {
      ...base,
      capabilityAccess: capabilityAccessFor(createCapabilities()),
      createAgent: (options) => {
        purposes.push(options.purpose.kind)
        if (options.purpose.kind !== "workflow-agent") return base.createAgent(options)
        return newTestRunner({ ...options, runtimeSurfaces: { ...options.runtimeSurfaces, launcher: refusingLauncher }, agentRegistry: new Map(), agentsMd: "" }, async () => asModelClient({
          accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5.4", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools() { requests += 1; yield* respond() },
        }), undefined, base.captureProviderConnection)
      },
    }
    const run = await workflowRun("pending", false, "Work", { workflow, workflowDeps })
    try {
      await run.reported
      await run.reconcile()
      await run.ended
      expect(await run.tracking.done).toMatchObject({ status: "completed" })
    } finally {
      // Disposal joins every background job of the run, as a review that outlived its agent once was.
      await run.workflowHosts.disposeAll(() => "runtime")
    }
    expect(requests).toBe(11)
    expect(purposes).toEqual(["workflow-agent"])
    expect(run.ctx.store.read({ types: ["skill.review.completed"] })).toEqual([])
    expect(run.ctx.store.read({ types: ["budget.stream.completed"] }).map(({ payload }) => String(payload.budgetStreamId))).not.toContainEqual(expect.stringContaining("learning-review"))
  })
})

/** A one-agent run whose agent reads a file in each of its first `reads` requests, each of which reports the usage
 *  `usage`, then hands off; the messages of each request it sent, serialized. */
async function agentRequests(config: Parameters<typeof captureRuntimeConfigRequest>[0]["config"], reads: number, usage: { readonly inputTokens: number; readonly outputTokens: number }) {
  const workflow = loadedWorkflow({
    id: "work", name: "Work", phases: [{ phase: "work", brief: "Do the work.", writes: [] }],
  })
  const base = makeWorkflowDeps()
  const requests: string[] = []
  const respond = (): ProviderStreamEvent[] => requests.length <= reads
    ? [
        { kind: "tool_use", toolCall: { id: `read-${requests.length}`, name: "read", input: { file_path: "missing.txt" } } },
        { kind: "usage", final: true, ...usage, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 },
        { kind: "done", stopReason: "tool_use" },
      ]
    : [{ kind: "tool_use", toolCall: { id: "handoff-1", name: "handoff", input: { summary: "done" } } }, { kind: "done", stopReason: "tool_use" }]
  const workflowDeps: WorkflowDeps = {
    ...base,
    captureRuntimeConfig: () => captureRuntimeConfigRequest({ revision: 0, config, warnings: [], diagnostics: [], sourceIdentity: "test", status: { kind: "valid" } }, "default"),
    createAgent: (options) => newTestRunner({ ...options, runtimeSurfaces: { ...options.runtimeSurfaces, launcher: refusingLauncher }, agentRegistry: new Map(), agentsMd: "" }, async () => asModelClient({
      accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5.4", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(stream) { requests.push(JSON.stringify(stream.messages)); yield* respond() },
    }), undefined, base.captureProviderConnection),
  }
  const run = await workflowRun("pending", false, "Work", { workflow, workflowDeps })
  try {
    await run.reported
    await run.reconcile()
    await run.ended
    expect(await run.tracking.done).toMatchObject({ status: "completed" })
  } finally {
    await run.workflowHosts.disposeAll(() => "runtime")
  }
  return { requests, run }
}

describe("a workflow agent's batch notices", () => {
  it("gives a workflow agent whose own store reports 70 percent context the context-pressure notice after its tool batch", async () => {
    // The agent's session measures the context of each request as the request starts, from the usage that the
    // provider reported for the one before it: the second request measures about 70 percent of 100,000 tokens.
    const { requests } = await agentRequests(CONFIG_DEFAULTS, 2, { inputTokens: 70_000, outputTokens: 10 })
    expect(requests).toHaveLength(3)
    expect(requests[1]).not.toContain("context_pressure_notice")
    expect(requests[2]).toContain("context_pressure_notice")
  })

  it("reports the member totals against a workflow token budget of 1,000, and the remaining attempts that the gate reads", async () => {
    const budget = { max_invocations: 3, max_tokens: 1_000, max_wall_clock_minutes: 0 }
    const { requests, run } = await agentRequests({ ...CONFIG_DEFAULTS, budget }, 1, { inputTokens: 800, outputTokens: 100 })
    // The gate counts the attempts that the workflow's own aggregate records.
    const attempts = run.ctx.store.read({ aggregateId: "workflow:child", types: ["budget.invocation.recorded"] }).length
    expect(attempts).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain(`Workflow budget running low: ${budget.max_invocations - attempts} attempts and 100 tokens remain.`)
  })
})

describe("workflow naming", () => {
  it("names a run by its launch summary and generates no title", async () => {
    const run = await workflowRun("pending", false, "Empty sweep")
    try {
      await run.reported
      expect(await workflowRunReader(run.reader).read("child")).toMatchObject({ label: "Empty sweep", shortLabel: "Empty sweep", name: "Empty sweep" })
      expect(run.names).toEqual([])
    } finally {
      await run.workflowHosts.disposeAll(() => "runtime")
    }
  })

  it("generates a title for a run whose launch gave no summary", async () => {
    const run = await workflowRun("pending")
    try {
      await run.reported
      expect(await workflowRunReader(run.reader).read("child")).toMatchObject({ label: "No targets", name: "No targets" })
      expect(run.names[0]).toEqual({ label: "No targets", shortLabel: "No Targets" })
    } finally {
      await run.workflowHosts.disposeAll(() => "runtime")
    }
  })
})
