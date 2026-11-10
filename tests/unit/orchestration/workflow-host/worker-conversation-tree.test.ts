import { attemptBrief, planEveryCapability } from "../../../helpers/attempt-brief"
import { fixedAvailability } from "../../../helpers/project-definitions.js"
import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { EventBus, createEmit } from "../../../../src/infra/event-bus"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types"
import type { Agent, AgentFactory, AgentOptions, AgentRunResult } from "../../../../src/orchestration/agent-runtime/types"
import { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback"
import { publishWorkerAttempt } from "./_workflow-host-fixtures"
import { makeWorkflowDeps, noConversationRecall } from "./_workflow-controller-fixtures"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages"
import { interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import type { AttemptRow } from "../../../../src/workflows/view/types"
import { reconcileWorkflowAgentInput } from "../../../../src/orchestration/workflow-host/agent-input-recovery.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { createWorkflowAgentInputs, type WorkflowAgentInputs } from "../../../../src/orchestration/workflow-host/agent-inputs"

import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { definition } from "../../workflows/vm/host-test-support"
import { childSessionProjectionAttachment } from "../../../../src/orchestration/session-store/child-session-projection"
import type { AttachChildSessionProjection } from "../../../../src/orchestration/module-seams"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
let baseDir: string
let store: EventStore
const sessionId = "s_worker_tree"

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-worker-tree-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
})

afterEach(() => {
  store.close()
  fs.rmSync(baseDir, { recursive: true, force: true })
})

function makeStep(): AttemptRow {
  return {
    id: "step-1",
    definitionId: "work",
    briefId: "work",
    workflowDefinitionId: "wf",
    name: "Work",
    status: "running",
    writes: [],
    resumeRevertCount: 0,
  }
}

interface CapturedRun {
  priorMessages: readonly ConversationMessage[]
  proactiveCompactionThreshold: number | undefined
  runtimeSurfaces: AgentOptions["runtimeSurfaces"]
}

function conversationOf(options: AgentOptions) {
  if (options.conversation.kind !== "durable-tree") throw new Error("expected durable worker conversation")
  return options.conversation
}

async function memberTree(conversationId: string) {
  const { member } = await publishWorkerAttempt({ projectRoot: baseDir, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), workflowId: `${sessionId}-${conversationId}`, attemptId: makeStep().id, conversationId })
  const tree = await tryOpenConversationTree({ conversationId, sessionId: member.sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
  if (!tree) throw new Error("Expected published conversation")
  return tree
}

/** Fake runner: records the priorMessages it was handed, emits one assistant
 *  canonical message, and resolves done. Stands in for the real agent loop so
 *  the test exercises the worker's durable-tree wiring, not the LLM. */
function makeCapturingFactory(captured: CapturedRun[], assistantText: string): AgentFactory {
  return (options: AgentOptions): Agent => {
    captured.push({
      priorMessages: conversationOf(options).priorMessages,
      proactiveCompactionThreshold: options.proactiveCompactionThreshold?.(),
      runtimeSurfaces: options.runtimeSurfaces,
    })
    return {
      send() {
        conversationOf(options).append({ kind: "assistant", content: [{ type: "text", text: assistantText }] })
        options.lifecycle.onTurnEnded?.({ handoffWritten: true, turnCount: 1 })
      },
      end() {},
      abort() {},
      done: Promise.resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: conversationOf(options).providerSessionKey, terminal: { kind: "completed" } }),
    }
  }
}

function makeWorker(createAgent: AgentFactory, workerSessionId = sessionId, eventWriter: AsyncEventWriter = asAsyncEventWriter(store), inputs?: WorkflowAgentInputs, attachChildProjection?: AttachChildSessionProjection) {
  const bus = new EventBus()
  return async (...args: Parameters<ReturnType<typeof createWorkerCallback>["worker"]>) => {
    const conversationId = args[3]
    const workflowId = `${workerSessionId}-${conversationId ?? "missing"}`
    const { manager } = await publishWorkerAttempt({ projectRoot: baseDir, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), workflowId, attemptId: args[0].id, conversationId: conversationId ?? "missing" })
    const base = makeWorkflowDeps()
    return createWorkerCallback({
    ...base,
    skills: base.definitions.skills(),
    availability: () => fixedAvailability({ skills: base.definitions.skills(), personas: base.definitions.personas() }),
    planCapabilities: planEveryCapability,
    createAgent,
    auth: testAuthContext(),
    proactiveCompactionThreshold: () => 270_000,
    resolveRoles: async () => new Map([
      ["workflow-agent", { roleId: "workflow-agent", model: "test-model", effort: "high" }],
    ]),
    emit: createEmit(bus),
    sessionId: workflowId,
    projectRoot: baseDir,
    executionCwd: baseDir,
    moduleSelection: composeFirstPartyModules(),
    agentInputs: inputs ?? workflowAgentInputs(asAsyncEventReadSurface(store), workerSessionId).agentInputs,
    deactivateSession: id => manager.updateLifecycleState(id, "inactive"),
    sessionEventWriter: createSessionFactWriter({ sessionId: workflowId, writer: asAsyncEventWriter(store) }),
    recall: noConversationRecall,
    eventStore: asAsyncEventReadSurface(store),
    projectionReader: asAsyncEventReadSurface(store),
    eventWriter,
    resolvedAgents: new Map([["work", definition]]),
    ...(attachChildProjection ? { attachChildProjection } : {}),
    }).worker(...args)
  }
}

describe("worker conversation tree", () => {
  it("wires the worker's stream-start handoff to the one all-input gate", async () => {
    const inputs = createWorkflowAgentInputs({ sessionId, store: asAsyncEventReadSurface(store) })
    let gated = false
    const factory: AgentFactory = (options) => ({
      send() {
        options.lifecycle.inputSource?.enqueueRuntimeNotice?.("queued before handoff")
        options.lifecycle.onHandoffStarted?.()
        expect(inputs.stateOf(makeStep().id)).toBe("handing_off")
        expect(inputs.notify({ text: "later completion" })).toBe(false)
        expect(inputs.compact()).toBe(false)
        options.lifecycle.inputSource?.enqueueRuntimeNotice?.("later expiry")
        expect(options.lifecycle.inputSource?.drainPending()).toBeNull()
        gated = true
      },
      end() {}, abort() {},
      done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
    })
    await makeWorker(factory, sessionId, asAsyncEventWriter(store), inputs)(makeStep(), attemptBrief("work", "task"), undefined, "conv-handoff-gate")
    expect(gated).toBe(true)
  })

  it("retires finalized result checkpoints at the canonical flush barrier", async () => {
    let remaining: number | undefined
    const worker = makeWorker((options) => {
      const done = Promise.withResolvers<AgentRunResult>()
      return {
        send() {
          void (async () => {
            const conversation = conversationOf(options)
            const key = `${conversation.conversationId}:finished-tool`
            store.putInFlight(conversation.sessionId, "finalized-tool-result", key, {
              version: 2, conversationId: conversation.conversationId, toolUseId: "finished-tool", toolName: "read",
              budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "done" }], outcome: "ok",
            })
            const raw = store.readInFlight(conversation.sessionId, "finalized-tool-result")[0]!.raw
            await conversation.append({ kind: "assistant", content: [{ type: "tool_use", id: "finished-tool", name: "read", input: {} }] })
            await conversation.append({ kind: "toolResult", toolUseId: "finished-tool", content: [{ type: "text", text: "done" }] })
            await conversation.flush?.(undefined, [{ kind: "finalized-tool-result", key, expectedRaw: raw }])
            remaining = store.readInFlight(conversation.sessionId, "finalized-tool-result").length
            options.lifecycle.onTurnEnded?.({ handoffWritten: true, turnCount: 1 })
            done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
          })().catch(done.reject)
        },
        end() {}, abort() {}, done: done.promise,
      }
    })
    await worker(makeStep(), attemptBrief("work"), undefined, "flush-checkpoint")
    expect(remaining).toBe(0)
  })

  it("ends a parked worker and propagates a rejected background notification hold", async () => {
    const { member } = await publishWorkerAttempt({ projectRoot: baseDir, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), workflowId: `${sessionId}-failed-notification`, attemptId: makeStep().id, conversationId: "failed-notification" })
    const failure = new Error("notification hold queue pressure")
    const durableWriter = asAsyncEventWriter(store)
    let holds = 0
    const writer: AsyncEventWriter = {
      ...durableWriter,
      putInFlight: async (...args) => {
        if (holds++ === 0) throw failure
        await durableWriter.putInFlight?.(...args)
      },
    }
    // The parked runner settles only when the worker aborts it, so the worker
    // ends only if the rejected hold reaches the runner.
    const done = Promise.withResolvers<Awaited<Agent["done"]>>()
    const worker = makeWorker((options) => ({
      send() {
        options.runtimeSurfaces?.background?.tasks.deliverDurableSubagentNotification?.({ text: "finished command" })
        options.runtimeSurfaces?.background?.tasks.deliverDurableSubagentNotification?.({ text: "later command" })
      },
      end() {},
      abort() { done.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" } }) },
      done: done.promise,
    }), sessionId, writer)
    const observed = await worker(makeStep(), attemptBrief("work"), undefined, "failed-notification")
      .then(() => "succeeded", (error: unknown) => error)
    expect(observed).toBe(failure)
    expect(store.readInFlight(member.sessionId, "chat.queued_background_notification").map((row) => row.payload.text)).toEqual(["later command"])
  })

  it("isolates foreground Bash holds and background work between agent sessions", async () => {
    const captured: CapturedRun[] = []
    const worker = makeWorker(makeCapturingFactory(captured, "done"))

    await worker(makeStep(), attemptBrief("first"), undefined, "worker-hold-first")
    await worker(makeStep(), attemptBrief("second"), undefined, "worker-hold-second")

    const first = captured[0]?.runtimeSurfaces
    const second = captured[1]?.runtimeSurfaces
    expect(first?.foregroundBashHold).toBeDefined()
    expect(second?.foregroundBashHold).not.toBe(first?.foregroundBashHold)
    expect(first?.background).toBeDefined()
    expect(second?.background).toBeDefined()
    expect(second?.background).not.toBe(first?.background)
  })

  it("isolates concurrent workflow-session prompts and conversation trees", async () => {
    const captured: CapturedRun[] = []
    const completions: Array<() => void> = []
    let sends = 0
    const createAgent: AgentFactory = (options) => {
      captured.push({
        priorMessages: conversationOf(options).priorMessages,
        proactiveCompactionThreshold: options.proactiveCompactionThreshold?.(),
        runtimeSurfaces: options.runtimeSurfaces,
      })
      let resolveDone!: () => void
      const done = new Promise<AgentRunResult>((resolve) => {
        resolveDone = () => resolve({ servedRequests: 0, durationMs: 1, providerSessionKey: conversationOf(options).providerSessionKey, terminal: { kind: "completed" } })
      })
      completions.push(resolveDone)
      return {
        send() {
          const prompt = conversationOf(options).priorMessages[0]?.content
          const text = typeof prompt === "string" ? prompt : "missing prompt"
          conversationOf(options).append({ kind: "assistant", content: [{ type: "text", text: `answered: ${text}` }] })
          options.lifecycle.onTurnEnded?.({ handoffWritten: true, turnCount: 1 })
          sends += 1
          if (sends === 2) for (const complete of completions) complete()
        },
        end() {},
        abort() {},
        done,
      }
    }

    const sessions = [
      { sessionId: "workflow-a", conversationId: "conversation-a", prompt: "alpha-only prompt" },
      { sessionId: "workflow-b", conversationId: "conversation-b", prompt: "beta-only prompt" },
    ] as const

    await Promise.all(sessions.map(({ sessionId: concurrentSessionId, conversationId, prompt }) =>
      makeWorker(createAgent, concurrentSessionId)(makeStep(), attemptBrief(prompt), undefined, conversationId),
    ))

    expect(captured.map((run) => run.priorMessages[0]?.content).sort()).toEqual([
      "alpha-only prompt",
      "beta-only prompt",
    ])

    for (const { sessionId: concurrentSessionId, conversationId, prompt } of sessions) {
      const tree = await tryOpenConversationTree({ conversationId, sessionId: concurrentSessionId, store: asAsyncEventReadSurface(store) })
      const branch = await tree!.getBranch()
      await tree!.getStorage().dispose()
      const texts = branch
        .filter((entry) => entry.kind === "message")
        .map((entry) => typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content.map((block) => "text" in block ? block.text : "").join(""))
      expect(texts).toEqual([prompt, `answered: ${prompt}`])
    }
  })

  it("persists the worker conversation to conversation:<conversationId> and resumes it", async () => {
    const conversationId = "conv-worker-1"

    // First run: empty tree → worker seeds the prompt and records one assistant turn.
    const firstCaptured: CapturedRun[] = []
    await makeWorker(makeCapturingFactory(firstCaptured, "first-answer"))(
      makeStep(),
      attemptBrief("do the work", "step task"),
      undefined,
      conversationId,
    )

    // First run: the worker committed the context and the task to the empty
    // tree as one opening turn (stamped origin="system": an assembled step
    // prompt, not a human keystroke), so the runner receives it as
    // priorMessages.
    expect(firstCaptured[0]?.priorMessages).toEqual([{ kind: "user", content: "do the work\n\nstep task", origin: "system" }])
    expect(firstCaptured[0]?.proactiveCompactionThreshold).toBe(270_000)

    // The durable tree now holds the prompt + assistant turn.
    const afterFirst = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    expect(afterFirst).not.toBeNull()
    const branch1 = await afterFirst!.getBranch()
    const texts1 = branch1
      .filter((entry) => entry.kind === "message")
      .map((entry) => typeof entry.message.content === "string" ? entry.message.content : entry.message.content.map((b) => ("text" in b ? b.text : "")).join(""))
    expect(texts1).toEqual(["do the work\n\nstep task", "first-answer"])
    await afterFirst!.appendMessage({ kind: "user", content: "resume work" })
    await afterFirst!.getStorage().dispose()

    // Resume run with the SAME conversationId: the worker replays priorMessages
    // from the tree rather than re-seeding, and the conversation continues upward.
    const secondCaptured: CapturedRun[] = []
    await makeWorker(makeCapturingFactory(secondCaptured, "second-answer"))(
      makeStep(),
      attemptBrief("do the work", "step task"),
      undefined,
      conversationId,
    )

    const resumedTexts = secondCaptured[0]!.priorMessages.map((m) =>
      typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(""),
    )
    expect(resumedTexts).toEqual(["do the work\n\nstep task", "first-answer", "resume work"])

    const afterSecond = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store) })
    const branch2 = await afterSecond!.getBranch()
    await afterSecond!.getStorage().dispose()
    expect(branch2).toHaveLength(4)
  })

  // A build before 2026-10-14 kept the step task in the system prompt, so the
  // tree that it seeded holds only the context. Remove after 2027-04-13.
  // The live view of a running agent holds the turns its tree held when the
  // view attached, and the agent view opens with the brief.
  it("seeds a fresh agent's live view with its brief", async () => {
    let seed: readonly AnyBlock[] | undefined
    const attach = childSessionProjectionAttachment({
      openSessionRuntime: (options) => { seed = options.priorBlocks; return options.sessionId },
      updateChatEntry: () => {},
      remove: async () => {},
    })
    await makeWorker(makeCapturingFactory([], "answer"), sessionId, asAsyncEventWriter(store), undefined, attach)(makeStep(), attemptBrief("do the work", "step task"), undefined, "conv-worker-live-brief")
    expect(seed?.map((block) => block.kind === "userMessage" ? { kind: block.kind, content: block.content, injected: block.injected } : { kind: block.kind })).toEqual([
      { kind: "userMessage", content: "do the work\n\nstep task", injected: false },
    ])
  })

  it("gives the reset opening the brief read from its recorded entry, fresh and after a resume", async () => {
    const briefs: Array<string | undefined> = []
    const factory: AgentFactory = (options) => {
      const agent = makeCapturingFactory([], "answer")(options)
      return { ...agent, done: agent.done.then(async (result) => { briefs.push(await options.standingBrief?.()); return result }) }
    }
    const worker = makeWorker(factory)
    await worker(makeStep(), attemptBrief("do the work", "step task"), undefined, "conv-worker-standing-brief")
    await worker(makeStep(), attemptBrief("do the work", "step task"), undefined, "conv-worker-standing-brief")
    expect(briefs).toEqual(["do the work\n\nstep task", "do the work\n\nstep task"])
  })

  it("restates the task once to a step whose tree an earlier build seeded without it", async () => {
    const conversationId = "conv-worker-system-task"
    const tree = await memberTree(conversationId)
    await tree.appendMessage({ kind: "user", content: "do the work", origin: "system" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "halfway there" }] })
    await tree.appendMessage({ kind: "user", content: "continue" })
    await tree.getStorage().dispose()

    const texts = async (): Promise<string[]> => {
      const captured: CapturedRun[] = []
      await makeWorker(makeCapturingFactory(captured, "answer"))(makeStep(), attemptBrief("do the work", "step task"), undefined, conversationId)
      return captured[0]!.priorMessages.map((m) => typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(""))
    }
    const restated = "Your brief follows. It applies to all of the work above and to the rest of your work.\n\nstep task"
    expect(await texts()).toEqual(["do the work", "halfway there", "continue", restated])
    expect((await texts()).filter((text) => text === restated)).toHaveLength(1)
  })

  it("resumes a step a person interrupted inside its own conversation: no task reseed, and the resume records its continuation", async () => {
    const conversationId = "conv-worker-interrupted"
    const tree = await memberTree(conversationId)
    await tree.appendMessage({ kind: "user", content: "do the work", origin: "system" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "halfway there" }] })
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage("person", true), origin: "system" }, turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k"))
    await tree.getStorage().dispose()

    const captured: CapturedRun[] = []
    await makeWorker(makeCapturingFactory(captured, "resumed-answer"))(
      makeStep(),
      attemptBrief("do the work"),
      undefined,
      conversationId,
    )

    const resumedTexts = captured[0]!.priorMessages.map((m) =>
      typeof m.content === "string" ? m.content : m.content.map((block: { readonly type: string; readonly text?: string }) => block.text ?? "").join(""),
    )
    expect(resumedTexts).toEqual(["do the work", "halfway there", interruptedTurnMessage("person", true), CONTINUATION_MESSAGES.resumed])
  })

  it.each(["person", "agent"] as const)("a planned successor keeps a restored %s park without recording an authorized continuation", async (by) => {
    const conversationId = `conv-worker-restored-${by}`
    const tree = await memberTree(conversationId)
    await tree.appendMessage({ kind: "user", content: "do the work", origin: "system" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "halfway there" }] })
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(by, true), origin: "system" }, turnEndEntryId({ reason: "paused", pausedBy: by }, "restore"))
    const timestamp = Date.parse((await tree.getBranch()).at(-1)!.timestamp)
    await tree.getStorage().dispose()
    const inputs = createWorkflowAgentInputs({ sessionId, store: asAsyncEventReadSurface(store), wake: "planned" })
    const captured: CapturedRun[] = []
    let cuts = 0
    const factory: AgentFactory = (options) => ({
      ...makeCapturingFactory(captured, "answer")(options),
      interruptGeneration: () => { cuts += 1; return true },
    })
    await makeWorker(factory, sessionId, asAsyncEventWriter(store), inputs)(makeStep(), attemptBrief("do the work"), undefined, conversationId)
    expect(cuts).toBe(1)
    expect(captured[0]!.priorMessages.map(({ content }) => content)).not.toContain(CONTINUATION_MESSAGES.resumed)
    expect(inputs.evidence(makeStep().id)?.cut).toEqual({ by, timestamp })
  })

  it("repairs an assistant-ended branch before resuming the worker", async () => {
    const conversationId = "conv-worker-prefill"
    const tree = await memberTree(conversationId)
    await tree.appendMessage({ kind: "user", content: "do the work" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "waiting for background work" }] })
    await tree.getStorage().dispose()

    const captured: CapturedRun[] = []
    await makeWorker(makeCapturingFactory(captured, "resumed-answer"))(
      makeStep(),
      attemptBrief("do the work"),
      undefined,
      conversationId,
    )

    const resumedTexts = captured[0]!.priorMessages.map((m) =>
      typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(""),
    )
    expect(resumedTexts).toEqual(["do the work", "waiting for background work", CONTINUATION_MESSAGES.unexpected_exit])

    const repaired = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store) })
    const branch = await repaired!.getBranch()
    await repaired!.getStorage().dispose()
    expect(branch.filter((entry) => entry.kind === "message").map((entry) => entry.message.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
  })

  it("rejects a worker invocation with no conversationId (must be minted before the first turn)", async () => {
    await expect(
      makeWorker(makeCapturingFactory([], "x"))(makeStep(), attemptBrief("prompt"), undefined, undefined),
    ).rejects.toThrow(/conversationId/)
  })
})

describe("worker agent-input recovery", () => {
  it("resumes a step agent past an answered-while-dead question with the canonical result", async () => {
    const conversationId = "conv-worker-ask"
    const tree = await memberTree(conversationId)
    await tree.appendMessage({ kind: "user", content: "do the work" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "ask-restart", name: "ask_user", input: {} }] })
    await tree.getStorage().dispose()
    store.append({
      aggregateId: `session:${sessionId}`,
      sessionId,
      type: "agent_input.requested",
      version: 3,
      actor: "agent",
      timestamp: 1,
      payload: { interactionId: "ask-restart", conversationId, toolUseId: "ask-restart", request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }] },
    })
    store.append({
      aggregateId: `session:${sessionId}`,
      sessionId,
      type: "agent_input.answered",
      version: 3,
      actor: "user",
      timestamp: 2,
      payload: { interactionId: "ask-restart", answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } } },
    })

    const recovered = await reconcileWorkflowAgentInput({ sessionId, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store), conversationIds: [conversationId] })
    expect(recovered.protectedToolUseIds.size).toBe(0)

    const captured: CapturedRun[] = []
    await makeWorker(makeCapturingFactory(captured, "continued"))(makeStep(), attemptBrief("do the work"), undefined, conversationId)

    const prior = captured[0]!.priorMessages
    const rendered = JSON.stringify(prior)
    expect(rendered).not.toContain("conversationHistoryGap")
    expect(rendered).not.toContain(CONTINUATION_MESSAGES.unexpected_exit)
    expect(prior.map((message) => message.kind)).toEqual(["user", "assistant", "toolResult"])
    expect(rendered).toContain("Yes")

    const reopened = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store) })
    const results = (await reopened!.getBranch()).filter((entry) => entry.kind === "message" && entry.message.kind === "toolResult")
    await reopened!.getStorage().dispose()
    expect(results).toHaveLength(1)
  })
})
