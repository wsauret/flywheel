import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { batch, deltas, outputProjectionRuntime, sink, textBlock, upsertChange } from "./_output-projection-fixtures.js"

/** A canonical absolute directory on every host; a bare `/scratch` is not one on Windows. */
const SCRATCH = resolve("/scratch")

const runtime = outputProjectionRuntime()
const directory = temporaryDirectories()

describe("output projection child cards", () => {
  test.each(["store", "stored"] as const)("a %s child change publishes only its parent's matching card, and only when the card changed", async (source) => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projectedIds: string[] = []
    const childToolCounts = new Map<string, number>()
    let stored: (events: readonly StoredFact[]) => void = () => {}
    const projection = createOutputProjection({
      sessionStore: store,
      shipped: s.shipped,
      onStored: (listener) => { stored = listener; return () => {} },
      projectBlock: async (sessionId, block) => {
        if (sessionId !== "parent" || block.kind !== "tool") return block
        projectedIds.push(block.id)
        return { kind: "agentGroup", containerKind: "subagent", id: block.id, toolUseId: block.id, label: block.id, description: "", children: [], totalToolCount: childToolCounts.get(block.id) ?? 0, status: "active", timestamp: 1, linkUri: `flywheel://session/child-${block.id}` }
      },
    })
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.openSessionRuntime({ sessionId: "child-b", conversationId: "conv-child" })
      const cards: AnyBlock[] = ["a", "b", "c"].map((id) => ({
        kind: "tool", id, name: "subagent", presentation: { name: "Agent", detail: id }, status: "pending", timestamp: 1,
      }))
      store.updateChatEntry("parent", { outputBlocks: [textBlock("before"), ...cards], visibleMessageCountSuffix: 1, outputChanges: batch(cards.map((block, index) => upsertChange(index + 1, block))) })
      await projection.flush("child-b")
      await projection.flush("parent")
      s.patches.length = 0
      projectedIds.length = 0
      const changeChild = async (seq: number): Promise<void> => {
        if (source === "store") {
          store.updateChatEntry("child-b", { outputBlocks: [textBlock(`busy-${seq}`)], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock(`busy-${seq}`))]) })
          await projection.flush("child-b")
        } else {
          const event: StoredFact = { id: `event-${seq}`, position: seq, seq, aggregateId: "conversation:child-b", sessionId: "child-b", actor: "agent", type: "tool-execution-started", version: 1, timestamp: 1, payload: {} }
          stored([event])
        }
        await projection.flush("parent")
      }

      childToolCounts.set("b", 1)
      await changeChild(1)
      expect(projectedIds).toEqual(["b"])
      expect(deltas(s.patches, "parent")).toHaveLength(1)
      expect(deltas(s.patches, "parent")[0]!.blocks).toEqual([
        { kind: "upsert", index: 2, blockId: "tool:b", block: { kind: "agentGroup", containerKind: "subagent", id: "b", toolUseId: "b", label: "b", description: "", children: [], totalToolCount: 1, status: "active", timestamp: 1, linkUri: "flywheel://session/child-b" } },
      ])

      // A child change that leaves the card as the client already holds it
      // sends nothing: a streaming child changes many times per second.
      s.patches.length = 0
      await changeChild(2)
      expect(deltas(s.patches, "parent")).toEqual([])
    } finally {
      projection.dispose()
    }
  })

  // A workflow card states its run's time from whether its agents run and
  // from its workflow's control, so it follows both while its parent idles.
  // A refused resume retires the continuation row and commits nothing, so
  // the card of a run that read as owed follows the retirement itself.
  test.each(["agent", "workflow", "continuation"] as const)("a workflow card follows a change of its %s", async (source) => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let projections = 0
    let duration = 0
    let stored: (events: readonly StoredFact[]) => void = () => {}
    let retired: (sessionId: string) => void = () => {}
    const projection = createOutputProjection({
      sessionStore: store,
      shipped: s.shipped,
      onStored: (listener) => { stored = listener; return () => {} },
      onContinuationRetired: (listener) => { retired = listener; return () => {} },
      projectBlock: async (sessionId, block) => {
        if (sessionId !== "parent" || block.kind !== "tool") return block
        projections += 1
        duration += 1000
        return { kind: "agentGroup", containerKind: "workflow", id: block.id, toolUseId: block.id, label: "Run", description: "", children: [], totalToolCount: 0, status: "active", timestamp: 1, linkUri: "flywheel://workflow/wf", duration }
      },
    })
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.openSessionRuntime({ sessionId: "agent", conversationId: "conv-agent", kind: "workflow-agent", workflowId: "wf" })
      const card: AnyBlock = { kind: "tool", id: "launch", name: "workflow", presentation: { name: "Workflow", detail: "Run" }, status: "pending", timestamp: 1 }
      store.updateChatEntry("parent", { outputBlocks: [card], visibleMessageCountSuffix: 0, outputChanges: batch([upsertChange(0, card)]) })
      await projection.flush("agent")
      await projection.flush("parent")
      s.patches.length = 0
      projections = 0
      if (source === "agent") {
        store.updateChatEntry("agent", { runnerState: "streaming", streamingStartedAt: 5 })
        await projection.flush("agent")
      } else if (source === "continuation") {
        retired("wf")
      } else {
        stored([{ id: "event-1", position: 1, seq: 1, aggregateId: "workflow:wf", sessionId: "wf", actor: "flywheel", type: "workflow.control.committed", version: 1, timestamp: 1, payload: {} }])
      }
      await projection.flush("parent")
      expect(projections).toBe(1)
      expect(deltas(s.patches, "parent")).toHaveLength(1)

      // An agent's transcript changes many times a second and leaves the
      // card as it is: only a change of whether the agent runs refreshes it.
      projections = 0
      for (const text of ["one", "two"]) {
        store.updateChatEntry("agent", { outputBlocks: [textBlock(text)], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock(text))]) })
        await projection.flush("agent")
      }
      await projection.flush("parent")
      expect(projections).toBe(0)
      store.updateChatEntry("agent", { runnerState: source === "agent" ? "idle" : "streaming", streamingStartedAt: source === "agent" ? null : 5 })
      await projection.flush("agent")
      await projection.flush("parent")
      expect(projections).toBe(1)
    } finally {
      projection.dispose()
    }
  })

  test("a child operation committed while another projection reads the child shows in the parent's card", async () => {
    const events = createSqliteEventStore(resolveEventStoreDbFile(directory("fw-child-card-join-")))
    const appendTool = (sessionId: string, toolUseId: string, toolName: string, input: { readonly [key: string]: string }) => events.append({
      aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now(), actor: "agent", type: "tool.input.completed", version: 1, payload: {
        toolUseId, toolName, input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      },
    })
    appendTool("parent", "dispatch", "subagent", { kind: "dispatch", persona: "explorer", description: "Read files" })
    events.append({ aggregateId: "session:parent", sessionId: "parent", timestamp: Date.now(), actor: "flywheel", type: "session.child.linked", version: 1, payload: { childSessionId: "child", lastUpdated: new Date().toISOString() } })
    events.append({ aggregateId: "session:child", sessionId: "child", timestamp: Date.now(), actor: "flywheel", type: "child_run.created", version: 2, payload: {
      childSessionId: "child", childRunId: "dispatch", conversationId: "child-dispatch", parentSessionId: "parent", parentConversationId: "conv-parent", parentToolCallId: "dispatch",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "dispatch" },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: SCRATCH, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read files",
    } })
    appendTool("child", "read-1", "read", { path: "one" })
    // The next position capture after `holdNextCapture` takes the committed
    // position at once and returns it only on release, as a slow catch-up does.
    const local = asAsyncEventReadSurface(events)
    let hold: { reached: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined
    const capture = async (upper?: number) => {
      const held = hold
      hold = undefined
      const position = upper ?? await local.capturePosition()
      if (held) {
        held.reached.resolve()
        await held.release.promise
      }
      return position
    }
    const reader: AsyncEventStateReadSurface = {
      ...local,
      capturePosition: () => capture(),
      readPage: async (query, upper, after, tolerant, content) => local.readPage(query, await capture(upper), after, tolerant, content),
    }
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const cache = createTranscriptProjectionCache({ reader, projectionReader: local, sessionStore: store, projectRoot: SCRATCH })
    const s = sink()
    let stored: (events: readonly StoredFact[]) => void = () => {}
    const projection = createOutputProjection({
      sessionStore: store,
      shipped: s.shipped,
      onStored: (listener) => { stored = listener; return () => {} },
      projectBlock: cache.projectBlock,
    })
    const card: AnyBlock = { kind: "tool", id: "dispatch", name: "subagent", presentation: { name: "Agent", detail: "Read files" }, status: "pending", timestamp: 1 }
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.updateChatEntry("parent", { outputBlocks: [card], visibleMessageCountSuffix: 0, outputChanges: batch([upsertChange(0, card)]) })
      await projection.flush("parent")
      const initializing = deltas(s.patches, "parent").at(-1)?.blocks[0]
      expect(initializing).toMatchObject({ block: { kind: "agentGroup", totalToolCount: 1, model: "test", linkUri: "flywheel://session/child" } })
      if (initializing?.kind !== "upsert" || initializing.block.kind !== "agentGroup") throw new Error("Expected a child card")
      expect(initializing.block.activeStartedAt).toBeUndefined()
      s.patches.length = 0

      // A concurrent projection of the same card reads the parent's tool facts
      // at once, then holds while it reads the child's.
      const concurrent = cache.projectBlock("parent", card)
      hold = { reached: Promise.withResolvers(), release: Promise.withResolvers() }
      const held = hold
      await held.reached.promise
      stored([appendTool("child", "read-2", "read", { path: "two" })])
      // The parent's refresh runs on microtasks only, so one task turn brings
      // it to the child's catch-up while the concurrent one still holds.
      await Bun.sleep(0)
      held.release.resolve()
      await concurrent
      await projection.flush("parent")

      const published = deltas(s.patches, "parent")
      expect(published).toHaveLength(1)
      expect(published[0]!.blocks).toMatchObject([{ kind: "upsert", blockId: "tool:dispatch", block: { kind: "agentGroup", totalToolCount: 2 } }])
      s.patches.length = 0
      store.openSessionRuntime({ kind: "subagent", sessionId: "child", conversationId: "child-dispatch" })
      store.updateChatEntry("child", { runnerState: "streaming", streamingStartedAt: 123 })
      await projection.flush("child")
      await projection.flush("parent")
      expect(deltas(s.patches, "parent").at(-1)?.blocks).toMatchObject([{
        kind: "upsert", blockId: "tool:dispatch",
        block: { kind: "agentGroup", model: "test", activeStartedAt: 123, totalToolCount: 2 },
      }])
      s.patches.length = 0
      store.updateChatEntry("child", { tokens: 23900 })
      await projection.flush("child")
      await projection.flush("parent")
      expect(deltas(s.patches, "parent").at(-1)?.blocks).toMatchObject([{
        kind: "upsert", blockId: "tool:dispatch",
        block: { kind: "agentGroup", totalTokens: 23900, totalToolCount: 2, children: [] },
      }])
    } finally {
      projection.dispose()
      await cache.dispose()
      events.close()
    }
  })

  test("a card projected before its child is bound links on the next stored batch, alone", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    const projectedIds: string[] = []
    const bound = new Set<string>(["a"])
    let stored: (events: readonly StoredFact[]) => void = () => {}
    const projection = createOutputProjection({
      sessionStore: store,
      shipped: s.shipped,
      onStored: (listener) => { stored = listener; return () => {} },
      projectBlock: async (sessionId, block) => {
        if (sessionId !== "parent" || block.kind !== "tool") return block
        projectedIds.push(block.id)
        if (!bound.has(block.id)) return block
        return { kind: "agentGroup", containerKind: "subagent", id: block.id, toolUseId: block.id, label: block.id, description: "", children: [], totalToolCount: 0, status: "active", timestamp: 1, linkUri: `flywheel://session/child-${block.id}` }
      },
    })
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.openSessionRuntime({ sessionId: "child-b", conversationId: "conv-child" })
      const cards: AnyBlock[] = ["a", "b"].map((id) => ({ kind: "tool", id, name: "subagent", presentation: { name: "Agent", detail: id }, status: "pending", timestamp: 1 }))
      store.updateChatEntry("parent", { outputBlocks: cards, visibleMessageCountSuffix: 0, outputChanges: batch(cards.map((block, index) => upsertChange(index, block))) })
      await projection.flush("child-b")
      await projection.flush("parent")
      s.patches.length = 0
      projectedIds.length = 0

      bound.add("b")
      const event: StoredFact = { id: "event", position: 1, seq: 1, aggregateId: "conversation:child-b", sessionId: "child-b", actor: "agent", type: "tool-execution-started", version: 1, timestamp: 1, payload: {} }
      stored([event])
      await projection.flush("parent")
      expect(projectedIds).toEqual(["b"])
      expect(deltas(s.patches, "parent").flatMap((delta) => delta.blocks.map((change) => change.kind === "upsert" ? change.blockId : change.kind))).toEqual(["tool:b"])

      projectedIds.length = 0
      store.updateChatEntry("child-b", { outputBlocks: [textBlock("busy")], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock("busy"))]) })
      await projection.flush("child-b")
      await projection.flush("parent")
      expect(projectedIds).toEqual(["b"])
    } finally {
      projection.dispose()
    }
  })

  // A row reaches a client either as a written change or in the display seed
  // that a runtime opens with: the assignment that launches a subagent is the
  // first row of the child's seed, from its parent.
  test.each(["written", "seeded"] as const)("a %s message row names its sender as the sender's own title does, and follows a later title", async (arrival) => {
    const events = createSqliteEventStore(resolveEventStoreDbFile(directory("fw-message-sender-")))
    const quickTitle = "This is a messaging test, not a real bug. The"
    events.append(buildSessionMetadataAppend("wf", buildSessionCreatedFact({
      kind: "workflow-agent", command: "workflow-agent", conversationId: "agent-conversation", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt" }, label: quickTitle, name: quickTitle,
      lifecycleState: "active", lastUpdated: "2026-10-04T14:11:21.164Z",
      launchedFrom: { parentSessionId: "parent", conversationId: "conv-parent", toolUseId: "launch" },
    })))
    const local = asAsyncEventReadSurface(events)
    const cache = createTranscriptProjectionCache({ reader: local, projectionReader: local, sessionStore: { get: () => undefined }, projectRoot: SCRATCH })
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let stored: (events: readonly StoredFact[]) => void = () => {}
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped, onStored: (listener) => { stored = listener; return () => {} }, projectBlock: cache.projectBlock })
    // The envelope keeps the name the sender had when it sent: the quick title
    // that a workflow carries until its generated title arrives.
    const message: AnyBlock = { kind: "userMessage", id: "msg:wf:call", content: "Which file should I check?", timestamp: 1, pending: false, injected: false, from: { sessionId: "wf", name: quickTitle, relation: "child" } }
    try {
      if (arrival === "written") {
        store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
        store.updateChatEntry("parent", { outputBlocks: [message], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, message)]) })
        await projection.flush("parent")
        expect(deltas(s.patches, "parent").at(-1)?.blocks[0]).toMatchObject({ block: { from: { sessionId: "wf", name: quickTitle, relation: "child" } } })
      } else {
        // A client reads a seed through the transcript window, not a delta.
        store.openSessionRuntime({ kind: "subagent", sessionId: "parent", conversationId: "conv-parent", priorBlocks: [message] })
        await projection.flush("parent")
      }
      s.patches.length = 0

      const titled = events.append({ aggregateId: "session:wf", sessionId: "wf", timestamp: Date.now(), actor: "flywheel", type: "session.label.updated", version: 1, payload: {
        label: "Messaging test, not a real bug", shortLabel: "Messaging Test", name: "Messaging test, not a real bug", lastUpdated: "2026-10-04T14:11:26.296Z",
      } })
      stored([titled])
      await projection.flush("parent")

      // A client holds the shipped copy of a written row, so the name ships as
      // an edit of it. A seeded row was never shipped, so it ships whole.
      expect(deltas(s.patches, "parent").flatMap((delta) => delta.blocks)).toEqual([arrival === "written"
        ? { kind: "edit", index: 0, blockId: "userMessage:msg:wf:call", edits: [{ kind: "assign", path: ["from", "name"], value: "Messaging test, not a real bug" }] }
        : { kind: "upsert", index: 0, blockId: "userMessage:msg:wf:call", block: { ...message, from: { sessionId: "wf", name: "Messaging test, not a real bug", relation: "child" } } },
      ])
      // A transcript read later, as a reopened client makes, names it the same way.
      expect(await cache.projectBlock("parent", message)).toMatchObject({ from: { sessionId: "wf", name: "Messaging test, not a real bug", relation: "child" } })
    } finally {
      projection.dispose()
      await cache.dispose()
      events.close()
    }
  })

  test("a message call names its recipient as the recipient's own title does, follows a rename, and keeps the recorded name of a deleted recipient", async () => {
    const events = createSqliteEventStore(resolveEventStoreDbFile(directory("fw-message-recipient-")))
    events.append(buildSessionMetadataAppend("recipient", buildSessionCreatedFact({
      kind: "chat", command: "chat", conversationId: "conv-recipient", label: "Plan the release", executionCwd: SCRATCH, lifecycleState: "active", lastUpdated: "2026-10-04T14:11:21.164Z",
    })))
    const local = asAsyncEventReadSurface(events)
    const cache = createTranscriptProjectionCache({ reader: local, projectionReader: local, sessionStore: { get: () => undefined }, projectRoot: SCRATCH })
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let stored: (events: readonly StoredFact[]) => void = () => {}
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped, onStored: (listener) => { stored = listener; return () => {} }, projectBlock: cache.projectBlock })
    // Each row was built with the name its result recorded at sending. The
    // second recipient was deleted since, so no metadata names it now.
    const toRecipient: AnyBlock = { kind: "tool", id: "to-recipient", name: "message_session", presentation: { name: "Message to", detail: "Draft plan" }, action: "ui_meta", status: "completed", timestamp: 1, targetSessionId: "recipient" }
    const toDeleted: AnyBlock = { kind: "tool", id: "to-deleted", name: "message_session", presentation: { name: "Message to", detail: "Old helper" }, action: "ui_meta", status: "completed", timestamp: 2, targetSessionId: "deleted" }
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.updateChatEntry("parent", { outputBlocks: [toRecipient, toDeleted], visibleMessageCountSuffix: 0, outputChanges: batch([upsertChange(0, toRecipient), upsertChange(1, toDeleted)]) })
      await projection.flush("parent")
      expect(deltas(s.patches, "parent").flatMap((delta) => delta.blocks).map((change) => change.kind === "upsert" ? change.block : undefined)).toEqual([
        { kind: "tool", id: "to-recipient", name: "message_session", presentation: { name: "Message to", detail: "Chat · Plan the release" }, action: "ui_meta", status: "completed", timestamp: 1 },
        { kind: "tool", id: "to-deleted", name: "message_session", presentation: { name: "Message to", detail: "Old helper" }, action: "ui_meta", status: "completed", timestamp: 2 },
      ])
      s.patches.length = 0

      stored([events.append({ aggregateId: "session:recipient", sessionId: "recipient", timestamp: Date.now(), actor: "flywheel", type: "session.label.updated", version: 1, payload: {
        label: "Ship the release", shortLabel: "Ship", name: "Ship the release", lastUpdated: "2026-10-04T14:11:26.296Z", userNamed: true,
      } })])
      await projection.flush("parent")

      expect(deltas(s.patches, "parent").flatMap((delta) => delta.blocks)).toEqual([
        { kind: "edit", index: 0, blockId: "tool:to-recipient", edits: [{ kind: "assign", path: ["presentation", "detail"], value: "Chat · Ship the release" }] },
      ])
    } finally {
      projection.dispose()
      await cache.dispose()
      events.close()
    }
  })

  test.each(["workflow-agent", "subagent", "legacy-subagent"] as const)("messages identify a %s from its owned type evidence without changing the message", async (kind) => {
    const events = createSqliteEventStore(resolveEventStoreDbFile(directory("fw-message-type-")))
    const session = {
      label: "Update server settings", lifecycleState: "active" as const, lastUpdated: "2026-10-04T14:11:21.164Z",
      launchedFrom: { parentSessionId: "parent", toolUseId: "dispatch" },
    }
    events.append(buildSessionMetadataAppend("parent", buildSessionCreatedFact({
      kind: "chat", command: "chat", conversationId: "conv-parent", label: "Parent", executionCwd: SCRATCH, lifecycleState: "active", lastUpdated: session.lastUpdated,
    })))
    events.append({ aggregateId: "session:parent", sessionId: "parent", timestamp: Date.now(), actor: "flywheel", type: "session.child.linked", version: 1,
      payload: { childSessionId: "target", lastUpdated: session.lastUpdated } })
    events.append(buildSessionMetadataAppend("target", buildSessionCreatedFact(kind === "workflow-agent"
      ? { ...session, kind: "workflow-agent", command: "workflow-agent", conversationId: "agent-conversation", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt" } }
      : { ...session, kind: "subagent", command: "subagent", executionCwd: SCRATCH, conversationId: "conv-target" })))
    if (kind === "subagent") events.append({ aggregateId: "session:target", sessionId: "target", timestamp: Date.now(), actor: "flywheel", type: "child_run.created", version: 2, payload: {
      childSessionId: "target", childRunId: "dispatch", conversationId: "conv-target", parentSessionId: "parent", parentConversationId: "conv-parent", parentToolCallId: "dispatch",
      persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "dispatch" },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: SCRATCH, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Update server settings",
    } })
    const local = asAsyncEventReadSurface(events)
    let runReads = 0
    const reader = { ...local, async readSlice(query: Parameters<typeof local.readSlice>[0]) {
      if (query.types?.includes("child_run.created")) runReads += 1
      return local.readSlice(query)
    } }
    const cache = createTranscriptProjectionCache({ reader, projectionReader: reader, sessionStore: { get: () => undefined }, projectRoot: SCRATCH })
    const typeLabel = kind === "subagent" ? "Explorer" : undefined
    const name = kind === "legacy-subagent" ? "Recorded name" : "Update server settings"
    const message: AnyBlock = { kind: "userMessage", id: "received", content: "Use main.ts", timestamp: 1, pending: false, injected: false,
      from: { sessionId: "target", name: "Recorded name", relation: "sibling", personWords: "Keep tests green" } }
    try {
      expect(await cache.projectBlock("parent", message)).toMatchObject({
        ...message, from: { ...message.from, name, ...(typeLabel ? { typeLabel } : {}) },
      })
      const initialRunReads = runReads
      expect(await cache.projectBlock("parent", { kind: "tool", id: "sent", name: "message_session", status: "completed", timestamp: 1,
        presentation: { name: "Message to", detail: "Recorded name" }, targetSessionId: "target" })).toMatchObject({
        presentation: { name: "Message to", detail: typeLabel ? `${typeLabel} · ${name}` : name },
      })
      expect(runReads).toBe(initialRunReads)
    } finally {
      await cache.dispose()
      events.close()
    }
  })

  test.each(["named", "deleted"] as const)("a running card names the newest message's recipient when the recipient is %s", async (recipient) => {
    const events = createSqliteEventStore(resolveEventStoreDbFile(directory("fw-card-message-row-")))
    if (recipient === "named") {
      events.append(buildSessionMetadataAppend("parent", buildSessionCreatedFact({
        kind: "chat", command: "chat", conversationId: "conv-parent", label: "Title Test", executionCwd: SCRATCH, lifecycleState: "active", lastUpdated: "2026-10-04T14:11:21.164Z",
      })))
    }
    const appendTool = (sessionId: string, toolUseId: string, toolName: string, input: { readonly [key: string]: string | boolean }) => events.append({
      aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now(), actor: "agent", type: "tool.input.completed", version: 1, payload: {
        toolUseId, toolName, input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      },
    })
    const appendResult = (sessionId: string, toolUseId: string, details: { readonly targetName: string }) => events.append({
      aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now(), actor: "flywheel", type: "tool.result.recorded", version: 1, payload: {
        toolUseId, outcome: "ok", contentPreview: "Delivered to parent.", details,
      },
    })
    appendTool("parent", "dispatch", "subagent", { kind: "dispatch", persona: "general", description: "Alpha waiter" })
    events.append({ aggregateId: "session:parent", sessionId: "parent", timestamp: Date.now(), actor: "flywheel", type: "session.child.linked", version: 1, payload: { childSessionId: "child", lastUpdated: new Date().toISOString() } })
    events.append({ aggregateId: "session:child", sessionId: "child", timestamp: Date.now(), actor: "flywheel", type: "child_run.created", version: 2, payload: {
      childSessionId: "child", childRunId: "dispatch", conversationId: "child-dispatch", parentSessionId: "parent", parentConversationId: "conv-parent", parentToolCallId: "dispatch",
      persona: { name: "general", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "dispatch" },
      admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: SCRATCH, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Alpha waiter",
    } })
    // The first message opens a wait with words; the second only waits again.
    appendTool("child", "ask", "message_session", { to: "parent", text: "Which color?", wait: true })
    appendResult("child", "ask", { targetName: "Title Test" })
    appendTool("child", "wait-again", "message_session", { to: "parent", wait: true })
    const local = asAsyncEventReadSurface(events)
    const cache = createTranscriptProjectionCache({ reader: local, projectionReader: local, sessionStore: { get: () => undefined }, projectRoot: SCRATCH })
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let stored: (events: readonly StoredFact[]) => void = () => {}
    const projection = createOutputProjection({ sessionStore: store, shipped: s.shipped, onStored: (listener) => { stored = listener; return () => {} }, projectBlock: cache.projectBlock })
    const card: AnyBlock = { kind: "tool", id: "dispatch", name: "subagent", presentation: { name: "Agent", detail: "Alpha waiter" }, status: "pending", timestamp: 1 }
    const activity = () => {
      const shipped = deltas(s.patches, "parent").flatMap((delta) => delta.blocks).findLast((change) => change.kind === "upsert")
      return shipped?.kind === "upsert" && shipped.block.kind === "agentGroup" ? shipped.block.activity : undefined
    }
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.updateChatEntry("parent", { outputBlocks: [card], visibleMessageCountSuffix: 0, outputChanges: batch([upsertChange(0, card)]) })
      await projection.flush("parent")
      if (recipient === "deleted") {
        // With no metadata to name the recipient, a call shows the name its
        // result recorded, and the session id until a result names it.
        expect(activity()).toMatchObject({ detail: "parent" })
        stored([appendResult("child", "wait-again", { targetName: "Title Test" })])
        await projection.flush("parent")
        expect(activity()).toMatchObject({ detail: "Title Test" })
        return
      }
      // The recipient's own title names every call, before and after its result.
      expect(activity()).toMatchObject({ detail: "Chat · Title Test" })
      stored([events.append({ aggregateId: "session:parent", sessionId: "parent", timestamp: Date.now(), actor: "flywheel", type: "session.label.updated", version: 1, payload: {
        label: "Renamed parent", shortLabel: "Renamed", name: "Renamed parent", lastUpdated: "2026-10-04T14:11:26.296Z", userNamed: true,
      } })])
      await projection.flush("parent")
      expect(activity()).toMatchObject({ detail: "Chat · Renamed parent" })
    } finally {
      projection.dispose()
      await cache.dispose()
      events.close()
    }
  })
})
