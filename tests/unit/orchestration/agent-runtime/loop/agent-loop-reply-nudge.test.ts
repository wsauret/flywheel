import { tmpdir } from "node:os"

import { describe, expect, it } from "bun:test"

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/loop/agent-loop.js"
import { messageInput, requestContextInput, type AgentLoopInput } from "../../../../../src/infra/agent-loop-events.js"
import { SILENT_REPLY_NUDGE } from "../../../../../src/orchestration/agent-runtime/loop/reply-nudge.js"
import { fixedRequestToolSurface, RequestToolMap } from "../../../../helpers/request-tool-surface.js"
import type { RuntimeTool, ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ModelClient, type ProviderStreamEvent, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ConversationMessage } from "../../../../../src/infra/llm/conversation/conversation-message.js"
import { asModelClient, ownHistoryTarget } from "../_model-client.js"
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

function scriptedClient(
  responses: Array<{ events: ProviderStreamEvent[] }>,
  requests: ConversationMessage[][] = [],
): ModelClient {
  let callIndex = 0
  return asModelClient({ historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      requests.push(options.messages)
      const response = responses[callIndex++]
      if (!response) throw new Error("No more mock responses")
      for (const event of response.events) yield event
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  } satisfies LLMClient)
}

async function runLoop(input: {
  responses: Array<{ events: ProviderStreamEvent[] }>
  history: ConversationMessage[]
  requests?: ConversationMessage[][]
  humanFacing?: boolean
  tools?: RequestToolMap
  seed?: { kind: "resume"; priorMessages: ConversationMessage[] }
  pending?: () => AgentLoopInput | null
  providerSessionKey?: string
  requestContext?: string
  prepareWaitForInput?: () => { commit(): Promise<AgentLoopInput | null>; cancel(): Promise<void> }
}) {
  return runAgentLoop({
    client: scriptedClient(input.responses, input.requests),
    tools: await fixedRequestToolSurface(input.tools ?? new RequestToolMap([])),
    systemPrompt: () => stableSystemPrompt("test"),
    instruction: input.seed ? null : "work",
    executionCwd: tmpdir(),
    userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
    providerSessionKey: input.providerSessionKey ?? "reply-nudge-test",
    promptCacheKey: input.providerSessionKey ?? "reply-nudge-test",
    artifactScopeId: input.providerSessionKey ?? "reply-nudge-test",
    retrievalSessionId: input.providerSessionKey ?? "reply-nudge-test",
    ...(input.humanFacing === undefined ? {} : { humanFacing: input.humanFacing }),
    ...(input.requestContext === undefined ? {} : { initialRequestContext: input.requestContext }),
    persistence: { history: { append: (message) => { input.history.push(message) } } },
    seed: input.seed ?? { kind: "fresh" },
    onEvent: () => {},
    inputSource: {
      drainPending: input.pending ?? (() => null),
      prepareWaitForInput: input.prepareWaitForInput ?? (() => ({
        commit: async () => null,
        cancel: async () => {},
      })),
    },
  })
}

const nudgeCount = (history: ConversationMessage[]): number =>
  history.filter((message) => message.kind === "user" && message.content === SILENT_REPLY_NUDGE).length

/** Each request's input starts with the full input of the request before it. */
const expectAppendOnly = (requests: readonly ConversationMessage[][]): void => {
  for (let index = 1; index < requests.length; index += 1) {
    expect(requests[index]!.slice(0, requests[index - 1]!.length)).toEqual(requests[index - 1]!)
  }
}

const silentTurn = { events: [{ kind: "done", stopReason: "end_turn" }] } satisfies { events: ProviderStreamEvent[] }

const probe: RuntimeTool = {
  name: "probe",
  action: "shell_exec",
  description: "Probe",
  inputSchema: { type: "object" },
  isConcurrencySafe: true,
  execute: async (): Promise<ToolResult> => ({ content: "ok", outcome: "ok" }),
}
const toolTurn = (index: number, text?: string, name = "probe") => ({
  events: [
    ...(text ? [{ kind: "text_delta", text, blockKey: `text_${index}` } as const] : []),
    { kind: "tool_use", toolCall: { id: `tc_${index}`, name, input: {} } },
    { kind: "done", stopReason: "tool_use" },
  ],
}) satisfies { events: ProviderStreamEvent[] }

const terminalTurn = {
  events: [{ kind: "text_delta", text: "finished", blockKey: "terminal" }, { kind: "done", stopReason: "end_turn" }],
} satisfies { events: ProviderStreamEvent[] }

const progressReminderCount = (history: readonly ConversationMessage[]): number =>
  history.filter((message) =>
    message.kind === "user"
    && typeof message.content === "string"
    && message.content.includes("The user hasn't heard from you in a while"),
  ).length


describe("silent-reply nudge", () => {
  it("does not accept a progress update as the final answer", async () => {
    const history: ConversationMessage[] = [];
    await runLoop({ history, humanFacing: true, responses: [
      { events: [
        { kind: "thinking_delta", text: "Checking the fix.", blockKey: "progress", presentation: "progress" },
        { kind: "thinking_complete", thinking: "Checking the fix.", blockKey: "progress", signature: "signed", presentation: "progress" },
        { kind: "done", stopReason: "end_turn" },
      ] },
      { events: [{ kind: "text_delta", text: "The fix passed.", blockKey: "answer" }, { kind: "done", stopReason: "end_turn" }] },
    ] });
    expect(nudgeCount(history)).toBe(1);
    expect(history.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "The fix passed." }] });
  });

  it("injects the nudge instead of parking when a user message got no visible text", async () => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      responses: [
        silentTurn,
        { events: [{ kind: "text_delta", text: "here is your answer", blockKey: "answer" }, { kind: "done", stopReason: "end_turn" }] },
      ],
    })
    expect(nudgeCount(history)).toBe(1)
    const nudge = history.find((message) => message.kind === "user" && message.content === SILENT_REPLY_NUDGE)
    if (nudge?.kind !== "user") throw new Error("expected a user nudge")
    expect(nudge?.origin).toBe("system")
    const nudgeIndex = history.findIndex((m) => m.kind === "user" && m.content === SILENT_REPLY_NUDGE)
    const replyIndex = history.findIndex((m) => m.kind === "assistant")
    expect(replyIndex).toBeGreaterThan(nudgeIndex)
  })

  it("nudges at most once per owed reply, then parks normally", async () => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      responses: [silentTurn, silentTurn],
    })
    expect(nudgeCount(history)).toBe(1)
  })

  it("arms on the resume seed's trailing human message (production chat shape)", async () => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      seed: { kind: "resume", priorMessages: [{ kind: "user", content: "what is the status?" }] },
      responses: [silentTurn, silentTurn],
    })
    expect(nudgeCount(history)).toBe(1)
  })

  it("does not arm on a resume seed whose trailing user message is system-produced", async () => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      seed: { kind: "resume", priorMessages: [{ kind: "user", content: "[background notification]", origin: "system" }] },
      responses: [silentTurn],
    })
    expect(nudgeCount(history)).toBe(0)
  })

  it("does not arm on a resume seed whose trailing user message came from another session", async () => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      seed: { kind: "resume", priorMessages: [{ kind: "user", content: "a peer message", producer: { kind: "session", sessionId: "peer", conversationId: "peer-conversation", toolUseId: "call-1", hop: 0 } }] },
      responses: [silentTurn],
    })
    expect(nudgeCount(history)).toBe(0)
  })

  it("requires a visible reply for a resumed background notification", async () => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      seed: {
        kind: "resume",
        priorMessages: [{
          kind: "user",
          content: "Workflow completed. Review the result and continue.",
          origin: "system",
          replyRequired: true,
        }],
      },
      responses: [
        silentTurn,
        { events: [{ kind: "text_delta", text: "Reviewing the completed workflow.", blockKey: "answer" }, { kind: "done", stopReason: "end_turn" }] },
      ],
    })
    expect(nudgeCount(history)).toBe(1)
    expect(history.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "Reviewing the completed workflow." }] })
  })

  it("requires a visible reply for a live background notification", async () => {
    const history: ConversationMessage[] = []
    let sent = false
    await runLoop({
      history,
      humanFacing: true,
      seed: {
        kind: "resume",
        priorMessages: [{
          kind: "user",
          content: "Internal state changed.",
          origin: "system",
        }],
      },
      pending: () => {
        if (sent) return null
        sent = true
        return messageInput("Workflow completed. Review the result and continue.", {
          origin: "silent-system",
          backgroundNotificationIds: ["workflow-completion:child"],
        })
      },
      responses: [
        silentTurn,
        { events: [{ kind: "text_delta", text: "Reviewing the completed workflow.", blockKey: "answer" }, { kind: "done", stopReason: "end_turn" }] },
      ],
    })
    expect(nudgeCount(history)).toBe(1)
    expect(history.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "Reviewing the completed workflow." }] })
  })

  it.each([
    { kind: "text_delta", text: "on it", blockKey: "visible" },
    { kind: "thinking_complete", thinking: "on it", signature: "Eg0KC0IJbmFycmF0aW9u", blockKey: "visible" },
  ] satisfies ProviderStreamEvent[])("does not nudge a turn that delivered a reply through $kind", async (reply) => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      responses: [
        { events: [reply, { kind: "done", stopReason: "end_turn" }] },
      ],
    })
    expect(nudgeCount(history)).toBe(0)
  })


  it("does not nudge loops without a human audience (subagents, workflows)", async () => {
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      responses: [silentTurn],
    })
    expect(nudgeCount(history)).toBe(0)
  })

  it("treats a successful ask_user as a delivered reply", async () => {
    const askUser: RuntimeTool = {
      name: "ask_user",
      action: "ask_user",
      description: "Stub ask_user",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async (): Promise<ToolResult> => ({ content: "answered: option A", outcome: "ok" }),
    }
    const history: ConversationMessage[] = []
    await runLoop({
      history,
      humanFacing: true,
      tools: new RequestToolMap([["ask_user", askUser]]),
      responses: [
        { events: [{ kind: "tool_use", toolCall: { id: "tc_ask", name: "ask_user", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
        silentTurn,
      ],
    })
    expect(nudgeCount(history)).toBe(0)
  })

  it("records a progress reminder once after five silent tool turns", async () => {
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    await runLoop({
      history,
      requests,
      humanFacing: true,
      tools: new RequestToolMap([["probe", probe]]),
      responses: [toolTurn(1), toolTurn(2), toolTurn(3), toolTurn(4), toolTurn(5), toolTurn(6), terminalTurn],
    })

    expect(progressReminderCount(history)).toBe(1)
    const reminder = requests[5]?.at(-1)
    expect(reminder).toMatchObject({ kind: "user", origin: "system", framing: "turn-context" })
    expect(reminder?.content).toContain("Do not mention or acknowledge this reminder")
    expect(reminder?.content).toContain("Do not apologize")
    // The request after the reminder carries it in place.
    expect(requests).toHaveLength(7)
    expect(progressReminderCount(requests[6]!)).toBe(1)
    expectAppendOnly(requests)
  })

  it.each([
    { source: "the run's options", queued: false },
    { source: "a command's request-context input", queued: true },
  ])("records turn context from $source once where it first applies", async ({ queued }) => {
    const turnContext = "split only the operation that stalled"
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    let backgroundSent = false
    let commandSent = false
    let waitCalls = 0

    const result = await runLoop({
      history,
      requests,
      ...(queued ? { seed: { kind: "resume" as const, priorMessages: [{ kind: "user" as const, content: "earlier", origin: "human" as const }, { kind: "assistant" as const, content: "done" }] } } : { requestContext: turnContext }),
      tools: new RequestToolMap([["probe", probe]]),
      responses: [toolTurn(1), terminalTurn, terminalTurn],
      pending: () => {
        if (queued && !commandSent) {
          commandSent = true
          return requestContextInput("/command", turnContext)
        }
        if (backgroundSent || requests.length !== 1) return null
        backgroundSent = true
        return messageInput("background result", { origin: "silent-system" })
      },
      prepareWaitForInput: () => ({
        commit: async () => ++waitCalls === 1 ? messageInput("new work") : null,
        cancel: async () => {},
      }),
    })

    expect(result.kind).toBe("input_closed")
    expect(requests).toHaveLength(3)
    const recorded: ConversationMessage = { kind: "user", content: turnContext, origin: "system", framing: "turn-context" }
    expect(requests[0]?.at(-1)).toEqual(recorded)
    expect(history.filter((message) => message.kind === "user" && message.content === turnContext)).toEqual([recorded])
    for (const request of requests) expect(request.filter((message) => message.kind === "user" && message.content === turnContext)).toHaveLength(1)
    expectAppendOnly(requests)
  })

  it("records turn context once across lives of one turn, redacted, and still owes the person's reply", async () => {
    // A credential-shaped observation, as a /papercuts drain can copy one; built in parts so no literal secret is in source.
    const turnContext = `Survey this observation: token ${"ghp_"}${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"} leaked`
    const recorded: ConversationMessage = { kind: "user", content: "Survey this observation: token [redacted secret] leaked", origin: "system", framing: "turn-context" }
    const goal: ConversationMessage = { kind: "user", content: "what is the status?", origin: "human" }
    const firstLife: ConversationMessage[] = []
    const firstRequests: ConversationMessage[][] = []
    await runLoop({ history: firstLife, requests: firstRequests, humanFacing: true, requestContext: turnContext, seed: { kind: "resume", priorMessages: [goal] }, responses: [silentTurn, silentTurn] })
    expect(firstRequests[0]).toEqual([goal, recorded])

    // A recovery starts a new life of the same turn over the recorded history, with the same context.
    const secondLife: ConversationMessage[] = []
    const secondRequests: ConversationMessage[][] = []
    await runLoop({ history: secondLife, requests: secondRequests, humanFacing: true, requestContext: turnContext, seed: { kind: "resume", priorMessages: [goal, recorded] }, responses: [silentTurn, silentTurn] })
    expect(secondRequests[0]).toEqual([goal, recorded])
    for (const request of secondRequests) expect(request.filter((message) => message.kind === "user" && message.framing === "turn-context")).toHaveLength(1)
    // The context is not the turn's input, so the silent answer is still owed and nudged.
    expect(nudgeCount(secondLife)).toBe(1)
    expectAppendOnly(secondRequests)
  })

  it("resets the progress-reminder stretch when visible text is delivered", async () => {
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    await runLoop({
      history,
      requests,
      humanFacing: true,
      tools: new RequestToolMap([["probe", probe]]),
      responses: [
        toolTurn(1), toolTurn(2), toolTurn(3), toolTurn(4),
        toolTurn(5, "Found the boundary; checking the next path."),
        toolTurn(6), toolTurn(7), toolTurn(8), toolTurn(9), terminalTurn,
      ],
    })

    expect(progressReminderCount(history)).toBe(0)
  })

  it("does not reset the progress stretch when ask_user is cancelled", async () => {
    const askUser: RuntimeTool = {
      name: "ask_user",
      action: "ask_user",
      description: "Stub ask_user",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async (): Promise<ToolResult> => ({ content: "cancelled", outcome: "cancelled" }),
    }
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    await runLoop({
      history,
      requests,
      humanFacing: true,
      tools: new RequestToolMap([["probe", probe], ["ask_user", askUser]]),
      responses: [toolTurn(1), toolTurn(2), toolTurn(3), toolTurn(4), toolTurn(5, undefined, "ask_user"), terminalTurn],
    })

    expect(progressReminderCount(history)).toBe(1)
  })

  it("starts a new progress stretch when queued human input arrives", async () => {
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    let sent = false
    await runLoop({
      history,
      requests,
      humanFacing: true,
      tools: new RequestToolMap([["probe", probe]]),
      pending: () => {
        if (requests.length < 4 || sent) return null
        sent = true
        return { kind: "message", text: "Check the other path." }
      },
      responses: [
        toolTurn(1), toolTurn(2), toolTurn(3), toolTurn(4),
        toolTurn(5), toolTurn(6), toolTurn(7), toolTurn(8), terminalTurn,
      ],
    })

    expect(progressReminderCount(history)).toBe(0)
  })

  it("caps progress reminders at three during one silent stretch", async () => {
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    await runLoop({
      history,
      requests,
      humanFacing: true,
      tools: new RequestToolMap([["probe", probe]]),
      responses: [...Array.from({ length: 20 }, (_, index) => toolTurn(index)), terminalTurn],
    })

    expect(progressReminderCount(history)).toBe(3)
  })
})
