import { describe, expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import type { FrontendMutation, FrontendOutputBlock, RuntimeClient } from "../../../../src/protocol/app-service-types.js"
import type { BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import type { HeadlessChatOutcome } from "../../../../src/protocol/headless-chat.js"
import type { AcpResult, AcpSessionUpdate } from "../../../../src/protocol/acp.js"
import type { UsageSessionStats } from "../../../../src/protocol/modules/subscription-usage.js"
import type { PendingQuestionView } from "../../../../src/protocol/question-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { projectFrontendOutputBlock } from "../../../../src/orchestration/app-service/frontend-output-blocks.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { AgentToolInput } from "../../../../src/orchestration/agent-runtime/types.js"
import { createChatInvocationCompletion, type ChatTurnEnding } from "../../../../src/orchestration/chat/runner-completion.js"
import { acpFraming } from "../../../../src/orchestration/headless/acp-chat.js"
import { runHeadlessChatChannel } from "../../../../src/orchestration/headless/run-headless-chat.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { tailWindow } from "../../../helpers/runtime-views.js"

/** One line Flywheel wrote: a response or a session update. */
interface Message {
  readonly id?: number
  readonly method?: string
  readonly result?: AcpResult
  readonly error?: { readonly code: number; readonly message: string; readonly data?: { readonly failure: string } }
  readonly params?: { readonly update: AcpSessionUpdate }
}

interface Inbound {
  readonly id?: number
  readonly method: string
  readonly params: object
}

const SUMMARY = {
  attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true,
  tokens: { input: 100, output: 40, cacheRead: 900, cacheWrite: 0, reasoning: 10, total: 1040 },
  estimatedBilledUsd: 0, includedValueUsd: 0.25, priceUnavailable: false,
}
const STATS: UsageSessionStats = {
  sessionId: "root", asOf: 0, partial: false, descendantCount: 0, direct: SUMMARY, descendants: SUMMARY, totals: SUMMARY, models: [], tools: [],
  generation: { basis: "O200kBase", totals: { outputTokens: 0, durationMs: 0, measuredRequests: 0, unmeasuredRequests: 0, measuredBlocks: 0, excludedBlocks: 0, averageTokensPerSecond: null }, coverageComplete: true, models: [] },
}

/** The directory the agent runs in, which session/new must name. */
const CWD = tmpdir()

const question: PendingQuestionView = {
  kind: "question", toolUseId: "ask", timestamp: 0,
  questions: [{ question: "Which port?", multiSelect: false, choices: [{ kind: "option", label: "8080" }, { kind: "freeform", label: "Other" }] }],
}

/** A root chat whose turns a test scripts: `onTurn` runs for every message
 *  or answer and owns the settlement state it ends in. */
function acpFixture(onTurn: (turn: { readonly command: FrontendMutation; publish(input: RuntimeUiPatchInput): void; output(block: FrontendOutputBlock): void; lose(block: FrontendOutputBlock): void; retract(block: FrontendOutputBlock): void; ended(ending: ChatTurnEnding): void; settle(outcome: HeadlessChatOutcome): Promise<void>; streamed(text: string): Promise<void> }) => void | Promise<void>, transport: Pick<Parameters<typeof runHeadlessChatChannel>[1], "oneShot" | "completion"> = {}) {
  const bus = createRuntimeUiBus()
  const framing = acpFraming(realpathSync(CWD))
  /** The runtime reports how the root chat's turn ended, as the invocation completion does. */
  const ended = (ending: ChatTurnEnding) => { framing.turnEnded?.(ending) }
  const calls: FrontendMutation[] = []
  // The rows a client reads, as the runtime's live edge publishes them, and
  // the blocks whose bodies a row can leave out.
  const blocks: FrontendOutputBlock[] = []
  const bodies = new Map<string, FrontendOutputBlock>()
  const resident = (block: FrontendOutputBlock) => {
    bodies.set(blockIdentity(block), block)
    const known = blocks.findIndex((candidate) => blockIdentity(candidate) === blockIdentity(block))
    const index = known === -1 ? blocks.length : known
    const row = projectFrontendOutputBlock(block)
    blocks[index] = row
    return { index, known: known !== -1, row }
  }
  const listeners = new Set<() => void>()
  let state: HeadlessChatOutcome | "busy" = "complete"
  let interrupt = () => {}
  let budget: BudgetView | null = null
  const settle = async (outcome: HeadlessChatOutcome) => {
    await bus.drain()
    state = outcome
    for (const listener of listeners) listener()
  }
  let position = 0
  const publish = (input: RuntimeUiPatchInput) => {
    if (input.payload.kind === "budget.updated") budget = input.payload.budget
    position = bus.publish(input)?.position ?? position
  }
  const output = (block: FrontendOutputBlock) => {
    const { index, known, row } = resident(block)
    publish({ cursor: { scope: "session", domain: "output", sessionId: "root" }, payload: { kind: "output.delta", delta: { visibleMessageCount: blocks.length, blocks: [{ kind: known ? "upsert" : "insert", index, blockId: blockIdentity(row), block: row }] } } })
  }
  /** Output whose live delta never reaches the client, as when its queue overflowed. */
  const lose = (block: FrontendOutputBlock) => { resident(block) }
  /** Removes a draft row, as a resync does: it truncates at the row and inserts the rows after it again. */
  const retract = (block: FrontendOutputBlock) => {
    const index = blocks.findIndex((candidate) => blockIdentity(candidate) === blockIdentity(block))
    blocks.splice(index, 1)
    const after = blocks.slice(index).map((row, offset) => ({ kind: "insert" as const, index: index + offset, blockId: blockIdentity(row), block: row }))
    publish({ cursor: { scope: "session", domain: "output", sessionId: "root" }, payload: { kind: "output.delta", delta: { visibleMessageCount: blocks.length, truncateTo: index, blocks: after } } })
  }
  const turn = async (command: FrontendMutation) => {
    state = "busy"
    queueMicrotask(() => { onTurn({ command, publish, output, lose, retract, ended, settle, streamed }) })
    return { ok: true as const, sessionId: "root" }
  }
  const client: RuntimeClient = {
    query: runtimeQuery({
      budgetSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: budget })) }),
      outputWindow: async ({ request }) => {
        const start = Math.max(0, blocks.length - request.range.maxBlocks)
        return tailWindow(blocks.slice(start), { snapshotPosition: position, startBlockIndex: start })
      },
      outputRange: async ({ request }) => {
        if (request.anchor.kind !== "beforeBlock") throw new Error(`Unexpected anchor ${request.anchor.kind}`)
        const { blockId } = request.anchor
        const end = blocks.findIndex((block) => blockIdentity(block) === blockId)
        const start = Math.max(0, end - request.maxBlocks)
        return {
          kind: "ok", consistencyToken: "fixture", anchor: request.anchor, streamingToolText: {}, streamingOutputChars: 0, blocks: blocks.slice(start, end),
          window: { startBlockIndex: start, endBlockIndex: end - 1, hasBefore: start > 0, hasAfter: true, contentBytes: 0 },
        }
      },
      outputBlockBody: async ({ request }) => {
        const block = bodies.get(request.blockId)
        return { blockId: request.blockId, ...(block?.kind === "tool" && block.content !== undefined ? { content: block.content } : {}) }
      },
      questionSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: state === "input_required" ? question : null })) }),
      "usage.stats": async () => STATS,
    }),
    dispatch: recordedDispatch((command) => { calls.push(command) }, runtimeDispatch({
      "chat.open": async () => ({ ok: true, sessionId: "root" }),
      "session.activate": async () => ({ ok: true, sessionId: "root" }),
      "session.send": turn,
      "question.answer": turn,
      "chat.interrupt": async () => { interrupt(); return { ok: true, sessionId: "root" } },
    })),
    close: async () => {},
    subscribe: (next) => { bus.addListener(next); return () => { bus.removeListener(next) } },
  }
  const input = new PassThrough()
  const messages: Message[] = []
  const arrived = new Set<() => void>()
  const channel = runHeadlessChatChannel({
    client, startChatDefault: () => {},
    workSettlement: { accepted: () => {}, read: async () => state, onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
  }, {
    ...transport, input, framing,
    write: async (line) => {
      messages.push(JSON.parse(line))
      for (const wake of arrived) wake()
    },
  })
  const send = (message: Inbound) => { input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`) }
  /** Resolves with the response to request `id`. */
  const response = async (id: number): Promise<Message> => {
    while (true) {
      const found = messages.find((message) => message.id === id)
      if (found) return found
      await new Promise<void>((resolve) => { arrived.add(resolve) })
    }
  }
  /** Resolves once a session update whose JSON contains `text` was written. */
  const streamed = async (text: string): Promise<void> => {
    while (!updates().some((update) => JSON.stringify(update).includes(text))) {
      await new Promise<void>((resolve) => { arrived.add(resolve) })
    }
  }
  const updates = () => messages.flatMap((message) => message.method === "session/update" && message.params ? [message.params.update] : [])
  const open = async () => {
    send({ id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } } })
    send({ id: 1, method: "session/new", params: { cwd: CWD, mcpServers: [] } })
    return [await response(0), await response(1)]
  }
  return { send, response, updates, open, calls, messages, channel, end: () => { input.end() }, onInterrupt: (next: () => void) => { interrupt = next } }
}

/** A tool result larger than a live row carries inline. */
const LARGE_RESULT = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n")

const prompt = (id: number, text: string) => ({ id, method: "session/prompt", params: { sessionId: "root", prompt: [{ type: "text", text }] } })

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
    expect(initialized?.result).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "flywheel" }, authMethods: [] })
    expect(opened?.result).toEqual({ sessionId: "root" })

    fixture.send(prompt(2, "list files"))
    expect((await fixture.response(2)).result).toEqual({
      stopReason: "end_turn",
      usage: { totalTokens: 1040, inputTokens: 1000, outputTokens: 40, thoughtTokens: 10, cachedReadTokens: 900, cachedWriteTokens: 0 },
    })
    fixture.end()
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })

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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
  })

  it("ends an unattended one-shot run after it answers the first prompt, while stdin stays open", async () => {
    let handoff: AgentToolInput | undefined
    const invocation = createChatInvocationCompletion((content) => { handoff = content }, undefined, true)
    const fixture = acpFixture(async ({ output, settle }) => {
      output({ kind: "text", id: "t1", content: "42", timestamp: 0 })
      // The loop seals the invocation with the final reply when the turn ends (PI-AGENT-121).
      invocation.seal?.("42")
      await invocation.finish({ kind: "completed" }, async () => {})
      await settle("complete")
    }, { oneShot: true, completion: { invocation, bind: () => {}, result: () => handoff } })
    await fixture.open()
    fixture.send(prompt(2, "compute"))
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete", handoff: { summary: "42" } })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
  })

  it("answers a cancelled prompt with stopReason cancelled after it interrupts the turn", async () => {
    let end = (_outcome: HeadlessChatOutcome) => {}
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "incomplete" })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "failed" })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "failed" })
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
    fixture.end()
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
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
    expect(await fixture.channel).toEqual({ sessionId: "root", outcome: "complete" })
    expect(fixture.calls.some((command) => command.type === "session.send")).toBe(false)
  })
})
