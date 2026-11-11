import { describe, expect, spyOn, test } from "bun:test"
import * as abort from "../../../../../src/infra/abort.js"
import { liveChildRuns, liveChildRun } from "../../../../../src/orchestration/session/live-session-control.js"
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { buildDurableSubagentCreated, buildSubagentPrompted } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { reconcileChildSessionCompletions } from "../../../../../src/orchestration/session/child-session-reconciliation.js"
import { prepareSessionFactAppend } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { buildSessionMetadataAppend } from "../../../../../src/orchestration/session/session-metadata-store.js"
import { makeContext, makeDeps, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { testGrant } from "../../agent-runtime/tools/_fixtures.js"
import { subagentChildHarnesses, completedRunner, createRoot, waitForSettled, childIds, runs, continuationService, continuationParentHost, heldRunner } from "./_subagent-child-fixtures.js"
import { createSubagentToolSummaryReader } from "../../../../../src/orchestration/modules/subagents/history/tool-summary.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { createSubagentSessionAuthority } from "../../../../../src/orchestration/modules/subagents/execution/session-authority.js"
import { fixedAvailability, repoDefinitions } from "../../../../helpers/project-definitions.js"
import { asModelClient } from "../../agent-runtime/_model-client.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js"
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js"
import { createHeadlessUsageAuthorityOwner } from "../../../../../src/orchestration/headless/headless-usage-authority.js"
import { createUsageAuthority } from "../../../../../src/infra/llm/usage-authority.js"
import { createAgentRuntime } from "../../../../../src/orchestration/agent-runtime/factory.js"
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js"
import { fakeModelInfos, tierAvailableModels } from "../../../../helpers/model-tier-fixtures.js"
import { roleCapture } from "../../../../helpers/role-capture.js"
import { newTestRunner } from "../../../../helpers/agent-runner.js"
const createHarness = subagentChildHarnesses()

function localClient(model: string) {
  return asModelClient({
    model, modelFamily: "openai", accessProvider: "openai_api", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
    accessProviderCandidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" },
    credentialLineage: "20000000-0000-4000-8000-000000000002",
    promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools() {
      yield { kind: "text_delta", text: '{"summary":"Inspected three files before the failure."}', blockKey: "summary" }
      yield { kind: "usage", final: true, inputTokens: 10, outputTokens: 7, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 }
      yield { kind: "done", stopReason: "end_turn" }
    },
  })
}

async function pausedGeneral(harness: ReturnType<typeof createHarness>) {
  const root = await createRoot(harness.manager)
  const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, availableTools: new Set(["read"]) })
  const result = await harness.tool(root.sessionId, { agentRegistry: repoDefinitions().personas() }).execute({ persona: "general", prompt: "Inspect the saved assignment.", rationale: TEST_RATIONALE }, context)
  const child: string = JSON.parse(result.content).session_id
  await liveChildRun(harness.reader, child)?.child.interrupt("person")
  return { root, child, context }
}

describe("explicit child Resume", () => {
  test.each(["complete", "host-close", "before-assembly"] as const)("a resumed grandchild waits for its live subagent parent's host, or refuses if that host ends (%s)", async (ending) => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const root = await createRoot(harness.manager)
    const rootHost = continuationParentHost(harness, root.sessionId, root.conversationId, runner.createAgent)
    const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, availableTools: new Set(["read"]) })
    const first = await harness.tool(root.sessionId, { agentRegistry: repoDefinitions().personas(), inheritableRuntimeSurfaces: rootHost.surfaces }).execute(
      { persona: "general", prompt: "Inspect the assignment.", rationale: TEST_RATIONALE }, context,
    )
    const parent: string = JSON.parse(first.content).session_id
    const parentOwner = runner.options[0]!.runtimeSurfaces!.background!
    const parentConversation = runs(harness.store, parent).at(-1)!.conversationId
    if (!parentConversation) throw new Error("The parent has no conversation")
    const parentHost = continuationParentHost(harness, parent, parentConversation, runner.createAgent, parentOwner)
    const second = await harness.tool(parent, { agentRegistry: repoDefinitions().personas(), backgroundTasks: parentOwner.tasks }).execute(
      { persona: "general", prompt: "Inspect the nested assignment.", rationale: TEST_RATIONALE }, { ...context, conversationId: parentConversation },
    )
    const child: string = JSON.parse(second.content).session_id
    await liveChildRun(harness.reader, child)!.child.interrupt("person")
    const noticesBefore = (await harness.reader.readInFlight(parent, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).length
    const host = continuationService(harness, runner.createAgent)
    try {
      const lookedUp = Promise.withResolvers<void>()
      const parentRun = liveChildRun(harness.reader, parent)!.child
      const modules = parentRun.modules.bind(parentRun)
      parentRun.modules = () => { lookedUp.resolve(); return modules() }
      const resuming = host.service.resume(child)
      await lookedUp.promise
      if (ending === "before-assembly") {
        await parentRun.interrupt("person")
        expect(await resuming).toMatchObject({ outcome: "error", content: expect.stringContaining(`Resume parent '${parent}' first`) })
        expect(runner.options).toHaveLength(2)
        return
      }
      await runner.options[0]!.lifecycle.onRuntimeAssembled?.({ modules: parentHost.modules })
      expect((await resuming).outcome).toBe("ok")
      expect(runner.options.at(-1)?.runtimeSurfaces?.foregroundBashHold).toBe(parentHost.foregroundBashHold)
      expect(runner.options.at(-1)?.runtimeSurfaces?.sessions).toBe(parentHost.surfaces.sessions)
      const run = runs(harness.store, child).at(-1)!
      expect(parentOwner.tasks.activeBackgroundCommands()).toMatchObject([{ id: run.childRunId, roleSessionId: child }])
      const control = liveChildRun(harness.reader, child)!
      if (ending === "host-close") await liveChildRun(harness.reader, parent)!.child.interrupt("person")
      else {
        runner.options.at(-1)!.runtimeSurfaces!.handoff!.onContent({ summary: "finished" })
        runner.results.at(-1)!.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
      }
      await control.settled
      await harness.authority.settleReconciliation()
      expect(harness.store.read({ aggregateId: `session:${child}`, types: [ending === "complete" ? "subagent.completed" : "subagent.paused"] })).toHaveLength(ending === "complete" ? 1 : 2)
      expect(parentOwner.tasks.activeBackgroundCommands()).toEqual([])
      expect(runs(harness.store, child).at(-1)?.status).toBe(ending === "complete" ? "completed" : "paused")
      expect(await harness.reader.readInFlight(parent, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(noticesBefore + (ending === "complete" ? 1 : 0))
    } finally { await host.close(); await rootHost.owner.close(); await harness.close() }
  })
  test("refuses a paused subagent parent and asks to resume the parent first", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const { child: parent, context } = await pausedGeneral(harness)
    const launch = await harness.tool(parent, { agentRegistry: repoDefinitions().personas() }).execute(
      { persona: "general", prompt: "Inspect the nested assignment.", rationale: TEST_RATIONALE }, context,
    )
    const child: string = JSON.parse(launch.content).session_id
    await liveChildRun(harness.reader, child)?.child.interrupt("person")
    const host = continuationService(harness, runner.createAgent)
    try {
      const result = await host.service.resume(child)
      expect(result.outcome).toBe("error")
      expect(result.content).toContain(`Resume parent '${parent}' first`)
      expect(runner.options).toHaveLength(2)
    } finally { await host.close(); await harness.close() }
  })
  test.each(["same_run", "new_attempt"] as const)("withdraws %s preparation before publication when the parent host closes", async (attempt) => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const root = await createRoot(harness.manager)
    const launch = await harness.tool(root.sessionId, { agentRegistry: repoDefinitions().personas() }).execute(
      { persona: "general", prompt: "Inspect the saved assignment.", rationale: TEST_RATIONALE },
      makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, availableTools: new Set(["read"]) }),
    )
    const child: string = JSON.parse(launch.content).session_id
    const control = liveChildRun(harness.reader, child)!
    if (attempt === "same_run") await control.child.interrupt("person")
    else {
      runner.results[0]!.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "budget_exhausted" } })
      await control.settled
      await harness.authority.settleReconciliation()
    }
    const before = await harness.reader.aggregateSeq(`session:${child}`)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const parentHost = continuationParentHost(harness, root.sessionId, root.conversationId, runner.createAgent)
    const host = continuationService(harness, runner.createAgent, {
      captureProviderConnection: async () => { entered.resolve(); await release.promise; return roleCapture(["gpt-6.1-sol"]) },
    }, async () => parentHost.runner)
    try {
      const resumed = host.service.resume(child)
      await entered.promise
      await parentHost.owner.close()
      release.resolve()
      expect((await resumed).outcome).toBe("error")
      expect(await harness.reader.aggregateSeq(`session:${child}`)).toBe(before)
      expect(runner.options).toHaveLength(1)
    } finally {
      release.resolve()
      await host.close()
      await harness.close()
    }
  })

  test.each([
    ["complete", "host-first"], ["stop", "host-first"], ["complete", "resume-first"],
  ] as const)("the parent's host tracks the resumed child as its own background work, with no second completion (%s, %s)", async (ending, order) => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const { child, context, root } = await pausedGeneral(harness)
    await harness.manager.updateRoleAssignment(child, "chat", { model: "gpt-5", effort: "high" })
    const requested: string[] = []
    const parentHost = continuationParentHost(harness, root.sessionId, root.conversationId, runner.createAgent)
    const { owner } = parentHost
    const tasks = owner.tasks
    let attached = 0
    const reattached = continuationService(harness, runner.createAgent, {
      createLLMClient: async (model) => { requested.push(model); return localClient(model) },
    }, async () => { attached += 1; return parentHost.runner })
    if (order === "host-first") {
      harness.sessionStore.openSessionRuntime({ sessionId: root.sessionId, conversationId: root.conversationId })
      harness.sessionStore.attachChatRunner(root.sessionId, { ...parentHost.runner, moduleRuntimes: parentHost.modules })
    }
    try {
      expect((await reattached.service.resume(child)).outcome).toBe("ok")
      expect(attached).toBe(order === "host-first" ? 0 : 1)
      expect(requested).toEqual([])
      expect(runner.options.at(-1)?.model).toBe("gpt-5")
      expect(await runner.options.at(-1)?.resolveRoles?.()).toMatchObject(new Map([["chat", expect.objectContaining({ model: "gpt-5" })]]))
      expect(runner.options.at(-1)?.runtimeSurfaces?.foregroundBashHold).toBe(parentHost.foregroundBashHold)
      expect(runner.options.at(-1)?.runtimeSurfaces?.sessions).toBeDefined()
      const childRunId = runs(harness.store, child).at(-1)!.childRunId
      expect(tasks.activeBackgroundCommands()).toMatchObject([{ id: childRunId, roleSessionId: child }])
      expect(tasks.awaitedTaskCount()).toBe(1)
      const waiting = tasks.waitProcess(childRunId)
      if (ending === "stop") {
        expect((await createProcessTool(tasks).execute({ action: "stop", process_id: childRunId }, { ...context, userDataRoot: `${harness.projectRoot}/.test-account`, retrievalSessionId: root.sessionId })).outcome).toBe("ok")
      } else {
        runner.options.at(-1)?.runtimeSurfaces?.handoff?.onContent({ summary: "finished" })
        runner.results.at(-1)?.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
      }
      expect(await waiting).toBe(true)
      expect(runs(harness.store, child).at(-1)?.status).toBe(ending === "stop" ? "cancelled" : "completed")
      expect(tasks.activeBackgroundCommands()).toEqual([])
      await harness.authority.settleReconciliation()
      expect(await harness.reader.readInFlight(root.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    } finally { await reattached.close(); await owner.close(); await harness.close() }
  })

  test.each(["discovery", "saved-read"] as const)("validates saved executables rather than all enabled modules (%s)", async (disabled) => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const { child } = await pausedGeneral(harness)
    const original = runs(harness.store, child).at(-1)!
    const host = continuationService(harness, runner.createAgent, { moduleSelection: () => composeFirstPartyModules(undefined, [disabled === "discovery" ? "discovery" : "file-tools"]) })
    try {
      const result = await host.service.resume(child)
      expect(result.outcome).toBe(disabled === "discovery" ? "ok" : "error")
      if (disabled === "saved-read") {
        expect(result.content).toContain("Saved subagent tool 'read' is unavailable")
        expect(runs(harness.store, child)).toEqual([original])
      } else {
        expect(runner.options.at(-1)?.toolGrant).toEqual(original.promptToolNames)
        await liveChildRun(harness.reader, child)?.child.interrupt("person")
      }
    } finally { await host.close(); await harness.close() }
  })

  const changedKind = new Map([["general", { kind: "persona", name: "general", description: "Changed persona", role: "explorer", tools: ["read"], systemPrompt: "Inspect", maxTurns: 10 } as const]])
  const personas = repoDefinitions().personas()
  test.each([
    ["a changed persona kind", { agentRegistry: changedKind }, "persona kind general is now persona"],
    // A continuation keeps the modules its dispatch was admitted with, but an agent type turned off since then keeps
    // it from resuming.
    ["an agent type turned off after the dispatch", { agentRegistry: personas, definitionAvailability: fixedAvailability({ personas }, undefined, ["general"]) }, "Subagent 'general' cannot run: agent type general is turned off. Remove it from subagents.disabled_types in flywheel.toml to turn it on."],
    ["a module turned off after the dispatch", { agentRegistry: personas, definitionAvailability: fixedAvailability({ personas }, composeFirstPartyModules(undefined, ["subagents"]).enabledModuleIds) }, undefined],
  ] as const)("judges a resume after %s, publishing nothing when it refuses", async (_, deps, refusal) => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const { child, root, context } = await pausedGeneral(harness)
    const original = runs(harness.store, child)
    try {
      const result = await harness.tool(root.sessionId, deps).processResume(child, { ...context, toolUseId: "resume-judged" })
      expect([result.outcome, liveChildRun(harness.reader, child) !== undefined]).toEqual(refusal === undefined ? ["ok", true] : ["error", false])
      if (refusal === undefined) return await liveChildRun(harness.reader, child)?.child.interrupt("person")
      expect(result.content).toContain(refusal)
      expect(runs(harness.store, child)).toEqual(original)
    } finally { await harness.close() }
  })

  test("settles a resumed failure summary in the child's audit, budget, and actual profile ledger", async () => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const { child, root } = await pausedGeneral(harness)
    await harness.manager.updateRoleAssignment(child, "chat", { model: "gpt-5", effort: "high" })
    const profileDirectory = `${harness.projectRoot}/child-profile`
    const accounting = createHeadlessUsageAuthorityOwner({ id: "default", directory: profileDirectory })
    const initialLease = await accounting.acquire({ profileId: "default", profileDir: profileDirectory })
    await initialLease.release()
    const base = makeDeps()
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      getAuth: () => ({ providers: new Map(), credentialLineages: {}, droppedCredentials: [] }),
      definitions: repoDefinitions(), moduleSelection: base.moduleSelection, authDirectory: () => profileDirectory,
      profileId: "default", userDataRoot: base.userDataRoot, captureRuntimeConfig: base.captureRuntimeConfig,
      usageAuthority: accounting.generation(), acquireUsageSettlementAuthority: accounting.acquire,
    })
    const requested: string[] = []
    const createLLMClient = async (model: string) => { requested.push(model); return localClient(model) }
    // The summary is a side call through the real runtime; the resumed child is held.
    const host = continuationService(harness, (options) => options.purpose.kind === "subagent-failure-summary"
      ? newTestRunner({ ...options, agentsMd: "", resolveEnvSnapshot: undefined }, createLLMClient, undefined, options.captureProviderConnection)
      : runner.createAgent(options), {
      usageProfile: runtime.usageProfile, modelInfos: fakeModelInfos, availableModels: tierAvailableModels, createLLMClient,
    })
    try {
      expect((await host.service.resume(child)).outcome).toBe("ok")
      const control = liveChildRun(harness.reader, child)!
      const options = runner.options.at(-1)!
      for (let index = 0; index < 3; index += 1) {
        const id = `read-${index}`
        options.onEvent(createRuntimeEvent("tool.input.completed", {
          model_request_id: "resumed-failed-request",
          tool_use: { id, name: "read", provider_call_id: id, provider_tool_name: "read", executable_tool_name: "read", input: { path: `file-${index}.ts` }, execution: { mode: "foreground", trace_kind: "tool" } },
        }))
        options.onEvent(createRuntimeEvent("tool.result.recorded", { tool_use_id: id, content: [{ type: "text", text: "read" }], is_error: false }))
      }
      runner.results.at(-1)!.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "context_overflow" } })
      await control.settled
      await host.close()
      const childRun = runs(harness.store, child).at(-1)!
      expect(new Set(requested)).toEqual(new Set([expect.stringMatching(/^gpt-/)]))
      const requests = harness.store.read({ aggregateId: `session:${child}`, types: ["model.requested"] })
      expect(requests).toHaveLength(1)
      // A side call, not a turn of the child's conversation: it keeps the child's provider session and caches for five
      // minutes, as every agent below a root conversation does.
      expect(requests[0]?.payload).toMatchObject({ identity: { providerSessionKey: childRun.conversationId }, cacheRetention: "5m" })
      const measured = harness.store.read({ aggregateId: `session:${child}`, types: ["model.usage.measured"] })
      expect(measured).toHaveLength(1)
      expect(measured[0]?.payload).toMatchObject({ profileId: "default", budgetStreamId: child, tokens: { input: 10, output: 7 } })
      expect(childRun.result).toContain("Inspected three files before the failure.")
      expect(harness.store.read({ aggregateId: `session:${root.sessionId}`, types: ["model.usage.measured", "model.requested"] })).toEqual([])
      await accounting.settled()
      const ledger = createUsageAuthority({ profileDir: profileDirectory, profileId: "default" })
      try {
        expect(ledger.rangeEntries({ startMs: 0, endMs: Date.now() + 1 }).groups.reduce((count, group) => count + group.attempts, 0)).toBe(1)
      } finally { ledger.dispose() }
    } finally { await host.close(); await accounting.settled(); await harness.close() }
  })

  test.each([false, true])("resumes through ordinary provider guidance when access is empty or pending: %s", async (pending) => {
    const runner = heldRunner()
    const harness = createHarness(runner.createAgent)
    const { child, root } = await pausedGeneral(harness)
    const capture = async () => roleCapture([], {}, pending)
    let clients = 0
    const host = continuationService(harness, (options) => newTestRunner({
      ...options, agentsMd: "", memorySnapshot: null, resolveEnvSnapshot: undefined,
    }, async () => { clients += 1; throw new Error("No provider request is admitted") }, undefined, capture), {
      captureProviderConnection: capture,
    })
    // Access that stays pending takes the counted recovery attempts; their
    // pauses end at once here.
    const realSleep = abort.abortableSleep
    const sleep = spyOn(abort, "abortableSleep").mockImplementation((ms, signal) => ms < 5_000 ? realSleep(ms, signal) : Promise.resolve())
    try {
      expect((await host.service.resume(child)).outcome).toBe("ok")
      await waitForSettled(harness, root.sessionId)
      const run = runs(harness.store, child).at(-1)!
      expect(run.continuationCount).toBe(1)
      expect(run.status).toBe("failed")
      expect(run.result).toContain(pending ? "still checking" : "No model provider")
      expect(clients).toBe(0)
    } finally { sleep.mockRestore(); await host.close(); await harness.close() }
  })
  test.each(["partial", "failed", "stopped", "cancelled"] as const)("resumes settled %s in the same child under the original call without changing its result", async (status) => {
    const calls: AgentOptions[] = []
    const results: Array<PromiseWithResolvers<AgentRunResult>> = []
    const harness = createHarness((options) => {
      calls.push(options)
      const done = Promise.withResolvers<AgentRunResult>()
      results.push(done)
      return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 7, terminal: { kind: "aborted" } }) }, done: done.promise }
    })
    try {
      const root = await createRoot(harness.manager)
      const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, toolUseId: "original-tool" })
      const tool = harness.tool(root.sessionId)
      await tool.execute({ persona: "delegator", description: "resume-child", rationale: TEST_RATIONALE, prompt: "continue this assignment" }, context)
      const child = (await childIds(harness.manager, root.sessionId))[0]!
      const conversation = calls[0]!.conversation
      if (conversation.kind !== "durable-tree") throw new Error("expected durable child history")
      await conversation.append({ kind: "assistant", content: [{ type: "tool_use", id: "recorded-read", name: "read", input: { path: "saved.txt" } }] })
      await conversation.append({ kind: "toolResult", toolUseId: "recorded-read", content: [{ type: "text", text: "saved result" }] })
      await conversation.append({ kind: "assistant", content: "earlier assistant work" })
      await conversation.flush?.()
      if (status === "stopped") liveChildRuns(harness.reader)[0]!.child.stop("person")
      else if (status === "cancelled") harness.backgroundTasks.terminateProcess(liveChildRuns(harness.reader)[0]!.child.runId, "agent")
      else if (status === "partial") {
        calls[0]!.runtimeSurfaces?.handoff?.onContent({ summary: "earlier work" })
        results[0]!.resolve({ servedRequests: 0, durationMs: 7, terminal: { kind: "budget_exhausted" } })
      } else results[0]!.resolve({ servedRequests: 0, durationMs: 7, terminal: { kind: "api_error", message: "provider failed", recovery: { kind: "none" } } })
      await waitForSettled(harness, root.sessionId)
      const original = runs(harness.store, child)[0]!
      expect(original.status).toBe(status)
      const parentResults = harness.store.read({ aggregateId: `session:${root.sessionId}`, types: ["tool.result.recorded"] })
      const initialNotices = await harness.reader.readInFlight(root.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
      expect(parentResults).toHaveLength(1)
      // Each `process` call of the parent records its own result. The original
      // call keeps the one result that its first run delivered.
      const originalCallResults = () => harness.store.read({ aggregateId: `session:${root.sessionId}`, types: ["tool.result.recorded"] })
        .filter((fact) => typeof fact.payload === "object" && fact.payload !== null && "toolUseId" in fact.payload && fact.payload.toolUseId === "original-tool")
      expect(initialNotices).toHaveLength(1)

      harness.rejectNextActivation()
      expect((await tool.processResume(child, { ...context, toolUseId: "refused-resume" })).outcome).toBe("error")
      expect(runs(harness.store, child)).toEqual([original])
      if (status === "failed") {
        const prepare = harness.authority.prepareResume
        harness.authority.prepareResume = async (input) => {
          const prepared = await prepare(input)
          harness.authority.prepareResume = prepare
          await harness.writer.append(prepareSessionFactAppend(child, {
            type: "session.duration.recorded", version: 1, actor: "flywheel", payload: { accumulatedActiveMs: 0 },
          }))
          return prepared
        }
        expect((await tool.processResume(child, { ...context, toolUseId: "stale-resume" })).outcome).toBe("error")
        expect(runs(harness.store, child)).toEqual([original])
      }
      const resumes = await Promise.all([
        tool.processResume(child, { ...context, conversationId: "a-later-step-conversation", toolUseId: "resume-tool" }),
        tool.processResume(child, { ...context, conversationId: "a-later-step-conversation", toolUseId: "concurrent-resume" }),
      ])
      expect(resumes.map((resume) => resume.outcome).sort()).toEqual(["error", "ok"])
      expect((await tool.processResume(child, { ...context, toolUseId: "duplicate-resume" })).outcome).toBe("error")
      const attempts = runs(harness.store, child)
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toEqual(original)
      expect(attempts[1]).toMatchObject({
        parentSessionId: root.sessionId, parentConversationId: root.conversationId,
        parentToolCallId: "original-tool", conversationId: original.conversationId, prompt: original.prompt,
        task: original.task, promptToolNames: original.promptToolNames, capabilityGrant: original.capabilityGrant,
        admittedModuleIds: original.admittedModuleIds, skillsRevision: original.skillsRevision,
        maxTurns: original.maxTurns, maxTokens: original.maxTokens,
      })
      expect(attempts[1]!.childRunId).not.toBe(original.childRunId)
      const accepted = resumes.find((resume) => resume.outcome === "ok")
      expect(JSON.parse(accepted!.content)).toMatchObject({ status: "resumed", session_id: child, id: attempts[1]!.childRunId })
      expect(liveChildRuns(harness.reader)[0]!.child).toMatchObject({ runId: attempts[1]!.childRunId, parentToolCallId: "original-tool" })
      const continued = calls[1]!.conversation
      if (continued.kind !== "durable-tree") throw new Error("expected continued durable history")
      expect(continued.priorMessages).toContainEqual({ kind: "toolResult", toolUseId: "recorded-read", content: [{ type: "text", text: "saved result" }] })
      expect(continued.priorMessages).toContainEqual({ kind: "assistant", content: "earlier assistant work" })
      expect(continued.priorMessages.at(-1)).toMatchObject({ kind: "user", origin: "system" })
      expect(JSON.stringify(continued.priorMessages)).not.toContain("process exited unexpectedly")
      if (status === "stopped") {
        liveChildRuns(harness.reader)[0]!.child.stop("person")
        await waitForSettled(harness, root.sessionId)
        expect(runs(harness.store, child).at(-1)?.status).toBe("stopped")
        expect(originalCallResults()).toEqual(parentResults)
        const { toolUseId: _toolUseId, ...personContext } = context
        expect((await tool.resume(child, personContext)).outcome).toBe("ok")
      }
      calls.at(-1)!.runtimeSurfaces?.handoff?.onContent({ summary: "finished remaining work" })
      results.at(-1)!.resolve({ servedRequests: 0, durationMs: 11, terminal: { kind: "completed" } })
      await waitForSettled(harness, root.sessionId)
      await reconcileChildSessionCompletions({ parentSessionId: root.sessionId, reader: harness.reader, writer: harness.writer })
      expect(originalCallResults()).toEqual(parentResults)
      const attemptCount = status === "stopped" ? 3 : 2
      expect(await harness.reader.readInFlight(root.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(attemptCount)
      expect((await tool.processResume(child, { ...context, toolUseId: "completed-resume" })).outcome).toBe("error")
      expect(runs(harness.store, child)).toHaveLength(attemptCount)
      const summaries = await createSubagentToolSummaryReader(harness.reader, root.sessionId).replay()
      expect(summaries.summaries.get("original-tool")?.duration).toBe(status === "stopped" ? 25 : 18)
    } finally {
      await harness.close()
    }
  })

  test.each(["created", "interrupted", "attach_failure", "metrics_failure"] as const)("guards explicit inactive %s resume activation and opening", async (status) => {
    const harness = createHarness(completedRunner([]))
    const root = await createRoot(harness.manager)
    const childSessionId = "crash-paused-child"
    const childConversationId = "crash-paused-conversation"
    const childRunId = "crash-paused-run"
    const runBinding = buildDurableSubagentCreated({
      childSessionId,
      childRunId,
      conversationId: childConversationId,
      parentSessionId: root.sessionId,
      parentConversationId: root.conversationId,
      parentToolCallId: "crash-tool",
      persona: { name: "delegator", kind: "persona" },
      capabilityGrant: testGrant("subagent", []),
      admittedModuleIds: [],
      skillsRevision: 1,
      model: "test/model",
      tools: ["read"],
      executionCwd: harness.projectRoot,
      budget: { maxTurns: 10, maxTokens: 0 },
      parentDepth: 0,
      description: "crash paused child",
    })
    const promptFact = prepareSessionFactAppend(childSessionId, buildSubagentPrompted({
      childRunId,
      prompt: "inspect",
      task: "inspect",
      toolNames: ["read"],
    }))
    await harness.manager.publishSubagent({
      id: childSessionId,
      conversationId: childConversationId,
      description: "crash paused child",
      executionCwd: harness.projectRoot,
      launchedFrom: { parentSessionId: root.sessionId, conversationId: root.conversationId, toolUseId: "crash-tool" },
      initialRoles: { chat: { model: "claude-opus-4.6", effort: "high" } },
      runBinding: prepareSessionFactAppend(childSessionId, runBinding),
      assignment: "inspect",
      promptFact,
    })
    const now = new Date().toISOString()
    await harness.writer.appendBatch([
      ...(status === "attach_failure" || status === "metrics_failure" ? [prepareSessionFactAppend(childSessionId, {
        type: "subagent.paused",
        version: 1,
        actor: "flywheel",
        payload: { childRunId, pausedBy: "person" },
      })] : []),
      ...(status === "interrupted" ? [prepareSessionFactAppend(childSessionId, {
        type: "subagent.interrupted",
        version: 1,
        actor: "flywheel",
        payload: { childRunId, reason: "runtime_restarted", recoveryId: "crash-recovery" },
      })] : []),
      buildSessionMetadataAppend(childSessionId, {
        type: "session.lifecycle.changed",
        version: 1,
        actor: "flywheel",
        payload: { lifecycleState: "inactive", lastUpdated: now },
      }),
    ])

    const prepared = await harness.authority.prepareResume({
      childSessionId,
      parentSessionId: root.sessionId,
      parentConversationId: root.conversationId,
    })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.error)
    const publication: Parameters<typeof harness.authority.publishResume>[0] = {
      expectedSeq: prepared.attempt.expectedSeq,
      childSessionId,
      childConversationId,
      parentSessionId: root.sessionId,
      parentConversationId: root.conversationId,
      parentToolUseId: "crash-tool",
      description: "crash paused child",
      executionCwd: harness.projectRoot,
      authProfileId: "default",
      initialRoles: { chat: { model: "claude-sonnet-4.6", effort: "medium" } },
      promptFact,
    }
    if (status === "attach_failure" || status === "metrics_failure") {
      let disposed = 0
      const authority = createSubagentSessionAuthority({
        manager: harness.manager, eventStore: harness.reader, projectionReader: {
          ...harness.reader,
          readPage: async (...args) => {
            if (status === "metrics_failure" && args[0].types?.includes("budget.process.started")) throw new Error("metrics failed")
            return harness.reader.readPage(...args)
          },
        },
        eventWriter: harness.writer, projectRoot: harness.projectRoot, recall: async () => ({ hits: [] }),
        attachProjection: async () => {
          if (status === "attach_failure") throw new Error("attachment failed")
          return { onEvent() {}, queueUserMessage() {}, setStreaming() {}, lifecycle: {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {}, async dispose() { disposed += 1 } }
        },
      })
      await expect(authority.publishResume(publication)).rejects.toThrow(status === "attach_failure" ? "attachment failed" : "metrics failed")
      expect(disposed).toBe(status === "metrics_failure" ? 1 : 0)
      expect(await harness.manager.read(childSessionId)).toMatchObject({ lifecycleState: "inactive" })
      expect(runs(harness.store, childSessionId).at(-1)).toMatchObject({ status: "failed" })
      const next = await authority.prepareResume({ childSessionId, parentSessionId: root.sessionId, parentConversationId: root.conversationId })
      expect(next).toMatchObject({ ok: true, attempt: { kind: "new_attempt" } })
      if (!next.ok) throw new Error(next.error)
      const retry = {
        ...publication,
        runBinding: { ...prepareSessionFactAppend(childSessionId, { ...runBinding, payload: { ...runBinding.payload, childRunId: "opening-retry" } }), expectedSeq: next.attempt.expectedSeq },
        promptFact: { ...prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId: "opening-retry", prompt: "inspect", task: "inspect", toolNames: ["read"] })), expectedSeq: next.attempt.expectedSeq + 1 },
      }
      await expect(authority.publishNewAttempt(retry)).rejects.toThrow(status === "attach_failure" ? "attachment failed" : "metrics failed")
      expect(await harness.manager.read(childSessionId)).toMatchObject({ lifecycleState: "inactive" })
      expect(runs(harness.store, childSessionId).map((run) => run.status)).toEqual(["failed", "failed"])
      expect(await authority.prepareResume({ childSessionId, parentSessionId: root.sessionId, parentConversationId: root.conversationId })).toMatchObject({ ok: true })
      const dispatchId = "failed-opening-dispatch"
      await expect(authority.publish({
        ...publication,
        childSessionId: dispatchId,
        childConversationId: "failed-opening-conversation",
        assignment: "inspect",
        runBinding: prepareSessionFactAppend(dispatchId, { ...runBinding, payload: { ...runBinding.payload, childSessionId: dispatchId, conversationId: "failed-opening-conversation", childRunId: "opening-dispatch" } }),
        promptFact: prepareSessionFactAppend(dispatchId, buildSubagentPrompted({ childRunId: "opening-dispatch", prompt: "inspect", task: "inspect", toolNames: ["read"] })),
      })).rejects.toThrow(status === "attach_failure" ? "attachment failed" : "metrics failed")
      expect(await harness.manager.read(dispatchId)).toMatchObject({ lifecycleState: "inactive" })
      expect(runs(harness.store, dispatchId).at(-1)).toMatchObject({ status: "failed" })

      let fresh: Awaited<ReturnType<typeof harness.authority.publishNewAttempt>> | undefined
      const superseded = createSubagentSessionAuthority({
        manager: harness.manager, eventStore: harness.reader, projectionReader: harness.reader,
        eventWriter: harness.writer, projectRoot: harness.projectRoot, recall: async () => ({ hits: [] }),
        attachProjection: async () => {
          await harness.writer.append(prepareSessionFactAppend(childSessionId, { type: "subagent.paused", version: 1, actor: "flywheel", payload: { childRunId: "opening-stale", pausedBy: "person" } }))
          await harness.manager.updateLifecycleState(childSessionId, "inactive")
          const freshPrepared = await harness.authority.prepareResume({ childSessionId, parentSessionId: root.sessionId, parentConversationId: root.conversationId })
          if (!freshPrepared.ok) throw new Error(freshPrepared.error)
          fresh = await harness.authority.publishResume({ ...publication, expectedSeq: freshPrepared.attempt.expectedSeq })
          throw new Error("old opening failed")
        },
      })
      const beforeStale = await harness.authority.prepareResume({ childSessionId, parentSessionId: root.sessionId, parentConversationId: root.conversationId })
      if (!beforeStale.ok) throw new Error(beforeStale.error)
      await expect(superseded.publishNewAttempt({
        ...retry,
        runBinding: { ...retry.runBinding, payload: { ...retry.runBinding.payload, childRunId: "opening-stale" }, expectedSeq: beforeStale.attempt.expectedSeq },
        promptFact: { ...prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId: "opening-stale", prompt: "inspect", task: "inspect", toolNames: ["read"] })), expectedSeq: beforeStale.attempt.expectedSeq + 1 },
      })).rejects.toThrow("old opening failed")
      expect(await harness.manager.read(childSessionId)).toMatchObject({ lifecycleState: "active" })
      expect(runs(harness.store, childSessionId).at(-1)).toMatchObject({ status: "created", childRunId: "opening-stale" })
      await fresh?.settle()
      await harness.close()
      return
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const openingAuthority = createSubagentSessionAuthority({
      manager: harness.manager, eventStore: harness.reader, projectionReader: harness.reader,
      eventWriter: harness.writer, projectRoot: harness.projectRoot, recall: async () => ({ hits: [] }),
      attachProjection: async () => {
        entered.resolve()
        await release.promise
        return { onEvent() {}, queueUserMessage() {}, setStreaming() {}, lifecycle: {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {}, async dispose() {} }
      },
    })
    const opening = openingAuthority.publishResume(publication)
    await entered.promise
    try {
      expect(await openingAuthority.prepareResume({
        childSessionId, parentSessionId: root.sessionId, parentConversationId: root.conversationId,
      })).toMatchObject({ ok: false, error: "Subagent is already starting or running" })
    } finally {
      release.resolve()
    }
    const resumed = await opening
    await expect(harness.authority.publishResume(publication)).rejects.toThrow()

    expect(harness.batches.findLast((batch) => batch.some((event) => event.type === "subagent.resumed"))?.map((event) => event.type)).toEqual([
      "subagent.resumed",
      "session.lifecycle.changed",
    ])
    expect(await harness.manager.read(childSessionId)).toMatchObject({ lifecycleState: "active" })
    expect((await resumed.resolveRoles()).get("chat")).toMatchObject({ model: "claude-opus-4.6", effort: "high" })
    expect(runs(harness.store, childSessionId).at(-1)).toMatchObject({ status: "created", continuationCount: 1 })
    await harness.close()
  })

})
