import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { createLeadRows, type LeadRowChange } from "../../../../../src/orchestration/modules/lead/rows.js"
import type { RuntimeSupervisor } from "../../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorConversationFixture, supervisorWithRunner, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
let supervisor: RuntimeSupervisor
beforeEach(() => {
  ctx = createSupervisorTestContext()
  supervisor = supervisorWithRunner(ctx, async (deps) => mockRunner(deps.sessionId))
})
afterEach(async () => {
  await supervisor.disposeAll()
  await disposeSupervisorTestContext(ctx)
})
const conversation = supervisorConversationFixture(() => ctx)

const CHANGES = 20
/** Each turn's own number, so every run's turns differ from the turns of the runs before it. */
let turns = 0

async function appendTurn(chat: string, index: number): Promise<void> {
  const conversationId = await conversation.chatConversationId(chat)
  const timestamp = new Date().toISOString()
  await asAsyncEventWriter(ctx.store).append({
    aggregateId: `conversation:${conversationId}`, type: "chat.entries.appended", version: 7, timestamp: Date.now(), actor: "flywheel", sessionId: chat,
    payload: { conversationId, entries: [{ kind: "message", id: `${chat}-${index}`, parentId: null, timestamp, message: { kind: "assistant", content: [{ type: "text", text: `Step ${index} is done.` }] } }] },
  })
}

/** The durable requests, the facts they return, and the row patches of each of `CHANGES` changes to the first
 *  `members` chats, after the owner built its rows. */
async function costs(chats: readonly string[], members: number) {
  const counter = countStateRequests(asAsyncEventReadSurface(ctx.store))
  const published: LeadRowChange[] = []
  const interim: string[] = []
  const rows = createLeadRows({ reader: counter.reader, sessionManager: ctx.manager, sessionStore: ctx.sessionStore, sessionRuntime: () => null, readMark: () => undefined, seenMark: () => undefined, publish: (change) => { published.push(change) }, onRest: () => {}, onInterim: (sessionId) => { interim.push(sessionId) } })
  let observing: Promise<void> = Promise.resolve()
  const unsubscribe = ctx.store.onStored((events: readonly StoredFact[]) => { observing = observing.then(() => rows.observe(events)) })
  try {
    await rows.add(chats.slice(0, members))
    const perChange = []
    for (let index = 0; index < CHANGES; index += 1) {
      const chat = chats[index % members]!
      counter.take()
      published.length = 0
      interim.length = 0
      turns += 1
      await appendTurn(chat, 1_000 + turns)
      await observing
      const requests = counter.take()
      const changed = `conversation:${await conversation.chatConversationId(chat)}`
      perChange.push({
        requests: requests.length,
        factsRead: factsRead(requests),
        otherChats: requests.filter((request) => request.aggregateId !== changed).length,
        published: published.map((change) => change.kind === "updated" ? change.row.sessionId === chat : change.sessionId === chat),
        interim: interim.map((sessionId) => sessionId === chat),
      })
    }
    return perChange
  } finally {
    unsubscribe()
    await rows.dispose()
  }
}

test("a reorder and a removal in the session store read nothing durable and publish no unchanged row", async () => {
  const chats: string[] = []
  for (let index = 0; index < 30; index += 1) {
    const chat = await supervisor.openSessionRuntime()
    await conversation.appendConversation(chat, [{ kind: "user", content: "Fix it", origin: "human" }])
    chats.push(chat)
  }
  const other = await supervisor.openSessionRuntime()
  const counter = countStateRequests(asAsyncEventReadSurface(ctx.store))
  const published: LeadRowChange[] = []
  const rows = createLeadRows({ reader: counter.reader, sessionManager: ctx.manager, sessionStore: ctx.sessionStore, sessionRuntime: () => null, readMark: () => undefined, seenMark: () => undefined, publish: (change) => { published.push(change) }, onRest: () => {}, onInterim: () => {} })
  try {
    await rows.add(chats)
    // Each chat holds an open turn with no live work and no record, so each has a row that the sweep reads again.
    expect(rows.rows()).toHaveLength(chats.length)
    for (const change of [() => ctx.sessionStore.reorder(chats[1]!, chats[0]!), () => ctx.sessionStore.remove(other)]) {
      counter.take()
      published.length = 0
      await change()
      await Bun.sleep(1)
      expect({ requests: counter.take().length, published }).toEqual({ requests: 0, published: [] })
    }
  } finally {
    await rows.dispose()
  }
})

test("each change of a started chat costs the same durable requests for 3, 30, and 70 chats with short and long history", async () => {
  const chats: string[] = []
  for (let index = 0; index < 70; index += 1) {
    const chat = await supervisor.openSessionRuntime()
    await conversation.appendConversation(chat, [{ kind: "user", content: "Fix it", origin: "human" }])
    chats.push(chat)
  }
  const short = [await costs(chats, 3), await costs(chats, 30), await costs(chats, 70)]
  for (const chat of chats) for (let index = 0; index < 12; index += 1) await appendTurn(chat, index)
  const long = [await costs(chats, 3), await costs(chats, 30), await costs(chats, 70)]
  const [first] = short
  for (const run of [...short, ...long]) expect(run).toEqual(first!)
  // One read of the changed chat's new batch at most, and one row patch, for that chat only. A final message is no
  // interim text.
  for (const change of first!) {
    expect(change.requests).toBeLessThanOrEqual(1)
    expect(change.factsRead).toBeLessThanOrEqual(1)
    expect(change.otherChats).toBe(0)
    expect(change.published).toEqual([true])
    expect(change.interim).toEqual([])
  }
})
