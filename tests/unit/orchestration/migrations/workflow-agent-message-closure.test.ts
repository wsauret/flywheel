import { expect, test } from "bun:test"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { legacyWorkflowFixture } from "../../../helpers/workflow-agent-legacy-fixtures.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { convertWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js"
import { readUnreadMessages, readWorkflowQueuedUserInputs, dropQueuedUserInput } from "../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { readConversationSnapshotSync } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { historicalWorkflowPublicationFacts } from "../../../release/fixtures/historical-workflow-publication.js"
import { recoverSessionMessageProducer, sessionMessageSourcesSync } from "../../../../src/orchestration/session/session-message-sources.js"
import type { EventStoreReadSurface } from "../../../../src/infra/event-store-types.js"
import { parseWorkflowSessionFact, workflowRootControl } from "../../../../src/workflows/vm/session-facts.js"

const temporary = temporaryDirectories()

test("conversion closes foreign workflow waits once and resolves the exact historical sender without changing committed bytes", async () => {
  const root = temporary("workflow-message-closure-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  f.store.append({ aggregateId: "conversation:parent-conversation", sessionId: "parent", type: "chat.tree.created", version: 1, timestamp: 0, actor: "flywheel",
    payload: JSON.parse('{"conversationId":"parent-conversation","createdAt":"2026-10-16T00:00:00.000Z"}') })
  f.store.append({ aggregateId: "conversation:parent-conversation", sessionId: "parent", type: "chat.entries.appended", version: 5, timestamp: 1, actor: "flywheel",
    payload: JSON.parse('{"conversationId":"parent-conversation","entries":[{"id":"question","parentId":null,"timestamp":"2026-10-16T00:00:00.000Z","kind":"message","message":{"kind":"user","content":"Question","producer":{"kind":"session","sessionId":"old","conversationId":"generation-one","toolUseId":"ask","hop":0,"envelope":{"name":"Agent","relation":"child","waits":true}}}}]}') })
  f.store.putInFlight("parent", "session.reply_wait", "old:wait-call", JSON.parse('{"openedAtMs":1,"readKey":"msg:parent:wait-call"}'))
  f.store.putInFlight("parent", "session.reply_wait", "old:existing-call", JSON.parse('{"openedAtMs":1}'))
  f.store.putInFlight("parent", "chat.queued_background_notification", "reply-wait:old:existing-call", JSON.parse('{"conversationId":"parent-conversation","text":"Existing end notice"}'))
  f.store.putInFlight("parent", "chat.queued_user_input", "msg:old:next", JSON.parse('{"conversationId":"parent-conversation","text":"Held","producer":{"kind":"session","sessionId":"old","conversationId":"generation-one","toolUseId":"next","hop":0}}'))
  const raw = f.store.read({ aggregateId: "conversation:parent-conversation" })
  f.store.close()
  expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(store.read({ aggregateId: "conversation:parent-conversation" })).toEqual(raw)
    expect(store.readInFlight("parent", "session.reply_wait")).toEqual([])
    const notice = store.readInFlight("parent", "chat.queued_background_notification")
    expect(notice).toHaveLength(2)
    expect(notice.find(row => row.key === "reply-wait:old:wait-call")?.payload.text).toBe("This reply wait ended because the workflow is orchestration, not an answering agent. Its delivered message is preserved. Use process wait for workflow completion, or message the particular agent session for a reply.")
    expect(notice.find(row => row.key === "reply-wait:old:existing-call")?.payload.text).toBe("Existing end notice")
    const reader = asAsyncEventReadSurface(store)
    const first = (await workflowMembershipReader(reader).list("old")).find(row => row.conversationId === "generation-one")!
    const history = readConversationSnapshotSync(store, "parent-conversation")
    expect(history.entriesById.question).toMatchObject({ message: { producer: { sessionId: first.sessionId } } })
    const inputs = await readUnreadMessages(reader, "parent")
    expect(inputs[0]).toMatchObject({ key: "msg:old:next", producer: { sessionId: first.sessionId, conversationId: "generation-one" } })
    const before = store.currentPosition()
    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(0)
    expect(store.currentPosition()).toBe(before)
    expect(store.readInFlight("parent", "chat.queued_background_notification")).toEqual(notice)
  } finally { store.close() }
})

test("an unproven private reply remains unread with its original dispatch identity and is not workflow direction", async () => {
  const root = temporary("workflow-message-gap-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  try {
    f.store.putInFlight("old", "chat.queued_user_input", "msg:parent:unproven", JSON.parse('{"target":"workflow","text":"Retained answer","producer":{"kind":"session","sessionId":"parent","conversationId":"parent-conversation","toolUseId":"unproven","hop":1}}'))
    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)
    const reader = asAsyncEventReadSurface(f.store)
    expect(await readWorkflowQueuedUserInputs(reader, "old")).toEqual([])
    const unread = await readUnreadMessages(reader, "old")
    expect(unread).toMatchObject([{ key: "msg:parent:unproven", retainedGap: true, text: "Retained answer", producer: { sessionId: "parent" } }])
    expect(f.store.readInFlight("parent", "chat.queued_background_notification")[0]?.payload.text).toBe("A historical private message could not be assigned to an agent. It remains retained and was not added as workflow direction.")
    await dropQueuedUserInput(asAsyncEventWriter(f.store), "old", unread[0]!.key, unread[0]!.retainedGap)
    expect(await readUnreadMessages(reader, "old")).toEqual([])
  } finally { f.store.close() }
})

test("one conversion pass attributes messages across workflows and incrementally decodes new sender sessions", async () => {
  const root = temporary("workflow-message-incremental-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  try {
    for (const fact of historicalWorkflowPublicationFacts({
      childSessionId: "later", parentSessionId: "parent", description: "Later workflow",
      projectRoot: root, timestamp: 2, completed: false,
    })) {
      if (fact.type === "workflow.control.initialized") {
        const parsed = parseWorkflowSessionFact({ type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload })
        if (parsed.type !== "workflow.control.initialized") throw new Error("Expected the historical workflow root")
        const control = workflowRootControl(parsed)
        fact.payload = { control: { ...control, attempts: control.attempts.map(attempt => ({
          ...attempt, conversationId: "later-generation", state: { _tag: "running" },
        })) } }
      }
      f.store.append(fact)
    }
    f.store.append({ aggregateId: "conversation:later-generation", sessionId: "later", type: "chat.tree.created", version: 1, timestamp: 3, actor: "flywheel",
      payload: { conversationId: "later-generation", createdAt: "2026-10-16T00:00:00.000Z" } })
    f.store.append({ aggregateId: "conversation:later-generation", sessionId: "later", type: "chat.entries.appended", version: 5, timestamp: 4, actor: "flywheel",
      payload: JSON.parse('{"conversationId":"later-generation","entries":[{"id":"earlier-sender","parentId":null,"timestamp":"2026-10-16T00:00:00.000Z","kind":"message","message":{"kind":"user","content":"Earlier workflow","producer":{"kind":"session","sessionId":"old","conversationId":"generation-one","toolUseId":"earlier","hop":0}}},{"id":"current-sender","parentId":"earlier-sender","timestamp":"2026-10-16T00:00:00.000Z","kind":"message","message":{"kind":"user","content":"Current workflow","producer":{"kind":"session","sessionId":"later","conversationId":"later-generation","toolUseId":"current","hop":0}}}]}') })

    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(2)
    const membership = workflowMembershipReader(asAsyncEventReadSurface(f.store))
    const earlier = (await membership.list("old")).find(row => row.conversationId === "generation-one")!
    const later = (await membership.list("later")).find(row => row.conversationId === "later-generation")!
    const batches: number[][] = []
    const reader: EventStoreReadSurface = {
      ...f.store,
      readTolerant(query) {
        const rows = f.store.readTolerant(query)
        batches.push(rows.map(row => row.position))
        return rows
      },
    }
    const readSources = sessionMessageSourcesSync(reader)
    const sources = readSources()
    const history = readConversationSnapshotSync(f.store, "later-generation", sources)
    expect(history.entriesById["earlier-sender"]).toMatchObject({ message: { producer: { sessionId: earlier.sessionId } } })
    expect(history.entriesById["current-sender"]).toMatchObject({ message: { producer: { sessionId: later.sessionId } } })

    const created = f.store.read({ aggregateId: `session:${later.sessionId}`, types: ["session.created"] })[0]!
    const appended = f.store.append({
      aggregateId: "session:next-agent", sessionId: "next-agent", type: created.type, version: created.version, actor: created.actor, timestamp: 5,
      payload: { ...created.payload, conversationId: "next-generation", importedResources: { workflowId: "later", conversationId: "next-generation" } },
    })
    const nextSources = readSources()
    expect(recoverSessionMessageProducer({
      kind: "session", sessionId: "later", conversationId: "next-generation", toolUseId: "next", hop: 0,
    }, nextSources)).toMatchObject({ sessionId: "next-agent", conversationId: "next-generation" })
    expect(readConversationSnapshotSync(f.store, "later-generation", nextSources).entriesById["earlier-sender"])
      .toMatchObject({ message: { producer: { sessionId: earlier.sessionId } } })
    expect(batches).toEqual([
      f.store.read({ types: ["session.created"], beforePosition: appended.position }).map(row => row.position),
      [appended.position],
    ])
  } finally { f.store.close() }
})
