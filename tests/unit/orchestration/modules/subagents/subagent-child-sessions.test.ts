import { describe, expect, test } from "bun:test"
import { liveChildRuns } from "../../../../../src/orchestration/session/live-session-control.js"
import { randomUUID } from "node:crypto"
import { appendUsage } from "./_subagent-usage-fixture.js"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js"
import { createOutputProjection } from "../../../../../src/orchestration/app-service/output-projection.js"
import { createShippedOutput } from "../../../../../src/orchestration/app-service/shipped-output.js"
import { createRuntimeUiPatchSequencer } from "../../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import type { RuntimeUiPatch } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { emitContextUpdate, emitToolInputComplete, emitToolResult } from "../../../../../src/orchestration/agent-runtime/emit.js"

import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import { resolveSessionDir } from "../../../../../src/infra/paths.js"
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { acquireSessionSummaryIndex } from "../../../../../src/orchestration/session/session-summary-index.js"
import { reconcileChildSessionCompletions } from "../../../../../src/orchestration/session/child-session-reconciliation.js"
import { readPlannedSessionContinuationAsync, interruptChildForReplacement } from "../../../../../src/orchestration/session/planned-session-continuation.js"
import { prepareSessionFactAppend } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { publishTestWorkflow } from "../../session/_session-manager-fixtures.js"
import { sessionStoreReaches, subagentChildHarnesses, completedRunner, heldRunner, createRoot, waitForSettled, childIds, runs } from "./_subagent-child-fixtures.js"
import { readSessionDurationFromReader } from "../../../../../src/orchestration/session/session-duration-projection.js"
import { createSubagentToolSummaryReader } from "../../../../../src/orchestration/modules/subagents/history/tool-summary.js"
import { executeChildSessionDeletionPlan } from "../../../../../src/orchestration/session/child-session-deletion.js"
import { createWorkflowRunReader } from "../../../../../src/orchestration/modules/workflows/run-record.js"
import { createConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer.js"
import { readConversationBackgroundNotifications } from "../../../../../src/orchestration/session/conversation/queued-background-notifications.js"

const createHarness = subagentChildHarnesses()

test("a nested completion commits into its live parent and retires that parent's owed result", async () => {
  const held = heldRunner()
  const harness = createHarness(held.createAgent)
  try {
    const root = await createRoot(harness.manager)
    await harness.tool(root.sessionId).execute(
      { persona: "delegator", description: "middle", rationale: TEST_RATIONALE, prompt: "delegate once" },
      makeContext({ conversationId: root.conversationId, toolUseId: "middle-dispatch" }),
    )
    const middle = held.options[0]
    const middleId = (await childIds(harness.manager, root.sessionId))[0]
    const background = middle?.runtimeSurfaces?.background
    const conversation = middle?.conversation
    if (!middleId || !background || conversation?.kind !== "durable-tree" || !middle?.lifecycle.inputSource) throw new Error("missing middle run")
    await harness.tool(middleId, {
      backgroundTasks: background.tasks,
      deliverParentNotification: async () => false,
    }).execute(
      { persona: "delegator", description: "nested", rationale: TEST_RATIONALE, prompt: "finish" },
      makeContext({ conversationId: conversation.conversationId, toolUseId: "nested-dispatch" }),
    )
    const nested = held.options[1]
    nested?.runtimeSurfaces?.handoff?.onContent({ summary: "nested result" })
    held.results[1]?.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    const notice = await middle.lifecycle.inputSource.prepareWaitForInput?.().commit()
    if (notice?.kind !== "message") throw new Error("missing nested completion")
    expect(notice.text).toContain("nested result")
    expect(background.tasks.liveWorkReferences()).toHaveLength(1)
    const key = notice.backgroundNotificationIds?.[0]
    if (!key) throw new Error("missing nested completion key")
    background.tasks.deliverDurableSubagentNotification({ key, text: notice.text })
    expect(middle.lifecycle.inputSource.drainPending()).toBeNull()
    await conversation.append({ kind: "user", content: notice.text, origin: "system", backgroundNotificationIds: notice.backgroundNotificationIds })
    await conversation.flush?.()
    expect(background.tasks.liveWorkReferences()).toEqual([])
    expect(background.tasks.assertHandoffReady()).toBeNull()
    expect((await conversation.committedTree()).entriesById[key]).toBeDefined()
    await harness.authority.settleReconciliation()
  } finally {
    for (const result of held.results) result.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await harness.close()
  }
})

test("a child resource close failure fails its tracked settlement", async () => {
  const harness = createHarness(completedRunner([]))
  const publish = harness.authority.publish
  harness.authority.publish = async (input) => {
    const execution = await publish(input)
    const projection = execution.projection
    if (!projection) throw new Error("Expected the child projection")
    const dispose = projection.dispose
    projection.dispose = async () => {
      await dispose()
      throw new Error("injected child projection close failure")
    }
    return execution
  }
  try {
    const root = await createRoot(harness.manager)
    await harness.tool(root.sessionId).execute(
      { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Complete the child" },
      makeContext({ conversationId: root.conversationId }),
    )
    await waitForSettled(harness, root.sessionId)
    expect(harness.backgroundTasks.processRecords()).toEqual([
      expect.objectContaining({ kind: "subagent", status: "failed" }),
    ])
  } finally {
    await harness.close()
  }
})

test.each([false, true])("settles child cleanup and joins parent publication (publication failure: %s)", async (injectFailure) => {
  const harness = createHarness(completedRunner([]))
  const cleanupStarted = Promise.withResolvers<void>()
  const releaseCleanup = Promise.withResolvers<void>()
  const reconciliationStarted = Promise.withResolvers<void>()
  const releaseReconciliation = Promise.withResolvers<void>()
  const publish = harness.authority.publish
  let reconciliationCalls = 0
  let notifications = 0
  let failPublication = injectFailure
  harness.authority.publish = async (input) => {
    const execution = await publish(input)
    return {
      ...execution,
      async settle() {
        cleanupStarted.resolve()
        await releaseCleanup.promise
        await execution.settle()
        await harness.writer.append(prepareSessionFactAppend(input.childSessionId, {
          type: "session.duration.recorded", version: 1, actor: "flywheel",
          payload: { accumulatedActiveMs: 123 },
        }))
      },
    }
  }
  const append = harness.writer.appendBatchGuarded
  harness.writer.appendBatchGuarded = async (...args) => {
    if (args[0].some((event) => event.type === "tool.result.recorded")) {
      reconciliationCalls += 1
      reconciliationStarted.resolve()
      await releaseReconciliation.promise
      if (failPublication) {
        failPublication = false
        throw new Error("injected parent publication failure")
      }
    }
    return append(...args)
  }
  try {
    const root = await createRoot(harness.manager)
    await harness.tool(root.sessionId, { deliverParentNotification: async () => { notifications += 1; return true } }).execute(
      { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Complete the child" },
      makeContext({ conversationId: root.conversationId }),
    )
    await cleanupStarted.promise
    expect(reconciliationCalls).toBe(0)
    releaseCleanup.resolve()
    await reconciliationStarted.promise
    let joined = false
    const joining = harness.authority.settleReconciliation().then(() => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    releaseReconciliation.resolve()
    if (injectFailure) {
      await expect(joining).rejects.toThrow("Subagent parent reconciliation failed")
      harness.authority.reconcileParentCompletion(root.sessionId, async () => { notifications += 1; return true })
      await harness.authority.settleReconciliation()
    } else await joining
    const child = (await childIds(harness.manager, root.sessionId))[0]!
    expect((await harness.manager.read(child))?.lifecycleState).toBe("inactive")
    expect(reconciliationCalls).toBe(injectFailure ? 2 : 1)
    expect(notifications).toBe(1)
    await reconcileChildSessionCompletions({
      parentSessionId: root.sessionId, reader: harness.reader, writer: harness.writer,
      deliverNotification: async () => { notifications += 1; return true },
    })
    expect(notifications).toBe(2)
    const conversation = createConversationTreeWriterController({
      sessionId: root.sessionId, conversationId: root.conversationId, projectRoot: harness.projectRoot,
      store: harness.reader, projectionReader: harness.reader, writer: harness.writer,
    })
    try {
      for (const held of await readConversationBackgroundNotifications(harness.reader, root.sessionId, root.conversationId)) {
        await conversation.commitBackgroundNotification(held)
      }
      await reconcileChildSessionCompletions({
        parentSessionId: root.sessionId, reader: harness.reader, writer: harness.writer,
        deliverNotification: async () => { notifications += 1; return true },
      })
      expect(notifications).toBe(2)
    } finally { await conversation.dispose() }
    expect(harness.store.read({ aggregateId: `session:${root.sessionId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
    expect(harness.store.read({ aggregateId: `session:${child}`, types: ["session.lifecycle.changed"] })).toHaveLength(1)
  } finally {
    releaseCleanup.resolve()
    releaseReconciliation.resolve()
    await harness.authority.settleReconciliation()
    await harness.close()
  }
})


test("direct child publishes later output to its retained session subscription", async () => {
  const done = Promise.withResolvers<AgentRunResult>()
  const started = Promise.withResolvers<AgentOptions>()
  const harness = createHarness((options) => ({
    send() { started.resolve(options) },
    end() {},
    abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
    done: done.promise,
  }))
  const patches: RuntimeUiPatch[] = []
  let onPublish = () => {}
  const sequencer = createRuntimeUiPatchSequencer()
  const projection = createOutputProjection({
    sessionStore: harness.sessionStore,
    shipped: createShippedOutput({
      publish(input) {
        const patch = sequencer.publish(input)
        patches.push(patch)
        onPublish()
        return patch
      },
    }),
  })
  try {
    const root = await createRoot(harness.manager)
    harness.sessionStore.openSessionRuntime({ sessionId: root.sessionId, conversationId: root.conversationId, initialTokens: 41, contextPercent: 7 })
    await harness.tool(root.sessionId).execute(
      { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Inspect live output" },
      makeContext({ conversationId: root.conversationId }),
    )
    const child = (await childIds(harness.manager, root.sessionId))[0]
    if (!child) throw new Error("Dispatch did not publish a child session")
    const publication = harness.batches.find((batch) => batch.some((event) =>
      event.sessionId === child && event.type === "child_run.created"
    ))
    expect(publication?.map((event) => event.type)).toEqual(expect.arrayContaining([
      "chat.tree.created",
      "chat.entries.appended",
      "session.created",
      "child_run.created",
      "subagent.prompted",
    ]))
    const options = await started.promise
    expect(harness.sessionStore.get(child)?.runner).toBeNull()
    expect(harness.sessionStore.get(child)?.runnerState).toBe("streaming")
    expect(harness.sessionStore.get(child)?.outputBlocks()[0]).toMatchObject({
      kind: "userMessage",
      content: "Inspect live output",
    })
    if (options.conversation.kind !== "durable-tree") throw new Error("Expected a durable child conversation")
    await options.conversation.append({ kind: "assistant", content: [{ type: "text", text: "retained child answer" }] })
    await options.conversation.flush?.()
    expect(harness.sessionStore.get(child)?.outputBlocks().filter((block) => block.kind === "userMessage")).toEqual([
      expect.objectContaining({ content: "Inspect live output" }),
    ])
    const before = patches.length
    const laterEntryId = await options.conversation.reserveMessageId()
    options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
      type: "model.assistant_message.recorded",
      entry_id: laterEntryId,
      parent_tool_use_id: "test-tool-use",
      message: { content: [{ type: "text", text: "later child output" }] },
    }))
    emitToolInputComplete(options.onEvent, { id: "child-read", name: "read", modelRequestId: "child-request", input: { path: "child.txt" }, execution: { mode: "foreground", trace_kind: "tool" } }, { parentToolUseId: "test-tool-use" })
    emitToolResult(options.onEvent, "child-read", [{ type: "text", text: "child tool result" }], "ok", { parentToolUseId: "test-tool-use" })
    emitContextUpdate(options.onEvent, 250, 1000, "test-tool-use")
    await options.sessionEventWriter!.record({
      type: "model.usage.measured", version: 5, actor: "provider",
      payload: {
        attemptId: randomUUID(), occurredAt: new Date().toISOString(), profileId: "profile-a",
        attribution: { kind: "candidate", providerId: "openai_api" }, spendMode: "direct_api",
        credentialLineage: randomUUID(), model: "gpt-5",
        tokens: { input: 600, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.5, rateCard: {}, provenance: "test" },
        currency: "USD", budgetStreamId: child,
      },
    })
    const publishedLaterOutput = () => patches.slice(before).some((patch) =>
      "sessionId" in patch.cursor && patch.cursor.sessionId === child && patch.payload.kind === "output.delta"
      && JSON.stringify(patch.payload).includes("later child output"),
    )
    const outputPublished = new Promise<void>((resolve) => {
      onPublish = () => {
        if (publishedLaterOutput() && JSON.stringify(patches.slice(before)).includes("child-read")) resolve()
      }
      onPublish()
    })
    await sessionStoreReaches(harness, () =>
      harness.sessionStore.get(child)?.tokens === 650
      && harness.sessionStore.get(child)?.contextPercent === 25
    )
    await outputPublished
    expect(publishedLaterOutput()).toBe(true)
    expect(JSON.stringify(patches.slice(before))).toContain("child-read")
    expect(harness.sessionStore.get(child)).toMatchObject({ tokens: 650, cost: 0.5, billedCost: 0.5, contextPercent: 25, contextPromptTokens: 250 })
    expect(harness.sessionStore.get(root.sessionId)).toMatchObject({ tokens: 41, contextPercent: 7, runnerState: "absent" })
    options.lifecycle.onTurnParked?.({ turnCount: 1, activeBackgroundCount: 0, handoffWritten: false, parkedOnBackgroundWork: false, waitRequested: false, userResumeRequired: true, park: "interrupted" })
    expect(harness.sessionStore.get(child)?.runnerState).toBe("idle")
    options.lifecycle.onTurnResumed?.()
    expect(harness.sessionStore.get(child)?.runnerState).toBe("streaming")
    options.runtimeSurfaces?.handoff?.onContent({ summary: "completed" })
    const finalEntryId = await options.conversation.reserveMessageId()
    options.onEvent(createRuntimeEvent("model.assistant_message.recorded", {
      type: "model.assistant_message.recorded",
      entry_id: finalEntryId,
      message: { content: [{ type: "text", text: "final before detach" }] },
    }))
    done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await waitForSettled(harness, root.sessionId)
    expect(runs(harness.store, child).at(-1)?.status).toBe("completed")
    expect(harness.sessionStore.has(child)).toBe(false)
    expect(JSON.stringify(patches)).toContain("final before detach")
    const facts = harness.store.read({ aggregateId: `session:${child}` })
    expect(facts.filter((fact) => fact.type === "model.usage.measured")).toHaveLength(1)
    expect(facts.filter((fact) => fact.type === "model.context.measured")).toHaveLength(1)
    expect(facts.filter((fact) => fact.type === "tool.input.completed")).toHaveLength(1)
    expect(facts.filter((fact) => fact.type === "tool.result.recorded")).toHaveLength(1)
    expect(JSON.stringify(harness.store.read({ aggregateId: `conversation:${options.conversation.conversationId}` }))).toContain("retained child answer")
  } finally {
    done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
    await harness.close()
    projection.dispose()
  }
})



describe("subagent child-session runtime", () => {
  test("drives five-way fanout and nested dispatch through durable child session actors", async () => {
    const runnerCalls: AgentOptions[] = []
    const harness = createHarness(completedRunner(runnerCalls))
    const root = await createRoot(harness.manager)

    for (let index = 0; index < 5; index += 1) {
      const result = await harness.tool(root.sessionId).execute(
        { persona: "delegator", description: `fanout-${index}`, rationale: TEST_RATIONALE, prompt: `inspect-${index}` },
        makeContext({
          projectRoot: harness.projectRoot,
          executionCwd: harness.projectRoot,
          conversationId: root.conversationId,
          toolUseId: `fanout-tool-${index}`,
        }),
      )
      expect(result).toMatchObject({ outcome: "ok", deferCompletion: true })
    }
    await waitForSettled(harness, root.sessionId)

    const fanout = await childIds(harness.manager, root.sessionId)
    expect(fanout).toHaveLength(5)
    expect(new Set(fanout).size).toBe(5)
    for (const childSessionId of fanout) {
      const child = await harness.manager.read(childSessionId)
      expect(child).toMatchObject({ kind: "subagent", lifecycleState: "inactive", launchedFrom: { parentSessionId: root.sessionId } })
      expect(existsSync(resolveSessionDir(childSessionId, harness.projectRoot))).toBe(true)
      const events = harness.store.read({ aggregateId: `session:${childSessionId}` })
      expect(events.findIndex((event) => event.type === "child_run.created")).toBeLessThan(
        events.findIndex((event) => event.type === "subagent.prompted"),
      )
      expect(runs(harness.store, childSessionId)).toHaveLength(1)
    }

    let parentSessionId = fanout[0]!
    for (const level of [2, 3]) {
      const parent = await harness.manager.read(parentSessionId)
      if (parent?.kind !== "subagent") throw new Error("expected nested subagent parent")
      const result = await harness.tool(parentSessionId).execute(
        { persona: "delegator", description: `depth-${level}`, rationale: TEST_RATIONALE, prompt: `nested-${level}` },
        makeContext({
          projectRoot: harness.projectRoot,
          executionCwd: harness.projectRoot,
          conversationId: parent.conversationId,
          toolUseId: `nested-tool-${level}`,
        }),
      )
      expect(result.outcome).toBe("ok")
      await waitForSettled(harness, parentSessionId)
      const descendants = await childIds(harness.manager, parentSessionId)
      expect(descendants).toHaveLength(1)
      parentSessionId = descendants[0]!
    }

    const depthThreeOptions = runnerCalls.at(-1)
    expect(depthThreeOptions?.toolGrant).not.toContain("subagent")
    expect(depthThreeOptions?.agentRegistry?.has("delegator")).toBe(true)
    expect(await harness.authority.childDepth(parentSessionId)).toBe(4)
    await harness.close()
  })

  test("retries a model failure once in the same child and continues a planned replacement on the same run", async () => {
    const runResults: Array<PromiseWithResolvers<AgentRunResult>> = []
    const runnerCalls: AgentOptions[] = []
    const harness = createHarness((options) => {
      runnerCalls.push(options)
      const done = Promise.withResolvers<AgentRunResult>()
      runResults.push(done)
      return {
        send() {},
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
        done: done.promise,
      }
    })
    const root = await createRoot(harness.manager)
    const tool = harness.tool(root.sessionId)
    const context = makeContext({
      projectRoot: harness.projectRoot,
      executionCwd: harness.projectRoot,
      conversationId: root.conversationId,
      toolUseId: "initial-tool",
    })

    await tool.execute(
      { persona: "delegator", description: "retry-child", rationale: TEST_RATIONALE, prompt: "inspect failure" },
      context,
    )
    const [retryChild] = await childIds(harness.manager, root.sessionId)
    if (!retryChild) throw new Error("expected retry child")
    appendUsage(harness.store, retryChild, 100, 10, 0.01)
    runResults[0]?.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } })
    await waitForSettled(harness, root.sessionId)
    expect(runs(harness.store, retryChild).at(-1)).toMatchObject({ status: "failed", modelFailure: true })
    const retryPriorMs = (await readSessionDurationFromReader(asAsyncEventReadSurface(harness.store), retryChild)).accumulatedActiveMs

    const retry = await tool.processResume(retryChild,
      { ...context, toolUseId: "retry-tool" },
    )
    // A Resume of a failed child opens a new attempt under the original call.
    expect(retry).toMatchObject({ outcome: "ok" })
    expect(JSON.parse(retry.content)).toMatchObject({ status: "resumed", session_id: retryChild })
    expect(harness.sessionStore.get(retryChild)).toMatchObject({ tokens: 110, accumulatedActiveMs: retryPriorMs })
    appendUsage(harness.store, retryChild, 50, 5, 0.005)
    expect(await harness.manager.read(retryChild)).toMatchObject({ lifecycleState: "active" })
    expect(harness.batches.findLast((batch) => batch.some((event) => event.type === "child_run.created"))?.map((event) => event.type)).toEqual([
      "child_run.created",
      "subagent.prompted",
      "session.lifecycle.changed",
    ])
    runnerCalls[1]?.runtimeSurfaces?.handoff?.onContent({ summary: "retry completed" })
    runResults[1]?.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await waitForSettled(harness, root.sessionId)
    const summaries = await createSubagentToolSummaryReader(asAsyncEventReadSurface(harness.store), root.sessionId).replay()
    const retried = summaries.summaries.get("initial-tool")
    expect((retried && await summaries.measure(retried))?.totalTokens).toBe(165)
    expect(runs(harness.store, retryChild).map((run) => ({ status: run.status, parentToolCallId: run.parentToolCallId }))).toEqual([
      { status: "failed", parentToolCallId: "initial-tool" },
      { status: "completed", parentToolCallId: "initial-tool" },
    ])

    await tool.execute(
      { persona: "delegator", description: "continued-child", rationale: TEST_RATIONALE, prompt: "continue after replacement" },
      { ...context, toolUseId: "continued-tool" },
    )
    const children = await childIds(harness.manager, root.sessionId)
    const continuedChild = children.find((id) => id !== retryChild)
    if (!continuedChild) throw new Error("expected planned-continuation child")
    const originalRun = runs(harness.store, continuedChild)[0]
    expect(originalRun).toBeDefined()
    appendUsage(harness.store, continuedChild, 200, 20, 0.02)

    const running = liveChildRuns(harness.reader)
    expect(running).toHaveLength(1)
    for (const control of running) await interruptChildForReplacement({ projectionReader: asAsyncEventReadSurface(harness.store), writer: harness.writer, control, handoffId: "handoff-test" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(harness.store), continuedChild)).toMatchObject({ runId: originalRun?.childRunId })
    await harness.manager.updateLifecycleState(continuedChild, "inactive")
    const resumedPriorMs = (await readSessionDurationFromReader(asAsyncEventReadSurface(harness.store), continuedChild)).accumulatedActiveMs
    harness.rejectNextActivation()
    const refusedResume = await tool.processResume(continuedChild,
      { ...context, toolUseId: "failed-resume-command" },
    )
    expect(refusedResume.outcome).toBe("error")
    expect(await harness.manager.read(continuedChild)).toMatchObject({ lifecycleState: "inactive" })
    expect(runs(harness.store, continuedChild)[0]?.status).toBe("paused")
    expect(runs(harness.store, continuedChild)[0]?.continuationCount).toBeUndefined()
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(harness.store), continuedChild)).toMatchObject({ runId: originalRun?.childRunId })
    const resume = await tool.processResume(continuedChild,
      { ...context, toolUseId: "resume-command" },
    )
    expect(resume).toMatchObject({ outcome: "ok" })
    expect(JSON.parse(resume.content)).toMatchObject({ status: "resumed", session_id: continuedChild, id: originalRun?.childRunId })
    expect(harness.sessionStore.get(continuedChild)).toMatchObject({ tokens: 220, accumulatedActiveMs: resumedPriorMs })
    appendUsage(harness.store, continuedChild, 30, 3, 0.003)
    expect(await harness.manager.read(continuedChild)).toMatchObject({ lifecycleState: "active" })
    expect(harness.batches.findLast((batch) => batch.some((event) => event.type === "subagent.resumed"))?.map((event) => event.type)).toEqual([
      "subagent.resumed",
      "session.lifecycle.changed",
    ])
    runnerCalls.at(-1)?.runtimeSurfaces?.handoff?.onContent({ summary: "continued" })
    runResults.at(-1)?.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await waitForSettled(harness, root.sessionId)

    const continuedRuns = runs(harness.store, continuedChild)
    expect(continuedRuns).toHaveLength(1)
    expect(continuedRuns[0]).toMatchObject({ childRunId: originalRun?.childRunId, status: "completed", continuationCount: 1 })
    const continuedSummaries = await createSubagentToolSummaryReader(asAsyncEventReadSurface(harness.store), root.sessionId).replay()
    const continued = continuedSummaries.summaries.get("continued-tool")
    expect((continued && await continuedSummaries.measure(continued))?.totalTokens).toBe(253)
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(harness.store), continuedChild)).toBeNull()
    await harness.close()
  })

  test("rolls descendant request leaves exactly once and deletes live owned descendants", async () => {
    const harness = createHarness(completedRunner([]))
    const root = await createRoot(harness.manager)
    await harness.tool(root.sessionId).execute(
      { persona: "delegator", description: "child", rationale: TEST_RATIONALE, prompt: "child work" },
      makeContext({
        projectRoot: harness.projectRoot,
        executionCwd: harness.projectRoot,
        conversationId: root.conversationId,
        toolUseId: "child-tool",
      }),
    )
    await waitForSettled(harness, root.sessionId)
    const [child] = await childIds(harness.manager, root.sessionId)
    if (!child) throw new Error("expected child")
    const childSession = await harness.manager.read(child)
    if (childSession?.kind !== "subagent") throw new Error("expected subagent child")
    await harness.tool(child).execute(
      { persona: "delegator", description: "grandchild", rationale: TEST_RATIONALE, prompt: "grandchild work" },
      makeContext({
        projectRoot: harness.projectRoot,
        executionCwd: harness.projectRoot,
        conversationId: childSession.conversationId,
        toolUseId: "grandchild-tool",
      }),
    )
    await waitForSettled(harness, child)
    const [grandchild] = await childIds(harness.manager, child)
    if (!grandchild) throw new Error("expected grandchild")

    const workflow = await publishTestWorkflow(harness.manager, {
      id: "independent-workflow",
      launchedFrom: { parentSessionId: root.sessionId, conversationId: root.conversationId, toolUseId: "workflow-tool" },
    })
    appendUsage(harness.store, root.sessionId, 10, 1, 1)
    appendUsage(harness.store, child, 20, 2, 2)
    appendUsage(harness.store, grandchild, 30, 3, 3)
    const summaries = acquireSessionSummaryIndex(
      join(harness.projectRoot, ".flywheel", "summary-test.sqlite"),
      asAsyncEventReadSurface(harness.store),
      { shared: false },
    )
    try {
      await summaries.replay()
      const indexed = await summaries.readImmediate([root.sessionId, child])
      expect(indexed.summaries.get(root.sessionId)?.budget).toMatchObject({
        totalTokens: 66,
        outputTokens: 6,
        totalCost: 6,
      })
      expect(indexed.summaries.get(child)?.budget).toMatchObject({
        totalTokens: 55,
        outputTokens: 5,
        totalCost: 5,
      })
    } finally {
      await summaries.dispose()
    }

    harness.store.append({
      aggregateId: `session:${root.sessionId}`,
      sessionId: root.sessionId,
      type: "child_run.created",
      version: 1,
      actor: "flywheel",
      timestamp: Date.now(),
      payload: {
        childRunId: "historical-inline-run",
        kind: "subagent",
        toolUseId: "historical-inline-tool",
        agentType: "explorer",
        description: "historical inline",
        model: "test/model",
        maxTurns: 10,
        tools: ["read"],
        executionCwd: harness.projectRoot,
      },
    })
    expect(runs(harness.store, root.sessionId)).toContainEqual(expect.objectContaining({
      childRunId: "historical-inline-run",
    }))

    const childDir = resolveSessionDir(child, harness.projectRoot)
    const grandchildDir = resolveSessionDir(grandchild, harness.projectRoot)
    await executeChildSessionDeletionPlan({
      projectRoot: harness.projectRoot,
      reader: harness.reader,
      projectionReader: asAsyncEventReadSurface(harness.store),
      writer: harness.writer,
      read: harness.manager.read,
      finalizeDeletionTarget: harness.manager.finalizeDeletionTarget,
    }, await harness.manager.admitDeletion(root.sessionId))
    expect(await harness.manager.read(root.sessionId)).toBeNull()
    expect(await harness.manager.read(child)).toBeNull()
    expect(await harness.manager.read(grandchild)).toBeNull()
    expect(await createWorkflowRunReader(harness.reader).read(workflow)).toBeNull()
    expect(existsSync(childDir)).toBe(false)
    expect(existsSync(grandchildDir)).toBe(false)
    expect(harness.store.read({ types: ["session.child.linked"] }).map((fact) => fact.payload.childSessionId)).toEqual(
      expect.arrayContaining([child, grandchild]),
    )
    expect(runs(harness.store, root.sessionId)).toContainEqual(expect.objectContaining({ childRunId: "historical-inline-run" }))
    await harness.close()
  })
})
