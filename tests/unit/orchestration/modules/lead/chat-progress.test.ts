import { afterEach, beforeEach, expect, test } from "bun:test"
import { createChatProgressTool } from "../../../../../src/orchestration/modules/lead/chat-progress.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, supervisorConversationFixture, type SupervisorTestContext } from "../../../../fixtures/runtime-supervisor-fixtures.js"
import { makeContext } from "../../agent-runtime/tools/_fixtures.js"
import { leadHarness } from "./_lead-harness.js"

let ctx: SupervisorTestContext
let dispose: () => Promise<void> = async () => {}
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => {
  await dispose()
  await disposeSupervisorTestContext(ctx)
})
const conversation = supervisorConversationFixture(() => ctx)

const CONTEXT = "The login page has two forms.\nBoth call one handler, so a fix to one changes the other."
const QUESTION = { question: "Which form should change?", header: "Form", multiSelect: false, choices: [
  { kind: "option" as const, choiceId: "a", label: "Sign-in form", description: "Only the sign-in form gets the new check.", recommended: true },
  { kind: "option" as const, choiceId: "b", label: "Both forms" },
  { kind: "freeform" as const, label: "Other" },
] }

/** A chat that the lead started, which waits on its question to the person. */
async function chatWithQuestion() {
  const lead = leadHarness(ctx)
  dispose = lead.dispose
  const chat = await lead.supervisor.openSessionRuntime()
  await conversation.appendConversation(chat, [
    { kind: "user", content: "Add a sign-in form", origin: "human" },
    { kind: "assistant", content: [{ type: "text", text: "Added the sign-in form." }] },
  ])
  await conversation.appendConversation(chat, [
    { kind: "user", content: "Fix the login page", origin: "human" },
    { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: { context: CONTEXT, question: QUESTION.question } }] },
  ])
  await ctx.store.append({
    aggregateId: `session:${chat}`, sessionId: chat, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
    payload: { interactionId: "ask-1", conversationId: await conversation.chatConversationId(chat), toolUseId: "ask-1", request: [QUESTION] },
  })
  await lead.service.journal.append({ type: "lead.chat.started", payload: { sessionId: chat, sourceEntryIds: ["entry-1"] } })
  return { lead, chat, tool: createChatProgressTool((target) => lead.service.progress(target)) }
}

test("chat_progress answers a started chat's pending question, its context, and its options word for word", async () => {
  const { chat, tool } = await chatWithQuestion()
  const result = await tool.execute({ chat }, makeContext())
  expect(result.outcome).toBe("ok")
  const text = String(result.content)
  expect(text).toContain("The person's newest message in that chat:\nFix the login page")
  expect(text).toContain(`Context:\n${CONTEXT}\n`)
  expect(text).toContain(`Question (Form): ${QUESTION.question}`)
  expect(text).toContain("- Sign-in form: Only the sign-in form gets the new check. (recommended)\n- Both forms\n- Other (free text)")
  // The final message of the last completed turn comes before the person's newest message.
  expect(text).toContain("The final message of its last turn:\nAdded the sign-in form.")

  const roster = await tool.execute({}, makeContext())
  expect(String(roster.content)).toContain(`Chat ${chat} `)
  expect(String(roster.content)).toContain("A question waits for the person.")
})

test("a chat whose newest entry is the person's forwarded message reads as starting while its runner starts, and as failed once it has no live work", async () => {
  const runnerStartup = Promise.withResolvers<void>()
  const lead = leadHarness(ctx, { runnerStartup: runnerStartup.promise })
  dispose = async () => { runnerStartup.resolve(); await lead.dispose() }
  const leadSessionId = await lead.openLead()
  if (leadSessionId === null) throw new Error("expected the lead to open")
  await conversation.appendConversation(leadSessionId, [
    { kind: "user", content: "Fix the login page", origin: "human" },
    { kind: "assistant", content: [{ type: "tool_use", id: "route-1", name: "route_request", input: { kind: "new" } }] },
  ])
  const routed = await lead.service.route({ leadSessionId, kind: "new", earlierTurns: 0 })
  if (!routed.ok) throw new Error(routed.reason)
  const tool = createChatProgressTool((target) => lead.service.progress(target))
  expect(String((await tool.execute({ chat: routed.sessionId }, makeContext())).content)).toContain(": starting; its last turn has not ended yet.")

  runnerStartup.resolve()
  await lead.supervisor.ensureChatRunner(routed.sessionId)
  const text = String((await tool.execute({ chat: routed.sessionId }, makeContext())).content)
  expect(text).toContain(": at rest; its last turn failed.")
})

test("chat_progress refuses a chat that the lead did not start", async () => {
  const { lead, tool } = await chatWithQuestion()
  const other = await lead.supervisor.openSessionRuntime()
  const result = await tool.execute({ chat: other }, makeContext())
  expect(result.outcome).toBe("error")
  expect(String(result.content)).toContain(`the lead did not start chat ${other}`)
})
