import { afterEach, beforeEach, expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../../src/infra/event-store-types.js"
import type { AgentGroupBlock } from "../../../../../src/infra/output-blocks.js"
import { createChatProgressTool } from "../../../../../src/orchestration/modules/lead/chat-progress.js"
import { emptyConversationCheckpoint } from "../../../../../src/orchestration/session/conversation-checkpoint.js"
import { countStateRequests } from "../../../../helpers/state-requests.js"
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

/** A chat that the lead started once `history` is written, and the lead's tool that reads it. */
async function startedChat(history: (chat: string) => Promise<void>, setup: Parameters<typeof leadHarness>[1] = {}) {
  const lead = leadHarness(ctx, setup)
  dispose = lead.dispose
  const chat = await lead.supervisor.openSessionRuntime()
  await history(chat)
  await lead.service.journal.append({ type: "lead.chat.started", payload: { sessionId: chat, sourceEntryIds: ["entry-1"] } })
  return { lead, chat, tool: createChatProgressTool((target, before) => lead.service.progress(target, before)) }
}

/** A chat that the lead started, which waits on its question to the person. */
const chatWithQuestion = () => startedChat(async (chat) => {
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
})

test("chat_progress answers a started chat's pending question, its context, and its options word for word", async () => {
  const { chat, tool } = await chatWithQuestion()
  const result = await tool.execute({ chat }, makeContext())
  expect(result.outcome).toBe("ok")
  const text = String(result.content)
  // The chat has no runner, as after a close at rest, while its question waits.
  expect(text).toContain(`Chat ${chat} "New Chat": waiting for the person's answer; its last turn stopped on a question for the person.`)
  expect(text).toContain(`Context:\n${CONTEXT}\n`)
  expect(text).toContain(`Question (Form): ${QUESTION.question}`)
  expect(text).toContain("- Sign-in form: Only the sign-in form gets the new check. (recommended)\n- Both forms\n- Other (free text)")
  // The conversation reads newest first, and the call's input is not part of it.
  expect(text).toContain("Its conversation, newest first:\nThe person: Fix the login page\nThe chat: Added the sign-in form.\nThe person: Add a sign-in form\nThat is the start of the conversation.")
  expect(text).toContain("It has no checkpoint.")
  expect(text).toContain("It runs no other agent now.")

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
  const tool = createChatProgressTool((target, before) => lead.service.progress(target, before))
  expect(String((await tool.execute({ chat: routed.sessionId }, makeContext())).content)).toContain(": starting; its last turn has not ended yet.")

  runnerStartup.resolve()
  await lead.supervisor.ensureChatRunner(routed.sessionId)
  const text = String((await tool.execute({ chat: routed.sessionId }, makeContext())).content)
  expect(text).toContain(": at rest; its last turn failed.")
})

test("chat_progress reads a listed chat that the lead did not start, and refuses a chat that the person closed", async () => {
  const { lead, tool } = await chatWithQuestion()
  const other = await lead.supervisor.openSessionRuntime()
  await conversation.appendConversation(other, [{ kind: "user", content: "Fix the header", origin: "human" }])
  let listed = ""
  for (let attempt = 0; attempt < 200 && !listed.includes("Fix the header"); attempt += 1) {
    await Bun.sleep(5)
    listed = String((await tool.execute({ chat: other }, makeContext())).content)
  }
  expect(listed).toContain("Fix the header")
  await lead.supervisor.closeChat(other)
  let result = await tool.execute({ chat: other }, makeContext())
  for (let attempt = 0; attempt < 200 && result.outcome !== "error"; attempt += 1) {
    await Bun.sleep(5)
    result = await tool.execute({ chat: other }, makeContext())
  }
  expect(result.outcome).toBe("error")
  expect(String(result.content)).toContain(`chat ${other} is not in your list`)
})

/** A workflow card of a chat's live transcript. A workflow's card states its progress only once its run's summary
 *  measures it, which needs a whole workflow, so this card states it as the transcript's join does. */
type PlainCard = Exclude<AgentGroupBlock, { readonly status: "paused" | "error" }>
function card(id: string, fields: Pick<PlainCard, "containerKind" | "label"> & Partial<Pick<PlainCard, "status" | "activeStartedAt" | "card">>): PlainCard {
  return { kind: "agentGroup", id, status: "active", description: "", children: [], totalToolCount: 0, timestamp: 1, toolUseId: id, ...fields }
}

/** The facts of a subagent that chat `parent` dispatched with call `toolUseId`, and the call that the child made. */
async function dispatchedSubagent(parent: string, toolUseId: string, child: string): Promise<void> {
  const tool = (sessionId: string, id: string, toolName: string, input: { readonly [key: string]: string }) => ctx.store.append({
    aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now(), actor: "agent", type: "tool.input.completed", version: 1, payload: {
      toolUseId: id, toolName, input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    },
  })
  await tool(parent, toolUseId, "subagent", { kind: "dispatch", persona: "explorer", description: "Find every caller of the login handler" })
  await ctx.store.append({ aggregateId: `session:${parent}`, sessionId: parent, timestamp: Date.now(), actor: "flywheel", type: "session.child.linked", version: 1, payload: { childSessionId: child, lastUpdated: new Date().toISOString() } })
  await ctx.store.append({ aggregateId: `session:${child}`, sessionId: child, timestamp: Date.now(), actor: "flywheel", type: "child_run.created", version: 2, payload: {
    childSessionId: child, childRunId: toolUseId, conversationId: `${child}-conversation`, parentSessionId: parent, parentConversationId: await conversation.chatConversationId(parent), parentToolCallId: toolUseId,
    persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: toolUseId },
    admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: ctx.baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Find every caller of the login handler",
  } })
  await tool(child, "child-read", "read", { path: "src/login.ts" })
}

test("chat_progress reads where a chat stands: its checkpoint, its running subagents and workflows, its newest calls, and its words without tool output", async () => {
  const { lead, chat, tool } = await startedChat(async (seeded) => {
    await conversation.appendConversation(seeded, [
      { kind: "user", content: "Fix the login page", origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read", input: { path: "src/login.ts" } }] },
      { kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "export function handler() {}" }] },
      { kind: "assistant", content: [{ type: "thinking", thinking: "Private reasoning." }, { type: "thinking", thinking: "Checking who calls it.", presentation: "progress" }, { type: "text", text: "I will read the handler." }, { type: "tool_use", id: "bash-1", name: "bash", input: { command: "grep -rn handler src" } }] },
      { kind: "toolResult", toolUseId: "bash-1", content: [{ type: "text", text: "src/login.ts:4: handler output" }] },
      { kind: "assistant", content: [{ type: "tool_use", id: "bash-2", name: "bash", input: { command: "bun test" } }] },
      { kind: "toolResult", toolUseId: "bash-2", content: [{ type: "text", text: "12 pass" }] },
    ])
    await ctx.store.append({
      aggregateId: `session:${seeded}`, sessionId: seeded, type: "conversation.checkpoint.updated", version: 1, actor: "flywheel", timestamp: 2,
      payload: { conversationId: await conversation.chatConversationId(seeded), checkpoint: { ...emptyConversationCheckpoint(), currentState: "Both forms share one handler.", nextStep: "Ask which form changes." } },
    })
  })
  const now = Date.now()
  await lead.supervisor.ensureChatRunner(chat)
  // The subagent's card as the chat's live transcript holds it: its call's row, which the transcript's join turns
  // into the card, with the child's own clock while it streams.
  await dispatchedSubagent(chat, "dispatch-1", "explorer-child")
  ctx.sessionStore.openSessionRuntime({ kind: "subagent", sessionId: "explorer-child", conversationId: "explorer-child-conversation" })
  ctx.sessionStore.updateChatEntry("explorer-child", { runnerState: "streaming", streamingStartedAt: now - 40_000 })
  for (const block of [
    card("wf-1", { containerKind: "workflow", label: "Review PR 5113", activeStartedAt: now - 660_000, card: { done: 3, total: 4, failed: 0, finishedFailed: 0, running: 1, parked: 0, before: 0, after: 0, phases: [] } }),
    { kind: "tool", id: "dispatch-1", name: "subagent", presentation: { name: "Agent", detail: "Find every caller of the login handler" }, status: "pending", timestamp: 1 } as const,
    card("sub-2", { containerKind: "subagent", status: "completed", label: "Finished check" }),
  ]) expect(ctx.sessionStore.appendPreRunnerOutput(chat, block)).toBe(true)

  const text = String((await tool.execute({ chat }, makeContext())).content)
  expect(text).toContain("Where its checkpoint says it stands:\nBoth forms share one handler.\nNext step: Ask which form changes.")
  expect(text).toContain("The agents that it runs now:\n- workflow \"Review PR 5113\", for 11m 0s: running, 3 of 4 agents done")
  expect(text).toMatch(/\n- subagent explorer "[^"\n]*Find every caller of the login handler", for 4\ds: running, newest call: Read [^\n]*login\.ts\n/)
  expect(text).not.toContain("Finished check")
  expect(text).toMatch(/Its newest calls, newest first: bash x2, read \([^)\n]*login\.ts\)\n/)
  // A progress update is text that the chat said to the person; other thinking is private.
  expect(text).toContain("Its conversation, newest first:\nThe chat: Checking who calls it.\nI will read the handler.\nThe person: Fix the login page")
  for (const hidden of ["Private reasoning", "handler output", "12 pass", "grep -rn", "export function"]) expect(text).not.toContain(hidden)
})

test("chat_progress pages a long conversation back through the cursor that each answer names, until its start", async () => {
  const { chat, tool } = await startedChat(async (seeded) => {
    await conversation.appendConversation(seeded, [
      { kind: "user", content: "Add a sign-in form", origin: "human" },
      { kind: "assistant", content: [{ type: "text", text: "Added the sign-in form." }] },
    ])
    for (let index = 0; index < 12; index += 1) {
      await conversation.appendConversation(seeded, [
        { kind: "user", content: `Go on ${index}`, origin: "human" },
        { kind: "assistant", content: [{ type: "text", text: `Step ${index}: ${"x".repeat(400)}` }] },
      ])
    }
  })
  const seen: string[] = []
  let text = String((await tool.execute({ chat }, makeContext())).content)
  expect(text.length).toBeLessThan(4_500)
  for (let page = 0; page < 10; page += 1) {
    seen.push(...[...text.matchAll(/^The (?:chat|person): (Step \d+|Go on \d+|Add a sign-in form|Added the sign-in form)/gm)].map((match) => match[1]!))
    const cursor = /call again with before "(\d+:\d+)"/.exec(text)?.[1]
    if (cursor === undefined) break
    const answer = await tool.execute({ chat, before: cursor }, makeContext())
    expect(answer.outcome).toBe("ok")
    text = String(answer.content)
  }
  expect(text).toContain("That is the start of the conversation.")
  expect(seen).toEqual([...Array.from({ length: 12 }, (_, index) => [`Step ${11 - index}`, `Go on ${11 - index}`]).flat(), "Added the sign-in form", "Add a sign-in form"])

  const refused = await tool.execute({ chat, before: "not a cursor" }, makeContext())
  expect(refused.outcome).toBe("error")
})

test("one read of a chat costs the same durable reads for a short and a long history", async () => {
  const counter = countStateRequests(asAsyncEventReadSurface(ctx.store))
  const { chat, tool } = await startedChat(async (seeded) => {
    await conversation.appendConversation(seeded, [{ kind: "user", content: "List the files", origin: "human" }])
  }, { projectionReader: counter.reader })
  const append = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      await conversation.appendConversation(chat, [
        { kind: "assistant", content: [{ type: "tool_use", id: `bash-${index}`, name: "bash", input: { command: "ls" } }] },
        { kind: "toolResult", toolUseId: `bash-${index}`, content: [{ type: "text", text: "ok" }] },
      ])
    }
  }
  const cost = async () => {
    expect((await tool.execute({ chat }, makeContext())).outcome).toBe("ok")
    counter.take()
    expect((await tool.execute({ chat }, makeContext())).outcome).toBe("ok")
    return counter.take().filter((request) => request.method === "readSlice").length
  }
  await append(40)
  const short = await cost()
  await append(200)
  expect(await cost()).toBe(short)
  // One checkpoint read, at most 32 batch reads, and one read that tells whether an earlier page exists.
  expect(short).toBeLessThanOrEqual(34)
})

test("a page that reads the conversation's first batch as its last read names no earlier page", async () => {
  const { chat, tool } = await startedChat(async (seeded) => {
    for (let index = 0; index < 32; index += 1) await conversation.appendConversation(seeded, [{ kind: "user", content: `Note ${index}`, origin: "human" }])
  })
  const text = String((await tool.execute({ chat }, makeContext())).content)
  expect(text).toContain("The person: Note 0\nThat is the start of the conversation.")
})

test("a busy chat's answer stays within its budget and names every agent that it runs", async () => {
  const long = (word: string) => `${word} `.repeat(200)
  const { chat, tool } = await startedChat(async (seeded) => {
    for (let index = 0; index < 12; index += 1) {
      await conversation.appendConversation(seeded, [
        { kind: "user", content: long(`Ask${index}`), origin: "human" },
        { kind: "assistant", content: [{ type: "text", text: long(`Reply${index}`) }, { type: "tool_use", id: `read-${index}`, name: "read", input: { path: `src/a/very/long/directory/name/for/the/file/number-${index}.ts` } }] },
      ])
    }
    await ctx.store.append({
      aggregateId: `session:${seeded}`, sessionId: seeded, type: "conversation.checkpoint.updated", version: 1, actor: "flywheel", timestamp: 2,
      payload: { conversationId: await conversation.chatConversationId(seeded), checkpoint: { ...emptyConversationCheckpoint(), currentState: long("state"), nextStep: long("next") } },
    })
  })
  for (let index = 0; index < 10; index += 1) {
    expect(ctx.sessionStore.appendPreRunnerOutput(chat, card(`wf-${index}`, { containerKind: "workflow", label: `Review PR ${index} ${"with a long goal ".repeat(10)}` }))).toBe(true)
  }
  const text = String((await tool.execute({ chat }, makeContext())).content)
  expect(text.length).toBeLessThanOrEqual(4_000)
  for (let index = 0; index < 10; index += 1) expect(text).toContain(`- workflow "Review PR ${index} `)
  // The calls come from the entries that the page walks.
  expect(text).toContain("Its newest calls, newest first: read (Read number-11.ts)\n")
  expect(text).toMatch(/Its conversation, newest first:\nThe chat: Reply11 /)
})
