/**
 * Agents of chat trees on the Google Antigravity route, each through the real provider client, on logins of one
 * engine harness (`_engine.ts`): one engine registry serves every login, as the module's runtime does, so each agent
 * names its tree and login and the registry decides which engine process serves it.
 */
import { Effect, Exit, Scope } from "effect"
import { providerModelInfo } from "../../../../../src/infra/llm/catalog/provider-model-info.js"
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/routing/client-factory.js"
import { lowerProviderHistory } from "../../../../../src/orchestration/agent-runtime/llm/history/provider-history.js"
import type { ContentBlock, ConversationMessage, LLMClient, ProviderStreamEvent, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ProviderTransportContext } from "../../../../../src/orchestration/session/runtime-facts/provider-request-audit-types.js"
import { createAntigravityClient } from "../../../../../src/orchestration/modules/provider-google-antigravity/client.js"
import type { EngineProcess } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/engine-process.js"
import { createEngineRegistry, type EnginePlace, type EngineRegistry } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/engine-registry.js"
import { createLoginObservations } from "../../../../../src/orchestration/modules/provider-google-antigravity/login/login-status.js"
import { fakeAvailability } from "../../../../unit/orchestration/agent-runtime/llm/_provider-chain-harness.js"
import type { HarnessLogin } from "./_engine.js"

export const PROVIDER_ID = "google_antigravity"

/** One agent of a chat tree: its client, and the end of its provider-session lifetime. */
export interface Agent {
  readonly client: LLMClient
  close(): Promise<void>
}

/** Every engine that the registry launched, with the place that it serves. */
export interface Launched {
  readonly place: EnginePlace
  readonly engine: EngineProcess
}

export interface ClientRig {
  readonly registry: EngineRegistry<EngineProcess>
  readonly launched: Launched[]
  /** An agent of the tree rooted at `tree`, on `login`, whose own provider session is `session`. */
  agent(options: { readonly login: HarnessLogin; readonly tree: string; readonly session: string; readonly projectRoot: string; readonly model?: string }): Promise<Agent>
  /** Ends every agent and drains the registry. */
  close(): Promise<void>
}

export function openClientRig(logins: readonly HarnessLogin[]): ClientRig {
  const byDir = new Map(logins.map((login) => [login.loginDir, login]))
  const login = (loginDir: string): HarnessLogin => {
    const found = byDir.get(loginDir)
    if (found === undefined) throw new Error(`no harness login at ${loginDir}`)
    return found
  }
  const launched: Launched[] = []
  const registry = createEngineRegistry<EngineProcess>(async (place) => {
    const engine = await login(place.loginDir).launch({ tools: place.tools })
    launched.push({ place, engine })
    return engine
  })
  const agents: Agent[] = []
  return {
    registry,
    launched,
    async agent({ login: owner, tree, session, projectRoot, model = "gemini-3.1-pro" }) {
      const scope = Scope.makeUnsafe()
      const metadata = providerModelInfo({ provider: "google", id: model, contextLimit: 230_000, outputLimit: 64_000, reasoning: true })
      const accountId = owner.loginDir
      const candidate = { kind: "subscription", providerId: PROVIDER_ID, instanceId: accountId, spendMode: "included" } as const
      const build: AccessProviderBuild = {
        notify: () => {}, candidate, providerIdentity: { name: "Google Antigravity", credential: "oauth" },
        model, wireModelId: model, family: "google",
        modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
        connection: {
          id: "connection", authDir: projectRoot, oauthPersistence: "memory-only",
          auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
          subscriptionCredentials: new Map([[PROVIDER_ID, [{ instanceId: accountId, identity: "person@example.com", lineageId: accountId, credential: { type: "external", configDir: owner.loginDir } }]]]),
        },
        classifySlot: () => "subscription", availability: fakeAvailability({}).availability, projectRoot,
        attribution: { candidate, wireModelId: model, dataUse: "standard", resolvedModelMetadata: metadata },
        recordModelRefusal: () => {},
        providerSessionLifetime: { providerSessionKey: session, treeRootSessionId: tree, scope },
      }
      const adapter = createAntigravityClient(build, { registry, loginDir: (id) => id, gate: (loginDir) => login(loginDir).gate, observations: createLoginObservations() })
      const client = await (await adapter.stage({ attribution: build.attribution, accountOfferings: [] })).connect()
      let closed = false
      const agent: Agent = {
        client,
        async close() {
          if (closed) return
          closed = true
          await Effect.runPromise(Scope.close(scope, Exit.void))
        },
      }
      agents.push(agent)
      return agent
    },
    async close() {
      for (const agent of agents.splice(0)) await agent.close()
      await registry.drain()
    },
  }
}

/** What one request streamed, read back as the canonical history holds it. */
export interface Sent {
  readonly events: readonly ProviderStreamEvent[]
  readonly assistant: ConversationMessage
  readonly calls: readonly Extract<ContentBlock, { type: "tool_use" }>[]
  readonly stopReason: string | undefined
  readonly audit: ProviderTransportContext | undefined
}

/** Sends one request, lowered for the client's history target as the attempt lowers it, and reads the answer back as
 *  the assistant message that the agent loop records, stamped with `accessProvider`. */
export async function send(client: LLMClient, request: Omit<StreamOptions, "messages"> & { readonly messages: readonly ConversationMessage[] }, accessProvider: string = PROVIDER_ID): Promise<Sent> {
  const options: StreamOptions = { ...request, messages: [...request.messages] }
  const lowered = lowerProviderHistory(options.messages, await client.historyTarget(options))
  const events: ProviderStreamEvent[] = []
  for await (const event of client.streamWithTools({ ...options, messages: lowered })) events.push(event)
  return readBack(events, accessProvider)
}

/** `send`, for a request that must fail: its failure, and the events it streamed before. */
export async function sendFailing(client: LLMClient, request: Parameters<typeof send>[1]): Promise<{ readonly error: unknown; readonly events: readonly ProviderStreamEvent[] }> {
  const options: StreamOptions = { ...request, messages: [...request.messages] }
  const lowered = lowerProviderHistory(options.messages, await client.historyTarget(options))
  const events: ProviderStreamEvent[] = []
  try {
    for await (const event of client.streamWithTools({ ...options, messages: lowered })) events.push(event)
  } catch (error) {
    return { error, events }
  }
  throw new Error(`the request did not fail: ${JSON.stringify(events.map((event) => event.kind))}`)
}

function readBack(events: readonly ProviderStreamEvent[], accessProvider: string): Sent {
  const thinking = events.flatMap((event): ContentBlock[] => event.kind === "thinking_complete" ? [{ type: "thinking", thinking: event.thinking, ...event.signature === undefined ? {} : { signature: event.signature } }] : [])
  const text = events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("")
  const calls = events.flatMap((event) => event.kind === "tool_use" ? [{ type: "tool_use" as const, id: event.toolCall.id, name: event.toolCall.name, input: event.toolCall.input, ...event.toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: event.toolCall.thoughtSignature } }] : [])
  const content: ContentBlock[] = [...thinking, ...text.length === 0 ? [] : [{ type: "text" as const, text }], ...calls]
  const done = events.find((event) => event.kind === "done")
  const audits = events.flatMap((event) => event.kind === "transport_context" ? [event.context] : [])
  return {
    events,
    assistant: { kind: "assistant", content, accessProvider, provider: "google", api: "google-generative-ai", model: "gemini-3.1-pro" },
    calls,
    stopReason: done?.kind === "done" ? done.stopReason : undefined,
    audit: audits.at(-1),
  }
}

export const user = (text: string): ConversationMessage => ({ kind: "user", content: text, origin: "human" })
export const result = (toolUseId: string, text: string): ConversationMessage => ({ kind: "toolResult", toolUseId, content: [{ type: "text", text }] })
/** A call of Flywheel's `echo` tool as the model of the engine names it, with the summary argument that agy adds. */
export const engineCall = (text: string) => ({ name: "mcp_runtime_echo", args: { text, toolSummary: "echo" } })
