// When a root chat records `chat.turn.stopped` and `chat.turn.started`
// (ARCH-SESSIONS-051, PI-INTERACTION-186), on a real supervisor, chat
// runner, and agent loop with a scripted model.
import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/substrate/store/event-store-types.js"
import type { BackgroundWorkMeta, BackgroundWorkResult } from "../../../../src/orchestration/session/control/background-work/background-work-types.js"
import { ProviderRequestValidationError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js"
import { turnEndOfEntry } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { ask, attach, describeMessage, newSupervisor, peerMessage, pendingAsk, questionHoldChats, quiesce, reply, settle, until, type Chat, type Step } from "./_question-hold-fixtures.js"

const withChat = questionHoldChats()

/** The session's stop and start facts in store order, as `stop` and `start`. */
function turnFacts(chat: Chat): StoredFact[] {
  return chat.ctx.store.read({ aggregateId: `session:${chat.sessionId}`, types: ["chat.turn.stopped", "chat.turn.started"] })
}
const stops = (chat: Chat): StoredFact[] => turnFacts(chat).filter((fact) => fact.type === "chat.turn.stopped")
const kinds = (chat: Chat): string[] => turnFacts(chat).map((fact) => fact.type === "chat.turn.stopped" ? "stop" : "start")

async function branch(chat: Chat) {
  const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
  if (!tree) return []
  try { return await tree.getBranch() } finally { tree.dispose() }
}

/** The entry of the assistant message with `text`. */
async function answerId(chat: Chat, text: string): Promise<string | undefined> {
  return (await branch(chat)).find((entry) => entry.kind === "message" && describeMessage(entry.message) === `assistant(${text})`)?.id
}

function runner(chat: Chat) {
  const live = chat.ctx.sessionStore.get(chat.sessionId)?.runner
  if (!live) throw new Error("the chat has no runner")
  return live
}

const send = async (chat: Chat, text: string) => { expect(await chat.supervisor.sendChat(chat.sessionId, text)).toMatchObject({ ok: true }) }

/** Runs `step` once the chat exists: a step is scripted before its chat opens. */
function inChat(step: (chat: Chat, messages: Parameters<Step>[0]) => ReturnType<Step>) {
  let chat: Chat | undefined
  return { bind: (bound: Chat) => { chat = bound }, step: ((messages) => { if (!chat) throw new Error("unbound step"); return step(chat, messages) }) satisfies Step }
}

/** A response with no text and no call: the turn ends with nothing new to read. */
const silent: Step = () => [{ kind: "done", stopReason: "end_turn" }]

const waitCall: Step = () => [{ kind: "tool_use", toolCall: { id: "wait-1", name: "process", input: { action: "wait", soft_timeout: 600 } } }, { kind: "done", stopReason: "tool_use" }]

describe("chat turn stops", () => {
  test("a final message records one stop that names its entry and its first line after one start; each later turn records its own pair", async () => {
    await withChat([reply("## Summary\n\nFirst **answer**.\nMore detail."), reply("Second answer.")], async (chat) => {
      await send(chat, "Hi.")
      await until("the first stop", () => stops(chat).length === 1)
      const [first] = stops(chat)
      const firstAnswer = await answerId(chat, "## Summary\n\nFirst **answer**.\nMore detail.")
      expect(firstAnswer).toBeString()
      expect(first?.payload).toEqual({ conversationId: chat.conversationId, ending: { kind: "completed" }, finalEntryId: firstAnswer, firstLine: "First answer." })
      // The stop is a later write than the entry it names.
      const entryCommit = chat.ctx.store.read({ aggregateId: `conversation:${chat.conversationId}`, types: ["chat.entries.appended"] }).find((fact) => JSON.stringify(fact.payload).includes(`"${firstAnswer}"`))
      expect(entryCommit?.position).toBeLessThan(first?.position ?? 0)
      await quiesce()
      expect(kinds(chat)).toEqual(["start", "stop"])

      await send(chat, "Again.")
      await until("the second stop", () => stops(chat).length === 2)
      expect(stops(chat)[1]?.payload).toMatchObject({ finalEntryId: await answerId(chat, "Second answer."), firstLine: "Second answer." })
      expect(kinds(chat)).toEqual(["start", "stop", "start", "stop"])
    })
  })

  test("a chat that a later runner reopens at rest records nothing", async () => {
    await withChat([reply("Done.")], async (chat) => {
      await send(chat, "Hi.")
      await until("the stop", () => stops(chat).length === 1)
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model)
      await attach(chat)
      await quiesce()
      expect(kinds(chat)).toEqual(["start", "stop"])
      expect(chat.model.requests).toHaveLength(1)
    })
  })

  const WORK: readonly (readonly [string, BackgroundWorkMeta])[] = [
    ["a background command", { id: "bash-bg-1", type: "background_command", description: "build" }],
    ["a subagent", { id: "agent-1", type: "subagent", description: "explore" }],
    ["a workflow", { id: "workflow-1", type: "workflow", description: "review" }],
    ["a watch", { id: "bash-bg-watch", type: "background_command", description: "tail -f app.log", notificationKey: "watch:bash-bg-watch:end", watch: true }],
  ]

  test.each(WORK)("a final message while %s still runs records no stop until the work ends and the turn answers", async (_label, meta) => {
    const work = Promise.withResolvers<BackgroundWorkResult>()
    const started = inChat((chat, messages) => {
      runner(chat).backgroundTasks.track({ done: work.promise, meta })
      return reply("Started it.")(messages)
    })
    // The second request answers the pending-work reminder; the loop then waits on the agent's behalf.
    await withChat([started.step, reply("Still waiting."), reply("All done.")], async (chat) => {
      started.bind(chat)
      try {
        await send(chat, "Start it.")
        await until("the park on the work", async () => chat.model.requests.length === 2 && await runner(chat).messageState() === "waiting_on_work")
        await quiesce()
        expect(await answerId(chat, "Still waiting.")).toBeString()
        expect(kinds(chat)).toEqual(["start"])

        work.resolve({ status: "completed", content: "the work finished" })
        // A child run's end reaches its parent as the durable completion that
        // reconciliation delivers; a command's end is its registry's own notice.
        if (meta.type !== "background_command") expect(await runner(chat).deliverBackgroundNotification({ text: "The child run finished.", completionRunIds: [meta.id] })).toBe(true)
        await until("the stop", () => stops(chat).length === 1)
        expect(stops(chat)[0]?.payload).toMatchObject({ finalEntryId: await answerId(chat, "All done."), ending: { kind: "completed" } })
        // The notice continued the parked turn, which records its start.
        expect(kinds(chat)).toEqual(["start", "start", "stop"])
      } finally { work.resolve({ status: "completed", content: "" }) }
    })
  })

  test("a turn parked on a wait call records no stop, and an interrupt of that park records none", async () => {
    const work = Promise.withResolvers<BackgroundWorkResult>()
    const waits = inChat((chat, messages) => {
      runner(chat).backgroundTasks.track({ done: work.promise, meta: { id: "bash-bg-1", type: "background_command", description: "build" } })
      return waitCall(messages)
    })
    // The second request answers the reply reminder that follows a wait call with no text for the person.
    await withChat([waits.step, reply("Waiting for the build.")], async (chat) => {
      waits.bind(chat)
      try {
        await send(chat, "Build it.")
        await until("the park on the wait", async () => chat.model.requests.length === 2 && await runner(chat).messageState() === "waiting_on_work")
        await quiesce()
        expect((await branch(chat)).at(-1)?.id).toBe(await answerId(chat, "Waiting for the build."))
        expect(stops(chat)).toEqual([])

        expect(await chat.supervisor.interruptSession(chat.sessionId, "person")).toBe(true)
        await until("the interrupt's park", async () => await runner(chat).messageState() === "interrupted")
        await quiesce()
        expect(stops(chat)).toEqual([])
      } finally { work.resolve({ status: "completed", content: "" }) }
    })
  })

  test("a pending question records no stop; the answer's turn records one when it ends", async () => {
    await withChat([ask, reply("Thanks.")], async (chat) => {
      await send(chat, "Ask me.")
      await until("the question", async () => (await pendingAsk(chat))?.kind === "pending" && chat.ctx.sessionStore.get(chat.sessionId)?.runnerState === "awaiting_user")
      await quiesce()
      expect(stops(chat)).toEqual([])
      await settle(chat)
      await until("the stop", () => stops(chat).length === 1)
      expect(stops(chat)[0]?.payload).toMatchObject({ finalEntryId: await answerId(chat, "Thanks."), ending: { kind: "completed" } })
    })
  })

  test("the answer to a question that waits at rest records the start of the turn it continues, then its stop", async () => {
    await withChat([ask, reply("Thanks.")], async (chat) => {
      await send(chat, "Ask me.")
      await until("the question", async () => (await pendingAsk(chat))?.kind === "pending" && chat.ctx.sessionStore.get(chat.sessionId)?.runnerState === "awaiting_user")
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model)
      await attach(chat)
      expect(kinds(chat)).toEqual(["start"])
      await settle(chat)
      await until("the stop", () => stops(chat).length === 1)
      expect(kinds(chat)).toEqual(["start", "start", "stop"])
      expect(stops(chat)[0]?.payload).toMatchObject({ finalEntryId: await answerId(chat, "Thanks.") })
    })
  })

  test("a person's interrupt of a running request records no stop", async () => {
    const gate = Promise.withResolvers<void>()
    await withChat([async (messages) => { await gate.promise; return reply("Late.")(messages) }], async (chat) => {
      try {
        await send(chat, "Go.")
        await until("the request", () => chat.model.requests.length === 1)
        expect(await chat.supervisor.interruptSession(chat.sessionId, "person")).toBe(true)
        // The scripted model ignores the abort signal, so its request ends here.
        gate.resolve()
        await until("the interrupt's park", async () => await runner(chat).messageState() === "interrupted")
        await quiesce()
        expect(stops(chat)).toEqual([])
      } finally { gate.resolve() }
    })
  })

  test("the runtime's stop of a running request records no stop, and the reopened chat records none", async () => {
    const gate = Promise.withResolvers<void>()
    await withChat([async (messages) => { await gate.promise; return reply("Late.")(messages) }], async (chat) => {
      try {
        await send(chat, "Go.")
        await until("the request", () => chat.model.requests.length === 1)
        const disposed = chat.supervisor.disposeAll()
        gate.resolve()
        await disposed
        expect(stops(chat)).toEqual([])
        expect((await branch(chat)).some((entry) => { const end = turnEndOfEntry(entry); return end?.reason === "paused" && end.pausedBy === "runtime" })).toBe(true)
        chat.supervisor = newSupervisor(chat.ctx, chat.model)
        await attach(chat)
        expect(stops(chat)).toEqual([])
      } finally { gate.resolve() }
    })
  })

  test("a chat that the person closes during a turn records no stop", async () => {
    const gate = Promise.withResolvers<void>()
    await withChat([async (messages) => { await gate.promise; return reply("Late.")(messages) }], async (chat) => {
      try {
        await send(chat, "Go.")
        await until("the request", () => chat.model.requests.length === 1)
        const closed = chat.supervisor.closeChat(chat.sessionId)
        gate.resolve()
        expect(await closed).toBe(true)
        await quiesce()
        expect(stops(chat)).toEqual([])
      } finally { gate.resolve() }
    })
  })

  test("a request that the provider refuses records a stop that names the failure and no answer", async () => {
    const refuse: Step = () => { throw new ProviderRequestValidationError("anthropic", "bad request") }
    await withChat([refuse, refuse, refuse], async (chat) => {
      await send(chat, "Go.")
      await until("the stop", () => stops(chat).length === 1)
      expect(stops(chat)[0]?.payload).toEqual({ conversationId: chat.conversationId, ending: { kind: "failed", failure: "api_error" } })
      await quiesce()
      expect(kinds(chat)).toEqual(["start", "stop"])
    })
  })

  test("a compaction of a stopped chat records neither a start nor a second stop", async () => {
    const save: Step = () => [{ kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "durable checkpoint" } } }, { kind: "done", stopReason: "tool_use" }]
    await withChat([reply("The answer."), save], async (chat) => {
      await send(chat, "Hi.")
      await until("the stop", () => stops(chat).length === 1)
      expect(await chat.supervisor.compactChat(chat.sessionId)).toBe(true)
      await until("the reset", async () => (await branch(chat)).some((entry) => entry.kind === "compaction"))
      await until("the save round", () => chat.model.requests.length === 2)
      await quiesce()
      expect(kinds(chat)).toEqual(["start", "stop"])
    })
  })

  test("a message from another session continues a stopped chat with a start and stops it again", async () => {
    await withChat([reply("First answer."), reply("Second answer.")], async (chat) => {
      await send(chat, "Hi.")
      await until("the first stop", () => stops(chat).length === 1)
      await peerMessage(chat, "A note from a peer.", "peer-call-1")
      await until("the second stop", () => stops(chat).length === 2)
      expect(kinds(chat)).toEqual(["start", "stop", "start", "stop"])
      expect(stops(chat)[1]?.payload).toMatchObject({ finalEntryId: await answerId(chat, "Second answer.") })
    })
  })

  // Each stop replaces the one before it, so a turn that says nothing new
  // still names the answer that the person has not read.
  test("a message from another session whose turn says nothing new stops the chat again on the earlier answer", async () => {
    await withChat([reply("First answer."), silent], async (chat) => {
      await send(chat, "Hi.")
      await until("the first stop", () => stops(chat).length === 1)
      await peerMessage(chat, "A note from a peer.", "peer-call-1")
      await until("the second stop", () => stops(chat).length === 2)
      expect(kinds(chat)).toEqual(["start", "stop", "start", "stop"])
      expect(stops(chat)[1]?.payload).toEqual({ conversationId: chat.conversationId, ending: { kind: "completed" }, finalEntryId: await answerId(chat, "First answer."), firstLine: "First answer." })
    })
  })

  test("a reopened runner whose first turn says nothing new stops the chat on the answer of the runner before it", async () => {
    await withChat([reply("First answer."), silent], async (chat) => {
      await send(chat, "Hi.")
      await until("the first stop", () => stops(chat).length === 1)
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model)
      await attach(chat)
      await peerMessage(chat, "A note from a peer.", "peer-call-1")
      await until("the second stop", () => stops(chat).length === 2)
      expect(stops(chat)[1]?.payload).toEqual(stops(chat)[0]?.payload)
    })
  })
})
