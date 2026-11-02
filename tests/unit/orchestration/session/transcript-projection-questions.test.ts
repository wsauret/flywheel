import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { SessionTranscriptProjection } from "../../../../src/orchestration/session/conversation/transcript-projection"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache"
import { readAllOutputBlocks } from "../../../helpers/indexed-output"

let baseDir: string
let store: EventStore

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "flywheel-transcript-questions-"))
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

function appendSessionFact(sessionId: string, fact: Omit<EventStoreAppend, "aggregateId" | "sessionId" | "timestamp">): void {
  store.append({ ...fact, aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now() })
}

describe("SessionTranscriptProjection questions", () => {
  it("keeps unreadable answers nonactionable at their ask and orphan gaps only in primary history", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    if (!writer) throw new Error("expected conversation tree")
    const cache = createTranscriptProjectionCache({ sessionStore: { get: () => undefined }, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), projectRoot: baseDir })
    try {
      await writer.appendMessages([
        { kind: "user", content: "healthy history" },
        { kind: "assistant", content: [{ type: "tool_use", id: "bad", name: "ask_user", input: {} }, { type: "tool_use", id: "good", name: "ask_user", input: {} }] },
      ])
      for (const interactionId of ["bad", "good"]) appendSessionFact(sessionId, {
        type: "agent_input.requested", version: 3, actor: "agent",
        payload: { interactionId, conversationId, toolUseId: interactionId, request: [{ question: "Q", choices: [], multiSelect: false }] },
      })
      appendSessionFact(sessionId, { type: "agent_input.answered", version: 1, actor: "user", payload: { interactionId: "bad", answers: { Q: 5 } } })
      appendSessionFact(sessionId, { type: "agent_input.answered", version: 1, actor: "user", payload: { interactionId: "orphan", answers: { Q: 5 } } })
      const workerView = cache.createSessionReader(sessionId, baseDir)
      const captured = await workerView.readAgentInput()
      appendSessionFact(sessionId, { type: "agent_input.answered", version: 3, actor: "user", payload: { interactionId: "good", answers: { Q: { kind: "freeform", text: "readable" } } } })
      const before = store.read({ aggregateId: `session:${sessionId}` })
      const bad = before.find((fact) => fact.type === "agent_input.answered" && fact.payload.interactionId === "bad")!
      const orphan = before.find((fact) => fact.payload.interactionId === "orphan")!
      const primary = await cache.read(sessionId, conversationId, baseDir)
      if (!primary) throw new Error("missing primary history")
      const blocks = await readAllOutputBlocks(primary)
      expect(blocks.map((block) => block.kind)).toEqual(["userMessage", "degraded", "question", "degraded"])
      expect(blocks[1]).toMatchObject({ factFamily: "agent_input", eventPosition: bad.position, eventVersion: 1, failureClass: "decode_failure" })
      expect(blocks[2]).toMatchObject({ answers: { Q: "Other: readable" } })
      expect(blocks[3]).toMatchObject({ factFamily: "agent_input", eventPosition: orphan.position })
      const worker = await workerView.readConversation(conversationId)
      expect(worker && (await readAllOutputBlocks(worker)).map((block) => block.kind)).toEqual(["userMessage", "degraded", "question"])
      expect(worker && (await readAllOutputBlocks(worker))[2]).not.toHaveProperty("answers")
      expect(await workerView.readAgentInput()).toBe(captured)
      const currentWorker = await cache.createSessionReader(sessionId, baseDir).readConversation(conversationId)
      expect(currentWorker && (await readAllOutputBlocks(currentWorker))[2]).toMatchObject({ kind: "question", answers: { Q: "Other: readable" } })
      expect(await readAllOutputBlocks((await cache.read(sessionId, conversationId, baseDir))!)).toEqual(blocks)
      expect(store.read({ aggregateId: `session:${sessionId}` })).toEqual(before)
    } finally {
      await cache.dispose()
      writer.getStorage().dispose()
    }
  })

  it("reprojects durable ask_user answers into the saved question row", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    if (!writer) throw new Error("expected conversation tree")
    const sourceQuestion = "Choose the issue source"
    const modelQuestion = "Choose the model name"
    await writer.appendMessages([
      {
        kind: "assistant",
        content: [{
          type: "tool_use",
          id: "ask-1",
          name: "ask_user",
          input: {
            questions: [
              { question: sourceQuestion, options: [{ label: "GitHub" }] },
              { question: modelQuestion, options: [{ label: "Named model" }] },
            ],
          },
        }],
      },
      {
        kind: "toolResult",
        toolUseId: "ask-1",
        content: [{ type: "text", text: `User answered:\n- ${sourceQuestion}: GitHub\n- ${modelQuestion}: Custom name` }],
      },
    ])
    appendSessionFact(sessionId, {
      type: "agent_input.requested",
      version: 3,
      actor: "agent",
      payload: {
        interactionId: "ask-1",
        conversationId,
        toolUseId: "ask-1",
        request: [
          {
            question: sourceQuestion,
            header: "Source",
            choices: [
              { kind: "option", choiceId: "github", label: "GitHub" },
              { kind: "freeform", label: "Other" },
            ],
            multiSelect: false,
          },
          {
            question: modelQuestion,
            header: "Model",
            choices: [
              { kind: "option", choiceId: "named-model", label: "Named model" },
              { kind: "freeform", label: "Other" },
            ],
            multiSelect: false,
          },
        ],
      },
    })
    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    const pending = await projection.read()
    const pendingBlock = await pending?.readBlock(0)

    expect(pendingBlock).toMatchObject({ kind: "question", toolUseId: "ask-1" })
    if (pendingBlock?.kind !== "question") throw new Error("expected pending question")
    expect(pendingBlock.answers).toBeUndefined()

    appendSessionFact(sessionId, {
      type: "agent_input.answered",
      version: 3,
      actor: "user",
      payload: {
        interactionId: "ask-1",
        answers: {
          [sourceQuestion]: {
            kind: "choice",
            selections: [{ choiceId: "github" }],
            text: "GitHub",
          },
          [modelQuestion]: { kind: "freeform", text: "Custom name" },
        },
      },
    })
    const answered = await projection.read()

    expect(await answered?.readBlock(0)).toMatchObject({
      kind: "question",
      toolUseId: "ask-1",
      questions: [
        expect.objectContaining({ header: "Source", question: sourceQuestion }),
        expect.objectContaining({ header: "Model", question: modelQuestion }),
      ],
      answers: {
        [sourceQuestion]: "GitHub",
        [modelQuestion]: "Other: Custom name",
      },
    })
    expect(answered?.consistencyToken).not.toBe(pending?.consistencyToken)
    await projection.dispose()

    const reopened = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    expect(await (await reopened.read())?.readBlock(0)).toMatchObject({
      kind: "question",
      answers: {
        [sourceQuestion]: "GitHub",
        [modelQuestion]: "Other: Custom name",
      },
    })
    await reopened.dispose()
    writer.getStorage().dispose()
  })

  it("reprojects a durable ask_user cancellation", async () => {
    const { sessionId, conversationId } = await createChat()
    const writer = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    if (!writer) throw new Error("expected conversation tree")
    await writer.appendMessage({
      kind: "assistant",
      content: [{ type: "tool_use", id: "ask-cancelled", name: "ask_user", input: { question: "Continue?" } }],
    })
    appendSessionFact(sessionId, {
      type: "agent_input.requested",
      version: 3,
      actor: "agent",
      payload: {
        interactionId: "ask-cancelled",
        conversationId,
        toolUseId: "ask-cancelled",
        request: [{
          question: "Continue?",
          choices: [
            { kind: "option", choiceId: "yes", label: "Yes" },
            { kind: "freeform", label: "Other" },
          ],
          multiSelect: false,
        }],
      },
    })
    appendSessionFact(sessionId, {
      type: "agent_input.cancelled",
      version: 1,
      actor: "user",
      payload: { interactionId: "ask-cancelled", reason: "user_cancelled" },
    })

    const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(store), executionCwd: baseDir })
    expect(await (await projection.read())?.readBlock(0)).toMatchObject({
      kind: "question",
      toolUseId: "ask-cancelled",
      cancelled: true,
    })
    await projection.dispose()
    writer.getStorage().dispose()
  })
})
