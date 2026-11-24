/**
 * The wire and qualification suite of the Google Antigravity route (plan M12c): the real provider client serves each
 * request through the real pinned `agy acp` against the fake Gemini host, and every HTTP request that the host receives
 * is classified (`title`, `compaction`, `main`).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Scope } from "effect"
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js"
import type { AcpRequests } from "../../../../../src/orchestration/modules/provider-google-antigravity/acp/schema.js"
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import { limitOutput } from "../../../../../src/orchestration/agent-runtime/tools/truncation.js"
import { toGoogleGenerativeAiRequest } from "../../../../../src/orchestration/agent-runtime/llm/conversions/google-generative-ai.js"
import { ContextLengthExceededError, LlmStreamError, RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import { lowerProviderHistory } from "../../../../../src/orchestration/agent-runtime/llm/provider-history.js"
import type { ContentBlock, ConversationMessage, LLMClient, ProviderStreamEvent, ToolDef, ToolOutputOwners } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ProviderTransportContext } from "../../../../../src/orchestration/session/provider-request-audit-types.js"
import { PRIMER_TEXT } from "../../../../../src/orchestration/modules/provider-google-antigravity/bridge.js"
import { createAntigravityClient } from "../../../../../src/orchestration/modules/provider-google-antigravity/client.js"
import type { EngineProcess } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-process.js"
import { createEngineRegistry, type EngineRegistry } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-registry.js"
import { createLoginObservations } from "../../../../../src/orchestration/modules/provider-google-antigravity/login-status.js"
import { CONTINUATION_PROMPT } from "../../../../../src/orchestration/modules/provider-google-antigravity/request-plan.js"
import { fakeAvailability } from "../../../../unit/orchestration/agent-runtime/llm/_provider-chain-harness.js"
import { openEngineHarness, type EngineHarness, type HarnessLogin } from "./_engine.js"
import type { FakeRequest } from "./_fake-gemini.js"

const PROVIDER_ID = "google_antigravity"
const SYSTEM = { stable: "STABLE-TIER-MARKER", session: "SESSION-TIER-MARKER", conversation: "CONVERSATION-TIER-MARKER" }
// The tool's description marks Flywheel's tool declarations, which agy sends with every model request of a process.
const FLYWHEEL_MARKERS = [SYSTEM.stable, SYSTEM.session, SYSTEM.conversation, "HISTORY-MARKER", "RESULT-MARKER", "TOOL-SCHEMA-MARKER"]
const ECHO: ToolDef = { name: "echo", description: "Echoes its text. TOOL-SCHEMA-MARKER", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }

const call = (text: string) => ({ name: "mcp_runtime_echo", args: { text, toolSummary: "echo" } })

const roots: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Rig {
  readonly harness: EngineHarness
  readonly login: HarnessLogin
  readonly registry: EngineRegistry<EngineProcess>
  readonly projectRoot: string
  /** Every `session/set_config_option` and `session/cancel` that an engine received, in order. */
  readonly engineCalls: string[]
  /** Runs once after each launch, before the engine serves anything. */
  afterLaunch: (() => void) | undefined
  client(model?: string): Promise<{ readonly client: LLMClient; readonly close: () => Promise<void> }>
}

function hooksFile(login: HarnessLogin): string {
  return join(login.loginDir, "home", ".gemini", "config", "hooks.json")
}

function writeHook(login: HarnessLogin, handler: { readonly command: string; readonly timeout: number } | undefined): void {
  if (handler === undefined) {
    rmSync(hooksFile(login), { force: true })
    return
  }
  writeFileSync(hooksFile(login), JSON.stringify({ flywheel: { PreInvocation: [{ type: "command", ...handler }] } }))
}

async function openRig(fake: Parameters<typeof openEngineHarness>[1] = {}): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), "agw-"))
  roots.push(root)
  const harness = openEngineHarness(root, fake)
  closers.push(() => harness.close())
  const login = await harness.login("w")
  const projectRoot = join(root, "project")
  mkdirSync(projectRoot, { recursive: true })
  const engineCalls: string[] = []
  const rig: Rig = {
    harness, login, projectRoot, engineCalls, afterLaunch: undefined,
    registry: createEngineRegistry(async (place) => {
      const engine = await login.launch({ tools: place.tools })
      rig.afterLaunch?.()
      const spied: EngineProcess = {
        processId: engine.processId, loginDir: engine.loginDir, toolNames: engine.toolNames, ended: engine.ended,
        get served() { return engine.served },
        openSession: (options) => engine.openSession(options),
        releaseSession: (sessionId) => engine.releaseSession(sessionId),
        prompt: (sessionId, prompt) => engine.prompt(sessionId, prompt),
        cancel(sessionId) {
          engineCalls.push("session/cancel")
          return engine.cancel(sessionId)
        },
        configure(method, params) {
          engineCalls.push(`${method} ${configured(params)}`)
          return engine.configure(method, params)
        },
        idle: () => engine.idle(), whenIdle: () => engine.whenIdle(), close: (reason) => engine.close(reason),
      }
      return spied
    }),
    async client(model = "gemini-3.1-pro") {
      const scope = Scope.makeUnsafe()
      const metadata = providerModelInfo({ provider: "google", id: model, contextLimit: 230_000, outputLimit: 64_000, reasoning: true })
      const candidate = { kind: "subscription", providerId: PROVIDER_ID, instanceId: "account", spendMode: "included" } as const
      const build: AccessProviderBuild = {
        notify: () => {}, candidate, providerIdentity: { name: "Google Antigravity", credential: "oauth" },
        model, wireModelId: model, family: "google",
        modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
        connection: {
          id: "connection", authDir: root, oauthPersistence: "memory-only",
          auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
          subscriptionCredentials: new Map([[PROVIDER_ID, [{ instanceId: "account", identity: "person@example.com", lineageId: "account", credential: { type: "external", configDir: login.loginDir } }]]]),
        },
        classifySlot: () => "subscription", availability: fakeAvailability({}).availability, projectRoot,
        attribution: { candidate, wireModelId: model, dataUse: "standard", resolvedModelMetadata: metadata },
        recordModelRefusal: () => {},
        providerSessionLifetime: { providerSessionKey: "conversation", treeRootSessionId: "tree-root", scope },
      }
      const adapter = createAntigravityClient(build, { registry: rig.registry, loginDir: () => login.loginDir, gate: () => login.gate, observations: createLoginObservations() })
      const client = await (await adapter.stage({ attribution: build.attribution, accountOfferings: [] })).connect()
      let closed = false
      const close = async () => {
        if (closed) return
        closed = true
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
      closers.push(async () => {
        await close()
        await rig.registry.drain()
      })
      return { client, close }
    },
  }
  return rig
}

function configured(params: AcpRequests["session/set_config_option" | "session/set_model"]["params"]): string {
  return "configId" in params ? `${params.configId}=${params.value}` : params.modelId
}

interface Sent {
  readonly events: readonly ProviderStreamEvent[]
  readonly assistant: ConversationMessage
  readonly call?: Extract<ContentBlock, { type: "tool_use" }>
  readonly audit: ProviderTransportContext | undefined
}

interface SendOptions {
  readonly effort?: "low" | "high"
  readonly estimatedContextTokens?: number
  readonly toolOutputs?: ToolOutputOwners
}

/** The failure of a request that failed, with the transport record that ended its events. */
async function sendFailing(client: LLMClient, messages: readonly ConversationMessage[], options: SendOptions = {}): Promise<{ readonly error: unknown; readonly audit: ProviderTransportContext | undefined }> {
  const audits: ProviderTransportContext[] = []
  const error = await send(client, messages, options, audits).then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeDefined()
  return { error, audit: audits.at(-1) }
}

/** Sends one request, lowered for the client's history target as the attempt lowers it. */
async function send(client: LLMClient, messages: readonly ConversationMessage[], options: SendOptions = {}, audits: ProviderTransportContext[] = []): Promise<Sent> {
  const request = { messages: [...messages], tools: [ECHO], systemPrompt: SYSTEM, estimatedContextTokens: options.estimatedContextTokens ?? 1_000, ...options.effort === undefined ? {} : { reasoningEffort: options.effort }, ...options.toolOutputs }
  const lowered = lowerProviderHistory(request.messages, await client.historyTarget(request))
  const events: ProviderStreamEvent[] = []
  for await (const event of client.streamWithTools({ ...request, messages: lowered })) {
    events.push(event)
    if (event.kind === "transport_context") audits.push(event.context)
  }
  const thinking = events.flatMap((event): ContentBlock[] => event.kind === "thinking_complete" ? [{ type: "thinking", thinking: event.thinking }] : [])
  const text = events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("")
  const toolUse = events.find((event) => event.kind === "tool_use")
  const callBlock = toolUse?.kind === "tool_use" ? { type: "tool_use" as const, id: toolUse.toolCall.id, name: toolUse.toolCall.name, input: toolUse.toolCall.input } : undefined
  const content: ContentBlock[] = [...thinking, ...text.length === 0 ? [] : [{ type: "text" as const, text }], ...callBlock === undefined ? [] : [callBlock]]
  return {
    events,
    assistant: { kind: "assistant", content, accessProvider: PROVIDER_ID, provider: "google", api: "google-generative-ai", model: "gemini-3.1-pro" },
    ...callBlock === undefined ? {} : { call: callBlock },
    audit: audits.at(-1),
  }
}

const user = (text: string): ConversationMessage => ({ kind: "user", content: text, origin: "human" })
const result = (toolUseId: string, text: string, extra: { readonly interrupted?: true } = {}): ConversationMessage => ({ kind: "toolResult", toolUseId, content: [{ type: "text", text }], ...extra })

function since(harness: EngineHarness, mark: number, kind?: FakeRequest["kind"]): readonly FakeRequest[] {
  return harness.fake.requests.slice(mark).filter((request) => kind === undefined ? request.kind !== "other" : request.kind === kind)
}

/** The fields of a Gemini request body that the suite reads. */
interface GeminiBody {
  readonly systemInstruction?: { readonly parts?: readonly { readonly text?: string }[] }
  readonly contents?: readonly { readonly parts: readonly { readonly functionResponse?: { readonly response: unknown } }[] }[]
}

interface WireBody {
  readonly system: string
  readonly contents: string
}

function parsedBody(request: FakeRequest): GeminiBody {
  const parsed: GeminiBody = JSON.parse(request.body)
  return parsed
}

function body(request: FakeRequest): WireBody {
  const parsed = parsedBody(request)
  return { system: (parsed.systemInstruction?.parts ?? []).map((part) => part.text ?? "").join(""), contents: JSON.stringify(parsed.contents ?? []) }
}

function hasFlywheelContent(request: FakeRequest): boolean {
  return FLYWHEEL_MARKERS.some((marker) => request.body.includes(marker))
}

/** A title request carries the fixed primer and nothing of Flywheel's. */
function primerOnly(request: FakeRequest): boolean {
  return request.body.includes(PRIMER_TEXT) && !hasFlywheelContent(request)
}

const WIRE_TIMEOUT_MS = 60_000

describe("Google Antigravity wire through the real provider client", () => {
  test("the first request sends one primer-only title request, a refused primer step, and one main request with the whole prompt in the append", async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    const mark = rig.harness.fake.requests.length
    const sent = await send(client, [user("HISTORY-MARKER first question"), { kind: "assistant", content: "earlier answer" }, user("what now")])

    const titles = since(rig.harness, mark, "title")
    const mains = since(rig.harness, mark, "main")
    // The gate probe of the new process and the request's own session each send agy's title request for their primer.
    expect(titles.length).toBe(2)
    expect(titles.every(primerOnly)).toBe(true)
    expect(mains.length).toBe(1)
    expect(since(rig.harness, mark, "compaction")).toEqual([])
    const main = body(mains[0]!)
    expect([SYSTEM.stable, SYSTEM.session, SYSTEM.conversation, "HISTORY-MARKER", "earlier answer"].every((marker) => main.system.includes(marker))).toBe(true)
    expect(main.system.indexOf(SYSTEM.stable)).toBeLessThan(main.system.indexOf("HISTORY-MARKER"))
    expect(main.contents).toContain("what now")
    expect(rig.login.gateEvents.filter((event) => event.kind === "canary-refused").length).toBe(2)
    expect(rig.login.gateEvents.filter((event) => event.kind === "consumed").length).toBe(1)
    expect(sent.events.some((event) => event.kind === "done" && event.stopReason === "end_turn")).toBe(true)
    expect(sent.audit?.identity).toBe("antigravity-engine")
    expect(sent.audit?.hiddenRequests.map((request) => request.source)).toEqual(["title:gate-probe", "title:new-session"])
    expect(sent.audit?.additions.map((addition) => addition.kind)).toEqual(expect.arrayContaining(["agent-body", "append", "primer", "tool-argument:toolSummary", "tool:manage_task"]))
  }, WIRE_TIMEOUT_MS)

  test("a response with three calls is four requests over two main HTTP requests, and the next message continues the session", async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    rig.harness.fake.script([{ kind: "calls", calls: [call("a"), call("b"), call("c")] }, { kind: "text", text: "all three done" }])
    const mark = rig.harness.fake.requests.length
    const history: ConversationMessage[] = [user("run three")]
    const stops: string[] = []
    const executed: string[] = []
    for (;;) {
      const sent = await send(client, history)
      history.push(sent.assistant)
      stops.push(...sent.events.flatMap((event) => event.kind === "done" ? [event.stopReason] : []))
      if (sent.call === undefined) break
      executed.push(String(sent.call.input.text))
      history.push(result(sent.call.id, `RESULT-MARKER ${String(sent.call.input.text)}`))
    }
    expect(stops).toEqual(["tool_use", "tool_use", "tool_use", "end_turn"])
    expect(executed).toEqual(["a", "b", "c"])
    expect(since(rig.harness, mark, "main").length).toBe(2)
    // No step of the session ran or was refused beyond the two admitted model steps.
    expect(rig.login.gateEvents.filter((event) => event.kind === "consumed").length).toBe(2)
    expect(rig.login.gateEvents.filter((event) => event.kind === "refused")).toEqual([])

    const next = rig.harness.fake.requests.length
    const firstAppend = body(since(rig.harness, mark, "main")[0]!).system
    await send(client, [...history, user("and now?")])
    expect(since(rig.harness, next, "title")).toEqual([])
    const mains = since(rig.harness, next, "main")
    expect(mains.length).toBe(1)
    expect(body(mains[0]!).system).toBe(firstAppend)
    expect(body(mains[0]!).contents).toContain("and now?")
  }, WIRE_TIMEOUT_MS)

  test("an effort change sets the thought level on the session; a model change rotates to a session of the new model", async () => {
    const rig = await openRig()
    const pro = await rig.client("gemini-3.1-pro")
    const history: ConversationMessage[] = [user("first")]
    history.push((await send(pro.client, history, { effort: "low" })).assistant)
    const mark = rig.harness.fake.requests.length
    history.push(user("second"))
    const second = await send(pro.client, history, { effort: "high" })
    history.push(second.assistant)
    expect(rig.engineCalls).toContain("session/set_config_option thought_level=high")
    expect(since(rig.harness, mark, "title")).toEqual([])
    expect(since(rig.harness, mark, "main").length).toBe(1)

    // The runtime replaces the client of another model, which ends the old client's scope.
    await pro.close()
    const neon = await rig.client("gemini-4-neon")
    const switched = rig.harness.fake.requests.length
    history.push(user("third"))
    const rotated = await send(neon.client, history)
    // The last lease of the old process ended, so a new process (with its own gate probe) serves the new session.
    expect(rotated.audit?.hiddenRequests.filter((request) => request.source === "title:new-session").length).toBe(1)
    expect(since(rig.harness, switched, "title").every(primerOnly)).toBe(true)
    const mains = since(rig.harness, switched, "main")
    expect(mains.map((request) => request.path)).toEqual(["/v1beta/models/gemini-4-neon:streamGenerateContent"])
    expect(body(mains[0]!).system).toContain("second")
  }, WIRE_TIMEOUT_MS)

  test("a model change while a call is parked cancels the session and serves the result on a session of the new model", async () => {
    const rig = await openRig()
    const pro = await rig.client("gemini-3.1-pro")
    rig.harness.fake.script([{ kind: "calls", calls: [call("x")] }])
    const history: ConversationMessage[] = [user("call it")]
    const sent = await send(pro.client, history)
    expect(sent.call?.name).toBe("echo")
    history.push(sent.assistant, result(sent.call!.id, "RESULT-MARKER x"))
    await pro.close()
    expect(rig.engineCalls).toContain("session/cancel")
    const neon = await rig.client("gemini-4-neon")
    const mark = rig.harness.fake.requests.length
    await send(neon.client, history)
    const mains = since(rig.harness, mark, "main")
    expect(mains.map((request) => request.path)).toEqual(["/v1beta/models/gemini-4-neon:streamGenerateContent"])
    expect(body(mains[0]!).system).toContain("RESULT-MARKER x")
    expect(body(mains[0]!).contents).toContain(CONTINUATION_PROMPT)
  }, WIRE_TIMEOUT_MS)

  test("an edited history rotates to a new session whose append holds the whole canonical history", async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    const history: ConversationMessage[] = [user("HISTORY-MARKER original")]
    history.push((await send(client, history)).assistant)
    const mark = rig.harness.fake.requests.length
    const edited: ConversationMessage[] = [user("HISTORY-MARKER edited"), history[1]!, user("next")]
    const sent = await send(client, edited)
    const titles = since(rig.harness, mark, "title")
    expect(titles.length).toBe(1)
    expect(titles.every(primerOnly)).toBe(true)
    const main = body(since(rig.harness, mark, "main")[0]!)
    expect(main.system).toContain("HISTORY-MARKER edited")
    expect(main.system).not.toContain("HISTORY-MARKER original")
    expect(sent.audit?.hiddenRequests.map((request) => request.source)).toEqual(["title:new-session"])
  }, WIRE_TIMEOUT_MS)

  test("a route switch with a pending call delivers the result as a rotation tail, and the next Google API request reads it as structured history", async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    const history: ConversationMessage[] = [
      user("HISTORY-MARKER task"),
      {
        kind: "assistant", accessProvider: "google_api", provider: "google", api: "google-generative-ai", model: "gemini-3.1-pro",
        content: [{ type: "thinking", thinking: "PRIVATE-REASONING", signature: "c2ln" }, { type: "tool_use", id: "call-1", name: "echo", input: { text: "x" }, thoughtSignature: "c2ln" }],
      },
      result("call-1", "RESULT-MARKER from google"),
    ]
    const mark = rig.harness.fake.requests.length
    const sent = await send(client, history)
    // The Google API's call already ran: the rotation reads its result and dispatches no call.
    expect(sent.events.filter((event) => event.kind === "tool_use")).toEqual([])
    const main = body(since(rig.harness, mark, "main")[0]!)
    expect(main.system).toContain(`<tool_result id="call-1">`)
    expect(main.contents).toContain(CONTINUATION_PROMPT)
    expect(rig.harness.fake.requests.some((request) => request.body.includes("PRIVATE-REASONING"))).toBe(false)

    rig.harness.fake.script([{ kind: "calls", calls: [call("y")], thought: "ENGINE-REASONING" }])
    const next = [...history, sent.assistant, user("call again")]
    const called = await send(client, next)
    expect(called.events.filter((event) => event.kind === "tool_use")).toHaveLength(1)
    expect(called.assistant.kind === "assistant" && Array.isArray(called.assistant.content) && called.assistant.content.some((block) => block.type === "thinking" && block.thinking.includes("ENGINE-REASONING"))).toBe(true)
    const back = [...next, called.assistant, result(called.call!.id, "RESULT-MARKER y")]
    // The request that the Google API route builds from canonical history, through its own lowering.
    const contents = toGoogleGenerativeAiRequest({ accessProvider: "google_api", provider: "google", model: "gemini-3.1-pro" }, back)
    const parts = contents.flatMap((content) => content.parts ?? [])
    expect(parts.filter((part) => part.functionCall !== undefined).map((part) => part.functionCall?.args)).toEqual([{ text: "x" }, { text: "y" }])
    const responses = parts.flatMap((part) => part.functionResponse === undefined ? [] : [JSON.stringify(part.functionResponse.response)])
    expect(responses).toHaveLength(2)
    expect(responses[1]).toContain("RESULT-MARKER y")
    // Only the Google API's own signed reasoning replays to it; the engine's reasoning stays out.
    expect(parts.filter((part) => part.thought === true).map((part) => part.text)).toEqual(["PRIVATE-REASONING"])
  }, WIRE_TIMEOUT_MS)

  /** The text of the function response that the main request since `mark` carries. */
  const delivered = (rig: Rig, mark: number): string => {
    const main = since(rig.harness, mark, "main")[0]!
    return JSON.stringify((parsedBody(main).contents ?? []).flatMap((content) => content.parts).find((part) => part.functionResponse !== undefined)?.functionResponse?.response)
  }
  const savedFiles = (root: string): string[] => {
    const dir = join(root, ".flywheel", "agent-outputs")
    return existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((entry) => entry.endsWith(".txt")) : []
  }

  test("a 25 KB tool result reaches the model below 10 KB, named from the agent's directory in the runtime's artifact scope; canonical history keeps it whole", async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    rig.harness.fake.script([{ kind: "calls", calls: [call("big")] }])
    const executionCwd = join(rig.projectRoot, "packages", "app")
    mkdirSync(executionCwd, { recursive: true })
    const toolOutputs: ToolOutputOwners = { executionCwd, artifactScopeId: "agent-scope", savedOutputPath: async () => undefined }
    const history: ConversationMessage[] = [user("read it")]
    const sent = await send(client, history, { toolOutputs })
    const full = `RESULT-MARKER ${"0123456789abcdef".repeat(1_600)}`
    expect(Buffer.byteLength(full)).toBeGreaterThan(25_000)
    const canonical = result(sent.call!.id, full)
    history.push(sent.assistant, canonical)
    const mark = rig.harness.fake.requests.length
    await send(client, history, { toolOutputs })
    const response = delivered(rig, mark)
    expect(Buffer.byteLength(response)).toBeLessThan(10_240)
    const saved = /Full output saved to ([^\]\\]+)\]/u.exec(response)?.[1]
    expect(saved).toBeDefined()
    expect(readFileSync(join(executionCwd, saved!), "utf8")).toBe(full)
    expect(savedFiles(rig.projectRoot).map((file) => file.split(/[\\/]/u)[0])).toEqual(["agent-scope"])
    expect(canonical.kind === "toolResult" && canonical.content).toEqual([{ type: "text", text: full }])
  }, WIRE_TIMEOUT_MS)

  test("a result whose full output the runtime already saved names that file and saves no second copy", async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    rig.harness.fake.script([{ kind: "calls", calls: [call("big")] }])
    const executionCwd = join(rig.projectRoot, "packages", "app")
    mkdirSync(executionCwd, { recursive: true })
    const full = `RESULT-MARKER ${"0123456789abcdef".repeat(2_500)}`
    // The runtime's own cut of the call's output, as the agent loop finalizes it.
    const cut = await limitOutput({ content: full, executionCwd, projectRoot: rig.projectRoot, artifactScopeId: "agent-scope", toolName: "echo" })
    expect(cut.fullContentPath).toBeDefined()
    const history: ConversationMessage[] = [user("read it")]
    const sent = await send(client, history)
    const lookups: string[] = []
    const toolOutputs: ToolOutputOwners = {
      executionCwd, artifactScopeId: "agent-scope",
      savedOutputPath: async (toolUseId) => {
        lookups.push(toolUseId)
        return toolUseId === sent.call!.id ? cut.fullContentPath : undefined
      },
    }
    history.push(sent.assistant, result(sent.call!.id, cut.text))
    const mark = rig.harness.fake.requests.length
    await send(client, history, { toolOutputs })
    const response = delivered(rig, mark)
    expect(lookups).toEqual([sent.call!.id])
    expect(Buffer.byteLength(response)).toBeLessThan(10_240)
    const named = [...response.matchAll(/Full output saved to ([^\]\\]+)\]/gu)].map((match) => match[1])
    expect(named).toHaveLength(1)
    expect(readFileSync(join(executionCwd, named[0]!), "utf8")).toBe(full)
    expect(savedFiles(rig.projectRoot)).toHaveLength(1)
  }, WIRE_TIMEOUT_MS)

  test("a user abort during a parked call cancels the session, and the next request rotates", async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    rig.harness.fake.script([{ kind: "calls", calls: [call("slow")] }])
    const history: ConversationMessage[] = [user("start")]
    const sent = await send(client, history)
    history.push(sent.assistant, result(sent.call!.id, "Interrupted by the person.", { interrupted: true }), user("stop that"))
    const mark = rig.harness.fake.requests.length
    await send(client, history)
    expect(rig.engineCalls).toContain("session/cancel")
    expect(since(rig.harness, mark, "title").length).toBe(1)
    expect(body(since(rig.harness, mark, "main")[0]!).system).toContain(`status="interrupted"`)
  }, WIRE_TIMEOUT_MS)

  test("a workspace .agents folder in the person's project never reaches the engine", async () => {
    const rig = await openRig()
    mkdirSync(join(rig.projectRoot, ".agents", "rules"), { recursive: true })
    writeFileSync(join(rig.projectRoot, ".agents", "rules", "rule.md"), "PROJECT-RULE-MARKER")
    const { client } = await rig.client()
    await send(client, [user("hello")])
    expect(rig.harness.fake.requests.some((request) => request.body.includes("PROJECT-RULE-MARKER"))).toBe(false)
  }, WIRE_TIMEOUT_MS)
})

describe("Google Antigravity qualification of agy 1.5.14", () => {
  const failures = {
    "missing hooks.json": undefined,
    "a hook command that cannot start": { command: "/nonexistent/flywheel-gate", timeout: 5 },
    "a hook that times out": { command: "sleep 30", timeout: 1 },
    "a hook that exits nonzero": { command: "exit 3", timeout: 5 },
  } as const
  for (const [name, handler] of Object.entries(failures)) {
    test(`${name} fails the first request with gate-not-reached before any Flywheel content reaches the host`, async () => {
      const rig = await openRig()
      rig.afterLaunch = () => { writeHook(rig.login, handler) }
      const { client } = await rig.client()
      const { error } = await sendFailing(client, [user("HISTORY-MARKER secret")])
      expect(error).toBeInstanceOf(RouteUnavailableError)
      expect(error).toMatchObject({ message: expect.stringContaining("gate-not-reached") })
      expect(rig.harness.fake.requests.filter(hasFlywheelContent)).toEqual([])
    }, WIRE_TIMEOUT_MS)
  }

  for (const [answer, scripted] of [["a text answer", undefined], ["a calls-only answer", { kind: "calls", calls: [call("unadmitted")] }]] as const) {
  test(`a hook failure after the canary with ${answer} is cancelled, fails the request, is recorded as a hidden request, and the next request rotates`, async () => {
    const rig = await openRig()
    const { client } = await rig.client()
    const history: ConversationMessage[] = [user("first")]
    history.push((await send(client, history)).assistant)
    const working = readFileSync(hooksFile(rig.login), "utf8")
    writeHook(rig.login, { command: "/nonexistent/flywheel-gate", timeout: 5 })
    if (scripted !== undefined) rig.harness.fake.script([scripted])
    history.push(user("second"))
    const failure = await sendFailing(client, history)
    expect(failure.error).toBeInstanceOf(LlmStreamError)
    expect(failure.audit?.hiddenRequests.map((request) => request.source)).toEqual(["unadmitted-step"])
    expect(rig.engineCalls).toContain("session/cancel")

    writeFileSync(hooksFile(rig.login), working)
    const mark = rig.harness.fake.requests.length
    const next = await send(client, history)
    expect(next.call).toBeUndefined()
    expect(since(rig.harness, mark, "title").length).toBe(1)
    expect(since(rig.harness, mark, "main").length).toBe(1)
  }, WIRE_TIMEOUT_MS)
  }

  for (const status of [429, 500]) {
    test(`a title request answered ${String(status)} is sent at most three times, each with the primer only`, async () => {
      const rig = await openRig({ titleStatus: status })
      const { client } = await rig.client()
      const history: ConversationMessage[] = [user("HISTORY-MARKER one")]
      history.push((await send(client, history)).assistant)
      const mark = rig.harness.fake.requests.length
      await send(client, [user("HISTORY-MARKER edited"), history[1]!, user("two")])
      const titles = since(rig.harness, mark, "title")
      expect(titles.length).toBeGreaterThan(0)
      expect(titles.length).toBeLessThanOrEqual(3)
      expect(titles.every(primerOnly)).toBe(true)
    }, WIRE_TIMEOUT_MS)
  }

  test("the occupancy that the engine reports keeps a 512K session under its guard, and a switch to a 256K family at 400K tokens sends no compaction request", async () => {
    const rig = await openRig()
    const neon = await rig.client("gemini-4-neon")
    // About 300,000 tokens of append, near the byte cap of a 512K family.
    const large = `HISTORY-MARKER ${"lorem ipsum ".repeat(100_000)}`
    const history: ConversationMessage[] = [user(large), { kind: "assistant", content: "noted" }, user("go on")]
    // gemini-4-neon summarizes at 512,000 reported tokens, and the guard stops 8,000 tokens below 511,000: 503,000.
    rig.harness.fake.script([{ kind: "text", text: "first", promptTokens: 502_000 }, { kind: "text", text: "second", promptTokens: 502_950 }])
    history.push((await send(neon.client, history)).assistant)
    let mark = rig.harness.fake.requests.length
    history.push(user("short"))
    const pushed = await send(neon.client, history)
    history.push(pushed.assistant)
    // A short input stays under the guard on the reported occupancy, so the session continues.
    expect(pushed.audit?.hiddenRequests).toEqual([])
    expect(since(rig.harness, mark, "main").length).toBe(1)

    // The engine now reports 502,950 tokens, so an input of about 115 tokens crosses the guard, though the request's own
    // estimate is 1,000 tokens: the session rotates before the engine could summarize it.
    mark = rig.harness.fake.requests.length
    history.push(user("x".repeat(400)))
    const rotated = await send(neon.client, history)
    history.push(rotated.assistant)
    expect(rotated.audit?.hiddenRequests.map((request) => request.source)).toEqual(["title:new-session"])
    expect(since(rig.harness, mark, "main").length).toBe(1)

    rig.harness.fake.script([{ kind: "text", text: "large", promptTokens: 400_000 }])
    history.push(user("more"))
    const large400 = await send(neon.client, history)
    history.push(large400.assistant)
    await neon.close()
    const pro = await rig.client("gemini-3.1-pro")
    history.push(user("switch"))
    const { error } = await sendFailing(pro.client, history, { estimatedContextTokens: 400_000 })
    expect(error).toBeInstanceOf(ContextLengthExceededError)
    expect(rig.harness.fake.requests.filter((request) => request.kind === "compaction")).toEqual([])
    expect(existsSync(rig.projectRoot)).toBe(true)
  }, WIRE_TIMEOUT_MS)
})
