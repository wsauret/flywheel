import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/projections/output/output-projection.js"
import type { SessionStore } from "../../../../src/orchestration/session-store/types.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/projections/output/transcript-projection-cache.js"
import { readOutputSequence } from "../../../../src/orchestration/app-service/projections/output/output-sequence.js"
import { hydrateDerivedOutputRange } from "../../../../src/orchestration/app-service/projections/output/transcript-queries.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { chatEntry, fakeSessionStore } from "./app-service-doubles.js"
import { batch, deltas, insertChange, outputProjectionRuntime, sink, textBlock, upsertChange } from "./_output-projection-fixtures.js"
import { quietOutputCollaborators } from "../../../helpers/output-projection-deps.js"

const runtime = outputProjectionRuntime()
const directory = temporaryDirectories()
/** A canonical absolute directory on every host; a bare `/scratch` is not one on Windows. */
const SCRATCH = resolve("/scratch")

describe("output projection of subagent cards and live ranges", () => {
  test.each([2, 20])("output-only changes of the children of %i subagent cards re-project no card and make no durable request", async (cardCount) => {
    const events = createSqliteEventStore(resolveEventStoreDbFile(directory("fw-card-live-gate-")))
    const children = Array.from({ length: cardCount }, (_, index) => ({ toolUseId: `dispatch-${index}`, sessionId: `child-${index}`, conversationId: `child-conversation-${index}` }))
    for (const child of children) {
      events.append({ aggregateId: "session:parent", sessionId: "parent", timestamp: 1, actor: "agent", type: "tool.input.completed", version: 1, payload: {
        toolUseId: child.toolUseId, toolName: "subagent", input: { kind: "dispatch", persona: "explorer", description: "Read files" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      events.append({ aggregateId: "session:parent", sessionId: "parent", timestamp: 1, actor: "flywheel", type: "session.child.linked", version: 1, payload: { childSessionId: child.sessionId, lastUpdated: "2026-10-04T14:11:21.164Z" } })
      events.append({ aggregateId: `session:${child.sessionId}`, sessionId: child.sessionId, timestamp: 1, actor: "flywheel", type: "child_run.created", version: 2, payload: {
        childSessionId: child.sessionId, childRunId: child.toolUseId, conversationId: child.conversationId, parentSessionId: "parent", parentConversationId: "conv-parent", parentToolCallId: child.toolUseId,
        persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: child.toolUseId },
        admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: SCRATCH, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read files",
      } })
    }
    const counter = countStateRequests(asAsyncEventReadSurface(events))
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const cache = createTranscriptProjectionCache({ reader: counter.reader, projectionReader: counter.reader, sessionStore: store, projectRoot: SCRATCH })
    const s = sink()
    let cardProjections = 0
    const projection = createOutputProjection({ ...quietOutputCollaborators(),
      sessionStore: store, shipped: s.shipped,
      projectBlock: (sessionId, block) => {
        if (sessionId === "parent") cardProjections += 1
        return cache.projectBlock(sessionId, block)
      },
    })
    const flushChildren = async (): Promise<void> => {
      for (const child of children) await projection.flush(child.sessionId)
      await projection.flush("parent")
    }
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      const cards: AnyBlock[] = children.map((child) => ({ kind: "tool", id: child.toolUseId, name: "subagent", presentation: { name: "Agent", detail: "Read files" }, status: "pending", timestamp: 1 }))
      store.updateChatEntry("parent", { outputBlocks: cards, visibleMessageCountSuffix: 0, outputChanges: batch(cards.map((card, index) => upsertChange(index, card))) })
      for (const child of children) store.openSessionRuntime({ kind: "subagent", sessionId: child.sessionId, conversationId: child.conversationId })
      await flushChildren()
      expect(deltas(s.patches, "parent").flatMap((delta) => delta.blocks)).toMatchObject(children.map((child) => ({ block: { kind: "agentGroup", linkUri: `flywheel://session/${child.sessionId}` } })))
      cardProjections = 0
      // Each child starts, which its card states.
      for (const child of children) store.updateChatEntry(child.sessionId, { runnerState: "streaming", streamingStartedAt: 100 })
      await flushChildren()
      expect(cardProjections).toBe(cardCount)
      cardProjections = 0
      counter.take()

      for (let change = 0; change < 5; change += 1) {
        for (const child of children) {
          const text = textBlock(`${child.sessionId}-${change}`)
          store.updateChatEntry(child.sessionId, { outputBlocks: [text], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, text)]) })
        }
        await flushChildren()
      }
      expect(cardProjections).toBe(0)
      expect(counter.take()).toEqual([])
    } finally {
      projection.dispose()
      await cache.dispose()
      events.close()
    }
  })

  test("a subagent card follows its child's clock and tokens, and a child that finishes updates its card once", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let cardProjections = 0
    const projection = createOutputProjection({ ...quietOutputCollaborators(),
      sessionStore: store, shipped: s.shipped,
      projectBlock: async (sessionId, block) => {
        if (sessionId !== "parent" || block.kind !== "tool") return block
        cardProjections += 1
        return { kind: "agentGroup", containerKind: "subagent", id: block.id, toolUseId: block.id, label: block.id, description: "", children: [], totalToolCount: 0, status: "active", timestamp: 1, linkUri: "flywheel://session/child" }
      },
    })
    const changeChild = async (patch: Parameters<SessionStore["updateChatEntry"]>[1]): Promise<void> => {
      store.updateChatEntry("child", patch)
      await projection.flush("child")
      await projection.flush("parent")
    }
    const streamOutput = async (count: number): Promise<void> => {
      for (let change = 0; change < count; change += 1) await changeChild({ outputBlocks: [textBlock(`out-${change}`)], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock(`out-${change}`))]) })
    }
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.openSessionRuntime({ kind: "subagent", sessionId: "child", conversationId: "conv-child" })
      const card: AnyBlock = { kind: "tool", id: "card", name: "subagent", presentation: { name: "Agent", detail: "card" }, status: "pending", timestamp: 1 }
      store.updateChatEntry("parent", { outputBlocks: [textBlock("before"), card], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, textBlock("before")), upsertChange(1, card)]) })
      await projection.flush("parent")
      await changeChild({ runnerState: "streaming", streamingStartedAt: 100 })
      cardProjections = 0

      await streamOutput(3)
      expect(cardProjections).toBe(0)
      await changeChild({ tokens: 500 })
      expect(cardProjections).toBe(1)

      cardProjections = 0
      await changeChild({ runnerState: "idle", streamingStartedAt: null })
      await streamOutput(3)
      expect(cardProjections).toBe(1)
    } finally {
      projection.dispose()
    }
  })

  test("a card refresh finds its card after a block was inserted before it", async () => {
    const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const s = sink()
    let tokens = 0
    const projection = createOutputProjection({ ...quietOutputCollaborators(),
      sessionStore: store, shipped: s.shipped,
      projectBlock: async (sessionId, block) => {
        if (sessionId !== "parent" || block.kind !== "tool") return block
        return { kind: "agentGroup", containerKind: "subagent", id: block.id, toolUseId: block.id, label: block.id, description: "", children: [], totalToolCount: 0, status: "active", timestamp: 1, linkUri: "flywheel://session/child", totalTokens: tokens }
      },
    })
    try {
      store.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      store.openSessionRuntime({ kind: "subagent", sessionId: "child", conversationId: "conv-child" })
      const card: AnyBlock = { kind: "tool", id: "card", name: "subagent", presentation: { name: "Agent", detail: "card" }, status: "pending", timestamp: 1 }
      store.updateChatEntry("parent", { outputBlocks: [card], visibleMessageCountSuffix: 0, outputChanges: batch([upsertChange(0, card)]) })
      await projection.flush("parent")
      store.updateChatEntry("parent", { outputBlocks: [textBlock("context"), card], visibleMessageCountSuffix: 1, outputChanges: batch([insertChange(0, textBlock("context"))]) })
      await projection.flush("parent")
      s.patches.length = 0

      tokens = 900
      store.updateChatEntry("child", { tokens })
      await projection.flush("child")
      await projection.flush("parent")
      expect(deltas(s.patches, "parent").flatMap((delta) => delta.blocks)).toMatchObject([
        { kind: "upsert", index: 1, blockId: "tool:card", block: { totalTokens: 900 } },
      ])
    } finally {
      projection.dispose()
    }
  })

  test("a range read of 20 rows in a 5,000-block live tail projects only those 20 blocks", async () => {
    const events = createSqliteEventStore(resolveEventStoreDbFile(directory("fw-lazy-range-")))
    const blocks = Array.from({ length: 5_000 }, (_, index) => textBlock(`block-${index}`))
    const entry = chatEntry({ outputBlocks: () => blocks, visibleMessageCountSuffix: blocks.length })
    const projected: string[] = []
    const unread = (): never => { throw new Error("not read by a live range") }
    try {
      const sequence = await readOutputSequence("chat", null, {
        sessionStore: fakeSessionStore(new Map([["chat", entry]])),
        reader: asAsyncEventReadSurface(events),
        projectionReader: asAsyncEventReadSurface(events),
        projectRoot: SCRATCH,
        transcriptCache: {
          read: unread, createSessionReader: unread, children: unread, projectGroupChildren: unread,
          projectBlock: async (_sessionId, block) => {
            projected.push(blockIdentity(block))
            return block
          },
        },
      })
      if (!sequence) throw new Error("Expected a live output sequence")
      expect(sequence.indexOf("text:t-block-4321")).toBe(4_321)
      expect(projected).toEqual([])

      const range = await hydrateDerivedOutputRange(sequence, { anchor: { kind: "tail" }, maxBlocks: 20, maxBytes: 1024 * 1024 })
      const tail = blocks.slice(-20).map(blockIdentity)
      expect(range.kind === "ok" ? range.blocks.map(blockIdentity) : []).toEqual(tail)
      expect(projected.toSorted()).toEqual(tail.toSorted())
    } finally {
      events.close()
    }
  })
})
