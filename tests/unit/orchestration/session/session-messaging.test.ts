import { afterEach, describe, expect, jest, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import type { ChatInput, SessionInputProducer } from "../../../../src/infra/chat-input"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { createListSessionsTool } from "../../../../src/orchestration/agent-runtime/tools/list-sessions"
import { createMessageSessionTool } from "../../../../src/orchestration/agent-runtime/tools/message-session"
import { buildSystemPrompt, type PromptKind } from "../../../../src/orchestration/agent-runtime/system-prompt"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers"
import type { ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types"
import { turnHopOf } from "../../../../src/orchestration/agent-runtime/turn-hop"
import { decodeQueuedUserInputCell, QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { registerLiveSessionControl, registerLiveWorkflowControl } from "../../../../src/orchestration/session/live-session-control"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionMessaging } from "../../../../src/orchestration/session/session-messaging"
import { workflowParentBinding } from "../../../helpers/workflow-parent"
import { validateWorkflowBootstrap } from "../../../../src/workflows/vm/bootstrap-validation"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection"
import { lowerProviderHistory } from "../../../../src/orchestration/agent-runtime/llm/provider-history"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestSubagent, publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"
import { ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, readAddressedWorkflowMessages } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { addressReachesStartedAgent } from "../../../../src/orchestration/workflow-host/workflow-addressing"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten"
import { buildWorkflowControlInitializedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts"
import { fourLaneControl, wideBindings } from "../../workflows/vm/_tree-fixtures"
import { countStateRequests, factsRead } from "../../../helpers/state-requests"
import { openAIResponsesTarget } from "../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
import { promptOptions } from "../../../helpers/prompt-capabilities.js";

afterEach(() => {
  cleanupTmpRoot()
})

function project() {
  const root = makeTmpDir()
  const { deps, store } = makeDepsWithStore(root)
  const manager = createSessionManager(deps)
  const counter = countStateRequests(asAsyncEventReadSurface(store))
  const reader = counter.reader
  const messaging = createSessionMessaging({ manager, projectionReader: reader, eventWriter: asAsyncEventWriter(store) }, unusedChildSessionControl())
  const producers = (sessionId: string): SessionInputProducer[] => store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)
    .flatMap((row) => {
      const producer = decodeQueuedUserInputCell(row, sessionId)?.producer
      return producer?.kind === "session" ? [producer] : []
    })
  return { root, store, manager, reader, messaging, producers, counter }
}

function context(sessionId: string, toolUseId: string, history: readonly ConversationMessage[] = [], hop = 0): ToolContext {
  const toolContext: ToolContext = {
    executionCwd: "/scratch",
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    artifactScopeId: sessionId,
    retrievalSessionId: sessionId,
    sessionId,
    conversationId: `${sessionId}-conversation`,
    toolUseId,
    turnHop: () => hop,
    conversationHistory: () => history,
  }
  return toolContext
}

function assistantCall(id: string, name: string, input: { readonly [key: string]: unknown }): ConversationMessage {
  return { kind: "assistant", content: [{ type: "tool_use", id, name, input }] }
}

function toolResult(toolUseId: string, text: string): ConversationMessage {
  return { kind: "toolResult", toolUseId, content: [{ type: "text", text }] }
}

function person(text: string): ConversationMessage {
  return { kind: "user", content: text, origin: "human", producer: { kind: "human" } }
}

describe("message_session prompting", () => {
  test("allows one needed message and forbids acknowledgements, status, and requests to be told later, for every runner", () => {
    const { messaging } = project()
    const tool = createMessageSessionTool(messaging)
    const kinds: PromptKind[] = ["chat", "subagent", "workflow-agent", "headless"]
    for (const promptKind of kinds) {
      const prompt = renderSystemPrompt(buildSystemPrompt(promptOptions({ tools: [tool], promptKind })))
      expect(prompt).toContain("One message is one question, one answer, one revision of your own child's instructions, or one thing your person asked you to send.")
      expect(prompt).toContain("Never acknowledge, confirm, promise a later update, or report status.")
      expect(prompt).toContain("Return delegated results through handoff, not message_session.")
    }
    expect(tool.description).toContain("Peers are not your workers: never ask a session that is not your own child to fix, commit, publish, or revert its files for you.")
    expect(tool.description).toContain('requests such as "tell me when it lands"')
    // A step that cannot answer its child's question passes it up, because
    // that child cannot wait on any session above its parent.
    expect(tool.description).toContain("When your own child asks a question that you cannot answer, ask your parent in your own words.")
    expect(JSON.stringify(tool.inputSchema)).toContain("Wait for a reply from your parent session or your own child session, only when you cannot continue without it.")
    // Shorthand such as "Idleoriginal80ff0276a53ledger" told the recipient
    // nothing until it asked again.
    expect(JSON.stringify(tool.inputSchema)).toContain("Its first sentence says what the message is about and what you need from the recipient, if anything. Write complete sentences in plain English, with a space between all words and numbers. Do not start with a greeting or a preamble.")
    // The person already reads every message row, so a restatement repeats
    // it. A root chat still asks its person the question that a child could
    // not answer.
    expect(tool.description).toContain("Your person sees every message that you send or receive, so do not quote or restate one to your person unless your person asks. When a message needs a decision from your person, ask only that question, in your own words.")
    expect(tool.description).toContain("A session that does not reply has not agreed to anything, so do not act as if it had.")
  })
})

describe("the words of the person", () => {
  test("a message after an ask_user answer and after a chat entry carries them; one with no new words carries none", async () => {
    const { root, manager, messaging, producers } = project()
    const parent = await manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(manager, root, "child", parent)
    const tool = createMessageSessionTool(messaging)
    // The launch of the child is the first exchange.
    const history: ConversationMessage[] = [
      person("start the work"),
      assistantCall("child-tool", "subagent", { kind: "spawn" }),
      toolResult("child-tool", "launched"),
      assistantCall("ask-1", "ask_user", { questions: [] }),
      toolResult("ask-1", "User answered:\n- Which file?: main.ts"),
      person("and keep the tests green"),
      assistantCall("send-1", "message_session", { to: child, text: "use main.ts" }),
    ]
    await tool.execute({ target: "session", to: child, text: "use main.ts" }, context(parent, "send-1", history))
    history.push(toolResult("send-1", "Delivered"), assistantCall("send-2", "message_session", { to: child, text: "again" }))
    await tool.execute({ target: "session", to: child, text: "again" }, context(parent, "send-2", history))

    expect(producers(child).map((producer) => producer.envelope)).toEqual([
      { name: "Root", relation: "parent", waits: false, personWords: "User answered:\n- Which file?: main.ts\n\nand keep the tests green" },
      { name: "Root", relation: "parent", waits: false },
    ])
  })

  test("a sender with no earlier exchange with the recipient attaches nothing", async () => {
    const { manager, messaging, producers } = project()
    const sender = await manager.createChat({ name: "Sender" })
    const recipient = await manager.createChat({ name: "Recipient" })
    const sent = await createMessageSessionTool(messaging).execute({ target: "session", to: recipient, text: "hello" }, context(sender, "send-1", [person("tell the other chat hello")]))
    expect(producers(recipient).map((producer) => producer.envelope)).toEqual([{ name: "Sender", relation: "other", waits: false }])
    // The result names the recipient for the call's row, and states why
    // nothing reads the message now; an unknown id has no name.
    expect(sent.details).toEqual({ targetName: "Recipient", statusMessage: "Held: nothing runs it now. It reads the message when it runs again." })
    // A held message stays with its recipient and a refusal is final, so
    // neither result invites a second copy or a reminder.
    expect(sent.content).toBe(`Held for ${recipient}: nothing runs it now. It reads the message when it runs again. Do not send the message again or send a reminder. Continue your own work.`)
    const missing = await createMessageSessionTool(messaging).execute({ target: "session", to: "missing", text: "hello" }, context(sender, "send-2"))
    expect(missing.details).toBeUndefined()
    expect(missing.content).toBe("Not delivered to missing: no session or workflow of this project has that id for the selected target kind. Call list_sessions to find other targets, or process(action='list') to find your own work. This refusal is final: do not send this message to missing again or send a reminder. Continue your own work.")
    // An unattended chat has no list_sessions, so its refusal names only its own work.
    const unattended = await createMessageSessionTool(messaging, undefined, true).execute({ target: "session", to: "missing", text: "hello" }, context(sender, "send-3"))
    expect(unattended.content).toBe("Not delivered to missing: no session or workflow of this project has that id for the selected target kind. Call process(action='list') to find your own work. This refusal is final: do not send this message to missing again or send a reminder. Continue your own work.")
  })
})

describe("wake chains", () => {
  test("a chain of wakes through three sessions is held at hop 5", async () => {
    const { manager, reader, messaging } = project()
    const sessions = [await manager.createChat({ name: "A" }), await manager.createChat({ name: "B" }), await manager.createChat({ name: "C" })]
    // Each idle chat starts a turn for a message; the hop of that turn is
    // read from the message that started it, as the loop reads it.
    const turnHops = new Map<string, number>()
    const unregister = sessions.map((sessionId) => registerLiveSessionControl(reader, {
      sessionId,
      state: async () => "idle",
      deliver: async (input: ChatInput, decide) => {
        const outcome = decide("idle")
        if (outcome.status === "delivered") turnHops.set(sessionId, turnHopOf([{ kind: "user", content: input.text, ...(input.producer ? { producer: input.producer } : {}) }]))
        return outcome
      },
      notify: async () => false,
    }))
    try {
      const tool = createMessageSessionTool(messaging)
      const results: string[] = []
      const details: unknown[] = []
      for (let index = 0; index < 6; index += 1) {
        const sender = sessions[index % 3]!
        const to = sessions[(index + 1) % 3]!
        const result = await tool.execute({ target: "session", to, text: `ping ${index}` }, context(sender, `call-${index}`, [], turnHops.get(sender) ?? 0))
        results.push(typeof result.content === "string" ? result.content.split(":")[0]!.split(" ")[0]! : "")
        details.push(result.details)
      }
      expect(results).toEqual(["Delivered", "Delivered", "Delivered", "Delivered", "Delivered", "Held"])
      expect(turnHops.get(sessions[2]!)).toBe(5)
      // The sender's row states the outcome of a held message; a delivered one needs none.
      expect(details[4]).toEqual({ targetName: "C" })
      expect(details[5]).toEqual({ targetName: "A", statusMessage: "Held: a chain of messages between sessions reached its limit of five hops. It reads the message later, and this message starts no work." })
    } finally {
      for (const off of unregister) off()
    }
  })

  test("the assignment that launched a subagent starts its first turn at hop 0", () => {
    const launch = { kind: "launch" as const, sessionId: "parent", toolUseId: "call-launch", name: "Root" }
    expect(turnHopOf([{ kind: "user", content: "Inspect the parser", producer: launch }])).toBe(0)
  })
})

describe("held messages and waits", () => {
  // A child's wait on its interrupted parent is in reply-waits.test.ts.
  test("a held message to an interrupted or closed own child opens no wait: an interrupted child is not active work", async () => {
    const { root, store, manager, reader, messaging } = project()
    const sender = await manager.createChat({ name: "Sender" })
    const workflow = await publishTestWorkflow(manager, { name: "Interrupted", launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "fixture-workflow", parentSessionId: sender }) })
    const interrupted = await startTestWorkflowMember(manager, store, workflow)
    // No run of this child is live in this process: nothing reads it.
    const closed = await publishTestSubagent(manager, root, "closed", sender)
    const unregisters = [registerLiveSessionControl(reader, {
      sessionId: interrupted,
      state: async () => "interrupted",
      deliver: async (_input, decide) => decide("interrupted"),
      notify: async () => false,
    })]
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    const send = (to: string, toolUseId: string, text?: string) => messaging.send({
      sender: { sessionId: sender, conversationId: `${sender}-conversation`, toolUseId, hop: 0 },
      target: "session",
      to,
      ...(text ? { text } : {}),
      wait: tasks,
      personWords: () => undefined,
    })
    try {
      expect(await send(interrupted, "ask-1", "Which file?")).toMatchObject({ status: "held", reason: "interrupted", to: interrupted, waiting: false })
      expect(await send(interrupted, "wait-2")).toMatchObject({ status: "held", reason: "interrupted", waiting: false })
      expect(await send(closed, "ask-2", "Which file?")).toEqual({ status: "held", reason: "no_reader", to: closed, name: "closed", waiting: false })
      expect(await send(closed, "wait-1")).toEqual({ status: "held", reason: "no_reader", to: closed, name: "closed", waiting: false })
      expect(tasks.holdsWait("ask-1")).toBe(false)
      expect(tasks.activeTaskCount()).toBe(0)
    } finally {
      await tasks.terminateAll()
      for (const unregister of unregisters) unregister()
    }
  })

  test("a wait on a session that is neither the sender's parent nor its own child refuses the whole call before delivery", async () => {
    const { root, manager, reader, messaging, producers } = project()
    const chat = await manager.createChat({ name: "Chat" })
    const peer = await manager.createChat({ name: "Peer" })
    const child = await publishTestSubagent(manager, root, "child", chat)
    const sibling = await publishTestSubagent(manager, root, "sibling", chat)
    const unregister = [chat, peer].map((sessionId) => registerLiveSessionControl(reader, {
      sessionId,
      state: async () => "idle",
      deliver: async (_input, decide) => decide("idle"),
      notify: async () => false,
    }))
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    try {
      const tool = createMessageSessionTool(messaging, tasks)
      const neither = "you can wait only on your parent or on your own child, and this session is neither."
      const refused = `${neither} Continue your own work. Send the message again without wait only if the message_session description allows it.`
      expect((await tool.execute({ target: "session", to: peer, text: "Did my fix land?", wait: true }, context(chat, "ask-1"))).content).toBe(`Not delivered to ${peer}: ${refused}`)
      // A wait with no text had no message, so the result never asks the
      // sender to send one.
      expect((await tool.execute({ target: "session", to: peer, wait: true }, context(chat, "wait-1"))).content).toBe(`Not waiting on ${peer}: ${neither} Do not wait for it or check on it. Continue your own work on your own judgment.`)
      expect((await tool.execute({ target: "session", to: sibling, text: "Which file?", wait: true }, context(child, "ask-2"))).content).toBe(`Not delivered to ${sibling}: ${refused}`)
      expect(producers(peer)).toEqual([])
      expect(producers(sibling)).toEqual([])
      expect(tasks.activeTaskCount()).toBe(0)
      // Without the wait, the same message is delivered.
      expect((await tool.execute({ target: "session", to: peer, text: "Did my fix land?" }, context(chat, "ask-3"))).content).toStartWith(`Delivered to ${peer}`)
    } finally {
      await tasks.terminateAll()
      for (const off of unregister) off()
    }
  })
})

describe("duplicate messages", () => {
  test("a text that repeats the sender's last text to the recipient within 30 seconds is refused, until the recipient writes back", async () => {
    // The window reads a monotonic clock, which fake timers move.
    jest.useFakeTimers()
    const { root, manager, reader, messaging, producers } = project()
    const sender = await manager.createChat({ name: "Sender" })
    const recipient = await manager.createChat({ name: "Recipient" })
    const other = await manager.createChat({ name: "Other" })
    const child = await publishTestSubagent(manager, root, "child", sender)
    const unregister = [recipient, other].map((sessionId) => registerLiveSessionControl(reader, {
      sessionId,
      state: async () => "idle",
      deliver: async (_input, decide) => decide("idle"),
      notify: async () => false,
    }))
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    const tool = createMessageSessionTool(messaging, tasks)
    const history: ConversationMessage[] = []
    const send = async (to: string, toolUseId: string, input: { readonly text?: string; readonly wait?: boolean }) =>
      String((await tool.execute({ target: "session", to, ...input }, context(sender, toolUseId, history))).content)
    const refusal = `Not delivered to ${recipient}: you sent it the same text less than 30 seconds ago, so it already has this message. This refusal is final: do not send this message to ${recipient} again or send a reminder.`
    try {
      expect(await send(recipient, "send-1", { text: "Yes." })).toStartWith(`Delivered to ${recipient}`)
      // Whitespace around the text does not make it a new message.
      const duplicate = await tool.execute({ target: "session", to: recipient, text: "  Yes.\n" }, context(sender, "send-2", history))
      expect(duplicate.outcome).toBe("error")
      expect(duplicate.content).toBe(`${refusal} Continue your own work.`)
      // A message from the recipient starts a new exchange, so the same
      // short answer to its new question is a new message.
      history.push({ kind: "user", content: "Does the parser need a test?", producer: { kind: "session", sessionId: recipient, conversationId: `${recipient}-conversation`, toolUseId: "question-2", hop: 0 } })
      expect(await send(recipient, "send-3", { text: "Yes." })).toStartWith(`Delivered to ${recipient}`)
      expect(await send(other, "send-4", { text: "Yes." })).toStartWith(`Delivered to ${other}`)
      // Only the sender's last text counts as a repeat.
      expect(await send(recipient, "send-5", { text: "Which test covers it?" })).toStartWith(`Delivered to ${recipient}`)
      expect(await send(recipient, "send-6", { text: "Yes." })).toStartWith(`Delivered to ${recipient}`)
      // A bare wait sends no text, so a second one is never a copy.
      for (const toolUseId of ["wait-1", "wait-2"]) expect(await send(child, toolUseId, { wait: true })).toStartWith(`Not waiting on ${child}: it cannot answer now`)
      jest.advanceTimersByTime(30_001)
      expect(await send(recipient, "send-7", { text: "Yes." })).toStartWith(`Delivered to ${recipient}`)
      expect(producers(recipient)).toHaveLength(5)
    } finally {
      jest.useRealTimers()
      await tasks.terminateAll()
      for (const off of unregister) off()
    }
  })

  test("a duplicate that asks for a wait says how to wait without sending it again", async () => {
    const { root, manager, messaging } = project()
    const parent = await manager.createChat({ name: "Parent" })
    const child = await publishTestSubagent(manager, root, "child", parent)
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    const tool = createMessageSessionTool(messaging, tasks)
    try {
      // The child keeps a held message, so a copy is still a duplicate.
      expect(String((await tool.execute({ target: "session", to: child, text: "Use main.ts." }, context(parent, "send-1"))).content)).toStartWith(`Held for ${child}`)
      expect((await tool.execute({ target: "session", to: child, text: "Use main.ts.", wait: true }, context(parent, "send-2"))).content).toBe(`Not delivered to ${child}: you sent it the same text less than 30 seconds ago, so it already has this message. This refusal is final: do not send this message to ${child} again or send a reminder. To wait for its reply, call message_session with wait true and no text.`)
      expect(tasks.activeTaskCount()).toBe(0)
    } finally {
      await tasks.terminateAll()
    }
  })

  test("a copy sent while the first is in delivery waits for it: it is refused only when the first copy was sent", async () => {
    const { manager, reader, messaging, producers } = project()
    const sender = await manager.createChat({ name: "Sender" })
    const recipient = await manager.createChat({ name: "Recipient" })
    let deliveries = 0
    const unregister = registerLiveSessionControl(reader, {
      sessionId: recipient,
      state: async () => "idle",
      deliver: async (_input, decide) => {
        deliveries += 1
        if (deliveries === 1) throw new Error("the recipient's queue closed")
        return decide("idle")
      },
      notify: async () => false,
    })
    const tool = createMessageSessionTool(messaging)
    const both = (text: string, ids: readonly [string, string]) => Promise.allSettled(ids.map((id) => tool.execute({ target: "session", to: recipient, text }, context(sender, id))))
    try {
      const contentsOf = (results: readonly PromiseSettledResult<{ readonly content: unknown }>[]) => results.map((result) => result.status === "fulfilled" ? String(result.value.content) : "rejected")
      const [failed, retried] = contentsOf(await both("Which file holds the parser?", ["send-1", "send-2"]))
      expect(failed).toBe("rejected")
      expect(retried).toStartWith(`Delivered to ${recipient}`)
      const before = producers(recipient).length
      const contents = contentsOf(await both("Which test covers it?", ["send-3", "send-4"]))
      expect(contents[0]).toStartWith(`Delivered to ${recipient}`)
      expect(contents[1]).toStartWith(`Not delivered to ${recipient}: you sent it the same text`)
      expect(producers(recipient)).toHaveLength(before + 1)
    } finally {
      unregister()
    }
  })

  test("a message that delivery refuses was never sent, so a second copy reads the same refusal, not a duplicate", async () => {
    const { manager, messaging } = project()
    const sender = await manager.createChat({ name: "Sender" })
    const tool = createMessageSessionTool(messaging)
    for (const toolUseId of ["send-1", "send-2"]) {
      expect(String((await tool.execute({ target: "session", to: sender, text: "hello" }, context(sender, toolUseId))).content)).toStartWith(`Not delivered to ${sender}: a session cannot message itself.`)
    }
  })
})

describe("addressed messages", () => {
  test("historical sender recovery gives provider and display the same exact member or explicit non-replyable gap without changing stored bytes", async () => {
    const { manager, reader, store } = project()
    const workflow = await publishTestWorkflow(manager)
    const member = await startTestWorkflowMember(manager, store, workflow)
    const agent = await manager.read(member)
    if (agent?.kind !== "workflow-agent") throw new Error("Expected a member")
    store.append({ aggregateId: `session:${workflow}`, sessionId: workflow, timestamp: 1, type: "session.created", version: 5, actor: "flywheel",
      payload: { kind: "workflow", command: "workflow", label: "Previous workflow", workflowDefinitionId: "fixture-workflow", lifecycleState: "inactive", executionCwd: "/scratch", lastUpdated: "2026-10-01T00:00:00.000Z" } })
    const recipient = await manager.createChat({ name: "Recipient" })
    const identity = await manager.read(recipient)
    if (identity?.kind !== "chat") throw new Error("Expected a chat")
    const messages = [agent.conversationId, "lost-generation"].map((conversationId, index) => ({
      kind: "message" as const, id: `old-${index}`, parentId: index === 0 ? null : "old-0", timestamp: "2026-10-01T00:00:00.000Z",
      message: { kind: "user" as const, content: "Which parser?", producer: { kind: "session" as const, sessionId: workflow, conversationId, toolUseId: `old-call-${index}`, hop: 0, envelope: { name: "Previous workflow", relation: "child" as const, waits: true } } },
    }))
    store.append({ aggregateId: `conversation:${identity.conversationId}`, sessionId: recipient, timestamp: 2, type: "chat.entries.appended", version: 7, actor: "flywheel", payload: { conversationId: identity.conversationId, entries: messages } })
    const before = JSON.stringify(store.read({ aggregateId: `conversation:${identity.conversationId}` }))
    const tree = await tryOpenConversationTree({ sessionId: recipient, conversationId: identity.conversationId, store: reader })
    if (!tree) throw new Error("Expected the historical tree")
    const providerHistory = lowerProviderHistory((await tree.buildContext()).messages, openAIResponsesTarget("openai_api", "test-model"))
    const text = JSON.stringify(providerHistory)
    expect(text).toContain(`using target \\"session\\" and to \\"${member}\\"`)
    expect(text).toContain("The historical sender session cannot be resolved. No exact reply target is available.")
    expect(text).not.toContain(`Reply with message_session using target \\"session\\" and to \\"${workflow}\\"`)
    const blocks = projectBlocksFromEntries(await tree.getBranch(), { executionCwd: "/scratch" })
    expect(blocks).toMatchObject([{ kind: "userMessage", from: { sessionId: member } }, { kind: "system", message: expect.stringContaining("No exact reply target is available.") }])
    expect(JSON.stringify(store.read({ aggregateId: `conversation:${identity.conversationId}` })) ).toBe(before)
    tree.getStorage().dispose()
  })

  const group = "input-mapped:node:1"
  const lane = (ordinal: number, key: string) => ({ _tag: "item" as const, listNodeId: group, itemNodeId: `${group}:item:${ordinal}`, key })

  test("a workflow wait refuses before delivery, while a reply targets only the asking member", async () => {
    const { manager, reader, store, messaging, producers } = project()
    const parent = await manager.createChat({ name: "Parent" })
    const workflow = await publishTestWorkflow(manager, { name: "Build", launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "fixture-workflow", parentSessionId: parent }) })
    const member = await startTestWorkflowMember(manager, store, workflow)
    const bootstrap = validateWorkflowBootstrap(store.read({ aggregateId: `workflow:${workflow}` }))
    if (!bootstrap.executable) throw new Error(JSON.stringify(bootstrap.reasons))
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    const tool = createMessageSessionTool(messaging, tasks)
    for (const text of [undefined, "Which file?"]) {
      const result = await tool.execute({ target: "workflow", to: workflow, wait: true, ...(text ? { text } : {}) }, context(parent, `wait-${text ?? "empty"}`))
      expect(result.content).toBe("Not delivered: a workflow has no answering agent and takes no reply wait. To ask a question, target the particular agent session. To send workflow direction, omit wait. To wait for workflow completion, use process wait.")
    }
    expect(store.readInFlight(workflow, [QUEUED_USER_INPUT_IN_FLIGHT_KIND, ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, "session.reply_wait"])).toEqual([])
    const reply = await tool.execute({ target: "session", to: member, text: "Use main.ts." }, context(parent, "reply"))
    expect(reply.outcome).toBe("ok")
    expect(producers(member)).toHaveLength(1)
    expect(await readAddressedWorkflowMessages(reader, workflow)).toEqual([])
    const invalid = await tool.execute({ target: "session", to: member, text: "Do not broadcast.", targets: ["build"] }, context(parent, "invalid"))
    expect(invalid.outcome).toBe("error")
    expect(producers(member)).toHaveLength(1)
  })

  test("a parent's message to two of four lanes waits for them in one addressed cell, a message without targets waits with the workflow address, and a finished or unknown lane refuses the whole call with every valid key", async () => {
    const { manager, reader, store, messaging, producers } = project()
    const parent = await manager.createChat({ name: "Parent" })
    const workflow = await publishTestWorkflow(manager, { name: "Lanes", launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "fixture-workflow", parentSessionId: parent }) })
    const control = fourLaneControl()
    const aggregateId = workflowAggregateId(workflow)
    store.appendBatch([buildWorkflowControlInitializedFact(control), ...queueFactsForState(null, flattenWorkflowView(control, wideBindings))].map((fact, index) => ({ ...fact, aggregateId, sessionId: workflow, timestamp: index + 1 })))
    const delivered: { readonly text: string; readonly reachesRunning: boolean }[] = []
    const unregister = registerLiveWorkflowControl(reader, {
      kind: "workflow", workflowId: workflow,
      handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined,
      state: async () => "running",
      deliver: async (input, decide, address) => {
        delivered.push({ text: input.text, reachesRunning: address !== undefined && addressReachesStartedAgent(await loadQueueSnapshotFromReader(reader, workflow) ?? undefined, address) })
        return decide("running")
      },
      notify: async () => false,
    })
    const tool = createMessageSessionTool(messaging)
    const held = () => readAddressedWorkflowMessages(reader, workflow)
    try {
      expect(tool.inputSchema.type).toBe("object")
      expect(Object.keys(tool.inputSchema).filter((key) => key === "oneOf" || key === "anyOf" || key === "allOf")).toEqual([])
      const finished = await tool.execute({ target: "workflow", to: workflow, text: "Redo the parser.", targets: ["t3", "t1"] }, context(parent, "send-1"))
      expect(finished.outcome).toBe("error")
      expect(finished.content).toStartWith(`Not delivered to ${workflow}: "t1" has finished and reads no more messages.\nValid targets (key | item | agent | state | activity):\n- t2 | `)
      expect(finished.content).not.toContain("| Review | done | ")
      expect(finished.content).toContain("| Implement | running | working")
      const unknown = await tool.execute({ target: "workflow", to: workflow, text: "Redo the parser.", targets: ["json"] }, context(parent, "send-2"))
      expect(unknown.content).toContain('no item or agent of this workflow has the target "json".')
      expect(unknown.content).toContain("- t4 | ")
      // A refusal writes nothing.
      expect(await held()).toEqual([])
      expect(producers(workflow)).toEqual([])
      expect(delivered).toEqual([])

      const sent = await tool.execute({ target: "workflow", to: workflow, text: "Keep the old flag names.", targets: ["t2", "t4"] }, context(parent, "send-3"))
      expect(sent.content).toStartWith(`Delivered to workflow ${workflow} for its addressed readers.`)
      expect(await held()).toEqual([{ key: `msg:${parent}:send-3`, source: { kind: "parent", name: "Parent" }, text: "Keep the old flag names.", addressedTo: [lane(2, "t2"), lane(4, "t4")] }])
      // No queued input waits for the next step of every lane.
      expect(producers(workflow)).toEqual([])
      // Lane t2 runs, so its step reads the message at once.
      expect(delivered).toEqual([{ text: "Keep the old flag names.", reachesRunning: true }])
      await tool.execute({ target: "workflow", to: workflow, text: "Start with the tests.", targets: ["t3"] }, context(parent, "send-4"))
      expect(delivered.at(-1)).toEqual({ text: "Start with the tests.", reachesRunning: false })

      // Without targets, a message has the address of the whole workflow:
      // it waits in the same kind of cell, which the next commit records once
      // for every lane, and the running step reads it at once.
      await tool.execute({ target: "workflow", to: workflow, text: "Use the new API." }, context(parent, "send-5"))
      expect(producers(workflow)).toEqual([])
      expect((await held()).at(-1)).toEqual({ key: `msg:${parent}:send-5`, source: { kind: "parent", name: "Parent" }, text: "Use the new API.", addressedTo: [{ _tag: "workflow" }] })
      expect(await held()).toHaveLength(3)
      expect(delivered.at(-1)).toEqual({ text: "Use the new API.", reachesRunning: true })

      // Targets name lanes of a workflow only.
      const chat = await manager.createChat({ name: "Other" })
      expect((await tool.execute({ target: "session", to: chat, text: "Hi.", targets: ["t2"] }, context(parent, "send-6"))).content).toContain("An agent-session target takes no targets")
      expect((await tool.execute({ target: "workflow", to: workflow, targets: ["t2"] }, context(parent, "send-7"))).outcome).toBe("error")
    } finally {
      unregister()
    }
  })

  test("the same text to two lanes is two messages, a repeat to one lane is a duplicate, and a message with targets opens no wait", async () => {
    const { manager, reader, store, messaging } = project()
    const parent = await manager.createChat({ name: "Parent" })
    const workflow = await publishTestWorkflow(manager, { name: "Lanes", launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "fixture-workflow", parentSessionId: parent }) })
    const aggregateId = workflowAggregateId(workflow)
    store.appendBatch([buildWorkflowControlInitializedFact(fourLaneControl()), ...queueFactsForState(null, flattenWorkflowView(fourLaneControl(), wideBindings))].map((fact, index) => ({ ...fact, aggregateId, sessionId: workflow, timestamp: index + 1 })))
    const unregister = registerLiveWorkflowControl(reader, { kind: "workflow", workflowId: workflow, handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined, state: async () => "running", deliver: async (_input, decide) => decide("running"), notify: async () => false })
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    const tool = createMessageSessionTool(messaging, tasks)
    const addressed = () => store.readInFlight(workflow, ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND).map(({ payload }) => payload.addressedTo)
    try {
      // Sent in one batch, so the second copy meets the first one's claim.
      const contents = (await Promise.all([
        tool.execute({ target: "workflow", to: workflow, text: "Start with the tests.", targets: ["t3"] }, context(parent, "send-1")),
        tool.execute({ target: "workflow", to: workflow, text: "Start with the tests.", targets: ["t4"] }, context(parent, "send-2")),
      ])).map(({ content }) => String(content))
      for (const content of contents) expect(content).toStartWith(`Delivered to workflow ${workflow}`)
      expect(addressed()).toEqual([[lane(3, "t3")], [lane(4, "t4")]])
      expect(String((await tool.execute({ target: "workflow", to: workflow, text: "Start with the tests.", targets: ["t4"] }, context(parent, "send-3"))).content)).toStartWith(`Not delivered to ${workflow}: you sent it the same text`)

      const waited = await tool.execute({ target: "workflow", to: workflow, text: "Which test fails?", targets: ["t2"], wait: true }, context(parent, "send-4"))
      expect(String(waited.content)).toStartWith("Not delivered: a workflow has no answering agent")
      expect(addressed()).toHaveLength(2)
    } finally {
      unregister()
    }
  })
})

describe("list_sessions", () => {
  test("workflow listing and repeated delivery advance without membership or history scans", async () => {
    const { root, store, manager, reader, messaging, counter } = project()
    const parent = await manager.createChat({ name: "Root" })
    const caller = await publishTestSubagent(manager, root, "caller", parent)
    const workflows: string[] = []
    for (const size of [3, 30]) {
      while (workflows.length < size) {
        workflows.push(await publishTestWorkflow(manager, { name: `Build ${workflows.length}`, launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "fixture-workflow", parentSessionId: parent }) }))
      }
      const workflow = workflows[0]!
      for (let index = 0; index < size; index += 1) {
        store.append({ aggregateId: workflowAggregateId(workflow), sessionId: workflow, timestamp: index, type: "workflow.run.cut.updated", version: 1, actor: "flywheel", payload: { cut: index % 2 === 0 ? { by: "person", timestamp: index } : null } })
      }
      await messaging.list(caller)
      counter.take()
      expect((await messaging.list(caller)).filter((row) => row.target === "workflow")).toHaveLength(size)
      const listingRequests = counter.take()

      const unregister = registerLiveWorkflowControl(reader, { kind: "workflow", workflowId: workflow, handBackMember: async (continueMember) => continueMember(), memberHost: async () => undefined, state: async () => "running", deliver: async (_input, decide) => decide("running"), notify: async () => false })
      try {
        const tool = createMessageSessionTool(messaging)
        expect((await tool.execute({ target: "workflow", to: workflow, text: `Warm ${size}` }, context(parent, `warm-${size}`))).outcome).toBe("ok")
        for (let index = 0; index < 2; index += 1) {
          counter.take()
          const result = await tool.execute({ target: "workflow", to: workflow, text: `Direction ${size} ${index}` }, context(parent, `delivery-${size}-${index}`))
          expect(result.outcome).toBe("ok")
          expect(factsRead(counter.take())).toBe(0)
        }
      } finally {
        unregister()
      }
      expect(listingRequests.length).toBeLessThanOrEqual(8)
    }
  })

  test("a subagent lists its parent and its siblings", async () => {
    const { root, manager, messaging } = project()
    const parent = await manager.createChat({ name: "Root" })
    const child = await publishTestSubagent(manager, root, "child-a", parent)
    const sibling = await publishTestSubagent(manager, root, "child-b", parent)
    const result = await createListSessionsTool(messaging).execute({}, context(child, "list-1"))
    expect(result.content).toContain(`- ${parent} | session | chat | parent | closed | Root`)
    expect(result.content).toContain(`- ${sibling} | session | subagent | sibling |`)
    expect(result.content).not.toContain(`- ${child} |`)
  })

  test("a workflow step lists the parent chat and its siblings", async () => {
    const { root, store, manager, messaging } = project()
    const parent = await manager.createChat({ name: "Root" })
    const workflow = await publishTestWorkflow(manager, { name: "Build", launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "fixture-workflow", parentSessionId: parent }) })
    const member = await startTestWorkflowMember(manager, store, workflow)
    const sibling = await publishTestSubagent(manager, root, "helper", parent)
    const result = await createListSessionsTool(messaging).execute({}, context(member, "list-1"))
    expect(result.content).toContain(`- ${parent} | session | chat | parent |`)
    expect(result.content).toContain(`- ${sibling} | session | subagent | sibling |`)
    expect(result.content).toContain(`- ${workflow} | workflow | workflow | chat ${parent}`)
  })

  test("a live chat of this project is listed as other; a live session of another project never is", async () => {
    const here = project()
    const elsewhere = project()
    const caller = await here.manager.createChat({ name: "Here" })
    const neighbour = await here.manager.createChat({ name: "Neighbour" })
    const foreign = await elsewhere.manager.createChat({ name: "Elsewhere" })
    const live = (reader: typeof here.reader, sessionId: string) => registerLiveSessionControl(reader, {
      sessionId,
      state: async () => "idle",
      deliver: async (_input, decide) => decide("idle"),
      notify: async () => false,
    })
    const unregister = [live(here.reader, neighbour), live(elsewhere.reader, foreign)]
    try {
      const result = await createListSessionsTool(here.messaging).execute({}, context(caller, "list-1"))
      expect(result.content).toContain(`- ${neighbour} | session | chat | other | idle | Neighbour`)
      expect(result.content).not.toContain(foreign)
    } finally {
      for (const off of unregister) off()
    }
  })
})
