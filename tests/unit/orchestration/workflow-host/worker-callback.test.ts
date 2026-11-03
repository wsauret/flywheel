import { describe, it, expect, setSystemTime, spyOn } from "bun:test"
import { createEmit, EventBus, type EmitFn } from "../../../../src/infra/event-bus"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory"
import { parseRuntimeEventPayload } from "../../../../src/infra/runtime-event-types"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { CommandHandoverAuthority } from "../../../../src/orchestration/agent-runtime/command-handover"
import { publishWorkerAttempt } from "./_workflow-host-fixtures"
import { makeWorkflowDeps } from "./_workflow-controller-fixtures"
import type { SessionManager } from "../../../../src/orchestration/session/manager"
import type { Agent, AgentFactory } from "../../../../src/orchestration/agent-runtime/types"
import type { AgentDefinition } from "../../../../src/infra/agent-definition"
import { scopedAgentRegistry } from "../../../../src/orchestration/modules/subagents/execution/dispatch-configuration"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND, commandHandoversOfAsync } from "../../../../src/orchestration/session/command-handover"
import { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback"
import { createBackgroundIndex } from "../../../../src/orchestration/app-service/background-index"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import type { ActiveBackgroundCommandDescriptor, BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work"
import { HandoffCorrectionExhausted } from "../../../../src/orchestration/agent-runtime/errors"
import { HandoffInvalidError } from "../../../../src/workflows/context-bundle/handoff-errors"
import type { AttemptRow } from "../../../../src/workflows/view/types"
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema"
import { Schema } from "effect"
import { testAuthContext } from "../../../helpers/auth-context"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories"
import { repoDefinitions } from "../../../helpers/project-definitions"
import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { fakeContainer, handedOverRow, handoverAuthority } from "../agent-runtime/_command-handover-fixtures"
import { makeMockOps } from "../agent-runtime/tools/_bash-fixtures"
import { loginWaitingRequest } from "../agent-runtime/_login-wait-fixture"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { newTestRunner } from "../../../helpers/agent-runner"
import { asModelClient } from "../agent-runtime/_model-client"
import { AllCandidatesExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors"
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types"
import { DebugLog } from "../../../../src/infra/debug-log"
import { countStateRequests } from "../../../helpers/state-requests"
import { refusingLauncher } from "../../../helpers/launcher-fake"
import { WHOLE_WORKFLOW } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { registerCapacityWaits } from "../../../../src/orchestration/session/capacity-wait"
import { liveSessionControl, messageDisposition } from "../../../../src/orchestration/session/live-session-control"
import type { RestoredAgentWait } from "../../../../src/orchestration/agent-runtime/agent-loop-types"

const temporary = temporaryDirectories()
const WORKFLOW = "workflow-1"
let sessionId: string
let manager: SessionManager
const CONVERSATION = "agent-step-1"
const STEP: AttemptRow = { id: "step-1", definitionId: "work", workflowDefinitionId: "wf", name: "Work", briefId: "work", status: "running", writes: [], resumeRevertCount: 0 }

async function agentStore(dir: string) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  const published = await publishWorkerAttempt({ projectRoot: dir, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), workflowId: WORKFLOW, attemptId: STEP.id, conversationId: CONVERSATION })
  sessionId = published.member.sessionId
  manager = published.manager
  return store
}

/** A member worker built with the executor's command handover. */
function handoverWorker(dir: string, createAgent: AgentFactory, commandHandover: CommandHandoverAuthority, emit: EmitFn = createEmit(new EventBus()), inputs = workflowAgentInputs(commandHandover.projectionReader, WORKFLOW), resolvedAgents: ReadonlyMap<string, ResolvedAgent> = resolveWorkflowAgents(Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "wf", name: "Workflow", phases: [{ phase: "work", brief: "Do the work.", name: "Work" }],
})), personas: ReadonlyMap<string, AgentDefinition> = new Map(), onBackgroundCommandsChanged?: (commands: readonly ActiveBackgroundCommandDescriptor[]) => void, workflowId = WORKFLOW, overrides: Partial<Pick<Parameters<typeof createWorkerCallback>[0], "attachChildProjection">> = {}) {
  const { accountHome, userDataRoot } = testDirectories(dir)
  return createWorkerCallback({
    ...makeWorkflowDeps(),
    createAgent,
    createLLMClient: () => { throw new Error("no step here creates a client of its own") },
    captureProviderConnection: makeWorkflowDeps().captureProviderConnection,
    auth: testAuthContext(),
    proactiveCompactionThreshold: () => 270_000,
    resolveRoles: async (): Promise<ResolvedRoles> => new Map([["workflow-agent", { roleId: "workflow-agent", model: "test-model", effort: "high" }]]),
    emit,
    sessionId: workflowId,
    projectRoot: dir,
    userDataRoot,
    accountHome,
    executionCwd: dir,
    moduleSelection: composeFirstPartyModules(),
    agentInputs: inputs.agentInputs,
    deactivateSession: id => manager.updateLifecycleState(id, "inactive"),
    sessionEventWriter: createSessionFactWriter({ sessionId: workflowId, writer: commandHandover.writer }),
    attachChildProjection: async input => ({
      onEvent: event => emit(event.type, { sessionId: input.sessionId, data: event.data }),
      lifecycle: {}, queueUserMessage() {}, updateMetrics() {}, updateBackgroundCommands: commands => onBackgroundCommandsChanged?.(commands), updateForegroundBash() {}, updateOperations() {}, dispose: async () => {},
    }),
    skills: repoDefinitions().skills(),
    personas,
    eventStore: commandHandover.reader,
    projectionReader: commandHandover.projectionReader,
    eventWriter: commandHandover.writer,
    recall: async () => ({ hits: [] }),
    commandHandover,
    resolvedAgents,
    ...overrides,
  }).worker
}

describe("a step's command handover", () => {
  it("lists a workflow's managed background command in its own index while live", async () => {
    const dir = temporary("step-background-index-")
    const store = await agentStore(dir)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
    const writer = createSessionFactWriter({ sessionId, writer: authority.writer })
    const writes: Promise<unknown>[] = []
    const emit: EmitFn = (type, input) => {
      if (type !== "tool.background_command.recorded") return
      expect(input.sessionId).toBe(sessionId)
      const event = parseRuntimeEventPayload("tool.background_command.recorded", input.data)
      for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) writes.push(writer.record(fact))
    }
    let live: readonly ActiveBackgroundCommandDescriptor[] = []
    const index = createBackgroundIndex({
      reader: authority.projectionReader,
      readSession: async (id) => await manager.read(id) ?? undefined,
      liveCommands: () => live,
      replyWaits: async () => [],
    })
    const container = fakeContainer([])
    const launched = Promise.withResolvers<void>()
    const done = Promise.withResolvers<Awaited<Agent["done"]>>()
    const worker = handoverWorker(dir, (options) => ({
      async send() {
        await options.runtimeSurfaces?.background?.shell.runBackground({
          command: "bun run dev",
          context: { executionCwd: dir, userDataRoot: `${dir}/.test-account`, projectRoot: dir, scratchDir: dir, toolUseId: "toolu_step", artifactScopeId: sessionId, retrievalSessionId: sessionId, sessionId },
          spawnOwned: async () => container.owned, env: {}, operations: makeMockOps(), platform: "linux",
          tempDir: dir, executionOutputThrottleMs: 5, foreground: false, rawOutput: false,
        })
        launched.resolve()
      },
      end() {},
      abort() { done.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" } }) },
      done: done.promise,
    }), authority, emit, undefined, undefined, undefined, (commands) => { live = commands })
    const run = worker(STEP, "work", "", undefined, CONVERSATION)
    try {
      await launched.promise
      await Promise.all(writes)
      expect(live.map((command) => command.toolUseId)).toEqual(["toolu_step"])
      const rows = await index.rows(sessionId)
      expect(rows.map((row) => row.id)).toEqual(live.map((command) => command.toolUseId))
      expect(rows[0]).toMatchObject({ kind: "command", status: "running", stop: { sessionId, toolUseId: "toolu_step" } })
    } finally {
      done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
      await run
      await Promise.all(writes)
      writer.dispose()
      store.close()
    }
  })

  it("adopts the command handed to a re-entered step's conversation before its first request, and delivers that command's completion to the step", async () => {
    const dir = temporary("step-command-handover-")
    const store = await agentStore(dir)
    const container = fakeContainer([])
    const row = handedOverRow(dir, { sessionId, conversationId: CONVERSATION })
    await Bun.write(row.logPath, "fixture-command-finished\n")
    store.putInFlight(sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND, row.processId, row)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store), heard: false, adopt: () => ({ kind: "adopted", owned: container.owned }) })
    const inputs = workflowAgentInputs(authority.projectionReader, WORKFLOW)
    const delivered: string[] = []
    let runningAtRequest: readonly string[] | undefined
    const worker = handoverWorker(dir, (options) => {
      runningAtRequest = options.runtimeSurfaces?.background?.tasks.activeBackgroundCommands().map((command) => command.id)
      const done = Promise.withResolvers<Awaited<Agent["done"]>>()
      return {
        send() {
          if (runningAtRequest?.length !== 1) {
            done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
            return
          }
          container.end(0)
          // The step parks on its command until its completion arrives.
          void inputs.queues.get(STEP.id)?.waitForMessage().then((message) => {
            delivered.push(JSON.stringify(message))
            done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
          })
        },
        end() {},
        abort() { done.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" } }) },
        done: done.promise,
      }
    }, authority, undefined, inputs)

    await worker(STEP, "work", "", undefined, CONVERSATION)

    expect(runningAtRequest).toEqual([row.processId])
    expect(store.readInFlight(sessionId, COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    expect(delivered).toEqual([expect.stringContaining("exited with code 0")])
    store.close()
  })

  it.each([
    ["hands its running command over at a close in its executor's stop for a heard handoff", true, [expect.stringMatching(/^handOver /)], ["toolu_step"]],
    ["ends its running command when it completes after its executor heard a handoff and before the stop", false, ["terminate"], []],
  ] as const)("%s", async (_name, stopping, closeEvents, handedOver) => {
    const dir = temporary("step-command-handover-")
    const store = await agentStore(dir)
    const events: string[] = []
    const container = fakeContainer(events, "handed_over")
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store), stopping })
    const worker = handoverWorker(dir, (options) => {
      const done = Promise.withResolvers<Awaited<Agent["done"]>>()
      return {
        send() {
          void options.runtimeSurfaces?.background?.shell.runBackground({
            command: "bun run dev",
            context: { executionCwd: dir, userDataRoot: `${dir}/.test-account`, projectRoot: dir, scratchDir: dir, toolUseId: "toolu_step", artifactScopeId: sessionId, retrievalSessionId: sessionId, sessionId },
            spawnOwned: async () => container.owned,
            env: {},
            operations: makeMockOps(),
            platform: "linux",
            tempDir: dir,
            executionOutputThrottleMs: 5,
            foreground: false,
            rawOutput: false,
          }).then(() => done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }))
        },
        end() {},
        abort() {},
        done: done.promise,
      }
    }, authority)

    await worker(STEP, "work", "", undefined, CONVERSATION)

    expect(events).toEqual([...closeEvents])
    expect((await commandHandoversOfAsync(asAsyncEventReadSurface(store), sessionId, CONVERSATION)).map((stored) => stored.row.toolUseId)).toEqual([...handedOver])
    store.close()
  })
})

describe("a step's loop notices", () => {
  it.each(["runtime", "person"] as const)("a %s cut supplies the saved wait policy through the workflow worker", async (by) => {
    const dir = temporary("worker-restored-wait-")
    const store = await agentStore(dir)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
    const at = Date.now() - 30_000
    const tree = await tryOpenConversationTree({ conversationId: CONVERSATION, sessionId, store: authority.projectionReader, writer: authority.writer })
    if (!tree) throw new Error("Missing worker conversation")
    setSystemTime(at)
    try {
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-command", name: "process", input: { action: "wait", soft_timeout: 60 } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-command", content: [{ type: "text", text: "Wait acknowledged." }] })
      const end = interruptedTurnEnd(by)
      await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage(end.pausedBy, false) }, turnEndEntryId(end, "wait-cut"))
    } finally { setSystemTime() }
    tree.getStorage().dispose()
    const inputs = workflowAgentInputs(authority.projectionReader, WORKFLOW)
    if (by === "person") inputs.agentInputs.interrupt(WHOLE_WORKFLOW, "person")
    const stop = new AbortController()
    const parked = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    const task = Promise.withResolvers<BackgroundWorkResult>()
    let requests = 0
    let restored: RestoredAgentWait | undefined
    const worker = handoverWorker(dir, (options) => {
      restored = options.lifecycle.restoredWait
      options.runtimeSurfaces?.background?.tasks.track({ done: task.promise, meta: { id: "pending", type: "background_command", description: "pending" }, kill: { run: () => { task.resolve({ status: "completed", content: "" }) } } })
      return newTestRunner({
        ...options, agentsMd: "", memorySnapshot: null, resolveEnvSnapshot: undefined,
        lifecycle: { ...options.lifecycle, onTurnParked: async (context) => { await options.lifecycle.onTurnParked?.(context); parked.resolve() } },
      }, async () => asModelClient({
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools() { requests += 1; requested.resolve(); stop.abort(); yield { kind: "done", stopReason: "end_turn" } },
      }))
    }, authority, undefined, inputs)
    const run = worker(STEP, "work", "", stop.signal, CONVERSATION)
    try {
      await parked.promise
      expect(requests).toBe(0)
      if (by === "runtime") {
        expect(restored).toEqual({ expiry: { seconds: 60, deadlineMs: at + 60_000 }, replyWaitIds: [] })
        task.resolve({ status: "completed", content: "command completed" })
        await requested.promise
        expect(requests).toBe(1)
      } else {
        expect(restored).toBeUndefined()
        expect(inputs.agentInputs.stateOf(STEP.id)).toBe("interrupted")
      }
    } finally { stop.abort(); task.resolve({ status: "completed", content: "" }); await run; store.close() }
  })

  // The continuation has no Resume input, so the run takes the open wait of
  // the turn that the planned cut ended between its requests.
  it("a planned cut in the middle of a turn continues its open wait through the workflow worker", async () => {
    const dir = temporary("worker-continued-wait-")
    const store = await agentStore(dir)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
    const at = Date.now() - 30_000
    const tree = await tryOpenConversationTree({ conversationId: CONVERSATION, sessionId, store: authority.projectionReader, writer: authority.writer })
    if (!tree) throw new Error("Missing worker conversation")
    setSystemTime(at)
    try {
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-command", name: "process", input: { action: "wait", soft_timeout: 7200 } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-command", content: [{ type: "text", text: "Wait acknowledged." }] })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read", input: { path: "notes.md" } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "notes" }] })
      const end = interruptedTurnEnd("replacement")
      await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage(end.pausedBy, false) }, turnEndEntryId(end, "planned-cut"))
    } finally { setSystemTime() }
    tree.getStorage().dispose()
    const stop = new AbortController()
    const parked = Promise.withResolvers<string>()
    const task = Promise.withResolvers<BackgroundWorkResult>()
    let requests = 0
    let continued: RestoredAgentWait | undefined
    const worker = handoverWorker(dir, (options) => {
      continued = options.lifecycle.continuedWait
      options.runtimeSurfaces?.background?.tasks.track({ done: task.promise, meta: { id: "pending", type: "background_command", description: "pending" }, kill: { run: () => { task.resolve({ status: "completed", content: "" }) } } })
      return newTestRunner({
        ...options, agentsMd: "", memorySnapshot: null, resolveEnvSnapshot: undefined,
        lifecycle: { ...options.lifecycle, onTurnParked: async (context) => { parked.resolve(context.park); stop.abort() } },
      }, async () => asModelClient({
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools() { requests += 1; yield { kind: "text_delta", text: "Read the notes.", blockKey: "text-0" }; yield { kind: "done", stopReason: "end_turn" } },
      }))
    }, authority, undefined, workflowAgentInputs(authority.projectionReader, WORKFLOW))
    const run = worker(STEP, "work", "", stop.signal, CONVERSATION)
    try {
      expect(await parked.promise).toBe("waiting_on_work")
      expect(continued).toEqual({ expiry: { seconds: 7200, deadlineMs: at + 7_200_000 }, replyWaitIds: [] })
      // Without the wait, the text answer would draw the pending-work nudge first.
      expect(requests).toBe(1)
    } finally { stop.abort(); task.resolve({ status: "completed", content: "" }); await run; store.close() }
  })

  it("propagates worker Stop to a production account login wait without resending", async () => {
    const dir = temporary("step-login-wait-")
    const store = await agentStore(dir)
    const request = loginWaitingRequest()
    const controller = new AbortController()
    const reason = new Error("workflow stopped")
    let waitSignal: AbortSignal | undefined
    let stopped: unknown
    const worker = handoverWorker(dir, (options) => {
      const done = Promise.withResolvers<Awaited<Agent["done"]>>()
      waitSignal = options.lifecycle.signal
      return {
        send() {
          if (!waitSignal) throw new Error("worker must forward its signal")
          void request.start(waitSignal, options.lifecycle.onLoginWait).then(
            () => done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
            (error) => { stopped = error; done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
          )
        },
        end() {},
        abort() {},
        done: done.promise,
      }
    }, handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) }))
    const run = worker(STEP, "work", "", controller.signal, CONVERSATION)
    try {
      await request.entered
      expect(request.observations.loginQuestions()).toHaveLength(1)
      controller.abort(reason)
      expect((await run).output).toBe("failed")
      expect(stopped).toBe(reason)
      expect(request.calls()).toBe(1)
      const [question] = request.observations.loginQuestions()
      expect(question?.phase).toBe("asking")
      // Stop withdraws the waiter, not the account's unanswered question.
      if (question) request.observations.answerLogin(question.id, "declined")
      expect(request.calls()).toBe(1)
    } finally {
      controller.abort(reason)
      await run
      store.close()
    }
  })

  it("reach the workflow session's transcript", async () => {
    const dir = temporary("step-loop-notice-")
    const store = await agentStore(dir)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
    const notices: unknown[] = []
    const emit: EmitFn = (type, input) => {
      if (type === "agent.system_message.recorded") notices.push(input)
    }
    let invocation = 0
    const createAgent: AgentFactory = (options) => {
      const done = Promise.withResolvers<Awaited<Agent["done"]>>()
      return {
        async send() {
          invocation += 1
          options.onSystemMessage?.("The agent ended its turn without waiting.", "info")
          const id = `call-${invocation === 1 ? 1 : invocation + 1}`
          const call = createRuntimeEvent("tool.input.completed", { type: "tool.input.completed", model_request_id: `request-${invocation}`, tool_use: { id, name: "read", provider_call_id: id, provider_tool_name: "read", executable_tool_name: "read", input: {}, execution: { mode: "foreground", trace_kind: "tool" } } })
          options.onEvent?.(call)
          options.onEvent?.(call)
          options.onEvent?.(createRuntimeEvent("tool.validation.failed", { type: "tool.validation.failed", tool_use_id: "call-2", tool_name: "read", input: {}, reason: "Invalid input", execution: { mode: "foreground", trace_kind: "tool" } }))
          if (options.conversation?.kind !== "durable-tree") throw new Error("The worker must own a durable conversation")
          const committedIds = invocation === 1 ? [id, "call-2"] : [id]
          await options.conversation.append({ kind: "assistant", content: committedIds.map((callId) => ({ type: "tool_use", id: callId, name: "read", input: {} })) })
          for (const callId of committedIds) {
            await options.conversation.append({ kind: "toolResult", toolUseId: callId, content: [{ type: "text", text: "done" }] })
          }
          await options.conversation.flush?.()
          done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: invocation === 1 ? "aborted" : "completed" } })
        },
        end() {},
        abort() {},
        get done() { return done.promise },
      }
    }
    const worker = handoverWorker(dir, createAgent, authority, emit)

    const result = await worker(STEP, "work", "", undefined, CONVERSATION)
    expect(result.toolUses).toBe(2)
    const resumed = await worker(STEP, "work", "", undefined, CONVERSATION)
    expect(resumed.toolUses).toBe(3)

    expect(notices).toEqual(Array.from({ length: 2 }, () => ({ sessionId, data: { message: "The agent ended its turn without waiting.", level: "info" } })))
    await publishWorkerAttempt({ projectRoot: dir, reader: authority.projectionReader, writer: authority.writer, workflowId: "retry", attemptId: "retry", conversationId: "retry-conversation" })
    const retried = await handoverWorker(dir, createAgent, authority, emit, workflowAgentInputs(authority.projectionReader, "retry"), undefined, undefined, undefined, "retry")({ ...STEP, id: "retry" }, "retry", "", undefined, "retry-conversation")
    expect(retried.toolUses).toBe(2)
    store.close()
  })

  it("restate operations only for events that change them", async () => {
    const dir = temporary("step-forward-work-")
    const store = await agentStore(dir)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
    const operations: number[] = []
    const createAgent: AgentFactory = (options) => {
      const done = Promise.withResolvers<Awaited<Agent["done"]>>()
      return {
        async send() {
          for (let index = 0; index < 50; index++) {
            options.onEvent?.(createRuntimeEvent("model.content.delta", { type: "model.content.delta", delta: index % 2 === 0 ? { type: "text_delta", text: "x" } : { type: "thinking_delta", thinking: "x" }, block_key: "answer" }))
          }
          options.onEvent?.(createRuntimeEvent("tool.input.completed", { type: "tool.input.completed", model_request_id: "request-1", tool_use: { id: "call-1", name: "read", provider_call_id: "call-1", provider_tool_name: "read", executable_tool_name: "read", input: {}, execution: { mode: "foreground", trace_kind: "tool" } } }))
          done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } })
        },
        end() {},
        abort() {},
        get done() { return done.promise },
      }
    }
    const worker = handoverWorker(dir, createAgent, authority, undefined, undefined, undefined, undefined, undefined, WORKFLOW, {
      attachChildProjection: async () => ({
        onEvent() {}, lifecycle: {}, queueUserMessage() {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {},
        updateOperations: (count) => { operations.push(count) }, dispose: async () => {},
      }),
    })

    await worker(STEP, "work", "", undefined, CONVERSATION)
    expect(operations).toEqual([0, 1])
    store.close()
  })
})

describe("a step's persona grant", () => {
  it("refuses a worker whose step was not admitted before building its agent", async () => {
    const dir = temporary("step-missing-grant-")
    const store = await agentStore(dir)
    try {
      const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
      let created = false
      const worker = handoverWorker(dir, () => {
        created = true
        throw new Error("unexpected agent creation")
      }, authority, undefined, workflowAgentInputs(authority.projectionReader, WORKFLOW), new Map())

      await expect(worker(STEP, "work", "", undefined, CONVERSATION)).rejects.toThrow("worker invoked without admitted agent 'work'")
      expect(created).toBe(false)
    } finally {
      store.close()
    }
  })

  it.each([
    [["reviewer"], ["reviewer", "advisor"]],
    [[], ["advisor"]],
  ])("restricts the dispatch registry to the declared subagents %j and the trial advisor default", async (subagents, expected) => {
    const dir = temporary("step-persona-grant-")
    const store = await agentStore(dir)
    try {
      const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
      const personas = new Map<string, AgentDefinition>(["reviewer", "editor", "advisor"].map((name) => [name, {
        kind: "persona", name, description: name, systemPrompt: name, tools: ["read"], role: name, maxTurns: 10,
      }]))
      const resolved = resolveWorkflowAgents(Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
        id: "wf", name: "Workflow",
        phases: [{ phase: "work", brief: "Review the work.", subagents, name: "Work" }],
      }))
      let visible: string[] | undefined
      const worker = handoverWorker(dir, (options) => {
        visible = [...scopedAgentRegistry(options.agentRegistry ?? new Map(), options.allowedSubagentTypes).keys()]
        return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }) }
      }, authority, undefined, workflowAgentInputs(authority.projectionReader, WORKFLOW), resolved, personas)

      await worker(STEP, "work", "", undefined, CONVERSATION)

      expect(visible).toEqual(expected)
    } finally {
      store.close()
    }
  })
})

describe("a step's recovery between failed runs", () => {
  /** A worker whose real runner serves the scripted responses in order, one per model request. */
  function scriptedWorker(dir: string, authority: CommandHandoverAuthority, responses: readonly (() => ProviderStreamEvent[])[], onRequest: () => void = () => {}) {
    let request = 0
    return handoverWorker(dir, (options) => newTestRunner({ ...options, runtimeSurfaces: { ...options.runtimeSurfaces, launcher: refusingLauncher }, agentsMd: "", memorySnapshot: null, resolveEnvSnapshot: undefined }, async () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() {
        onRequest()
        const respond = responses[Math.min(request, responses.length - 1)]!
        request += 1
        yield* respond()
      },
    })), authority)
  }
  // A walk that found no candidate whose capacity returns at once: the policy waits 0 ms, uncounted.
  const noCapacity = (): ProviderStreamEvent[] => { throw new AllCandidatesExhaustedError({ message: "No access provider can run the model", recovery: { kind: "at", atMs: 0 } }) }
  const readCall = (id: string) => (): ProviderStreamEvent[] => [{ kind: "tool_use", toolCall: { id, name: "read", input: { file_path: "missing.txt" } } }, { kind: "done", stopReason: "tool_use" }]
  const handoff = (): ProviderStreamEvent[] => [{ kind: "tool_use", toolCall: { id: "handoff-1", name: "handoff", input: { summary: "done" } } }, { kind: "done", stopReason: "tool_use" }]

  it("reports the requests a failed run served to the recovery, and the next run continues the step", async () => {
    const dir = temporary("step-served-recovery-")
    const store = await agentStore(dir)
    const recoveries: unknown[] = []
    const diagnostic = spyOn(DebugLog, "record").mockImplementation((entry) => { if (entry.type === "agent.unattended.recovery") recoveries.push(entry.payload) })
    try {
      const worker = scriptedWorker(dir, handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) }), [readCall("read-1"), readCall("read-2"), noCapacity, handoff])
      const result = await worker(STEP, "work", "", undefined, CONVERSATION)
      expect(result.output).toBe("completed")
      expect(recoveries).toEqual([{ caller: "workflow-agent", runId: STEP.id, decision: "wait", failure: "api_error", streak: 0, delayMs: 0, served: 2 }])
    } finally {
      diagnostic.mockRestore()
      store.close()
    }
  })

  it("ends a capacity wait at once for a person's message, withdraws the wait for the message, and the turn that reads the message starts at once", async () => {
    const dir = temporary("step-capacity-message-")
    const store = await agentStore(dir)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
    const ledger = registerCapacityWaits(authority.reader, { reader: authority.projectionReader, writer: authority.writer })
    const events: unknown[] = []
    const armed = Promise.withResolvers<void>()
    const diagnostic = spyOn(DebugLog, "record").mockImplementation((entry) => {
      if (entry.type !== "agent.capacity_wait") return
      events.push(entry.payload)
      const { payload } = entry
      if (typeof payload === "object" && payload !== null && "event" in payload && payload.event === "armed") armed.resolve()
    })
    try {
      // The walk states a time an hour away, so only the message can end the wait inside the test.
      const noCapacityForAnHour = (): ProviderStreamEvent[] => { throw new AllCandidatesExhaustedError({ message: "No access provider can run the model", recovery: { kind: "at", atMs: Date.now() + 3_600_000 } }) }
      const run = scriptedWorker(dir, authority, [noCapacityForAnHour, handoff])(STEP, "work", "", undefined, CONVERSATION)
      await armed.promise
      const control = liveSessionControl(authority.reader, sessionId)
      if (!control) throw new Error("a waiting step is live")
      const outcome = await control.deliver({ text: "Continue with what you have.", dispatchIds: ["person-1"] }, (state) => messageDisposition({ state, origin: "human", hop: 0, self: false }))
      expect(outcome).toEqual({ status: "delivered", startsTurn: true })
      expect((await run).output).toBe("completed")
      expect(events).toEqual([
        expect.objectContaining({ event: "armed", sessionId }),
        expect.objectContaining({ event: "withdrawn", sessionId, reason: "message" }),
      ])
    } finally {
      diagnostic.mockRestore()
      ledger.dispose()
      store.close()
    }
  })

  it("costs the same state requests for each recovery decision whatever the count of failed runs", async () => {
    /** The state requests between consecutive model requests of a step whose
     *  first `failures` runs fail and whose last run hands off. */
    async function perDecision(failures: number): Promise<number[]> {
      const dir = temporary("step-recovery-work-count-")
      const store = await agentStore(dir)
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const counts: number[] = []
      try {
        const authority = { ...handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) }), reader: counter.reader, projectionReader: counter.reader }
        const responses = [...Array.from({ length: failures }, () => noCapacity), handoff]
        const worker = scriptedWorker(dir, authority, responses, () => { counts.push(counter.take().length) })
        expect((await worker(STEP, "work", "", undefined, CONVERSATION)).output).toBe("completed")
        // The first count pays the step's start; each later one follows one recovery decision.
        return counts.slice(1)
      } finally {
        store.close()
      }
    }
    const diagnostic = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      const few = await perDecision(3)
      const many = await perDecision(30)
      expect(few).toHaveLength(3)
      expect(many).toHaveLength(30)
      expect(new Set([...few, ...many])).toEqual(new Set([few[0]!]))
    } finally {
      diagnostic.mockRestore()
    }
  })
})

describe("a step whose handoff corrections run out", () => {
  it("fails as the step's invalid handoff, not as a request the provider rejected", async () => {
    const dir = temporary("step-handoff-exhausted-")
    const store = await agentStore(dir)
    const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
    const exhausted = new HandoffCorrectionExhausted({ message: "handoff failed 3 consecutive attempts; last error: Handoff rejected" })
    const worker = handoverWorker(dir, () => ({
      send() {},
      end() {},
      abort() {},
      done: Promise.reject(exhausted),
    }), authority)

    const run = worker(STEP, "work", "", undefined, CONVERSATION)

    await expect(run).rejects.toBeInstanceOf(HandoffInvalidError)
    await expect(run).rejects.toThrow(`Handoff invalid for attempt ${STEP.id}: ${exhausted.message}`)
    store.close()
  })
})
