import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore, type EventStoreAppend, type StoredFact } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionToolSummaryReader } from "../../../../src/orchestration/modules"
import { SessionTranscriptProjection } from "../../../../src/orchestration/session/conversation/transcript-projection"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { createToolResultDisplayMetaCursorReader } from "../../../../src/orchestration/session/conversation/tool-result-meta"
import { createAgentInputCursorReader } from "../../../../src/orchestration/session/agent-input-projection"
import { readOutputSequence } from "../../../../src/orchestration/app-service/output-sequence"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults"
import type { ChatSessionEntry, SessionEntry } from "../../../../src/orchestration/session-store/types"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection"
import { createShippedOutput } from "../../../../src/orchestration/app-service/shipped-output"
import { fakeSessionStore } from "../app-service/app-service-doubles"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection"
import { publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold"
import { replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition"
import { composeControlRestatement } from "../../../../src/workflows/vm/companions"
import { workflowCardHeaderParts } from "../../../../src/protocol/client/workflow-card"
import { Schema } from "effect"
import { FrontendOutputBlockSchema } from "../../../../src/protocol/transcript-protocol-schemas"

let baseDir: string
let store: EventStore

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "flywheel-transcript-child-index-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
})

afterEach(async () => {
  await store.close()
  rmSync(baseDir, { recursive: true, force: true })
})

async function createChat(): Promise<{ sessionId: string; conversationId: string }> {
  const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
  const sessionId = await manager.createChat({ name: "Chat" })
  const conversationId = (await manager.listMetadata()).sessions.find((session) => session.id === sessionId)?.conversationId
  if (!conversationId) throw new Error("missing conversation id")
  return { sessionId, conversationId }
}

async function openExistingTree(options: Omit<Parameters<typeof tryOpenConversationTree>[0], "store"> & { store: EventStore }) {
  const tree = await tryOpenConversationTree({ ...options, store: asAsyncEventReadSurface(options.store), writer: asAsyncEventWriter(options.store) })
  if (!tree) throw new Error(`expected conversation tree ${options.conversationId}`)
  return tree
}

function appendSessionFact(sessionId: string, fact: Omit<EventStoreAppend, "aggregateId" | "sessionId" | "timestamp">): StoredFact {
  return store.append({ ...fact, aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now() })
}

async function publishMember(parentSessionId: string, conversationId: string) {
  const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
  await publishTestWorkflow(manager, {
    id: "workflow-child", name: "Review", workflowDefinitionId: "workflow",
    launchedFrom: { parentSessionId, conversationId, workflowDefinitionId: "workflow", toolUseId: "workflow-tool", description: "Review" },
  })
  const memberId = await startTestWorkflowMember(manager, store, "workflow-child")
  const member = await manager.read(memberId)
  if (member?.kind !== "workflow-agent") throw new Error("Expected an ordinary member session")
  return { manager, memberId, member }
}

async function pauseWorkflow(manager: ReturnType<typeof createSessionManager>, timestamp: number) {
  const facts = store.read({ aggregateId: "workflow:workflow-child" })
  const control = replayWorkflowControl(facts)
  const result = composeControlRestatement(transitionWorkflow(replayWorkflow(control), { type: "PAUSE", reason: "Test interrupt" }), loadQueueFromEvents(facts))
  if (result.command.kind !== "commit") throw new Error("Expected pause proposal")
  const committed = await manager.commitWorkflow({ workflowId: "workflow-child", events: result.command.proposal.facts.map((fact, index) => ({
    ...fact, aggregateId: "workflow:workflow-child", sessionId: "workflow-child", timestamp,
    ...(index === 0 && result.command.kind === "commit" ? { expectedSeq: result.command.proposal.expectedSeq } : {}),
  })) })
  expect(committed.kind).toBe("stored")
  expect(replayWorkflowControl(store.read({ aggregateId: "workflow:workflow-child" })).status).toBe("paused")
}

describe("SessionTranscriptProjection child indexes", () => {
  it("gives one live card ownership of a resumed subagent run", async () => {
    const { sessionId, conversationId } = await createChat()
    appendSessionFact(sessionId, { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId: "child", lastUpdated: new Date().toISOString() } })
    const appendCall = (toolUseId: string, input: { kind: "dispatch" | "resume"; persona?: string; description?: string; session_id?: string }, outcome?: "ok" | "error") => {
      appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId, toolName: "subagent", input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      if (outcome) appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId, outcome } })
    }
    appendCall("dispatch", { kind: "dispatch", persona: "explorer", description: "Read files" })
    store.append({ aggregateId: "session:child", sessionId: "child", timestamp: Date.now(), actor: "flywheel", type: "child_run.created", version: 2, payload: {
      childSessionId: "child", childRunId: "dispatch", conversationId: "child-dispatch", parentSessionId: sessionId, parentConversationId: conversationId, parentToolCallId: "dispatch",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "dispatch" },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read files",
    } })
    appendCall("resume", { kind: "resume", session_id: "child" }, "ok")
    appendCall("rejected", { kind: "resume", session_id: "child" }, "error")
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: () => undefined }, projectRoot: baseDir })
    const card = (id: string, status: "completed" | "error" = "completed"): AnyBlock => status === "error"
      ? { kind: "tool", id, name: "subagent", presentation: { name: "Subagent resume", detail: "Read files" }, status, errorMessage: "Already running", timestamp: 1 }
      : { kind: "tool", id, name: "subagent", presentation: { name: "Subagent", detail: "Read files" }, status, timestamp: 1 }
    try {
      expect(await cache.projectBlock(sessionId, card("dispatch"))).toMatchObject({ kind: "agentGroup", id: "dispatch", status: "interrupted", totalToolCount: 0 })
      expect(await cache.projectBlock(sessionId, card("resume"))).toMatchObject({ kind: "agentGroup", id: "resume", status: "active", totalToolCount: 0 })
      expect(await cache.projectBlock(sessionId, card("rejected", "error"))).toMatchObject({ kind: "tool", id: "rejected", status: "error" })
      expect(await cache.projectBlock(sessionId, card("resume"))).toMatchObject({ id: "resume", status: "active" })

      appendCall("resume-again", { kind: "resume", session_id: "child" }, "ok")
      expect(await cache.projectBlock(sessionId, card("resume"))).toMatchObject({ id: "resume", status: "interrupted" })
      expect(await cache.projectBlock(sessionId, card("resume-again"))).toMatchObject({ id: "resume-again", status: "active" })

      store.append({ aggregateId: "session:child", sessionId: "child", timestamp: Date.now(), actor: "flywheel", type: "subagent.completed", version: 5, payload: {
        childRunId: "dispatch", status: "completed", isError: false, durationMs: 5000, totalTokens: 200, toolUses: 4, result: "Done", resultBytes: 4, resultSha256: "sha", resultPreview: "Done",
      } })
      expect(await cache.projectBlock(sessionId, card("dispatch"))).toMatchObject({ id: "dispatch", status: "interrupted", totalToolCount: 4 })
      expect(await cache.projectBlock(sessionId, card("resume"))).toMatchObject({ id: "resume", status: "interrupted", totalToolCount: 4 })
      expect(await cache.projectBlock(sessionId, card("resume-again"))).toMatchObject({ id: "resume-again", status: "completed", totalToolCount: 4 })
    } finally {
      await cache.dispose()
    }
  })

  it("states a running card's time as the child's settled active time, with an open episode only while the child's clock runs", async () => {
    const { sessionId } = await createChat()
    const now = Date.now()
    // The builder's claim is the wall time since launch; only the child knows its active time.
    const running: AnyBlock = {
      kind: "agentGroup", containerKind: "subagent", id: "live-card", label: "Explorer resume", description: "Read files", status: "active",
      children: [], totalToolCount: 0, linkUri: "flywheel://session/child", duration: 121_000, timestamp: now - 202_000, toolUseId: "live-card",
    }
    let child: ChatSessionEntry | undefined = { ...entryRuntimeDefaults(() => [], now), kind: "chat", runner: null, conversationId: "child-conversation", description: "Child", accumulatedActiveMs: 12_000, streamingStartedAt: null }
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: (id) => id === "child" ? child : undefined }, projectRoot: baseDir })
    try {
      const idle = await cache.projectBlock(sessionId, running)
      expect(idle).toMatchObject({ duration: 12_000 })
      expect(idle).not.toHaveProperty("activeStartedAt")

      child = { ...child, streamingStartedAt: now - 3_000 }
      expect(await cache.projectBlock(sessionId, running)).toMatchObject({ duration: 12_000, activeStartedAt: now - 3_000 })

      // No live child: the recorded active time, and a stopped clock.
      child = undefined
      appendSessionFact("child", { type: "session.duration.recorded", version: 1, actor: "flywheel", payload: { accumulatedActiveMs: 15_000 } })
      const unowned = await cache.projectBlock(sessionId, running)
      expect(unowned).toMatchObject({ duration: 15_000 })
      expect(unowned).not.toHaveProperty("activeStartedAt")
    } finally {
      await cache.dispose()
    }
  })

  it("states a live workflow card from the workflow's own state, so an interrupted workflow shows no spinner", async () => {
    const { sessionId, conversationId } = await createChat()
    const { manager } = await publishMember(sessionId, conversationId)
    // The workflow's active time starts at its running commit, which a slow
    // host can record a few milliseconds after the attempt started.
    const start = store.read({ aggregateId: "workflow:workflow-child", types: ["workflow.control.committed"] }).at(-1)
    if (!start) throw new Error("Expected workflow start")
    await pauseWorkflow(manager, start.timestamp + 4_000)
    // The parent's live tail: the launch was acknowledged, so the builder's
    // card stays in flight until the workflow's result settles it.
    const live: AnyBlock = {
      kind: "agentGroup", containerKind: "workflow", id: "workflow-tool", label: "Workflow", description: "Review", status: "pending",
      children: [], totalToolCount: 0, linkUri: "flywheel://workflow/workflow-child", timestamp: Date.now() - 60_000, toolUseId: "workflow-tool",
    }
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: () => undefined }, projectRoot: baseDir })
    try {
      const interrupted = await cache.projectBlock(sessionId, live)
      expect(interrupted).toMatchObject({ kind: "agentGroup", status: "paused", pausedBy: "runtime", duration: 4_000 })
      expect(interrupted).not.toHaveProperty("activeStartedAt")

      store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.state.changed", version: 1, timestamp: 1, actor: "flywheel", payload: { status: "running", cursor: 0 } })
      expect(await cache.projectBlock(sessionId, live)).toMatchObject({ status: "active", duration: 4_000 })

      // The workflow's result settles the card; the summary no longer states it.
      expect(await cache.projectBlock(sessionId, { ...live, status: "completed" })).toMatchObject({ status: "completed" })
    } finally {
      await cache.dispose()
    }
  })

  // A person's Stop records the launching call's result before the teardown
  // ends the workflow's step, and the parent's builder settles its card only
  // when that result reaches the parent. The card states the Stop from the
  // result at once, and keeps the workflow's counts in every state.
  it("states a workflow card that a person stopped or interrupted with its operations and tokens", async () => {
    const { sessionId, conversationId } = await createChat()
    const { manager, memberId } = await publishMember(sessionId, conversationId)
    await pauseWorkflow(manager, Date.now())
    appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
      toolUseId: "workflow-tool", toolName: "workflow", input: { workflow_definition_id: "workflow", description: "Review" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}",
      executionMode: "background", traceKind: "subagent", childHasOwnViewport: true,
    } })
    appendSessionFact(memberId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
      toolUseId: "step-read", toolName: "read", input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    } })
    appendSessionFact(memberId, { type: "model.usage.measured", version: 5, actor: "provider", payload: {
      attemptId: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "profile", attribution: { kind: "unattributed" }, spendMode: "direct_api",
      credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      classification: "real_spend", price: { kind: "unavailable", reason: "missing-rate-card" }, currency: "USD", budgetStreamId: "step",
    } })
    // The parent's builder still holds the launch's card in flight.
    const live: AnyBlock = {
      kind: "agentGroup", containerKind: "workflow", id: "workflow-tool", label: "Workflow", description: "Review", status: "pending",
      children: [], totalToolCount: 0, linkUri: "flywheel://workflow/workflow-child", timestamp: Date.now() - 60_000, toolUseId: "workflow-tool",
    }
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: () => undefined }, projectRoot: baseDir })
    try {
      expect(await cache.projectBlock(sessionId, live)).toMatchObject({ status: "paused", totalToolCount: 1, totalTokens: 1_200 })

      appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "workflow-tool", outcome: "stopped" } })
      const stopped = await cache.projectBlock(sessionId, live)
      expect(stopped).toMatchObject({ status: "stopped", totalToolCount: 1, totalTokens: 1_200 })
      expect(stopped).not.toHaveProperty("pausedBy")
    } finally {
      await cache.dispose()
    }
  })

  // A Resume records its continuation before the step's first request, so
  // until the step's first reply commits, the step's record still says the
  // step waits for a person. The live run is the truth then, so the card
  // never flashes paused while the resumed step runs.
  it("states a resumed workflow step's live run over its recorded interrupt", async () => {
    const { sessionId, conversationId } = await createChat()
    const { memberId, member } = await publishMember(sessionId, conversationId)
    const step = await openExistingTree({ conversationId: member.conversationId, sessionId: memberId, store })
    await step.appendMessage({ kind: "user", content: "Review the change.", origin: "human" })
    await step.appendMessage({ kind: "user", content: "The process exited.", origin: "system" }, turnEndEntryId({ reason: "crash" }, "exit"))
    await step.appendMessage({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" })
    step.getStorage().dispose()
    let child: Extract<SessionEntry, { kind: "workflow-agent" }> | undefined
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: (id) => id === memberId ? child : undefined }, projectRoot: baseDir })
    const pending: AnyBlock = {
      kind: "agentGroup", containerKind: "workflow", id: "workflow-tool", label: "Workflow", description: "Review", status: "pending",
      children: [], totalToolCount: 0, linkUri: "flywheel://workflow/workflow-child", timestamp: Date.now() - 60_000, toolUseId: "workflow-tool",
    }
    const card = (status: "pending" | "paused"): AnyBlock => status === "paused" ? { ...pending, status, pausedBy: "runtime" } : pending
    try {
      // No runner runs the step: the recorded exit is the truth.
      expect(await cache.projectBlock(sessionId, card("pending"))).toMatchObject({ status: "paused", pausedBy: "runtime" })
      const start = store.read({ aggregateId: "workflow:workflow-child", types: ["attempt.started"] })[0]!.timestamp
      child = { ...entryRuntimeDefaults(() => [], start), kind: "workflow-agent", workflowId: "workflow-child", operations: null, runner: null, conversationId: member.conversationId, description: "Review", runnerState: "streaming", streamingStartedAt: start + 2_000 }
      store.append({ aggregateId: `session:${memberId}`, sessionId: memberId, timestamp: start + 4_000, actor: "agent", type: "tool.input.completed", version: 1, payload: {
        toolUseId: "read", toolName: "read", input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      // The live tail's card and a reopened transcript's card both read the run.
      for (const status of ["pending", "paused"] as const) {
        const running = await cache.projectBlock(sessionId, card(status))
        expect(running).toMatchObject({ status: "active", activeStartedAt: start, duration: 0 })
        if (running.kind !== "agentGroup") throw new Error("Expected workflow card")
        expect(workflowCardHeaderParts(running, start + 5_000).map(part => part.text)).toContain("5s")
        expect(running).not.toHaveProperty("pausedBy")
      }
    } finally {
      await cache.dispose()
    }
  })

  // A step can run while its workflow's control is paused, as in the window
  // after a Resume and before the workflow's running commit. The workflow then
  // has no open episode, so the card states no start. The protocol rejects a
  // stated but undefined start, and one such card fails the whole window.
  it("states a live workflow card with no open episode without a start, so the protocol accepts it", async () => {
    const { sessionId, conversationId } = await createChat()
    const { manager, memberId, member } = await publishMember(sessionId, conversationId)
    const start = store.read({ aggregateId: "workflow:workflow-child", types: ["attempt.started"] })[0]!.timestamp
    await pauseWorkflow(manager, start + 4_000)
    const child: Extract<SessionEntry, { kind: "workflow-agent" }> = { ...entryRuntimeDefaults(() => [], start), kind: "workflow-agent", workflowId: "workflow-child", operations: null, runner: null, conversationId: member.conversationId, description: "Review", runnerState: "streaming", streamingStartedAt: start + 5_000 }
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: (id) => id === memberId ? child : undefined }, projectRoot: baseDir })
    const pending: AnyBlock = {
      kind: "agentGroup", containerKind: "workflow", id: "workflow-tool", label: "Workflow", description: "Review", status: "pending",
      children: [], totalToolCount: 0, linkUri: "flywheel://workflow/workflow-child", timestamp: Date.now() - 60_000, toolUseId: "workflow-tool",
    }
    try {
      const running = await cache.projectBlock(sessionId, pending)
      expect(running).toMatchObject({ status: "active", duration: 4_000 })
      expect(Object.keys(running)).not.toContain("activeStartedAt")
      expect(Schema.decodeUnknownExit(FrontendOutputBlockSchema)(running)._tag).toBe("Success")
    } finally {
      await cache.dispose()
    }
  })

  it("projects a live retry through the shared transcript and seeds old operations before fresh ones", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
    for (const id of ["dispatch", "retry"]) {
      appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: id, toolName: "subagent", input: { kind: id, session_id: "child", persona: "explorer", description: "Read files" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id, name: "subagent", input: { kind: id, session_id: "child", persona: "explorer", description: "Read files" } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "accepted" }] })
    }
    appendSessionFact(sessionId, { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId: "child", lastUpdated: new Date().toISOString() } })
    for (const id of ["dispatch", "retry"]) {
      store.append({ aggregateId: "session:child", sessionId: "child", timestamp: Date.now(), actor: "flywheel", type: "child_run.created", version: 2, payload: {
        childSessionId: "child", childRunId: id, conversationId: `child-${id}`, parentSessionId: sessionId, parentConversationId: conversationId, parentToolCallId: id,
        persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: id },
        admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read files",
      } })
      if (id === "dispatch") store.append({ aggregateId: "session:child", sessionId: "child", timestamp: Date.now(), actor: "flywheel", type: "subagent.completed", version: 5, payload: {
        childRunId: id, status: "failed", isError: true, durationMs: 7000, totalTokens: 900, toolUses: 4, result: "Provider overloaded", resultBytes: 19, resultSha256: "sha", resultPreview: "Provider overloaded",
      } })
    }
    const addChild = (id: string, _parentToolUseId: string) => appendSessionFact("child", { type: "tool.input.completed", version: 1, actor: "agent", payload: {
      toolUseId: id, toolName: "read", input: { path: id }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    } })
    for (let i = 0; i < 4; i++) addChild(`old-${i}`, "dispatch")
    // The failed dispatch's active time: what the running retry card states while no runner holds the child.
    appendSessionFact("child", { type: "session.duration.recorded", version: 1, actor: "flywheel", payload: { accumulatedActiveMs: 7000 } })
    const entry: ChatSessionEntry = {
      ...entryRuntimeDefaults(() => [{ kind: "tool", id: "retry", name: "subagent", presentation: { name: "Retry", detail: "child" }, status: "completed", timestamp: Date.now() }], Date.now()),
      kind: "chat", runner: null, conversationId, description: "Chat",
    }
    let child: ChatSessionEntry | undefined
    const sessionStore = { get: (id: string) => id === sessionId ? entry : id === "child" ? child : undefined }
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore, projectRoot: baseDir })
    const read = async () => readOutputSequence(sessionId, await manager.read(sessionId), { reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore, projectRoot: baseDir, transcriptCache: cache })
    const published: AnyBlock[] = []
    const sequencer = createRuntimeUiPatchSequencer()
    const outputStore = fakeSessionStore(new Map([[sessionId, entry]]))
    let revision = 1
    outputStore.revision = () => revision
    let notifyStored: ((events: readonly StoredFact[]) => void) | undefined
    outputStore.drainOutputChanges = () => ({ fullResync: true, changes: [], changedTools: new Set() })
    const publication = createOutputProjection({
      sessionStore: outputStore,
      projectBlock: cache.projectBlock,
      onStored(listener) { notifyStored = listener; return () => { notifyStored = undefined } },
      shipped: createShippedOutput({
        publish(input) {
          if (input.payload.kind === "output.delta") for (const delta of input.payload.delta.blocks) if (delta.kind === "insert" || delta.kind === "upsert") published.push(delta.block)
          return sequencer.publish(input)
        },
      }),
    })
    try {
      await publication.flush(sessionId)
      expect(published.at(-1)).toMatchObject({ kind: "agentGroup", label: "Explorer retry", totalToolCount: 4 })
      const first = await read()
      expect(await first?.readBlock(0)).toMatchObject({ kind: "agentGroup", label: "Explorer retry", status: "active", totalTokens: 900, duration: 7000 })
      const card = await first?.readBlock(0)
      expect(card).toMatchObject({ activity: { name: "Read", detail: "old-3" } })
      expect(card?.kind === "agentGroup" && card.children).toHaveLength(1)
      const children = await first?.groupChildren("tool:retry")
      expect(children?.blockCount).toBe(4)
      addChild("fresh", "retry")
      appendSessionFact("child", { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: "hidden", toolName: "process", input: { action: "list" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      notifyStored?.(store.read({ aggregateId: "session:child" }).slice(-2))
      await publication.flush(sessionId)
      expect(published.at(-1)).toMatchObject({ kind: "agentGroup", totalToolCount: 6 })
      const publishedRow = published.at(-1)
      expect(publishedRow).toMatchObject({ children: [], activity: { name: "Read", detail: "fresh" } })
      const next = await read()
      const updated = await next?.groupChildren("tool:retry")
      expect(updated?.blockCount).toBe(5)
      expect(await updated?.readBlock(4)).toMatchObject({ name: "read", presentation: { detail: "fresh" } })
      expect(children?.blockCount).toBe(4)
      const retained = await cache.read(sessionId, conversationId, baseDir)
      expect(await retained?.readBlock(0)).toMatchObject({ status: "error" })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "resume", name: "subagent", input: { kind: "resume", session_id: "child" } }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: "resume", content: [{ type: "text", text: "resumed" }] })
      appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: "resume", toolName: "subagent", input: { kind: "resume", session_id: "child" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "resume", outcome: "ok" } })
      entry.outputBlocks = () => [{ kind: "tool", id: "resume", name: "subagent", presentation: { name: "Resume", detail: "child" }, status: "completed", timestamp: 1 }]
      child = { ...entry, accumulatedActiveMs: 12000, streamingStartedAt: 50000, tokens: 1100 }
      revision += 1
      await publication.flush(sessionId)
      expect(published.at(-1)).toMatchObject({ kind: "agentGroup", label: "Explorer resume", totalToolCount: 6 })
      const resumed = await read()
      expect(await resumed?.readBlock(0)).toMatchObject({ kind: "agentGroup", label: "Explorer resume", duration: 12000, activeStartedAt: 50000, totalTokens: 1100, totalToolCount: 6 })
      expect((await resumed?.groupChildren("tool:resume"))?.blockCount).toBe(5)
      addChild("resumed-fresh", "retry")
      notifyStored?.(store.read({ aggregateId: "session:child" }).slice(-1))
      await publication.flush(sessionId)
      expect(published.at(-1)).toMatchObject({ kind: "agentGroup", label: "Explorer resume", totalToolCount: 7 })
      expect((await (await read())?.groupChildren("tool:resume"))?.blockCount).toBe(6)
      store.append({ aggregateId: "session:child", sessionId: "child", timestamp: Date.now(), actor: "flywheel", type: "subagent.completed", version: 5, payload: {
        childRunId: "retry", status: "failed", isError: true, durationMs: 5000, totalTokens: 200, toolUses: 2, result: "Provider overloaded", resultBytes: 19, resultSha256: "sha", resultPreview: "Provider overloaded",
      } })
      entry.outputBlocks = () => [{ kind: "tool", id: "retry", name: "subagent", presentation: { name: "Retry", detail: "child" }, status: "error", errorMessage: "Provider overloaded", timestamp: 1 }]
      revision += 1
      await publication.flush(sessionId)
      expect(published.at(-1)).toMatchObject({ kind: "agentGroup", label: "Explorer retry", status: "interrupted", totalToolCount: 7 })
      appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: "later-retry", toolName: "subagent", input: { kind: "retry", session_id: "child" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      const priorCreated = store.read({ aggregateId: "session:child", types: ["child_run.created"] }).at(-1)
      if (!priorCreated) throw new Error("Missing prior run")
      appendSessionFact("child", { type: "child_run.created", version: 2, actor: "flywheel", payload: {
        ...priorCreated.payload, childRunId: "later-retry", parentToolCallId: "later-retry",
      } })
      const earlierResume: AnyBlock = { kind: "tool", id: "resume", name: "subagent", presentation: { name: "Resume", detail: "child" }, status: "completed", timestamp: 1 }
      expect(await cache.projectBlock(sessionId, earlierResume)).toMatchObject({ kind: "agentGroup", label: "Explorer resume", status: "error", totalToolCount: 7 })
      const retainedResume = await cache.read(sessionId, conversationId, baseDir)
      const resumeIndex = retainedResume?.indexOf("tool:resume") ?? -1
      if (!retainedResume || resumeIndex < 0) throw new Error("Missing retained resume")
      expect(await cache.projectBlock(sessionId, await retainedResume.readBlock(resumeIndex))).toMatchObject({ status: "error", totalToolCount: 7 })
    } finally {
      publication.dispose()
      await cache.dispose()
      tree.getStorage().dispose()
    }
  })
  it("reads the tool and usage history of only the child sessions whose cards a read states", async () => {
    // A window of a chat with hundreds of subagents states a few cards. The
    // card figures are measured from the child's history, which a read pays
    // for only for those cards.
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    const childOf = (index: number) => `${sessionId}-child-${index}`
    for (let index = 0; index < 4; index += 1) {
      const id = `dispatch-${index}`
      const childSessionId = childOf(index)
      const input = { kind: "dispatch", persona: "explorer", description: "Read files" }
      appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: id, toolName: "subagent", input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: id, outcome: "ok" } })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id, name: "subagent", input }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "done" }] })
      appendSessionFact(sessionId, { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId, lastUpdated: new Date().toISOString() } })
      appendSessionFact(childSessionId, { type: "child_run.created", version: 2, actor: "flywheel", payload: {
        childSessionId, childRunId: id, conversationId: `${childSessionId}-conversation`, parentSessionId: sessionId, parentConversationId: conversationId, parentToolCallId: id,
        persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: id },
        admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read files",
      } })
      appendSessionFact(childSessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: `${childSessionId}-read`, toolName: "read", input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      // The run records more operations than its history holds: the card
      // states the measured count.
      appendSessionFact(childSessionId, { type: "subagent.completed", version: 5, actor: "flywheel", payload: {
        childRunId: id, status: "completed", isError: false, durationMs: 10, totalTokens: 20, toolUses: 9, result: "Done", resultBytes: 4, resultSha256: "sha", resultPreview: "Done",
      } })
    }
    tree.getStorage().dispose()
    const local = asAsyncEventReadSurface(store)
    const historyReads = new Set<string>()
    const record = (query: Parameters<typeof local.readSlice>[0]) => {
      if (!query.types?.includes("tool.input.completed")) return
      for (const aggregateId of query.aggregateIds ?? (query.aggregateId ? [query.aggregateId] : [])) historyReads.add(aggregateId)
    }
    const counted = {
      ...local,
      readPage: (...args: Parameters<typeof local.readPage>) => { record(args[0]); return local.readPage(...args) },
      readSlice: (...args: Parameters<typeof local.readSlice>) => { record(args[0]); return local.readSlice(...args) },
    }
    const cache = createTranscriptProjectionCache({ reader: counted, projectionReader: counted, sessionStore: { get: () => undefined }, projectRoot: baseDir })
    try {
      const history = await cache.read(sessionId, conversationId, baseDir)
      if (!history) throw new Error("Expected durable transcript")
      expect(await history.readBlock(history.indexOf("tool:dispatch-2"))).toMatchObject({ kind: "agentGroup", status: "completed", totalToolCount: 1 })
      expect((await history.groupChildren("tool:dispatch-2")).blockCount).toBe(1)
      expect([...historyReads].filter((aggregateId) => aggregateId !== `session:${sessionId}`)).toEqual([`session:${childOf(2)}`])
    } finally {
      await cache.dispose()
    }
  })

  it("states a settled card's operations as the child records them after the card settles", async () => {
    // After a crash, recovery settles the card as interrupted. The child's
    // runner later records its orphaned operation as interrupted, a fact of
    // the child alone that changes nothing in the parent.
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    const childSessionId = `${sessionId}-child`
    const input = { kind: "dispatch", persona: "explorer", description: "Read files" }
    appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
      toolUseId: "dispatch", toolName: "subagent", input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    } })
    appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "dispatch", outcome: "ok" } })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "dispatch", name: "subagent", input }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "dispatch", content: [{ type: "text", text: "done" }] })
    tree.getStorage().dispose()
    appendSessionFact(sessionId, { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId, lastUpdated: new Date().toISOString() } })
    appendSessionFact(childSessionId, { type: "child_run.created", version: 2, actor: "flywheel", payload: {
      childSessionId, childRunId: "dispatch", conversationId: `${childSessionId}-conversation`, parentSessionId: sessionId, parentConversationId: conversationId, parentToolCallId: "dispatch",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "dispatch" },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read files",
    } })
    appendSessionFact(childSessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
      toolUseId: "orphan", toolName: "read", input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    } })
    appendSessionFact(childSessionId, { type: "subagent.interrupted", version: 1, actor: "flywheel", payload: { childRunId: "dispatch", reason: "runtime_restarted", recoveryId: "recovery" } })
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: () => undefined }, projectRoot: baseDir })
    try {
      const before = await cache.read(sessionId, conversationId, baseDir)
      if (!before) throw new Error("Expected durable transcript")
      expect(await before.readBlock(before.indexOf("tool:dispatch"))).toMatchObject({ kind: "agentGroup", status: "interrupted" })
      const pending = await (await before.groupChildren("tool:dispatch")).readBlock(0)
      expect(pending).toMatchObject({ kind: "tool", id: "orphan#dispatch", status: "pending" })

      appendSessionFact(childSessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "orphan", outcome: "interrupted" } })
      const after = await cache.read(sessionId, conversationId, baseDir)
      if (!after) throw new Error("Expected durable transcript")
      expect(await (await after.groupChildren("tool:dispatch")).readBlock(0)).toMatchObject({ id: "orphan#dispatch", status: "interrupted" })
    } finally {
      await cache.dispose()
    }
  })

  it("shares lazy child bodies with live cache queries while retaining branch and render identities", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    const root = await tree.appendMessage({ kind: "user", content: "root" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "parent", name: "subagent", input: { persona: "explorer", description: "Read files" } }] })
    for (let index = 0; index < 128; index += 1) appendSessionFact(sessionId, {
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: { toolUseId: `child-${index}`, parentToolUseId: "parent", toolName: "read", input: { path: `file-${index}` }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false },
    })
    const cache = createTranscriptProjectionCache({ reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), sessionStore: { get: () => undefined }, projectRoot: baseDir })
    const context = { executionCwd: baseDir, idSuffix: "", presentation: "container" as const }
    try {
      const live = await cache.children(sessionId, "parent", context)
      const selected = await live.readBlock(64)
      const history = await cache.read(sessionId, conversationId, baseDir)
      if (!history) throw new Error("Expected durable transcript")
      expect(await (await history.groupChildren("tool:parent")).readBlock(64)).toBe(selected)
      const group = await history.groupChildren("tool:parent")
      const settled = group.settledCount !== undefined ? { settledCount: group.settledCount } : {}
      expect(await cache.children(sessionId, "parent", { ...context, ...settled })).toBe(group)
      const suffixed = await cache.children(sessionId, "parent", { ...context, idSuffix: "#entry" })
      expect(await suffixed.readBlock(64)).toMatchObject({ id: "child-64#entry", linkUri: selected.linkUri })
      const executed = await cache.children(sessionId, "parent", { ...context, presentation: "execute" })
      expect(await executed.readBlock(64)).toMatchObject({ id: "child-64", runCategoryOverride: "execute" })
      expect(selected.runCategoryOverride).toBeUndefined()
      appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "child-65", outcome: "error", contentPreview: "failed" } })
      const updated = await cache.read(sessionId, conversationId, baseDir)
      const updatedLive = await cache.children(sessionId, "parent", context)
      expect(await (await updated?.groupChildren("tool:parent"))?.readBlock(64)).toBe(selected)
      expect(await (await updated?.groupChildren("tool:parent"))?.readBlock(65)).toBe(await updatedLive.readBlock(65))
      expect(await (await history?.groupChildren("tool:parent"))?.readBlock(65)).toMatchObject({ status: "pending" })
      await tree.moveTo(root)
      const moved = await cache.read(sessionId, conversationId, baseDir)
      await expect(moved?.groupChildren("tool:parent")).rejects.toThrow("Missing output group")
      expect(await cache.children(sessionId, "parent", context)).toBe(updatedLive)
    } finally {
      await cache.dispose()
      tree.getStorage().dispose()
    }
  })

  it("catches up skipped readers and late parents, replacing only the completed child slot", async () => {
    const { sessionId, conversationId } = await createChat()
    const tree = await openExistingTree({ conversationId, sessionId, store })
    const meta = createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), sessionId)
    const runs = createSessionToolSummaryReader(asAsyncEventReadSurface(store), sessionId)
    const questions = createAgentInputCursorReader(asAsyncEventReadSurface(store), sessionId)
    const auxiliary = async () => ({
      agentInput: await questions.replay(),
      toolMeta: await meta.replay(),
      toolSummaries: await runs.replay(),
    })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir, auxiliarySource: "external" })
    const addChild = (id: string) => appendSessionFact(sessionId, {
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: { toolUseId: id, parentToolUseId: "code", toolName: "read", input: { path: id }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false },
    })
    addChild("child-a")
    addChild("child-b")
    await auxiliary()
    expect((await projection.read(await auxiliary()))?.blockCount).toBe(0)
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "code", name: "code", input: { code: "return 1" } }] })
    await tree.appendMessage({ kind: "user", content: "suffix" })
    const first = await projection.read(await auxiliary())
    if (!first) throw new Error("Missing indexed transcript")
    expect(first.blockCount).toBe(4)
    expect(first.indexOf("tool:child-b")).toBe(2)
    const a = await first.readBlock(1)
    const b = await first.readBlock(2)
    appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "child-a", outcome: "error", contentPreview: "failed" } })
    appendSessionFact(sessionId, { type: "tool.result.acknowledged", version: 1, actor: "provider", payload: { toolUseId: "child-a" } })
    await auxiliary()
    const settled = await projection.read(await auxiliary())
    if (!settled) throw new Error("Missing settled transcript")
    expect(settled.tipEntryId).toBe(first.tipEntryId)
    expect(settled.consistencyToken).not.toBe(first.consistencyToken)
    expect(await settled.readBlock(1)).not.toBe(a)
    expect(await settled.readBlock(1)).toMatchObject({ status: "error" })
    expect(await first.readBlock(1)).toBe(a)
    expect(await first.readBlock(1)).toMatchObject({ status: "pending" })
    expect(await settled.readBlock(2)).toBe(b)
    expect(settled.indexOf("tool:child-b")).toBe(2)
    expect(await projection.read(await auxiliary())).toBe(settled)
    addChild("child-c")
    const inserted = await projection.read(await auxiliary())
    expect(inserted?.blockCount).toBe(5)
    expect(await inserted?.readBlock(4)).toMatchObject({ kind: "userMessage", content: "suffix" })
    expect(await inserted?.readBlock(2)).toBe(b)
    await projection.dispose()
    tree.getStorage().dispose()
  })
})
