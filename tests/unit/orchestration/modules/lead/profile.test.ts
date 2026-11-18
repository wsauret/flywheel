import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { renderCapabilityText } from "../../../../../src/infra/capability-text.js"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import type { LLMClientFactory } from "../../../../../src/orchestration/agent-runtime/factory.js"
import { FUNCTION_TOOL_PRESENTATION } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { openRequestInputs } from "../../../../../src/orchestration/agent-runtime/request-inputs.js"
import { resolveRuntimeConversation } from "../../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import type { RunnableAgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js"
import type { WebSearchPort } from "../../../../../src/orchestration/agent-runtime/web-search/types.js"
import { resolveChatProfile, resolveChatRole } from "../../../../../src/orchestration/chat-profile.js"
import { LEAD_PROMPT, LISTED_CHAT_PROMPT, STARTED_CHAT_PROMPT } from "../../../../../src/orchestration/modules/lead/prompt.js"
import { leadService, type LeadRole, type LeadService } from "../../../../../src/orchestration/modules/lead/service.js"
import { LEAD_TOOLS } from "../../../../../src/orchestration/modules/lead/tools.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js"
import { checkpointTestPersistences } from "../../../../helpers/checkpoint-store.js"
import { unusedSessionMessaging } from "../../../../helpers/child-session-control.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js"
import { asModelClient } from "../../agent-runtime/_model-client.js"
import { makeOptions } from "../../agent-runtime/_runner-options.js"
import { askUserController } from "../../agent-runtime/tools/_planner-fixtures.js"

const client: LLMClientFactory = async () => asModelClient({
  accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION,
  contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
  priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } },
})

// A web search provider that is available, so the lead's plan holds `web`.
const webPort: WebSearchPort = { available: () => true, run: async () => { throw new Error("no search runs") } }
const webSearch = (): WebSearchPort => webPort

const checkpointTestPersistence = checkpointTestPersistences()

/** The tools and the system prompt of each request of one durable chat in the shipped composition, with a lead service
 *  that answers `role` for the chat. `selections` gives the module snapshot of each request in turn. */
async function chatRequests(role: LeadRole | undefined, selections: readonly ReturnType<typeof composeFirstPartyModules>[]) {
  const sessionId = "chat-1"
  const roleOf = (id: string) => id === sessionId ? role : undefined
  const service: Pick<LeadService, "role" | "settledRole"> = { role: roleOf, settledRole: async (id) => roleOf(id) }
  const moduleServices = composeModuleServices([["lead", service]])
  let request = 0
  const options: RunnableAgentOptions = {
    ...makeOptions({ agentRegistry: new Map(), agentsMd: "", ...checkpointTestPersistence({ kind: "session", sessionId }), conversation: {
      kind: "durable-tree", sessionId, conversationId: "conversation-1", priorMessages: [], reserveMessageId: async () => crypto.randomUUID(),
      append: () => {}, captureCommittedForkMessages: async () => [], resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }),
    } }),
    captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
    runtimeSurfaces: { askUser: askUserController(), sessions: unusedSessionMessaging(), moduleServices, webSearch },
    moduleSelection: () => selections[Math.min(request, selections.length - 1)]!,
    chatProfile: (modules) => resolveChatProfile(modules, { sessionId, modules: moduleServices }),
  }
  expect(moduleServices.get(leadService)?.role(sessionId)).toBe(role)
  const scope = Scope.makeUnsafe("sequential")
  try {
    const opened = await openRequestInputs({
      options, definitions: repoDefinitions(), personas: new Map(),
      conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: "agent", artifactScopeId: "artifact", retrievalSessionId: "retrieval" }),
      captureModelRuntime: async () => ({ generation: client, createLLMClient: client }),
      createRunner: () => { throw new Error("no run is built") },
      providerSessionLifetime: { providerSessionKey: "agent", scope },
    }, { kind: "prestart", signal: new AbortController().signal })
    const { request: inputs, planned } = await opened.build()
    const buildPrompt = inputs.systemPrompt
    if (typeof buildPrompt !== "function") throw new Error("a chat builds its system prompt for each request")
    const results = []
    for (request = 0; request < selections.length; request += 1) {
      const surface = await inputs.tools.resolve()
      const prompt = await surface.prepareStablePrompt(() => buildPrompt(planned, DEFAULT_MODEL_INTERACTION_PROFILE), DEFAULT_MODEL_INTERACTION_PROFILE)
      results.push({
        offered: new Set(prompt.definitions.map(({ name }) => surface.registrationIdentities.get(name) ?? name)),
        planned: new Set(surface.registrationIdentities.values()),
        prompt: [prompt.systemPrompt.stable, prompt.systemPrompt.session, prompt.systemPrompt.conversation].join("\n"),
      })
    }
    return results
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void))
  }
}

const on = composeFirstPartyModules()
const off = composeFirstPartyModules(undefined, ["lead"])
const firstLine = (text: string) => text.split("\n", 1)[0]!

describe("the lead's chat profile", () => {
  test("the lead plans exactly LEAD_TOOLS, a selection without the module gives the ordinary chat, and turning it on again restores the lead", async () => {
    const [lead, ordinary, again] = await chatRequests("lead", [on, off, on])
    expect(lead!.planned).toEqual(new Set(LEAD_TOOLS))
    expect(lead!.offered).toEqual(lead!.planned)
    expect(lead!.prompt.startsWith(firstLine(LEAD_PROMPT))).toBe(true)

    expect(ordinary!.planned.has("route_request")).toBe(false)
    expect(ordinary!.planned.has("chat_progress")).toBe(false)
    expect(ordinary!.planned.has("search")).toBe(true)
    expect(ordinary!.prompt).not.toContain(firstLine(LEAD_PROMPT))

    expect(again!.planned).toEqual(new Set(LEAD_TOOLS))
    expect(again!.prompt.startsWith(firstLine(LEAD_PROMPT))).toBe(true)

    // The lead's whole prompt names no tool outside its plan as a tool to call.
    for (const name of ordinary!.planned) {
      if (lead!.planned.has(name)) continue
      expect(lead!.prompt).not.toContain(`\`${name}\``)
      if (name.includes("_")) expect(lead!.prompt).not.toContain(name)
    }
  })

  test("an ordinary chat plans neither lead tool and has no lead text; a started chat and a briefed chat each have their addition", async () => {
    const [ordinary] = await chatRequests(undefined, [on])
    const [started] = await chatRequests("started", [on])
    const [briefed] = await chatRequests("briefed", [on])
    for (const chat of [ordinary!, started!, briefed!]) {
      expect(chat.planned.has("route_request")).toBe(false)
      expect(chat.planned.has("chat_progress")).toBe(false)
      expect(chat.prompt).not.toContain(firstLine(LEAD_PROMPT))
    }
    expect(started!.prompt).toContain(STARTED_CHAT_PROMPT)
    expect(briefed!.prompt).toContain(LISTED_CHAT_PROMPT)
    expect(briefed!.prompt).not.toContain(firstLine(STARTED_CHAT_PROMPT))
    expect(ordinary!.prompt).not.toContain(firstLine(STARTED_CHAT_PROMPT))
    expect(ordinary!.prompt).not.toContain(firstLine(LISTED_CHAT_PROMPT))
  })

  // PI-LEAD-020: only the lead's requests use the Lead setting.
  test("the lead's requests use the Lead role, and every other chat, also one that the lead started, uses Chat", () => {
    const roleOf = (role: LeadRole | undefined) => composeModuleServices([["lead", { role: () => role }]])
    const cases: readonly (readonly [LeadRole | undefined, string])[] = [["lead", "lead-chat"], ["started", "chat"], ["briefed", "chat"], [undefined, "chat"]]
    for (const [role, expected] of cases) expect(resolveChatRole(on, { sessionId: "chat-1", modules: roleOf(role) })).toBe(expected)
    expect(resolveChatRole(off, { sessionId: "chat-1", modules: roleOf("lead") })).toBe("chat")
  })

  test("the lead prompt rendered without web has no line that names web", () => {
    const rendered = renderCapabilityText(LEAD_PROMPT, (term) => term !== "web")
    expect(rendered.split("\n").filter((line) => /\bweb\b/.test(line))).toEqual([])
    expect(renderCapabilityText(LEAD_PROMPT, () => true)).toContain("`web`")
  })
})
