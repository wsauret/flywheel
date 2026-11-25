// A question that waits holds its chat (PI-INTERACTION-185, ARCH-SESSIONS-050):
// nothing reaches the agent after the ask until the person answers or skips,
// and the settlement then continues one turn with the held input in order.
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildMutationDiff } from "../../../../src/infra/substrate/file-mutations/mutation-diff.js"
import { buildMutationDiffEvidence } from "../../../../src/infra/substrate/file-mutations/mutation-diff-evidence.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/substrate/store/event-store-types.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer.js"
import { attachedRunnerDelivery, createBackgroundNotificationDelivery } from "../../../../src/orchestration/app-service/supervisor/session-background-notifications.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle.js"
import { holdQueuedBackgroundNotification } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { chatSessionActions, readChatTurnEnd } from "../../../../src/orchestration/session/control/chat-session-run-evidence.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { type Step, askCall, ask, reply, type Chat, newSupervisor, until, quiesce, describeMessage, fromAsk, heldCells, pendingAsk, settle, questionAtRest, attach, expectHeld, expectContinued, askedQuestion, peerMessage, displayedRows, storedRows, displayedBlocks, storedBlocks, questionHoldChats } from "./_question-hold-fixtures.js"

const withChat = questionHoldChats()

setDefaultTimeout(30_000)

describe("a waiting question holds its chat", () => {
  for (const how of ["answer", "skip"] as const) test(`a notice to an attached chat at rest waits behind the question, and the ${how} continues the turn with it`, async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      const mark = chat.model.requests.length
      await attachedRunnerDelivery(chat.ctx.sessionStore)(chat.sessionId, { key: "command:notice-1", text: "<background-command id=\"notice-1\">finished</background-command>" })
      await expectHeld(chat, mark)
      // No turn runs, so a planned update's cut writes no continuation for it.
      expect(chat.ctx.sessionStore.get(chat.sessionId)?.runner?.holdsRunningTurn()).toBe(false)
      expect(chat.ctx.sessionStore.get(chat.sessionId)?.runnerState).toBe("idle")
      expect(await settle(chat, how)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["notice-1"])
    })
  })

  test("a completion held with no runner stays held through activation, and the answer lands it", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      const mark = chat.model.requests.length
      await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "<subagent-result run=\"run-2\">done</subagent-result>", "subagent-completions:run-2")
      await attach(chat)
      await expectHeld(chat, mark)
      expect(await heldCells(chat)).toBe(1)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["run-2"])
    })
  })

  test("the answer of a closed chat with no runner continues the turn with a completion held meanwhile, and its row offers Interrupt, not Resume, while the turn runs", async () => {
    const requested = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const heldReply: Step = async () => { requested.resolve(); await released.promise; return reply("done")([]) }
    await withChat([ask, heldReply], async (chat) => {
      await questionAtRest(chat, { attach: false })
      await chat.ctx.manager.updateLifecycleState(chat.sessionId, "inactive")
      const mark = chat.model.requests.length
      await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "<subagent-result run=\"cold-9\">first</subagent-result>", "subagent-completions:cold-9")
      expect(await settle(chat)).toEqual({ ok: true })
      try {
        await requested.promise
        // The row's evidence while the answer's turn runs: an active chat whose
        // last exchange has no reply, which reads as a crash only once inactive.
        const lifecycleState = (await chat.ctx.manager.read(chat.sessionId))?.lifecycleState
        expect(lifecycleState).toBe("active")
        if (lifecycleState === undefined) throw new Error("no session row")
        const actions = chatSessionActions("chat", lifecycleState, await readChatTurnEnd(asAsyncEventReadSurface(chat.ctx.store), chat.conversationId))
        expect(actions).toContain("chat.interrupt")
        expect(actions).not.toContain("chat.resume")
        expect(chat.ctx.sessionStore.get(chat.sessionId)?.runnerState).toBe("streaming")
      } finally { released.resolve() }
      await expectContinued(chat, mark, ["cold-9"])
    })
  })

  for (const attached of [true, false]) test(`a person's message to a chat at rest (${attached ? "runner attached" : "cold"}) waits behind the question and follows the answer`, async () => {
    await withChat([ask, reply("done"), reply("done-2")], async (chat) => {
      await questionAtRest(chat, { attach: attached })
      const mark = chat.model.requests.length
      expect(await chat.supervisor.sendChat(chat.sessionId, "Person speaks at rest.")).toMatchObject({ ok: true })
      await expectHeld(chat, mark)
      if (!attached) await attach(chat)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Person speaks at rest."])
    })
  })

  test("a person can recall a message held behind a question at rest, and Resume still has nothing to resume", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      const mark = chat.model.requests.length
      expect(await chat.supervisor.sendChat(chat.sessionId, "Never mind.")).toMatchObject({ ok: true })
      await expectHeld(chat, mark)
      expect(await chat.supervisor.resumeChat(chat.sessionId)).toMatchObject({ ok: false })
      expect(await chat.supervisor.recallQueuedMessage(chat.sessionId)).toMatchObject({ text: "Never mind." })
      expect(await heldCells(chat)).toBe(0)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, [])
    })
  })

  test("a message queued behind a live parked question and a person's interrupt start no turn before the answer", async () => {
    await withChat([ask, reply("done"), reply("done-2")], async (chat) => {
      expect(await chat.supervisor.sendChat(chat.sessionId, "Ask me something.")).toMatchObject({ ok: true })
      await until("the question to wait", async () => (await pendingAsk(chat))?.kind === "pending" && chat.ctx.sessionStore.get(chat.sessionId)?.runnerState === "awaiting_user")
      const mark = chat.model.requests.length
      expect(await chat.supervisor.sendChat(chat.sessionId, "Queued then interrupted.")).toMatchObject({ ok: true })
      await chat.supervisor.interruptSession(chat.sessionId, "person")
      await quiesce()
      expect(chat.model.requests.length).toBe(mark)
      expect((await fromAsk(chat)).some((entry) => entry.includes("Queued then interrupted."))).toBe(false)
      expect(await settle(chat)).toEqual({ ok: true })
      await until("the reply", async () => chat.model.requests.length > mark && (await fromAsk(chat)).some((entry) => entry.includes("Queued then interrupted.")))
      await quiesce()
      expect(chat.model.requests.length).toBe(mark + 1)
      const request = chat.model.requests[mark]?.map(describeMessage) ?? []
      const result = request.findIndex((entry) => entry.startsWith("toolResult#ask-1"))
      expect(result).toBeGreaterThan(0)
      expect(request.findIndex((entry) => entry.includes("Queued then interrupted."))).toBeGreaterThan(result)
    })
  })

  for (const attached of [true, false]) test(`a peer's message to a chat at rest (${attached ? "runner attached" : "no runner"}) is held with its reason and follows the answer`, async () => {
    await withChat([ask, reply("done"), reply("done-2")], async (chat) => {
      await questionAtRest(chat, { attach: attached })
      const mark = chat.model.requests.length
      const told = await peerMessage(chat, "Peer says hello.", "peer-call-1")
      expect(told).toMatchObject({ status: "held", reason: attached ? "awaiting_answer" : "no_reader" })
      await expectHeld(chat, mark)
      if (!attached) await attach(chat)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Peer says hello."])
    })
  })

  test("mixed input at rest lands after the answer in arrival order", async () => {
    await withChat([ask, reply("done"), reply("done-2")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      const mark = chat.model.requests.length
      await attachedRunnerDelivery(chat.ctx.sessionStore)(chat.sessionId, { key: "command:order-1", text: "<background-command id=\"order-1\">first</background-command>" })
      expect(await chat.supervisor.sendChat(chat.sessionId, "Person second.")).toMatchObject({ ok: true })
      await peerMessage(chat, "Peer third.", "peer-call-3")
      await attachedRunnerDelivery(chat.ctx.sessionStore)(chat.sessionId, { key: "subagent-completions:order-4", text: "<subagent-result run=\"order-4\">fourth</subagent-result>" })
      await expectHeld(chat, mark)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["order-1", "Person second.", "Peer third.", "order-4"])
    })
  })

  test("held input survives an orderly stop and a new supervisor, and the answer lands it in order", async () => {
    await withChat([ask, reply("done"), reply("done-2")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      const mark = chat.model.requests.length
      await attachedRunnerDelivery(chat.ctx.sessionStore)(chat.sessionId, { key: "command:restart-1", text: "<background-command id=\"restart-1\">first</background-command>" })
      expect(await chat.supervisor.sendChat(chat.sessionId, "Person before restart.")).toMatchObject({ ok: true })
      await quiesce()
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model)
      await attach(chat)
      await expectHeld(chat, mark)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["restart-1", "Person before restart."])
    })
  })

  test("a peer's message to a live parked question is held with its reason and follows the answer", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      expect(await chat.supervisor.sendChat(chat.sessionId, "Ask me something.")).toMatchObject({ ok: true })
      await until("the question to wait", async () => (await pendingAsk(chat))?.kind === "pending" && chat.ctx.sessionStore.get(chat.sessionId)?.runnerState === "awaiting_user")
      const mark = chat.model.requests.length
      expect(await peerMessage(chat, "Peer while parked.", "peer-call-p")).toMatchObject({ status: "held", reason: "awaiting_answer" })
      await expectHeld(chat, mark)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Peer while parked."])
    })
  })

  test("/compact at rest waits behind the question and runs no request before the answer", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      const mark = chat.model.requests.length
      expect(await chat.supervisor.compactChat(chat.sessionId)).toBe(true)
      await expectHeld(chat, mark)
    })
  })

  test("a context command at rest is refused while the question waits and starts nothing", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: true })
      const mark = chat.model.requests.length
      expect(await chat.supervisor.requestChatContext(chat.sessionId, { text: "Run the command." }, "One-shot context.")).toBe(false)
      await expectHeld(chat, mark)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, [])
    })
  })

  test("cold cells, mailbox input and a second activation land after the answer in arrival order", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      const mark = chat.model.requests.length
      await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "<subagent-result run=\"order-a\">first</subagent-result>", "subagent-completions:order-a")
      await peerMessage(chat, "Peer second.", "peer-call-b")
      await attach(chat)
      expect(await chat.supervisor.sendChat(chat.sessionId, "Person third.")).toMatchObject({ ok: true })
      await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "<subagent-result run=\"order-d\">fourth</subagent-result>", "subagent-completions:order-d")
      expect(await chat.supervisor.activateSession(chat.sessionId, { shown: true })).toBe(true)
      await attachedRunnerDelivery(chat.ctx.sessionStore)(chat.sessionId, { key: "command:order-e", text: "<background-command id=\"order-e\">fifth</background-command>" })
      await expectHeld(chat, mark)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["order-a", "Peer second.", "Person third.", "order-d", "order-e"])
    })
  })

  // A reattach and the answer each read the display again from the
  // conversation, which holds no entry for input that waits. A background
  // notice has no row of its own.
  for (const attached of [true, false]) test(`the open display shows each held message once, queued and then sent after the answer in arrival order (${attached ? "held with the runner attached" : "held before the attach"})`, async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: attached })
      const mark = chat.model.requests.length
      await peerMessage(chat, "Peer first.", "peer-call-1")
      if (attached) await attachedRunnerDelivery(chat.ctx.sessionStore)(chat.sessionId, { key: "command:shown-2", text: "<background-command id=\"shown-2\">second</background-command>" })
      else await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "<background-command id=\"shown-2\">second</background-command>", "command:shown-2")
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Person third.", submissionIds: ["shown-3"] })).toMatchObject({ ok: true })
      await attach(chat)
      await expectHeld(chat, mark)
      expect(displayedRows(chat)).toEqual(["question", "queued#msg:peer-session:peer-call-1(from a session: Peer first.)", "queued#person:shown-3(Person third.)"])
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Peer first.", "shown-2", "Person third."])
      const shown = displayedRows(chat)
      expect(shown).toEqual(["question", "sent#msg:peer-session:peer-call-1(from a session: Peer first.)", "sent#person:shown-3(Person third.)", "text(done)"])
      expect(await storedRows(chat)).toEqual(shown)
    })
  })

  test("an answer that lands before the runner attaches shows each held message once, sent in arrival order", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      const startup = Promise.withResolvers<void>()
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model, startup.promise)
      const mark = chat.model.requests.length
      await peerMessage(chat, "Peer first.", "peer-call-1")
      const activated = chat.supervisor.activateSession(chat.sessionId, { shown: true })
      await until("the shell to open", () => chat.ctx.sessionStore.get(chat.sessionId)?.kind === "chat")
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Person second.", submissionIds: ["shown-2"] })).toMatchObject({ ok: true })
      // The settlement waits for the runner, which waits at admission.
      const settled = settle(chat)
      await quiesce()
      startup.resolve()
      expect(await activated).toBe(true)
      expect(await settled).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Peer first.", "Person second."])
      const shown = displayedRows(chat)
      expect(shown).toEqual(["question", "sent#msg:peer-session:peer-call-1(from a session: Peer first.)", "sent#person:shown-2(Person second.)", "text(done)"])
      expect(await storedRows(chat)).toEqual(shown)
    })
  })

  // A skill invocation shows as its divider and the arguments the person
  // typed, never as its expanded prompt. A review notice waits in a cell as
  // a system entry and is no row until it lands.
  test("a held skill invocation and a held system entry show as the stored transcript holds them once the answer lands them", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      const startup = Promise.withResolvers<void>()
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model, startup.promise)
      const mark = chat.model.requests.length
      const activated = chat.supervisor.activateSession(chat.sessionId, { shown: true })
      await until("the shell to open", () => chat.ctx.sessionStore.get(chat.sessionId)?.kind === "chat")
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Expanded prompt of the plain skill.", invocation: { label: "plain-skill" }, submissionIds: ["plain"] })).toMatchObject({ ok: true })
      const mutationEvidence = await buildMutationDiffEvidence(buildMutationDiff([{ path: "SKILL.md", before: { kind: "absent" }, after: { kind: "text", text: "body\n" } }]), "review-write", (nodes) => chat.writer.stageSessionContentNodes(chat.sessionId, nodes))
      await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "Review finished.", "review-1", { mutationEvidence })
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Expanded prompt with arguments.", invocation: { label: "args-skill", args: "the arguments" }, submissionIds: ["args"] })).toMatchObject({ ok: true })
      startup.resolve()
      expect(await activated).toBe(true)
      await until("the runner to attach", () => Boolean(chat.ctx.sessionStore.get(chat.sessionId)?.runner))
      await expectHeld(chat, mark)
      expect(displayedRows(chat)).toEqual(["question", "divider(plain-skill)", "divider(args-skill)", "queued#person:args(the arguments)"])
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Expanded prompt of the plain skill.", "Review finished.", "Expanded prompt with arguments."])
      expect(displayedRows(chat)).toEqual(["question", "divider(plain-skill)", "system", "divider(args-skill)", "sent#person:args(the arguments)", "text(done)"])
      // Ids and the notice's evidence included: the reply streamed after the
      // held input landed, so only its row is the turn's own.
      const landed = (blocks: ReturnType<typeof displayedBlocks>) => blocks.filter((block) => block.kind !== "text")
      expect(landed(displayedBlocks(chat))).toEqual(landed(await storedBlocks(chat)))
      expect(displayedBlocks(chat).find((block) => block.kind === "system")).toMatchObject({ message: "Review finished.", mutationEvidence })
    })
  })

  // With no runner, the next send commits the held message ahead of its
  // own, and no runner marks the queued row sent.
  test("a queued row whose message was committed without its runner shows once, as sent, at that commit and when the chat opens again", async () => {
    await withChat([ask], async (chat) => {
      await questionAtRest(chat, { attach: false })
      await chat.supervisor.disposeAll()
      const refused = Promise.reject(new Error("no admission"))
      refused.catch(() => {})
      chat.supervisor = newSupervisor(chat.ctx, chat.model, refused)
      const open = () => chat.supervisor.activateSession(chat.sessionId, { shown: true }).catch(() => false)
      await open()
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Held first.", submissionIds: ["held-1"] })).toMatchObject({ ok: true })
      await open()
      expect(displayedRows(chat)).toEqual(["question", "queued#person:held-1(Held first.)", "system"])
      expect(await settle(chat)).toEqual({ ok: true })
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Sent second.", submissionIds: ["sent-2"] })).toMatchObject({ ok: true })
      const sent = ["question", "sent#person:held-1(Held first.)", "sent#person:sent-2(Sent second.)"]
      expect(displayedRows(chat).filter((row) => row !== "system")).toEqual(sent)
      await open()
      expect(displayedRows(chat)).toEqual([...sent, "system"])
      expect(await storedRows(chat)).toEqual(sent)
    })
  })

  // With no runner, an activation's drain commits a held notice, and that
  // commit lands the held message too. No runner marks its queued row sent.
  test("a queued row whose message an activation committed without its runner shows as sent", async () => {
    await withChat([ask], async (chat) => {
      await questionAtRest(chat, { attach: false })
      await chat.supervisor.disposeAll()
      const refused = Promise.reject(new Error("no admission"))
      refused.catch(() => {})
      chat.supervisor = newSupervisor(chat.ctx, chat.model, refused)
      const open = () => chat.supervisor.activateSession(chat.sessionId, { shown: true }).catch(() => false)
      await open()
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Held first.", submissionIds: ["held-1"] })).toMatchObject({ ok: true })
      await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "<background-command id=\"notice-1\">finished</background-command>", "command:notice-1")
      expect(await settle(chat)).toEqual({ ok: true })
      await open()
      expect(await heldCells(chat)).toBe(0)
      const sent = ["question", "sent#person:held-1(Held first.)"]
      expect(displayedRows(chat).filter((row) => row !== "system")).toEqual(sent)
      expect(await storedRows(chat)).toEqual(sent)
    })
  })

  // A settlement is durable before its turn starts, so a runner that cannot
  // start then leaves the result with no turn after it. The person's Resume
  // is that turn.
  test("a Resume after a settlement whose turn could not start continues it with the held input after the result", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      await chat.supervisor.disposeAll()
      let refused = true
      chat.supervisor = newSupervisor(chat.ctx, chat.model, async () => { if (refused) throw new Error("no admission") })
      await chat.supervisor.activateSession(chat.sessionId, { shown: true }).catch(() => false)
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Held first.", submissionIds: ["held-1"] })).toMatchObject({ ok: true })
      const mark = chat.model.requests.length
      expect(await settle(chat)).toEqual({ ok: true })
      await quiesce()
      expect(chat.model.requests.length).toBe(mark)
      refused = false
      expect(await chat.supervisor.resumeChat(chat.sessionId)).toEqual({ ok: true })
      await expectContinued(chat, mark, ["Held first."])
      const shown = displayedRows(chat).filter((row) => row !== "system")
      expect(shown).toEqual(["question", "sent#person:held-1(Held first.)", "text(done)"])
      expect(await storedRows(chat)).toEqual(shown)
    })
  })

  test("a message sent before the runner attaches shows queued, and a recall after the attach takes it back", async () => {
    await withChat([ask, reply("done")], async (chat) => {
      await questionAtRest(chat, { attach: false })
      const startup = Promise.withResolvers<void>()
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model, startup.promise)
      const mark = chat.model.requests.length
      // The activation opens the shell and its runner waits at admission, so
      // the send meets no runner.
      const activated = chat.supervisor.activateSession(chat.sessionId, { shown: true })
      await until("the shell to open", () => chat.ctx.sessionStore.get(chat.sessionId)?.kind === "chat")
      expect(await chat.supervisor.sendChat(chat.sessionId, { text: "Sent cold.", submissionIds: ["cold-submission"] })).toMatchObject({ ok: true })
      expect(chat.ctx.sessionStore.get(chat.sessionId)?.runner).toBeFalsy()
      const queued = chat.ctx.sessionStore.get(chat.sessionId)?.outputBlocks().filter((block) => block.kind === "userMessage" && block.content === "Sent cold.")
      expect(queued).toMatchObject([{ pending: true, dispatchIds: ["person:cold-submission"] }])
      startup.resolve()
      expect(await activated).toBe(true)
      await until("the runner to attach", () => Boolean(chat.ctx.sessionStore.get(chat.sessionId)?.runner))
      await expectHeld(chat, mark)
      expect(chat.ctx.sessionStore.get(chat.sessionId)?.outputBlocks().filter((block) => block.kind === "userMessage" && block.content === "Sent cold.")).toHaveLength(1)
      expect(await chat.supervisor.recallQueuedMessage(chat.sessionId)).toMatchObject({ text: "Sent cold." })
      expect(await heldCells(chat)).toBe(0)
      expect(await settle(chat)).toEqual({ ok: true })
      await expectContinued(chat, mark, [])
    })
  })

  test("an ask call whose question was never asked is repaired before the hold, so a person's message starts its turn", async () => {
    await withChat([reply("done")], async (chat) => {
      const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
      if (!tree) throw new Error("missing conversation tree")
      await tree.appendMessages([{ kind: "user", content: "Ask me" }, { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] }])
      tree.dispose()
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model)
      expect(await chat.supervisor.sendChat(chat.sessionId, "Carry on.")).toMatchObject({ ok: true })
      await until("the request", () => chat.model.requests.length === 1)
      expect((await fromAsk(chat)).slice(0, 3)).toEqual(["assistant(call:ask_user#ask-1)", "toolResult#ask-1[interrupted]", "user(Carry on.)"])
      expect(await heldCells(chat)).toBe(0)
    })
  })

  for (const order of ["siblings-first", "ask-first"] as const) test(`an orderly stop keeps the finished results of the ask's sibling calls (${order}), and the answer continues the turn`, async () => {
    let dir = ""
    const siblings = () => [
      { id: "sib-1", name: "read", input: { path: join(dir, "a.txt") } },
      { id: "sib-2", name: "read", input: { path: join(dir, "b.txt") } },
    ].map((toolCall) => ({ kind: "tool_use", toolCall } as const))
    const question = { kind: "tool_use", toolCall: askCall } as const
    const step: Step = () => [...(order === "ask-first" ? [question, ...siblings()] : [...siblings(), question]), { kind: "done", stopReason: "tool_use" }]
    await withChat([step, reply("done")], async (chat) => {
      dir = chat.ctx.baseDir
      writeFileSync(join(dir, "a.txt"), "alpha\n")
      writeFileSync(join(dir, "b.txt"), "beta\n")
      expect(await chat.supervisor.sendChat(chat.sessionId, "Ask me something.")).toMatchObject({ ok: true })
      await until("the question to wait", async () => (await pendingAsk(chat))?.kind === "pending" && chat.ctx.sessionStore.get(chat.sessionId)?.runnerState === "awaiting_user")
      await until("the sibling calls to finish", async () => (await asAsyncEventReadSurface(chat.ctx.store).readInFlight(chat.sessionId, "finalized-tool-result")).length === 2)
      await chat.supervisor.disposeAll()
      chat.supervisor = newSupervisor(chat.ctx, chat.model)
      const afterStop = await fromAsk(chat)
      expect(afterStop.slice(1).sort()).toEqual(["toolResult#sib-1", "toolResult#sib-2"])
      await attach(chat)
      const mark = chat.model.requests.length
      expect(await settle(chat)).toEqual({ ok: true })
      await until("the reply", async () => chat.model.requests.length > mark && (await fromAsk(chat)).at(-1)?.startsWith("assistant(") === true)
      const branch = await fromAsk(chat)
      expect(branch.slice(1, 4).every((entry) => entry.startsWith("toolResult#"))).toBe(true)
      expect(branch.some((entry) => entry.includes("conversationHistoryGap"))).toBe(false)
      expect(chat.model.requests.length).toBe(mark + 1)
    })
  })
})

describe("the conversation writer's hold", () => {
  async function seedWaitingQuestion(chat: Chat): Promise<void> {
    const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
    if (!tree) throw new Error("missing conversation tree")
    await tree.appendMessages([{ kind: "user", content: "Ask me" }, { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] }])
    tree.dispose()
    await askedQuestion(chat)
  }

  async function appendAskResult(chat: Chat): Promise<void> {
    const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
    if (!tree) throw new Error("missing conversation tree")
    await tree.appendMessages([{ kind: "toolResult", toolUseId: "ask-1", content: [{ type: "text", text: "User answered" }] }])
    tree.dispose()
  }

  const controller = (chat: Chat) => createConversationTreeWriterController({ conversationId: chat.conversationId, sessionId: chat.sessionId, projectRoot: chat.ctx.baseDir, store: asAsyncEventReadSurface(chat.ctx.store), projectionReader: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })

  // A learning review can finish after a person interrupted the parked turn,
  // and subagent recovery writes its turn through a writer it disposes at once.
  for (const [label, commit, landed] of [
    ["a review notice", (writer: ReturnType<typeof controller>) => writer.commitSystemMessage("Review finished."), "system(Review finished.)"],
    ["a system turn", (writer: ReturnType<typeof controller>) => writer.commitSystemTurn("Review finished.", "subagent-recovery:r-1"), "user(Review finished.)"],
  ] as const) test(`${label} behind a waiting question outlives its writer and lands after the result, behind a notice held before it`, async () => {
    await withChat([], async (chat) => {
      await seedWaitingQuestion(chat)
      await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, "<background-command id=\"cold-1\">finished</background-command>", "command:cold-1")
      const first = controller(chat)
      try {
        expect(await commit(first)).toBeNull()
      } finally {
        await first.dispose()
      }
      expect(await fromAsk(chat)).toEqual(["assistant(call:ask_user#ask-1)"])
      expect(await heldCells(chat)).toBe(2)
      await appendAskResult(chat)
      const successor = controller(chat)
      try {
        await successor.releaseHeldInput()
      } finally {
        await successor.dispose()
      }
      const branch = await fromAsk(chat)
      expect(branch.slice(0, 2)).toEqual(["assistant(call:ask_user#ask-1)", "toolResult#ask-1"])
      // A cell of the previous shape, with no system entry, lands as the
      // notice it always was; the system entry lands as a system entry.
      expect(branch[2]).toStartWith("user(")
      expect(branch[2]).toContain("cold-1")
      expect(branch[3]).toBe(landed)
      expect(branch).toHaveLength(4)
      expect(await heldCells(chat)).toBe(0)
    })
  })

  // Each cold send and activation drains the held notices of a chat at rest.
  test("a cold drain behind a waiting question reads no more with more held notices or longer history", async () => {
    const counts: number[] = []
    for (const [history, held] of [[2, 1], [40, 1], [2, 12], [40, 12]] as const) {
      await withChat([], async (chat) => {
        const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
        if (!tree) throw new Error("missing conversation tree")
        const seeded: ConversationMessage[] = []
        for (let turn = 0; turn < history; turn += 1) seeded.push({ kind: "user", content: `question ${turn}` }, { kind: "assistant", content: `answer ${turn}` })
        await tree.appendMessages(seeded)
        tree.dispose()
        await seedWaitingQuestion(chat)
        for (let cell = 0; cell < held; cell += 1) await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, `held ${cell}`, `held-${cell}`)
        const counter = countStateRequests(asAsyncEventReadSurface(chat.ctx.store))
        const delivery = createBackgroundNotificationDelivery({ sessionId: chat.sessionId, projectRoot: chat.ctx.baseDir, projectionReader: counter.reader, eventWriter: chat.writer, admitsDelivery: () => true, sweepAfterCommit: () => {} })
        const entry = chat.ctx.sessionStore.get(chat.sessionId)
        if (entry?.kind !== "chat") throw new Error("missing chat entry")
        counter.take()
        expect(await delivery.drainHeld({ ...entry, runner: null })).toEqual({ questionWaits: true, landed: false })
        counts.push(counter.take().length)
        expect(await heldCells(chat)).toBe(held)
      })
    }
    expect(new Set(counts).size).toBe(1)
  })

  // Hot path: every delivery behind a waiting question asks the writer.
  test("the reads of a held delivery grow with neither the held input nor the history", async () => {
    const perDelivery: number[][] = []
    for (const [history, held] of [[2, 1], [40, 1], [2, 12], [40, 12]] as const) {
      await withChat([], async (chat) => {
        const tree = await tryOpenConversationTree({ conversationId: chat.conversationId, sessionId: chat.sessionId, store: asAsyncEventReadSurface(chat.ctx.store), writer: chat.writer })
        if (!tree) throw new Error("missing conversation tree")
        const seeded: ConversationMessage[] = []
        for (let turn = 0; turn < history; turn += 1) seeded.push({ kind: "user", content: `question ${turn}` }, { kind: "assistant", content: `answer ${turn}` })
        seeded.push({ kind: "user", content: "Ask me" }, { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] })
        await tree.appendMessages(seeded)
        tree.dispose()
        await askedQuestion(chat)
        for (let cell = 0; cell < held; cell += 1) await holdQueuedBackgroundNotification(chat.writer, chat.sessionId, chat.conversationId, `held ${cell}`, `held-${cell}`)
        const counter = countStateRequests(asAsyncEventReadSurface(chat.ctx.store))
        const writer = createConversationTreeWriterController({ conversationId: chat.conversationId, sessionId: chat.sessionId, projectRoot: chat.ctx.baseDir, store: counter.reader, projectionReader: counter.reader, writer: chat.writer })
        try {
          expect(await writer.awaitsAnswer()).toBe(true)
          counter.take()
          const counts: number[] = []
          for (let delivery = 0; delivery < 4; delivery += 1) {
            const notice = await writer.holdBackgroundNotification(`notice ${delivery}`, `notice-${delivery}`)
            if (!notice) throw new Error("the notice was not held")
            expect(writer.holdsForQuestion()).toBe(true)
            expect(await writer.commitBackgroundNotification(notice)).toBeNull()
            counts.push(counter.take().length)
          }
          perDelivery.push(counts)
        } finally {
          await writer.dispose()
        }
      })
    }
    const [first] = perDelivery
    for (const counts of perDelivery) expect(counts).toEqual(first ?? [])
    expect(new Set(first).size).toBe(1)
  })
})
