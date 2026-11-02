import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { factRowsChanged } from "../../../../src/infra/sqlite-event-store-core.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { createConversationTreeProjection, releaseConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { openReplyWait, suspendReplyWaits } from "../../../../src/orchestration/session/reply-waits.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js"
import { conversationToolUseIds, createStartedAgentStates, readStartedAgentsLive } from "../../../../src/orchestration/workflow-host/started-agent-states.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { publishWorkerAttempt } from "./_workflow-host-fixtures.js"

const temporary = temporaryDirectories()

/** Two started agents of workflow `wf`. The runtime cut a batch of agent
 *  `a` whose message_session call only an open reply wait of `a` marks as a
 *  wait. The owner and the waits read through `gate(reader)`. */
async function cutOnWait(gate: (reader: AsyncEventStateReadSurface) => AsyncEventStateReadSurface = (reader) => reader) {
  const dir = temporary("flywheel-started-agents-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  const counter = countStateRequests(reader)
  const read = gate(counter.reader)
  const states = createStartedAgentStates({ reader: read, onStored: store.onStored })
  const { member } = await publishWorkerAttempt({ projectRoot: dir, reader, writer, workflowId: "wf", attemptId: "a", conversationId: "conv-a", siblings: [{ attemptId: "b", conversationId: "conv-b" }] })
  const other = await workflowMembershipReader(reader).attempt("wf", "b")
  const tree = await tryOpenConversationTree({ conversationId: "conv-a", sessionId: member.sessionId, store: reader, writer })
  if (!tree || !other) throw new Error("Expected both agents")
  await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "ask", name: "message_session", input: { to: other.sessionId, wait: true } }] })
  await tree.appendMessage({ kind: "toolResult", toolUseId: "ask", content: [{ type: "text", text: "Waiting." }] })
  const end = interruptedTurnEnd("replacement")
  await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage(end.pausedBy, false) }, turnEndEntryId(end, "cut"))
  // The waits key their listeners by the project's reader, which the owner reads through.
  const deps = { projectionReader: read, eventWriter: writer, addresseeState: async () => "running" as const, lineage: async (sessionId: string) => [sessionId] }
  const tasks = (sessionId: string) => ({ sessionId, tasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }) })
  return {
    store, reader, counter, states, member, other, end, deps, tasks,
    turnEndOfA: async () => (await states.turnEnds("wf")).find(({ attemptId }) => attemptId === "a")?.turnEnd,
    dispose() { suspendReplyWaits(read); states.dispose(); store.close() },
  }
}

/** Workflow `wf` with `agents` started agents, each conversation holding
 *  `turns` tool calls with their results. */
async function startedAgents(agents: number, turns: number) {
  const dir = temporary("flywheel-started-agents-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  const counter = countStateRequests(reader)
  const states = createStartedAgentStates({ reader: counter.reader, onStored: store.onStored })
  const bindings = Array.from({ length: agents }, (_, index) => ({ attemptId: `a${index}`, conversationId: `conv-${index}` }))
  const [first, ...siblings] = bindings
  if (!first) throw new Error("Expected an agent")
  await publishWorkerAttempt({ projectRoot: dir, reader, writer, workflowId: "wf", ...first, siblings })
  const trees = await Promise.all(bindings.map(async ({ attemptId, conversationId }) => {
    const member = await workflowMembershipReader(reader).attempt("wf", attemptId)
    const tree = member && await tryOpenConversationTree({ conversationId, sessionId: member.sessionId, store: reader, writer })
    if (!tree) throw new Error(`Expected agent ${attemptId}`)
    return tree
  }))
  const call = async (tree: (typeof trees)[number], id: string) => {
    const assistant = await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id, name: "read", input: {} }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "Read." }] })
    return assistant
  }
  for (const [index, tree] of trees.entries()) for (let turn = 0; turn < turns; turn++) await call(tree, `call-${index}-${turn}`)
  const conversationIds = bindings.map(({ conversationId }) => conversationId)
  return {
    dir, store, reader, counter, states, trees, call, conversationIds,
    operations: async () => new Map([...await states.conversations("wf", conversationIds, () => true)].map(([id, live]) => [id, live.operations])),
    dispose() { states.dispose(); store.close() },
  }
}

/** The operation count of conversation `conversationId` of workflow `wf`,
 *  as a new conversation tree and a new owner each count it from the whole
 *  history in the store now. */
async function freshCounts(f: Awaited<ReturnType<typeof startedAgents>>, conversationId: string) {
  releaseConversationTreeProjection(f.reader, conversationId)
  const states = createStartedAgentStates({ reader: f.reader, onStored: f.store.onStored })
  try {
    const tree = await createConversationTreeProjection(f.reader, conversationId).replay()
    const live = await states.conversations("wf", [conversationId], () => true)
    return { tree: new Set(conversationToolUseIds(tree)).size, owner: live.get(conversationId)?.operations, gaps: tree.degraded.length }
  } finally { states.dispose() }
}

describe("started agent states", () => {
  test("an entry appended to one agent's conversation reads only the facts after that agent's last count, whatever the number of agents and the length of their history", async () => {
    const perChange = async (agents: number, turns: number) => {
      const f = await startedAgents(agents, turns)
      try {
        expect([...(await f.operations()).values()]).toEqual(Array.from({ length: agents }, () => turns))
        const costs: string[][] = []
        for (let change = 0; change < 3; change++) {
          const index = (change * 7) % agents
          await f.call(f.trees[index]!, `new-${change}`)
          f.counter.take()
          expect((await f.operations()).get(`conv-${index}`)).toBe(turns + 1 + Math.floor(change / agents))
          const requests = f.counter.take()
          // The count reads one page, after the position of the last count.
          for (const request of requests.filter(({ method }) => method === "readPage")) expect(request.args[2]).toBeGreaterThan(0)
          costs.push(requests.map(({ method, aggregateId }) => `${method} ${aggregateId}`))
        }
        return costs
      } finally { f.dispose() }
    }
    const few = await perChange(3, 1)
    const many = await perChange(30, 4)
    expect(few.map((reads) => reads.length)).toEqual(many.map((reads) => reads.length))
    expect(new Set(many.flat().map((read) => read.split(" ")[0]))).toEqual(new Set(["readPage", "readSlice"]))
  })

  test("the operation count of a parked agent counts the tool calls of every branch of its conversation, as the conversation tree holds them", async () => {
    const f = await startedAgents(2, 0)
    try {
      const [tree] = f.trees
      if (!tree) throw new Error("Expected the agent's conversation")
      const first = await f.call(tree, "first")
      await f.call(tree, "second")
      await tree.moveTo(first)
      await f.call(tree, "rewound")
      expect(new Set(conversationToolUseIds(await createConversationTreeProjection(f.reader, "conv-0").replay())).size).toBe(3)
      expect((await f.operations()).get("conv-0")).toBe(3)
    } finally { f.dispose() }
  })

  test("the operation count of a parked agent leaves out the calls of a batch whose referenced tool output no longer verifies, as the conversation tree does", async () => {
    const f = await startedAgents(2, 1)
    const [tree] = f.trees
    if (!tree) throw new Error("Expected the agent's conversation")
    await tree.appendMessages([
      { kind: "assistant", content: [{ type: "tool_use", id: "lost", name: "read", input: {} }] },
      { kind: "toolResult", toolUseId: "lost", content: [{ type: "text", text: "x".repeat(4096) }] },
    ])
    // The next call continues from the damaged batch's result.
    await f.call(tree, "after")
    try {
      const db = new Database(resolveEventStoreDbFile(f.dir))
      try { expect(db.query("update tool_content set content = 'damaged'").run().changes).toBe(1) } finally { db.close() }
      expect(await freshCounts(f, "conv-0")).toEqual({ tree: 2, owner: 2, gaps: 1 })
    } finally { f.dispose() }
  })

  test("the operation count of a parked agent leaves out the calls of a disconnected entry and of a duplicate entry, as the conversation tree does", async () => {
    const f = await startedAgents(2, 0)
    const [tree] = f.trees
    if (!tree) throw new Error("Expected the agent's conversation")
    const first = await tree.getEntry(await f.call(tree, "first"))
    if (!first) throw new Error("Expected the first call")
    const append = (entries: readonly unknown[]) => f.store.append({
      aggregateId: "conversation:conv-0", type: "chat.entries.appended", version: 1, timestamp: Date.now(), actor: "flywheel", sessionId: "s",
      payload: { conversationId: "conv-0", entries },
    })
    const assistant = (id: string, parentId: string | null, toolUseId: string) => ({
      kind: "message", id, parentId, timestamp: new Date().toISOString(),
      message: { kind: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "read", input: {} }] },
    })
    append([assistant("stray", "nowhere", "disconnected")])
    append([assistant(first.id, first.parentId, "duplicate")])
    try {
      expect(await freshCounts(f, "conv-0")).toEqual({ tree: 1, owner: 1, gaps: 2 })
    } finally { f.dispose() }
  })

  test("the operation count of a parked agent fails as the conversation tree does when the conversation's creation cannot be read", async () => {
    const f = await startedAgents(2, 0)
    const [tree] = f.trees
    if (!tree) throw new Error("Expected the agent's conversation")
    await f.call(tree, "intact")
    try {
      const db = new Database(resolveEventStoreDbFile(f.dir))
      try {
        db.query("update event set payload = '{broken' where aggregate_id = 'conversation:conv-0' and type = 'chat.tree.created'").run()
        expect(factRowsChanged(db)).toBe(1)
      } finally { db.close() }
      const failure = "chat.tree.created has not been observed"
      releaseConversationTreeProjection(f.reader, "conv-0")
      await expect(createConversationTreeProjection(f.reader, "conv-0").replay()).rejects.toThrow(failure)
      await expect(readStartedAgentsLive(f.reader).conversations("wf", ["conv-0"], () => true)).rejects.toThrow(failure)
      const states = createStartedAgentStates({ reader: f.reader, onStored: f.store.onStored })
      try {
        await expect(states.conversations("wf", ["conv-0"], () => true)).rejects.toThrow(failure)
      } finally { states.dispose() }
    } finally { f.dispose() }
  })

  test("a change of the reply waits that decided an agent's turn end reads that agent again, and no other change of waits reads anything", async () => {
    const f = await cutOnWait()
    const { counter, states, member, other, end, deps, tasks, turnEndOfA } = f
    try {
      expect(await turnEndOfA()).toEqual({ end, recorded: true })

      const moved: string[][] = []
      states.onChange((workflowIds) => { moved.push([...workflowIds]) })
      // A wait of a waiter whose waits decided no turn end moves nothing.
      const unrelated = await openReplyWait(deps, { waiter: tasks(other.sessionId), addressee: { sessionId: member.sessionId, name: "A" }, toolUseId: "unrelated" })
      expect(moved).toEqual([])
      counter.take()
      expect(await turnEndOfA()).toEqual({ end, recorded: true })
      expect(counter.take()).toEqual([])

      const opened = await openReplyWait(deps, { waiter: tasks(member.sessionId), addressee: { sessionId: other.sessionId, name: "B" }, toolUseId: "ask" })
      expect(moved).toEqual([["wf"]])
      counter.take()
      expect(await turnEndOfA()).toEqual({ end, recorded: true, backgroundWait: true })
      // This agent's tail, one batch for each read, and one read of its waiter's waits; nothing of the other agent.
      const reads = counter.take().map(({ method, aggregateId }) => `${method} ${aggregateId}`)
      expect(new Set(reads)).toEqual(new Set(["readSlice conversation:conv-a", `readInFlight ${member.sessionId}`]))
      expect(reads.filter((read) => read.startsWith("readInFlight"))).toHaveLength(1)
      unrelated.withdraw()
      opened.withdraw()
      await Bun.sleep(0)
      expect(moved).toEqual([["wf"], ["wf"]])
      expect(await turnEndOfA()).toEqual({ end, recorded: true })
    } finally { f.dispose() }
  })

  test("a wait that opens after a turn-end read took the waits, and before that read finished, reads the agent again", async () => {
    /** Runs once, when the next read of the reply waits has taken them. */
    let afterWaitsRead: (() => Promise<void>) | undefined
    const f = await cutOnWait((reader) => ({
      ...reader,
      async readInFlight(...args: Parameters<AsyncEventStateReadSurface["readInFlight"]>) {
        const rows = await reader.readInFlight(...args)
        const run = afterWaitsRead
        afterWaitsRead = undefined
        await run?.()
        return rows
      },
    }))
    const { states, member, other, end, deps, tasks, turnEndOfA } = f
    try {
      const moved: string[][] = []
      states.onChange((workflowIds) => { moved.push([...workflowIds]) })
      let opened: Awaited<ReturnType<typeof openReplyWait>> | undefined
      afterWaitsRead = async () => { opened = await openReplyWait(deps, { waiter: tasks(member.sessionId), addressee: { sessionId: other.sessionId, name: "B" }, toolUseId: "ask" }) }
      // The read took the waits before the wait opened, so it shows none.
      expect(await turnEndOfA()).toEqual({ end, recorded: true })
      expect(opened).toBeDefined()
      expect(moved).toEqual([["wf"]])
      expect(await turnEndOfA()).toEqual({ end, recorded: true, backgroundWait: true })
      opened?.withdraw()
    } finally { f.dispose() }
  })
})
