// A question that an earlier build left behind a later entry (ANS-4,
// PI-INTERACTION-185): its answer or skip still reaches the agent and
// continues the chat. Remove with the conversion after 2027-05-24.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../src/infra/substrate/store/event-store-types.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input/agent-input-projection.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js"
import { settleLateQuestion } from "../../../../src/orchestration/session/history/agent-input-reconciliation.js"
import { type Step, askCall, ask, reply, type Chat, newSupervisor, until, quiesce, describeMessage, fromAsk, heldCells, pendingAsk, settle, questionAtRest, attach, questionHoldChats } from "./_question-hold-fixtures.js"

const withChat = questionHoldChats()

setDefaultTimeout(30_000)

/** The previous shape (ANS-4): an earlier build committed a notice after the
 *  ask while its question waited. Remove with the conversion after 2027-05-24. */
async function appendAfterAsk(chat: Chat, text: string): Promise<void> {
  const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
  if (!tree) throw new Error("missing conversation tree")
  try { await tree.appendMessage({ kind: "user", content: text, origin: "system" }) } finally { tree.dispose() }
}

describe("a question an earlier build left behind a later entry", () => {
  for (const how of ["answer", "skip"] as const) test(`its ${how} reaches the model as one entry and continues the chat with one request`, async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      await appendAfterAsk(chat, "An earlier notice.")
      const mark = chat.model.requests.length
      expect(await settle(chat, how)).toEqual({ ok: true })
      await until("the reply", async () => chat.model.requests.length > mark && (await fromAsk(chat)).at(-1)?.startsWith("assistant(") === true)
      await quiesce()
      const branch = await fromAsk(chat)
      expect(branch).toHaveLength(4)
      expect(branch[1]).toContain("An earlier notice.")
      expect(branch[2]).toContain("<late-question-settlement")
      expect(branch[2]).toContain(how === "answer" ? "Continue?" : "User skipped the question")
      expect(chat.model.requests.length).toBe(mark + 1)
      const request = chat.model.requests[mark]?.map(describeMessage) ?? []
      expect(request.filter((entry) => entry.includes("<late-question-settlement"))).toHaveLength(1)
      expect(request.at(-1)).toContain("<late-question-settlement")
    })
  })

  test("a stop after the settlement entry and before its fact loses neither, and the retry adds no second entry", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      await appendAfterAsk(chat, "An earlier notice.")
      const interaction = await pendingAsk(chat)
      if (interaction?.kind !== "pending") throw new Error("no pending question")
      const reader = asAsyncEventReadSurface(chat.ctx.store)
      expect(await settleLateQuestion({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: reader, projectionReader: reader, writer: chat.writer }, interaction, { kind: "cancelled" })).toEqual({ kind: "appended" })
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model)
      const mark = chat.model.requests.length
      expect(await settle(chat, "skip")).toEqual({ ok: true })
      await until("the reply", async () => chat.model.requests.length > mark && (await fromAsk(chat)).at(-1)?.startsWith("assistant(") === true)
      expect((await fromAsk(chat)).filter((entry) => entry.includes("<late-question-settlement"))).toHaveLength(1)
      expect(chat.model.requests.length).toBe(mark + 1)
    })
  })

  for (const where of ["parked", "at rest"] as const) test(`behind a newer question that waits (${where}), its settlement waits too and lands after the newer answer`, async () => {
    const newerAsk: Step = () => [{ kind: "tool_use", toolCall: { ...askCall, id: "ask-2" } }, { kind: "done", stopReason: "tool_use" }]
    await withChat([ask, newerAsk, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      await appendAfterAsk(chat, "An earlier notice.")
      // An earlier build let the chat continue and ask again.
      await attach(chat)
      expect(await chat.supervisor.sendChat(chat.sessionId, "Go on.")).toMatchObject({ ok: true })
      await until("the newer question", async () => (await loadAgentInputProjection(asAsyncEventReadSurface(chat.ctx.store), chat.sessionId)).get("ask-2")?.kind === "pending")
      await quiesce()
      if (where === "at rest") {
        await chat.supervisor.disposeAll()
        chat.supervisor = newSupervisor(chat.ctx, chat.model)
        await attach(chat)
      }
      const mark = chat.model.requests.length
      expect(await settle(chat, "skip")).toEqual({ ok: true })
      await quiesce()
      expect(chat.model.requests.length).toBe(mark)
      expect((await fromAsk(chat)).at(-1)).toBe("assistant(call:ask_user#ask-2)")
      expect(await heldCells(chat)).toBe(1)
      expect(await chat.supervisor.cancelQuestion(chat.sessionId, "ask-2")).toEqual({ ok: true })
      await until("the reply", async () => chat.model.requests.length > mark && (await fromAsk(chat)).at(-1)?.startsWith("assistant(") === true)
      const branch = await fromAsk(chat)
      expect(branch[0]).toBe("assistant(call:ask_user#ask-2)")
      expect(branch[1]).toStartWith("toolResult#ask-2")
      expect(branch[2]).toContain("<late-question-settlement tool-use-id=\"ask-1\"")
      expect(chat.model.requests.length).toBe(mark + 1)
    })
  })
})
