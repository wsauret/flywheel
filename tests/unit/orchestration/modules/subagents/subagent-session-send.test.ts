import { afterEach, describe, expect, test } from "bun:test"
import { roleCapture } from "../../../../helpers/role-capture.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { composeModuleProtocolRuntimes } from "../../../../../src/orchestration/app-service/module-protocol-host.js"
import { createRuntimeUiBus } from "../../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { subagentsModule } from "../../../../../src/orchestration/modules/subagents.js"
import { buildSubagentCompleted, buildSubagentPaused } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { readUnreadMessages } from "../../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { publishTestSubagent, publishTestWorkflow, startTestWorkflowMember } from "../../session/_session-manager-fixtures.js"
import { replaceWorkflowState } from "../../session/_child-session-reconciliation-fixtures.js"
import { subagentChildHarnesses, continuationParentHost } from "./_subagent-child-fixtures.js"
import { makeContext, makeDeps, makeCapabilityAccess, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { createSubagentContinuationService } from "../../../../../src/orchestration/modules/subagents/execution/continuation-service.js"
import { createSessionAuthAdmission } from "../../../../../src/orchestration/session/session-auth-profile.js"
import { childSessionProjectionAttachment } from "../../../../../src/orchestration/session-store/child-session-projection.js"
import { liveChildRun, registerLiveSessionControl, registerLiveWorkflowControl } from "../../../../../src/orchestration/session/live-session-control.js"
import { Schema } from "effect"
import { runtimeDispatchResultSchema } from "../../../../../src/protocol/runtime-dispatch-result-schemas.js"
import { readSubagentRuns } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import type { WorkflowDeps } from "../../../../../src/orchestration/workflow-host/deps.js"
import type { Agent, AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { interruptLiveChild } from "../../../../helpers/live-child-run"
import { asModelClient } from "../../agent-runtime/_model-client.js"
import { createConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer.js"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js"
import { planEveryCapability } from "../../../../helpers/attempt-brief.js"

const contexts: SupervisorTestContext[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await disposeSupervisorTestContext(ctx)
})

/** The registered protocol routes continuation to the module's execution owner. */
async function project(resume: (childSessionId: string) => Promise<{ readonly outcome: "ok" } | { readonly outcome: "error"; readonly content: string }>) {
  const ctx = createSupervisorTestContext()
  contexts.push(ctx)
  const writer = asAsyncEventWriter(ctx.store)
  const parentConversationId = "parent-conversation"
  const parent = await ctx.manager.createChat({ name: "Parent", conversationId: parentConversationId })
  const child = await publishTestSubagent(ctx.manager, ctx.baseDir, "child", parent)
  const resumed: string[] = []
  const bus = createRuntimeUiBus()
  const protocol = composeModuleProtocolRuntimes([subagentsModule], {
    eventStore: asAsyncEventReadSurface(ctx.store),
    projectionReader: asAsyncEventReadSurface(ctx.store),
    eventWriter: writer,
    manager: ctx.manager,
    sessionStore: ctx.sessionStore,
    interruptSession: interruptLiveChild({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), writer, manager: ctx.manager, lanes: ctx.continuationLanes }),
    definitions: repoDefinitions(),
    onStored: () => () => {},
    publish: bus.publish,
    snapshotPosition: bus.snapshotPosition,
    hasLiveSession: () => false,
    openChatRunner: async () => { throw new Error("Resume must not open the parent") },
    background: async () => { throw new Error("a message reads no background history") },
    modules: composeModuleServices([["subagents", {
      resume: async (childSessionId: string) => {
        resumed.push(childSessionId)
        return resume(childSessionId)
      },
    }]]),
  }, () => [subagentsModule.id])
  const record = async (fact: Parameters<ReturnType<typeof createSessionFactWriter>["record"]>[0]) => {
    const facts = createSessionFactWriter({ sessionId: child, writer })
    await facts.record(fact)
    facts.dispose()
  }
  const unread = async () => (await readUnreadMessages(asAsyncEventReadSurface(ctx.store), child)).map((cell) => cell.text)
  return { protocol, child, resumed, record, unread, reader: asAsyncEventReadSurface(ctx.store), parent, parentConversationId }
}

describe("a person's message to a subagent", () => {
  test("a handoff refusal crosses the wire as a kept-draft warning and holds no input", async () => {
    const here = await project(async () => ({ outcome: "ok" }))
    const release = registerLiveSessionControl(here.reader, {
      sessionId: here.child, state: async () => "handing_off",
      child: {
        runId: `${here.child}-run`, parentSessionId: here.parent, parentConversationId: here.parentConversationId, parentToolCallId: "dispatch",
        modules: async () => undefined, backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }),
        stop: () => {}, interrupt: async () => true, progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }),
      },
      deliver: async (_input, decide) => decide("handing_off"), notify: async () => false,
    })
    try {
      const result = await here.protocol.send("subagent", here.child, { text: "late guidance", submissionIds: ["late"] })
      const codec = runtimeDispatchResultSchema("session.send")
      expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual({
        ok: false, kind: "handing_off", error: "This agent has started its handoff and cannot read another message. Your draft was kept.",
      })
      expect(await here.unread()).toEqual([])
      expect(here.resumed).toEqual([])
    } finally { release() }
  })
  test("holds the message for an interrupted child and starts only the child", async () => {
    const here = await project(async () => ({ outcome: "ok" }))
    await here.record(buildSubagentPaused({ childRunId: `${here.child}-run`, pausedBy: "person" }))

    expect(await here.protocol.send("subagent", here.child, "Look at the parser first.")).toEqual({ ok: true })
    expect(here.resumed).toEqual([here.child])
    expect(await here.unread()).toEqual(["Look at the parser first."])
  })

  test("keeps the message when the child cannot start again, and says so", async () => {
    const here = await project(async () => ({ outcome: "error", content: "The parent session is closing." }))
    await here.record(buildSubagentPaused({ childRunId: `${here.child}-run`, pausedBy: "person" }))

    expect(await here.protocol.send("subagent", here.child, "Look at the parser first.")).toEqual({
      ok: false,
      error: "The parent session is closing. Your message is kept, and the subagent reads it when it resumes.",
    })
    expect(await here.unread()).toEqual(["Look at the parser first."])
  })

  test("answers a copy of a message it holds with a receipt that its transcript retires, starts an interrupted child again, refuses no child that ended since, and holds the message once", async () => {
    // The first copy's start fails, as when the runtime stops before the
    // child starts, so only the copy the client sends again can start it.
    const starts: ("ok" | "error")[] = ["error", "ok"]
    const here = await project(async () => starts.shift() === "ok" ? { outcome: "ok" } : { outcome: "error", content: "The parent session is closing." })
    await here.record(buildSubagentPaused({ childRunId: `${here.child}-run`, pausedBy: "person" }))
    const message = { text: "Look at the parser first.", submissionIds: ["submission-1"] }
    const receipt = { ok: true as const, confirmedSubmissionIds: ["submission-1"], inTranscript: true }

    expect(await here.protocol.send("subagent", here.child, message)).toMatchObject({ ok: false })
    expect(await here.protocol.send("subagent", here.child, message)).toEqual(receipt)
    expect(here.resumed).toEqual([here.child, here.child])
    await here.record(buildSubagentCompleted({ childRunId: `${here.child}-run`, status: "completed", isError: false, content: "done", durationMs: 1 }))
    expect(await here.protocol.send("subagent", here.child, message)).toEqual(receipt)
    expect(here.resumed).toEqual([here.child, here.child])
    expect(await here.unread()).toEqual(["Look at the parser first."])
  })

  test("refuses a child that ended, and starts nothing", async () => {
    const here = await project(async () => ({ outcome: "ok" }))
    await here.record(buildSubagentCompleted({ childRunId: `${here.child}-run`, status: "completed", isError: false, content: "done", durationMs: 1 }))

    expect(await here.protocol.send("subagent", here.child, "one more thing")).toEqual({ ok: false, error: "This subagent has ended, so it reads no more messages." })
    expect(here.resumed).toEqual([])
    expect(await here.unread()).toEqual([])
  })
})

const childHarness = subagentChildHarnesses()

describe("the registered Resume route", () => {
  for (const parentKind of ["inactive chat", "running workflow", "assembling workflow", "completed subagent", "completed workflow", "stopped workflow", "workflow without a current step", "advanced workflow"] as const) {
    test(`continues only the child of a ${parentKind} with its saved profile and binding`, async () => {
      const options: AgentOptions[] = []
      const heldRunner = (opts: AgentOptions): Agent => {
        options.push(opts)
        const done = Promise.withResolvers<AgentRunResult>()
        return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise }
      }
      const harness = childHarness(heldRunner)
      const root = await harness.manager.createChat({ name: "Root", authProfileId: "parent-profile" })
      let parent = root
      let workflowId: string | undefined
      if (parentKind === "completed subagent") parent = await publishTestSubagent(harness.manager, harness.projectRoot, "nested-parent", root)
      if (parentKind.includes("workflow")) {
        workflowId = await publishTestWorkflow(harness.manager, { authProfileId: "parent-profile" })
        parent = await startTestWorkflowMember(harness.manager, harness.store, workflowId)
      }
      const parentMetadata = await harness.manager.read(parent)
      if (!parentMetadata || parentMetadata.kind === "workflow") throw new Error("Expected a parent conversation")
      const originalConversation = parentMetadata.conversationId
      if (parentKind === "advanced workflow") {
        const tree = createConversationTreeWriterController({ sessionId: parent, conversationId: originalConversation, projectRoot: harness.projectRoot, store: harness.reader, projectionReader: harness.reader, writer: harness.writer })
        try {
          await tree.commitSystemTurn("Original step assignment")
          tree.beginTurn()
          await tree.recordCanonicalMessage({ kind: "assistant", content: [{ type: "tool_use", id: "original-call", name: "subagent", input: { persona: "general", prompt: "Inspect the saved assignment." } }] })
          await tree.endTurn()
        } finally { await tree.dispose() }
      }
      const base = makeDeps({ agentRegistry: repoDefinitions().personas() })
      const launch = await harness.tool(parent, base).execute({
        persona: "general", rationale: TEST_RATIONALE, prompt: "Inspect the saved assignment.",
      }, makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: originalConversation, availableTools: new Set(["read"]), toolUseId: "original-call" }))
      const child: string = JSON.parse(launch.content).session_id
      await liveChildRun(harness.reader, child)?.child.interrupt("person")
      await harness.manager.selectAuthProfile(child, "child-profile")
      await harness.manager.updateLifecycleState(parent, "inactive")
      if (parentKind === "completed subagent") {
        const facts = createSessionFactWriter({ sessionId: parent, writer: harness.writer })
        await facts.record(buildSubagentCompleted({ childRunId: `${parent}-run`, status: "completed", isError: false, content: "Parent finished.", durationMs: 1 }))
        facts.dispose()
      }
      if (parentKind === "completed workflow" || parentKind === "stopped workflow") {
        await replaceWorkflowState(harness.store, workflowId!, "Parent", parentKind === "completed workflow" ? "completed" : "failed")
      }
      const parentSeq = await harness.reader.aggregateSeq(`session:${parent}`)
      const admittedProfiles: string[] = []
      const runnerProfiles: string[] = []
      const childCapture: WorkflowDeps["captureRuntimeConfig"] = () => base.captureRuntimeConfig()
      const admission = createSessionAuthAdmission<WorkflowDeps>({
        manager: harness.manager,
        authProfiles: { inspect: () => ({ id: "parent-profile", persistedId: "parent-profile", displayName: "Parent", directory: base.userDataRoot, projectBinding: undefined, source: "default", availableProfiles: [{ id: "parent-profile", displayName: "Parent" }, { id: "child-profile", displayName: "Child" }], retirements: {} }) },
        materialize: async () => { throw new Error("Resume must not change a saved profile") },
        prepare: async (profileId) => {
          admittedProfiles.push(profileId)
          return {
            userDataRoot: base.userDataRoot, accountHome: base.accountHome, activeProfileId: profileId,
            auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
            availableModels: new Map(), modelInfos: new Map(), definitions: repoDefinitions(),
            moduleSelection: base.moduleSelection, captureRuntimeConfig: childCapture,
            createAgent: (input) => { runnerProfiles.push(profileId); return heldRunner(input) },
            prepareRequest: () => { throw new Error("This fixture prepares no pre-start") },
            planCapabilities: planEveryCapability,
            createLLMClient: async () => asModelClient({
              model: base.parentModel, modelFamily: "anthropic", accessProvider: "anthropic_api", contextLimit: 100_000,
              outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
              priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
              async *streamWithTools() { throw new Error("The fixture streams only through its held runner") },
            }),
            captureProviderConnection: async () => roleCapture(["gpt-5", "gpt-6.1-sol", "claude-sonnet-4.6"]),
            runOwnedCommand: async () => { throw new Error("This fixture launches no commands") },
            resolveEnvSnapshot: async () => { throw new Error("This fixture does not resolve an environment") },
            capabilityAccess: makeContext().capabilityAccess,
            awaitModelAccessSettled: async () => {},
          }
        },
      })
      const parentAccess = makeCapabilityAccess({
        grant: makeContext().capabilityAccess!.grant,
        admit: () => ({ ok: false, missing: ["web"], reason: "The parent host refused web" }),
      })
      const parentHost = continuationParentHost(harness, parent, originalConversation, () => { throw new Error("Resume must use the child-bound runner factory") }, undefined, parentAccess)
      const assembling = Promise.withResolvers<typeof parentHost.modules>()
      const lookedUp = Promise.withResolvers<void>()
      let attached = 0
      const unregister = parentKind === "running workflow" || parentKind === "assembling workflow" ? registerLiveWorkflowControl(harness.reader, {
        kind: "workflow", workflowId: workflowId!, handBackMember: async (continueMember) => continueMember(),
        state: async () => "running", deliver: async () => ({ status: "refused", reason: "settled" }), notify: async () => false,
        memberHost: async (conversationId) => {
          if (conversationId !== originalConversation) return undefined
          lookedUp.resolve()
          return { modules: parentKind === "assembling workflow" ? await assembling.promise : parentHost.modules, backgroundTasks: parentHost.owner.tasks }
        },
      }) : () => {}
      const service = createSubagentContinuationService({
        directories: { projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, userDataRoot: base.userDataRoot, accountHome: base.accountHome },
        sessionManager: harness.manager, sessionStore: harness.sessionStore, eventStore: harness.reader, projectionReader: harness.reader, enabled: () => true,
        executionEnvironment: () => ({ authAdmission: admission, recall: async () => ({ hits: [] }), attachProjection: childSessionProjectionAttachment(harness.sessionStore), deliverNotification: async () => false,
          openChatRunner: async () => { attached += 1; return parentHost.runner },
        }),
      })
      const bus = createRuntimeUiBus()
      const protocol = composeModuleProtocolRuntimes([subagentsModule], {
        eventStore: harness.reader, projectionReader: harness.reader, eventWriter: harness.writer,
        manager: harness.manager, sessionStore: harness.sessionStore, interruptSession: async () => false,
        definitions: repoDefinitions(), onStored: harness.store.onStored, publish: bus.publish, snapshotPosition: bus.snapshotPosition,
        hasLiveSession: () => false, openChatRunner: async () => { throw new Error("Resume must not activate the parent") },
        background: async () => { throw new Error("Resume reads no background snapshot") }, modules: composeModuleServices([["subagents", service]]),
      }, () => ["subagents"])
      try {
        const before = (await readSubagentRuns(harness.reader, child)).at(-1)
        const resuming = protocol.mutate({ type: "subagent.resume", sessionId: child })
        if (parentKind === "assembling workflow") {
          await lookedUp.promise
          expect(options).toHaveLength(1)
          expect(parentHost.owner.tasks.activeBackgroundCommands()).toEqual([])
          assembling.resolve(parentHost.modules)
        }
        const result = await resuming
        const permitted = parentKind === "inactive chat" || parentKind === "running workflow" || parentKind === "assembling workflow"
        if (!permitted) {
          expect(result).toEqual({ ok: false, error: expect.stringContaining(`Resume parent '${parent}' first`) })
          expect(options).toHaveLength(1)
          expect(admittedProfiles).toEqual([])
          return
        }
        expect(result).toEqual({ ok: true })
        expect(attached).toBe(parentKind === "inactive chat" ? 1 : 0)
        expect(options.at(-1)?.runtimeSurfaces?.background).toBeDefined()
        expect(options.at(-1)?.runtimeSurfaces?.foregroundBashHold).toBe(parentHost.foregroundBashHold)
        expect(options.at(-1)?.runtimeSurfaces?.sessions).toBeDefined()
        expect(parentHost.owner.tasks.activeBackgroundCommands()).toMatchObject([{ roleSessionId: child }])
        expect(await options.at(-1)?.capabilityAccess?.admit({ operation: "web probe", required: ["web"] })).toMatchObject({ ok: false, reason: "The parent host refused web" })
        const after = (await readSubagentRuns(harness.reader, child)).at(-1)
        expect(after).toMatchObject({ childRunId: before?.childRunId, parentSessionId: parent, parentConversationId: originalConversation, parentToolCallId: "original-call", promptToolNames: before?.promptToolNames })
        expect(admittedProfiles).toEqual(["child-profile"])
        expect(runnerProfiles).toEqual(["child-profile"])
        const input = options.at(-1)!
        const capturedConfig = "captureRuntimeConfig" in input ? input.captureRuntimeConfig : undefined
        expect(typeof capturedConfig === "function" ? capturedConfig() : undefined).toEqual(childCapture())
        const conversation = options.at(-1)?.conversation
        if (conversation?.kind !== "durable-tree") throw new Error("Expected the child's durable conversation")
        expect(conversation.sessionId).toBe(child)
        expect(await harness.reader.aggregateSeq(`session:${parent}`)).toBe(parentSeq)
        expect((await harness.manager.read(parent))?.lifecycleState).toBe("inactive")
        await liveChildRun(harness.reader, child)?.child.interrupt("person")
      } finally {
        unregister()
        protocol.dispose()
        await parentHost.owner.close()
        await admission.dispose()
        await harness.close()
      }
    })
  }
})
