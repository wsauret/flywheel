import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock } from "../../../../src/protocol/runtime/app-service-types.js"
import type { BudgetView } from "../../../../src/protocol/session/budget-protocol-types.js"
import type { ChatSettlementOutcome } from "../../../../src/protocol/session/chat-settlement-protocol-types.js"
import type { PendingQuestionView } from "../../../../src/protocol/session/question-protocol-types.js"
import type { AgentToolInput } from "../../../../src/orchestration/agent-runtime/types.js"
import { createChatInvocationCompletion } from "../../../../src/orchestration/chat/runner-completion.js"
import { CHAT, CWD, acpFixture, prompt, question } from "./_acp-fixture.js"
/** A tool result larger than a live row carries inline. */
const LARGE_RESULT = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n")


describe("headless chat over ACP", () => {
  it("initializes, opens the root chat as its session, streams a turn, and answers the prompt when the turn settles", async () => {
    // The turn streams while it runs, then ends with a reply that only the
    // settled read delivers, as when its last delta is still on its way.
    const fixture = acpFixture(async ({ output, publish, settle, streamed }) => {
      output({ kind: "text", id: "t1", content: "Hel", timestamp: 0 })
      await streamed("Hel")
      output({ kind: "text", id: "t1", content: "Hello", timestamp: 0 })
      // The tool's input streams before its detail is known.
      output({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "" }, status: "streaming", timestamp: 0 })
      await streamed("pending")
      output({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "ls" }, status: "pending", timestamp: 0 })
      await streamed("in_progress")
      output({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "ls" }, status: "completed", content: "a.txt", timestamp: 0 })
      publish({ cursor: { scope: "session", domain: "budget", sessionId: "root" }, payload: { kind: "budget.updated", budget: { totalsLoading: false, tokens: 1040, cost: 0.3, billedCost: 0.25, priceUnavailable: false, contextPercent: 10, contextPromptTokens: 1000 } } })
      output({ kind: "text", id: "t2", content: "Done.", timestamp: 0 })
      await settle("complete")
    })
    const [initialized, opened] = await fixture.open()
    expect(initialized?.result).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }, agentInfo: { name: "flywheel" }, authMethods: [] })
    expect(opened?.result).toMatchObject({ sessionId: "root", configOptions: [{ id: "model", currentValue: "gpt-a" }, { id: "effort", currentValue: "medium" }] })

    fixture.send(prompt(2, "list files"))
    expect((await fixture.response(2)).result).toEqual({
      stopReason: "end_turn",
      usage: { totalTokens: 1040, inputTokens: 1000, outputTokens: 40, thoughtTokens: 10, cachedReadTokens: 900, cachedWriteTokens: 0 },
    })
    fixture.end()
    expect(await fixture.channel).toBe("complete")

    expect(fixture.calls).toContainEqual({ type: "session.send", sessionId: "root", input: "list files" })
    const updates = fixture.updates()
    expect(updates.flatMap((update) => update.sessionUpdate === "agent_message_chunk" ? [update.content] : [])).toEqual([
      { type: "text", text: "Hel" }, { type: "text", text: "lo" }, { type: "text", text: "Done." },
    ])
    expect(updates.filter((update) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Bash", kind: "execute", status: "pending", rawInput: { tool: "bash" } },
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress", title: "Bash ls", rawInput: { tool: "bash" } },
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawInput: { tool: "bash" }, content: [{ type: "content", content: { type: "text", text: "a.txt" } }] },
    ])
    const answered = fixture.messages.findIndex((message) => message.id === 2)
    expect(fixture.messages.slice(0, answered).at(-1)?.params?.update).toEqual({ sessionUpdate: "usage_update", used: 1000, size: 10_000, cost: { amount: 0.25, currency: "USD" } })
  })

  it("states the usage of a turn's last request before it answers the prompt", async () => {
    const budget = (billedCost: number, contextPromptTokens: number): BudgetView => ({ totalsLoading: false, tokens: contextPromptTokens, cost: billedCost, billedCost, priceUnavailable: false, contextPercent: 10, contextPromptTokens })
    const fixture = acpFixture(async ({ output, publish, stored, settle, streamed }) => {
      // The first request calls a tool, and the totals state its usage while the tool runs.
      output({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "ls" }, status: "completed", content: "a.txt", timestamp: 0 })
      publish({ cursor: { scope: "session", domain: "budget", sessionId: "root" }, payload: { kind: "budget.updated", budget: budget(0.25, 1000) } })
      await streamed("usage_update")
      // The second request ends the turn: its usage is stored, and the turn
      // settles before the totals state it.
      output({ kind: "text", id: "t1", content: "Done.", timestamp: 0 })
      stored(budget(0.75, 3000))
      await settle("complete")
    })
    await fixture.open()
    fixture.send(prompt(2, "list files"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    fixture.end()
    await fixture.channel
    const answered = fixture.messages.findIndex((message) => message.id === 2)
    expect(fixture.messages.slice(0, answered).at(-1)?.params?.update).toEqual({ sessionUpdate: "usage_update", used: 3000, size: 30_000, cost: { amount: 0.75, currency: "USD" } })
    expect(fixture.messages.slice(answered + 1)).toEqual([])
  })

  it("fails the prompt, and states no settled usage, when the turn's totals cannot be read", async () => {
    const budget = (billedCost: number, contextPromptTokens: number): BudgetView => ({ totalsLoading: false, tokens: contextPromptTokens, cost: billedCost, billedCost, priceUnavailable: false, contextPercent: 10, contextPromptTokens })
    const fixture = acpFixture(async ({ output, publish, stored, unreadable, settle, streamed }) => {
      output({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "ls" }, status: "completed", content: "a.txt", timestamp: 0 })
      publish({ cursor: { scope: "session", domain: "budget", sessionId: "root" }, payload: { kind: "budget.updated", budget: budget(0.25, 1000) } })
      await streamed("usage_update")
      output({ kind: "text", id: "t1", content: "Done.", timestamp: 0 })
      stored(budget(0.75, 3000))
      unreadable(new Error("summary read timed out"))
      await settle("complete")
    })
    await fixture.open()
    fixture.send(prompt(2, "list files"))
    const answer = await fixture.response(2)
    expect(answer.result).toBeUndefined()
    expect(answer.error?.message).toContain("summary read timed out")
    const answered = fixture.messages.indexOf(answer)
    // The only usage the client holds for the turn is the live one, which
    // the settlement did not certify.
    expect(fixture.messages.slice(0, answered).flatMap((message) => message.params?.update.sessionUpdate === "usage_update" ? [message.params.update] : [])).toEqual([
      { sessionUpdate: "usage_update", used: 1000, size: 10_000, cost: { amount: 0.25, currency: "USD" } },
    ])
    expect(fixture.messages[answered - 1]?.params?.update).toMatchObject({ sessionUpdate: "agent_message_chunk" })
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("streams the whole result of a tool whose body the live row leaves out", async () => {
    const fixture = acpFixture(async ({ output, settle, streamed }) => {
      output({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "cat log" }, status: "pending", timestamp: 0 })
      await streamed("in_progress")
      output({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "cat log" }, status: "completed", content: LARGE_RESULT, timestamp: 0 })
      await settle("complete")
    })
    await fixture.open()
    fixture.send(prompt(2, "read the log"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.updates().filter((update) => update.sessionUpdate === "tool_call_update").at(-1)).toEqual(
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawInput: { tool: "bash" }, content: [{ type: "content", content: { type: "text", text: LARGE_RESULT } }] },
    )
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("ends an unattended one-shot run after it answers the first prompt, while stdin stays open", async () => {
    let handoff: AgentToolInput | undefined
    const invocation = createChatInvocationCompletion((content) => { handoff = content }, true)
    const fixture = acpFixture(async ({ output, settle }) => {
      output({ kind: "text", id: "t1", content: "42", timestamp: 0 })
      // The loop seals the invocation with the final reply when the turn ends (PI-AGENT-121).
      invocation.seal?.("42")
      await invocation.finish({ kind: "completed" }, async () => {})
      await settle("complete")
    }, { completion: { bind: () => {}, result: () => handoff } })
    await fixture.open()
    fixture.send(prompt(2, "compute"))
    expect(await fixture.channel).toBe("complete")
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
  })

  it("leaves the prompt unanswered after the model's last reply while work the chat owns is still busy", async () => {
    const replied = Promise.withResolvers<() => Promise<void>>()
    const fixture = acpFixture(async ({ output, settle, streamed }) => {
      // The model ended its turn, but a background command still runs.
      output({ kind: "text", id: "t1", content: "Started the server.", timestamp: 0 })
      await streamed("Started the server.")
      replied.resolve(() => settle("complete"))
    })
    await fixture.open()
    fixture.send(prompt(2, "start a server"))
    const finish = await replied.promise
    await Bun.sleep(10)
    expect(fixture.messages.some((message) => message.id === 2)).toBe(false)
    await finish()
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("answers a cancelled prompt with stopReason cancelled after it interrupts the turn", async () => {
    let end = (_outcome: ChatSettlementOutcome) => {}
    const fixture = acpFixture(({ publish, settle }) => {
      // A subscription run bills nothing: its equivalent value is not a cost.
      publish({ cursor: { scope: "session", domain: "budget", sessionId: "root" }, payload: { kind: "budget.updated", budget: { totalsLoading: false, tokens: 1040, cost: 0.5, billedCost: 0, priceUnavailable: false, contextPercent: 10, contextPromptTokens: 1000 } } })
      end = (outcome) => { void settle(outcome) }
    })
    fixture.onInterrupt(() => { end("incomplete") })
    await fixture.open()
    fixture.send(prompt(2, "work forever"))
    await Bun.sleep(0)
    fixture.send({ method: "session/cancel", params: { sessionId: "root" } })
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "cancelled" })
    expect(fixture.calls).toContainEqual({ type: "chat.interrupt", sessionId: "root" })
    expect(fixture.updates()).toContainEqual({ sessionUpdate: "usage_update", used: 1000, size: 10_000 })
    fixture.end()
    expect(await fixture.channel).toBe("incomplete")
  })

  it("answers a failed prompt with the turn's error notice, which it also streams as the agent's message", async () => {
    let turns = 0
    const fixture = acpFixture(async ({ output, settle }) => {
      if (turns++ > 0) return settle("failed")
      output({ kind: "system", id: "n1", level: "error", message: "The login expired", timestamp: 0 })
      output({ kind: "system", id: "n2", level: "info", message: "Retrying", timestamp: 0 })
      return settle("failed")
    })
    await fixture.open()
    fixture.send(prompt(2, "work"))
    expect((await fixture.response(2)).error).toEqual({ code: -32603, message: "The login expired" })
    expect(fixture.updates().filter((update) => update.sessionUpdate === "agent_message_chunk")).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The login expired" } },
    ])
    // A later turn that fails without a notice of its own states no earlier cause.
    fixture.send(prompt(3, "again"))
    expect((await fixture.response(3)).error?.message).toBe("The turn ended before it completed")
    fixture.end()
    expect(await fixture.channel).toBe("failed")
  })

  it("answers a turn that the run's failure ended with an error that names the failure kind, also when the chat's work settles complete", async () => {
    let turns = 0
    const fixture = acpFixture(async ({ output, ended, settle }) => {
      turns++
      if (turns === 1) {
        // The recorded failure notice ends the conversation, so the settled read finds nothing to resume.
        output({ kind: "system", id: "n1", level: "error", message: "The provider is overloaded", timestamp: 0 })
        ended({ kind: "failed", failure: "api_overloaded" })
      } else {
        ended(turns === 2 ? { kind: "failed", failure: "context_overflow" } : { kind: "completed" })
      }
      return settle("complete")
    })
    await fixture.open()
    fixture.send(prompt(2, "work"))
    expect((await fixture.response(2)).error).toEqual({ code: -32603, message: "The provider is overloaded", data: { failure: "api_overloaded" } })
    fixture.send(prompt(3, "again"))
    expect((await fixture.response(3)).error).toEqual({ code: -32603, message: "The turn ended before it completed", data: { failure: "context_overflow" } })
    // The next turn's ending is its own.
    fixture.send(prompt(4, "once more"))
    expect((await fixture.response(4)).result).toMatchObject({ stopReason: "end_turn" })
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("answers a turn that the provider's refusal of the content ended with stopReason refusal, unless the channel then failed", async () => {
    let turns = 0
    const fixture = acpFixture(async ({ output, ended, settle }) => {
      output({ kind: "system", id: `n${turns}`, level: "error", message: "The provider's content filter blocked this response", timestamp: 0 })
      ended({ kind: "refused" })
      // The second refusal's durable write fails after the turn ended.
      return settle(turns++ === 0 ? "complete" : "failed")
    })
    await fixture.open()
    fixture.send(prompt(2, "work"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "refusal" })
    fixture.send(prompt(3, "again"))
    expect((await fixture.response(3)).error).toMatchObject({ code: -32603 })
    fixture.end()
    expect(await fixture.channel).toBe("failed")
  })

  it("ends the prompt on an open question without answering it, and answers it with the next prompt", async () => {
    let turns = 0
    const fixture = acpFixture(({ output, settle }) => {
      if (turns++ > 0) return settle("complete")
      output(question)
      return settle("input_required")
    })
    await fixture.open()
    fixture.send(prompt(2, "start the server"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.updates()).toContainEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Which port?\n- 8080" } })
    expect(fixture.calls.some((command) => command.type === "question.answer" || command.type === "question.cancel")).toBe(false)

    fixture.send(prompt(3, "9090"))
    expect((await fixture.response(3)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.calls).toContainEqual({ type: "question.answer", sessionId: "root", toolUseId: "ask", answers: { "Which port?": { kind: "freeform", text: "9090" } } })
    // A client that advertised no forms is never asked for one.
    expect(fixture.messages.some((message) => message.method === "elicitation/create")).toBe(false)
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("loads a saved chat by replaying its history, the person's messages included, before it answers, and starts no work", async () => {
    const fixture = acpFixture(({ settle }) => settle("complete"), {}, {
      history: [
        { kind: "userMessage", id: "u1", content: "list files", timestamp: 0, pending: false, injected: false },
        { kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "ls" }, status: "completed", content: "a.txt", timestamp: 0 },
        { kind: "text", id: "t1", content: "One file.", timestamp: 0 },
      ],
    })
    await fixture.initialize()
    fixture.send({ id: 1, method: "session/load", params: { sessionId: "root", cwd: CWD, mcpServers: [] } })
    const loaded = await fixture.response(1)
    expect(loaded.result).toMatchObject({ configOptions: [{ id: "model" }, { id: "effort" }], _meta: { "dev.flywheel/settings": { workflowsMode: "ask", roles: { assignments: { chat: { model: "gpt-a" } } } } } })
    const replayed = fixture.messages.slice(0, fixture.messages.indexOf(loaded)).flatMap((message) => message.params?.update ? [message.params.update] : [])
    expect(replayed).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "list files" } },
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "Bash ls", kind: "execute", status: "completed", rawInput: { tool: "bash" }, content: [{ type: "content", content: { type: "text", text: "a.txt" } }] },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "One file." } },
    ])
    fixture.end()
    expect(await fixture.channel).toBe("complete")
    expect(fixture.calls).toEqual([{ type: "session.activate", sessionId: "root" }])
  })

  it("resumes a saved chat without a replay and starts no work, and refuses an unknown chat or another directory", async () => {
    const fixture = acpFixture(({ settle }) => settle("complete"), {}, { history: [{ kind: "text", id: "t1", content: "Earlier.", timestamp: 0 }] })
    await fixture.initialize()
    fixture.send({ id: 1, method: "session/resume", params: { sessionId: "missing", cwd: CWD } })
    expect((await fixture.response(1)).error).toEqual({ code: -32002, message: "Unknown session: missing", data: { sessionId: "missing" } })
    fixture.send({ id: 2, method: "session/resume", params: { sessionId: "root", cwd: "/" } })
    expect((await fixture.response(2)).error?.code).toBe(-32602)
    fixture.send({ id: 3, method: "session/resume", params: { sessionId: "root", cwd: CWD } })
    expect((await fixture.response(3)).result).toMatchObject({ configOptions: [{ id: "model" }, { id: "effort" }] })
    expect(fixture.updates()).toEqual([])
    // The resumed client already holds the history: a prompt streams only its own turn.
    fixture.send(prompt(4, "go on"))
    expect((await fixture.response(4)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.updates().filter((update) => update.sessionUpdate === "agent_message_chunk")).toEqual([])
    fixture.end()
    expect(await fixture.channel).toBe("complete")
    expect(fixture.calls).toEqual([{ type: "session.activate", sessionId: "root" }, { type: "session.send", sessionId: "root", input: "go on" }])
  })

  it("closes the session idempotently, letting go of the chat without deleting it", async () => {
    const fixture = acpFixture(({ settle }) => settle("complete"))
    await fixture.open()
    fixture.send({ id: 2, method: "session/close", params: { sessionId: "root" } })
    fixture.send({ id: 3, method: "session/close", params: { sessionId: "root" } })
    fixture.send({ id: 4, method: "session/close", params: { sessionId: "other" } })
    fixture.send(prompt(5, "hello"))
    expect((await fixture.response(2)).result).toEqual({})
    expect((await fixture.response(3)).result).toEqual({})
    expect((await fixture.response(4)).error?.code).toBe(-32002)
    expect((await fixture.response(5)).error?.code).toBe(-32602)
    fixture.end()
    await fixture.channel
    expect(fixture.calls.filter((command) => command.type === "session.release")).toEqual([{ type: "session.release", sessionId: "root" }])
    expect(fixture.calls.some((command) => command.type === "session.close" || command.type === "session.delete" || command.type === "session.send")).toBe(false)
  })

  it("follows its chat across broken lanes: it reads settlement again, activates the chat again, and streams on each lane's watch", async () => {
    const fixture = acpFixture(async ({ output, settleUnseen, streamed }) => {
      output({ kind: "text", id: "t1", content: "Before.", timestamp: 0 })
      await streamed("Before.")
      fixture.breakLane()
      output({ kind: "text", id: "t2", content: "After.", timestamp: 0 })
      await streamed("After.")
      // No wake reaches the client: only the next lane reads the settled turn.
      settleUnseen("complete")
      fixture.breakLane()
    })
    await fixture.open()
    fixture.loseSettlementReads(1)
    fixture.send(prompt(2, "go"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.watching("root")).toBe(true)
    fixture.end()
    expect(await fixture.channel).toBe("complete")
    expect(fixture.updates().flatMap((update) => update.sessionUpdate === "agent_message_chunk" ? [update.content] : [])).toEqual([
      { type: "text", text: "Before." }, { type: "text", text: "After." },
    ])
    expect(fixture.calls.filter((command) => command.type === "session.activate")).toHaveLength(3)
  })

  it("selects the requested auth profile for the chat it opens, and fails session/new when the runtime refuses it", async () => {
    const fixture = acpFixture(({ settle }) => settle("complete"), { authProfile: "Work" })
    const [, opened] = await fixture.open()
    expect(opened?.result).toMatchObject({ sessionId: "root" })
    expect(fixture.calls.slice(0, 3)).toEqual([
      { type: "chat.open" },
      { type: "auth.profile.select", scope: { kind: "session", sessionId: "root" }, id: "Work" },
      { type: "session.activate", sessionId: "root" },
    ])
    fixture.end()
    await fixture.channel
    const locked = acpFixture(({ settle }) => settle("complete"), { authProfile: "Locked" })
    const [, refused] = await locked.open()
    expect(refused?.error?.message).toBe("cannot switch the environment-selected auth profile")
    expect(locked.calls.some((command) => command.type === "session.activate")).toBe(false)
    locked.end()
    await locked.channel
  })

  it("lists the chat seat's model and effort as config options, saves a change for the session, and pushes a change the runtime made", async () => {
    const fixture = acpFixture(({ settle }) => settle("complete"))
    const [, opened] = await fixture.open()
    expect(opened?.result).toMatchObject({
      configOptions: [
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "gpt-a", options: [{ value: "gpt-a", name: "GPT A" }, { value: "gpt-b", name: "GPT B" }] },
        { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low", name: "low" }, { value: "medium", name: "medium" }] },
      ],
      _meta: { "dev.flywheel/settings": { modelPlan: { sessionId: "root", profile: { effectiveId: "Personal" } }, workflowsMode: "ask" } },
    })
    // A model whose efforts leave out the one in force takes its first.
    fixture.send({ id: 2, method: "session/set_config_option", params: { sessionId: "root", configId: "model", value: "gpt-b" } })
    expect((await fixture.response(2)).result).toMatchObject({
      configOptions: [{ id: "model", currentValue: "gpt-b" }, { id: "effort", currentValue: "high", options: [{ value: "high", name: "high" }] }],
      _meta: { "dev.flywheel/settings": { modelPlan: { plans: [{ model: "gpt-b" }] } } },
    })
    expect(fixture.calls).toContainEqual({
      type: "model.save_effort", scope: { kind: "session", sessionId: "root" }, slot: CHAT, model: "gpt-b", effort: "high",
      expected: { kind: "value", value: { model: "gpt-a", effort: "medium" } },
    })
    fixture.send({ id: 3, method: "session/set_config_option", params: { sessionId: "root", configId: "effort", value: "low" } })
    fixture.send({ id: 4, method: "session/set_config_option", params: { sessionId: "root", configId: "model", value: "gpt-off" } })
    fixture.send({ id: 5, method: "session/set_config_option", params: { sessionId: "other", configId: "model", value: "gpt-a" } })
    expect((await fixture.response(3)).error?.code).toBe(-32602)
    expect((await fixture.response(4)).error?.code).toBe(-32602)
    expect((await fixture.response(5)).error?.code).toBe(-32002)
    const pushed = () => fixture.updates().filter((update) => update.sessionUpdate === "config_option_update")
    // The session's own save pushes nothing the response did not state.
    expect(pushed()).toEqual([])
    fixture.reseat({ model: "gpt-a", effort: "low" })
    fixture.send({ id: 6, method: "session/set_config_option", params: { sessionId: "root", configId: "bogus", value: "x" } })
    expect((await fixture.response(6)).error?.code).toBe(-32602)
    fixture.end()
    await fixture.channel
    expect(pushed()).toMatchObject([{ configOptions: [{ id: "model", currentValue: "gpt-a" }, { id: "effort", currentValue: "low" }] }])
  })

  const choices: PendingQuestionView = {
    kind: "question", toolUseId: "ask", timestamp: 0,
    questions: [
      { question: "Which port?", header: "Port", multiSelect: false, choices: [{ kind: "option", choiceId: "c8080", label: "8080" }, { kind: "freeform", label: "Other" }] },
      { question: "Which checks?", multiSelect: true, choices: [{ kind: "option", choiceId: "lint", label: "Lint" }, { kind: "option", choiceId: "tests", label: "Tests", requiresText: true }] },
    ],
  }

  it("asks a question as a form while the prompt stays open, answers it with the accepted choices, and answers the prompt after the next settlement", async () => {
    let turns = 0
    const fixture = acpFixture(async ({ output, settle }) => {
      if (turns++ > 0) {
        output({ kind: "text", id: "t1", content: "Started.", timestamp: 0 })
        return settle("complete")
      }
      output(choices)
      return settle("input_required")
    }, {}, { forms: true, asks: choices })
    await fixture.open()
    fixture.send(prompt(2, "start the server"))
    const asked = await fixture.form()
    expect(asked.params).toEqual({
      sessionId: "root", toolCallId: "ask", mode: "form", message: "Which port?\n\nWhich checks?",
      requestedSchema: {
        type: "object",
        properties: {
          q1: { type: "string", title: "Port", description: "Which port?", oneOf: [{ const: "c8080", title: "8080" }] },
          q1_other: { type: "string", title: "Other" },
          q2: { type: "array", title: "Which checks?", items: { anyOf: [{ const: "lint", title: "Lint" }, { const: "tests", title: "Tests" }] } },
          q2_tests: { type: "string", title: "Tests: details" },
        },
        required: ["q2"],
      },
    })
    expect(fixture.messages.some((message) => message.id === 2)).toBe(false)
    fixture.reply(asked.id, { action: "accept", content: { q1: "c8080", q2: ["tests", "unknown"], q2_tests: " unit only " } })
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.calls).toContainEqual({
      type: "question.answer", sessionId: "root", toolUseId: "ask", answers: {
        "Which port?": { kind: "choice", selections: [{ choiceId: "c8080" }], text: "8080" },
        "Which checks?": { kind: "choice", selections: [{ choiceId: "tests", text: "unit only" }], text: "Tests: unit only" },
      },
    })
    // The question reaches a form client as the form, never as the agent's text.
    expect(fixture.updates().flatMap((update) => update.sessionUpdate === "agent_message_chunk" ? [update.content.text] : [])).toEqual(["Started."])
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("declines a question when the form is declined, and leaves it open, ending the prompt, when the form is cancelled", async () => {
    let turns = 0
    const fixture = acpFixture(({ output, settle }) => {
      turns++
      if (turns === 2) return settle("complete")
      output({ ...question, toolUseId: `ask-${turns}` })
      return settle("input_required")
    }, {}, { forms: true })
    await fixture.open()
    fixture.send(prompt(2, "first"))
    fixture.reply((await fixture.form(0)).id, { action: "decline" })
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.calls).toContainEqual({ type: "question.cancel", sessionId: "root", toolUseId: "ask" })

    fixture.send(prompt(3, "second"))
    fixture.reply((await fixture.form(1)).id, { action: "cancel" })
    expect((await fixture.response(3)).result).toMatchObject({ stopReason: "end_turn" })
    const answers = fixture.calls.filter((command) => command.type === "question.answer" || command.type === "question.cancel")
    expect(answers).toHaveLength(1)
    fixture.end()
    expect(await fixture.channel).toBe("input_required")
  })

  it("asks a resumed chat's open question again: as a form, or as the agent's message to a client without forms", async () => {
    const formClient = acpFixture(({ settle }) => settle("complete"), {}, { forms: true, waiting: true, history: [question] })
    await formClient.initialize()
    formClient.send({ id: 1, method: "session/resume", params: { sessionId: "root", cwd: CWD } })
    await formClient.response(1)
    const asked = await formClient.form()
    expect(asked.params.toolCallId).toBe("ask")
    expect(formClient.messages.indexOf(formClient.messages.find((message) => message.id === 1)!)).toBeLessThan(formClient.messages.findIndex((message) => message.method === "elicitation/create"))
    formClient.reply(asked.id, { action: "accept", content: { q1_other: "9090" } })
    formClient.end()
    expect(await formClient.channel).toBe("complete")
    expect(formClient.calls).toContainEqual({ type: "question.answer", sessionId: "root", toolUseId: "ask", answers: { "Which port?": { kind: "freeform", text: "9090" } } })

    const textClient = acpFixture(({ settle }) => settle("complete"), {}, { waiting: true, history: [question] })
    await textClient.initialize()
    textClient.send({ id: 1, method: "session/resume", params: { sessionId: "root", cwd: CWD } })
    await textClient.response(1)
    textClient.send(prompt(2, "9090"))
    expect((await textClient.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    expect(textClient.updates().filter((update) => update.sessionUpdate === "agent_message_chunk")).toEqual([
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Which port?\n- 8080" } },
    ])
    expect(textClient.calls).toContainEqual({ type: "question.answer", sessionId: "root", toolUseId: "ask", answers: { "Which port?": { kind: "freeform", text: "9090" } } })
    textClient.end()
    expect(await textClient.channel).toBe("complete")
  })

  it("streams a thought once when its finalized block replaces the streamed draft under another identity", async () => {
    const fixture = acpFixture(async ({ output, retract, settle, streamed }) => {
      const draft = (content: string): FrontendOutputBlock => ({ kind: "thinking", id: "run:thinking:0", content, status: "streaming", timestamp: 0 })
      output(draft("Let me"))
      await streamed("Let me")
      output(draft("Let me check the tests."))
      await streamed("check the tests.")
      // The thought settles to its recorded part, whose block identity names
      // the entry: the draft is retracted and the part is published whole.
      retract(draft("Let me check the tests."))
      output({ kind: "thinking", id: "entry:1", content: "Let me check the tests.", status: "completed", timestamp: 0 })
      output({ kind: "text", id: "entry:2", content: "Done.", timestamp: 0 })
      await streamed("Done.")
      output({ kind: "thinking", id: "entry:3", content: "Let me check again.", status: "completed", timestamp: 0 })
      await settle("complete")
    })
    await fixture.open()
    fixture.send(prompt(2, "check"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    const thoughts = fixture.updates().flatMap((update) => update.sessionUpdate === "agent_thought_chunk" ? [update.content.text] : [])
    expect(thoughts).toEqual(["Let me", " check the tests.", "Let me check again."])
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("streams the output whose live deltas were lost, in order, once the turn settles", async () => {
    const text = (index: number): FrontendOutputBlock => ({ kind: "text", id: `t${index}`, content: `chunk-${index};`, timestamp: 0 })
    const tool = (status: "pending" | "completed"): FrontendOutputBlock => ({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "ls" }, status, ...(status === "completed" ? { content: "a.txt" } : {}), timestamp: 0 })
    const fixture = acpFixture(async ({ output, lose, publish, settle, streamed }) => {
      // A running tool and a partial text whose final versions are lost
      // before the gap.
      output(tool("pending"))
      output({ kind: "text", id: "t0", content: "chunk", timestamp: 0 })
      await streamed("chunk")
      lose(tool("completed"))
      lose(text(0))
      for (let index = 1; index <= 300; index += 1) lose(text(index))
      publish({ cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } })
      output(text(301))
      await settle("complete")
    })
    await fixture.open()
    fixture.send(prompt(2, "write a lot"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    const chunks = fixture.updates().flatMap((update) => update.sessionUpdate === "agent_message_chunk" ? [update.content.text] : [])
    expect(chunks).toEqual(["chunk", "-0;", ...Array.from({ length: 301 }, (_, index) => `chunk-${index + 1};`)])
    expect(fixture.updates().filter((update) => update.sessionUpdate === "tool_call_update")).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawInput: { tool: "bash" }, content: [{ type: "content", content: { type: "text", text: "a.txt" } }] },
    ])
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("streams the lost result of a running tool that the recovered window starts after", async () => {
    const tool = (status: "pending" | "completed"): FrontendOutputBlock => ({ kind: "tool", id: "call-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "ls" }, status, ...(status === "completed" ? { content: LARGE_RESULT } : {}), timestamp: 0 })
    const fixture = acpFixture(async ({ output, lose, publish, settle, streamed }) => {
      output(tool("pending"))
      // More streamed output than one window holds, so the recovered window
      // starts at a block that already streamed.
      for (let index = 0; index < 300; index += 1) output({ kind: "text", id: `t${index}`, content: `chunk-${index};`, timestamp: 0 })
      await streamed("chunk-299;")
      lose(tool("completed"))
      publish({ cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } })
      output({ kind: "text", id: "t300", content: "Done.", timestamp: 0 })
      await settle("complete")
    })
    await fixture.open()
    fixture.send(prompt(2, "run a tool"))
    expect((await fixture.response(2)).result).toMatchObject({ stopReason: "end_turn" })
    expect(fixture.updates().filter((update) => update.sessionUpdate === "tool_call_update")).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawInput: { tool: "bash" }, content: [{ type: "content", content: { type: "text", text: LARGE_RESULT } }] },
    ])
    fixture.end()
    expect(await fixture.channel).toBe("complete")
  })

  it("refuses another working directory, a second session, model selection, and malformed input with JSON-RPC errors", async () => {
    const fixture = acpFixture(({ settle }) => { settle("complete") })
    fixture.send({ id: 9, method: "session/new", params: { cwd: "/", mcpServers: [] } })
    expect((await fixture.response(9)).error?.code).toBe(-32602)
    await fixture.open()
    fixture.send({ id: 2, method: "session/new", params: { cwd: CWD, mcpServers: [] } })
    fixture.send({ id: 3, method: "session/set_model", params: { sessionId: "root", modelId: "x" } })
    fixture.send({ id: 4, method: "session/prompt", params: { sessionId: "other", prompt: [{ type: "text", text: "hi" }] } })
    expect((await fixture.response(2)).error?.code).toBe(-32600)
    expect((await fixture.response(3)).error?.code).toBe(-32601)
    expect((await fixture.response(4)).error?.code).toBe(-32602)
    fixture.end()
    expect(await fixture.channel).toBe("complete")
    expect(fixture.calls.some((command) => command.type === "session.send")).toBe(false)
  })
})
