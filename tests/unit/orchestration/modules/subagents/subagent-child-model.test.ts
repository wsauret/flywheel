import { expect, test } from "bun:test"
import { liveChildRuns } from "../../../../../src/orchestration/session/live-session-control.js"
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { createSessionRoleResolver, effectiveRoleAssignments } from "../../../../../src/orchestration/config/session-role-resolver.js"
import { reconcileChildSessionCompletions } from "../../../../../src/orchestration/session/child-session-reconciliation.js"
import { interruptChildForReplacement } from "../../../../../src/orchestration/session/planned-session-continuation.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { subagentChildHarnesses } from "./_subagent-child-fixtures.js"
import { loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { createSessionToolSummaryReader } from "../../../../../src/orchestration/modules.js"
import { subagentsModule } from "../../../../../src/orchestration/modules/subagents.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"

const createHarness = subagentChildHarnesses()

test("child role revisions switch the next admitted model, survive resume and retry, and leave the parent alone", async () => {
  const attempts: { options: AgentOptions; done: PromiseWithResolvers<AgentRunResult> }[] = []
  let nextAttempt = Promise.withResolvers<void>()
  const harness = createHarness((options) => {
    const done = Promise.withResolvers<AgentRunResult>()
    attempts.push({ options, done })
    return {
      send() { nextAttempt.resolve() },
      end() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "input_closed" } }) },
      abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
      done: done.promise,
    }
  })
  try {
    const parentRoles = { chat: { model: "claude-opus-4.7", effort: "high" } }
    const parent = await harness.manager.createChat({ id: "parent", conversationId: "parent-conversation", initialRoles: parentRoles })
    const parentResolver = createSessionRoleResolver({ reader: asAsyncEventReadSurface(harness.store), projectRoot: harness.projectRoot, sessionId: parent })
    const parentBefore = await parentResolver()
    const tool = harness.tool(parent)
    const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: "parent-conversation" })
    await tool.execute({ persona: "delegator", rationale: TEST_RATIONALE, prompt: "Inspect" }, context)
    await nextAttempt.promise
    const first = attempts[0]!
    if (first.options.conversation.kind !== "durable-tree") throw new Error("Expected child tree")
    const child = first.options.conversation.sessionId
    expect(harness.metricUpdates).toEqual([child])
    await first.options.sessionEventWriter!.record({
      type: "tool.execution_output.recorded", version: 1, actor: "flywheel",
      payload: { toolUseId: "tool-output", output: "not budget usage" },
    })
    expect(harness.metricUpdates).toEqual([child])
    const childBefore = await harness.manager.read(child)
    expect(childBefore?.roleAssignments?.defaults).toEqual({})
    expect(childBefore?.roleAssignments?.overrides).toEqual({})
    await first.options.conversation.append({ kind: "assistant", content: [{ type: "text", text: "completed on first model" }] })
    await harness.manager.updateRoleAssignment(child, "chat", { model: "claude-opus-4.6", effort: "high", providerOptions: { anthropic: { thinking_display: "omitted" } } })
    expect(attempts).toHaveLength(1)
    expect(first.options.model).toBe("claude-sonnet-4.6")
    expect(await first.options.requestSelection?.(await first.options.resolveRoles!())).toMatchObject({
      model: "claude-opus-4.6",
      effort: "high",
      providerOptions: { anthropic: { thinking_display: "omitted" } },
    })
    expect(attempts).toHaveLength(1)
    expect((await first.options.resolveRoles?.())?.get("chat")?.model).toBe("claude-opus-4.6")
    expect(await parentResolver()).toEqual(parentBefore)
    expect(effectiveRoleAssignments((await harness.manager.read(parent))!.roleAssignments!)).toEqual(parentRoles)

    const running = liveChildRuns(harness.reader)
    expect(running).toHaveLength(1)
    for (const control of running) await interruptChildForReplacement({ projectionReader: asAsyncEventReadSurface(harness.store), writer: harness.writer, control, handoffId: "handoff-test" })
    await harness.manager.updateLifecycleState(child, "inactive")
    nextAttempt = Promise.withResolvers<void>()
    const resumed = await tool.processResume(child, { ...context, toolUseId: "resume-tool" })
    expect(resumed).toMatchObject({ outcome: "ok" })
    await nextAttempt.promise
    expect(attempts[1]!.options.model).toBe("claude-opus-4.6")
    attempts[1]!.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } })
    expect(await harness.backgroundTasks.waitProcess(harness.backgroundTasks.processRecords()[0]!.id)).toBe(true)
    await reconcileChildSessionCompletions({ parentSessionId: parent, reader: harness.reader, writer: harness.writer })
    nextAttempt = Promise.withResolvers<void>()
    const retry = await tool.processResume(child, { ...context, toolUseId: "retry-tool" })
    expect(retry.outcome).toBe("ok")
    await nextAttempt.promise
    expect(attempts[2]!.options.model).toBe("claude-opus-4.6")
    expect(attempts[2]!.options.providerOptions).toEqual({ anthropic: { thinking_display: "omitted" } })
    const runs = loadSubagentRunsFromEvents(harness.store.read({ aggregateId: `session:${child}`, types: SUBAGENT_RUN_FACT_TYPES }))
    expect(runs.map((run) => run.model)).toEqual(["claude-sonnet-4-6", "claude-opus-4.6"])
    expect(runs.at(-1)?.effort).toBe("high")
    // A Resume of a failed child opens a new attempt under the original call.
    expect((await createSessionToolSummaryReader(asAsyncEventReadSurface(harness.store), parent, [subagentsModule]).replay()).summaries.get("test-tool-use")?.model).toBe("claude-opus-4.6 high")
    expect(harness.backgroundTasks.activeBackgroundCommands()).toContainEqual(expect.objectContaining({ model: "claude-opus-4.6", effort: "high" }))
    expect(await parentResolver()).toEqual(parentBefore)
  } finally {
    await harness.close()
  }
})

test("general children persist only their inherited request pair", async () => {
  const entered = Promise.withResolvers<AgentOptions>()
  const done = Promise.withResolvers<AgentRunResult>()
  const harness = createHarness((options) => ({
    send() { entered.resolve(options) },
    end() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "input_closed" } }) },
    abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise,
  }))
  try {
    const parent = await harness.manager.createChat({ id: "clone-parent", conversationId: "clone-conversation" })
    const tool = harness.tool(parent, {
      agentRegistry: new Map([["clone", { kind: "general", name: "clone", description: "Clone the request.", maxTurns: 10 }]]),
      parentModel: "gpt-6.1-sol", parentEffort: "high",
    })
    const result = await tool.execute({ persona: "clone", rationale: TEST_RATIONALE, prompt: "Inspect" }, makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: "clone-conversation", availableTools: new Set(["read"]) }))
    if (result.outcome !== "ok") throw new Error(result.content)
    const options = await entered.promise
    if (options.conversation.kind !== "durable-tree") throw new Error("Expected a child conversation")
    expect((await harness.manager.read(options.conversation.sessionId))?.roleAssignments).toEqual({
      defaults: {}, overrides: { chat: { model: "gpt-6.1-sol", effort: "high" } },
    })
  } finally { await harness.close() }
})
