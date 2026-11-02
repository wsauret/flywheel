import { tmpdir } from "node:os"

import { describe, expect, it } from "bun:test"

import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { messageInput, type AgentLoopInput } from "../../../../src/infra/agent-loop-events.js"
import { SILENT_REPLY_NUDGE } from "../../../../src/orchestration/agent-runtime/reply-nudge.js"
import { fixedRequestToolSurface, RequestToolMap } from "../../../helpers/request-tool-surface.js"
import type { RuntimeTool, ToolResult } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type LLMClient, type ModelClient, type ProviderStreamEvent, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { asModelClient, ownHistoryTarget } from "./_model-client.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

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
    promptNotes: { progress: "", modelNotes: "" },
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

const progressReminderCount = (requests: ConversationMessage[][]): number =>
  requests.flat().filter((message) =>
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

  it("adds a request-only progress reminder after five silent tool turns", async () => {
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    await runLoop({
      history,
      requests,
      humanFacing: true,
      tools: new RequestToolMap([["probe", probe]]),
      responses: [toolTurn(1), toolTurn(2), toolTurn(3), toolTurn(4), toolTurn(5), terminalTurn],
    })

    expect(progressReminderCount(requests)).toBe(1)
    const requestContext = requests[5]?.at(-1)
    expect(requestContext?.kind).toBe("user")
    expect(requestContext?.content).toContain("Do not mention or acknowledge this reminder")
    expect(requestContext?.content).toContain("Do not apologize")
    expect(history.some((message) =>
      message.kind === "user"
      && typeof message.content === "string"
      && message.content.includes("The user hasn't heard from you in a while"),
    )).toBe(false)
  })

  it("keeps request context within one logical turn", async () => {
    const recoveryContext = "split only the operation that stalled"
    const history: ConversationMessage[] = []
    const requests: ConversationMessage[][] = []
    let backgroundSent = false
    let waitCalls = 0

    const result = await runLoop({
      history,
      requests,
      requestContext: recoveryContext,
      tools: new RequestToolMap([["probe", probe]]),
      responses: [toolTurn(1), terminalTurn, terminalTurn],
      pending: () => {
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
    expect(requests[0]?.at(-1)).toEqual({ kind: "user", content: recoveryContext, requestOnly: true })
    expect(requests[1]?.at(-1)).toEqual({ kind: "user", content: recoveryContext, requestOnly: true })
    expect(requests[2]).not.toContainEqual({ kind: "user", content: recoveryContext, requestOnly: true })
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

    expect(progressReminderCount(requests)).toBe(0)
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

    expect(progressReminderCount(requests)).toBe(1)
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

    expect(progressReminderCount(requests)).toBe(0)
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

    expect(progressReminderCount(requests)).toBe(3)
  })
})
