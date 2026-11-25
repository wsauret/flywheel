/**
 * Conformance of the Google Antigravity route with the Google API route (plan M13, L51). One scripted conversation runs
 * through the `google_api` adapter against the fake Gemini host and through the real pinned `agy acp` against another
 * fake Gemini host. The suite compares the canonical histories, the outcomes, and the requests that reached each host.
 * Each difference must be an entry of the deviation ledger below, and each ledger entry that changes a request must be
 * an addition that the route's transport record states (ARCH-CONTEXT-008), so the record and the ledger agree in both
 * directions.
 */
import { describe, expect, test } from "bun:test"
import { ApiError, GoogleGenAI } from "@google/genai"
import { Redacted } from "effect"
import { providerModelInfo } from "../../../../../src/infra/providers/llm/catalog/provider-model-info.js"
import { createGoogleAdapter } from "../../../../../src/orchestration/agent-runtime/llm/adapters/google/google.js"
import type { LLMClient, ToolDef } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ConversationMessage } from "../../../../../src/infra/providers/llm/conversation/conversation-message.js"
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/dispatch/tool-dispatch.js"
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { PRIMER_TEXT } from "../../../../../src/orchestration/modules/provider-google-antigravity/request/bridge.js"
import { CONTINUATION_PROMPT } from "../../../../../src/orchestration/modules/provider-google-antigravity/request/request-plan.js"
import type { ProviderTransportAddition } from "../../../../../src/orchestration/session/runtime-facts/provider-request-audit-types.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { makeContext } from "../../../../unit/orchestration/agent-runtime/tools/_fixtures.js"
import { engineCall, openClientRig, result, send, user, type Sent } from "./_client.js"
import { expectNoEngineLeft, openEngineHarness, type EngineHarness, type HarnessLogin } from "./_engine.js"
import { openFakeGemini, type FakeAnswer, type FakeGemini, type FakeRequest } from "./_fake-gemini.js"

const temporary = temporaryDirectories()
expectNoEngineLeft()

const MODEL = "gemini-3.1-pro"
const SYSTEM = { stable: "STABLE-TIER-MARKER", session: "SESSION-TIER-MARKER", conversation: "" }
const ECHO: ToolDef = { name: "echo", description: "Echoes its text.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
const READ: ToolDef = { name: "read", description: "Reads a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
const TIMEOUT_MS = 120_000

/**
 * Every way in which the Antigravity route differs from the Google API route for one conversation. `additions` are the
 * transport-record additions that state the difference, at the positions the record names (the `append` addition
 * also carries the append's size); an entry with none changes no request that Flywheel prepared, and `reason` says why.
 */
const LEDGER = {
  primerAndTitle: { additions: [{ part: "message", kind: "primer" }], reason: "Each new engine session opens with the fixed primer, which agy also sends as its title request and keeps in the session's history before every later message (decision 5)." },
  oneCallPerRequest: { additions: [], reason: "agy reveals the next call of a response only after the previous result, so each Flywheel request ends at one call, each call of a response is its own assistant message followed by its result, and a request that settles on a call that agy revealed without a step sends no model request (decision 9)." },
  append: { additions: [{ part: "system", kind: "agent-body", at: 0 }, { part: "system", kind: "append", at: 0 }], reason: "The system text is agy's agent frame, then the whole system prompt and the history before the request as text in the session's append (decision D1)." },
  messageEnvelope: { additions: [], reason: "The route sends each new message of the person as prompt text, in the message envelope of the append's history text, which Flywheel prepares." },
  continuationPrompt: { additions: [{ part: "message", kind: "prompt:continuation" }], reason: "A rotation whose history ends with a tool result prompts the session with the fixed continuation prompt, after the request's messages." },
  engineTools: { additions: [{ part: "body", kind: "tool:manage_task" }, { part: "body", kind: "tool:list_resources" }, { part: "body", kind: "tool:read_resource" }], reason: "agy declares its own task tool and the resource tools of its MCP client beside Flywheel's tools." },
  schemaRewrites: { additions: [{ part: "body", kind: "tool-argument:toolSummary" }, { part: "body", kind: "tool-description-prefix" }, { part: "body", kind: "tool-schema-rewrite" }], reason: "agy requires a toolSummary argument, prefixes each description with the MCP server, closes every object schema, and orders its keys (decision 13). The `mcp_runtime_` name prefix is the route's own tool presentation." },
  promptWrapper: { additions: [{ part: "message", kind: "prompt-wrapper" }], reason: "agy wraps each prompt in its request tags with the local time, and adds a notice when the session's model setting changed." },
  resultTimestamps: { additions: [{ part: "message", kind: "tool-result-timestamps" }], reason: "Once the session holds a delivered result, agy puts the call's start and end times before each result that did not fail." },
  errorPrefix: { additions: [{ part: "message", kind: "tool-error-prefix" }], reason: "Once the session holds a delivered failed result, agy puts its own error text before each failed result, which carries no times." },
  generationConfig: { additions: [{ part: "body", kind: "generation-config" }], reason: "agy replaces the generation config with its own output cap and the thinking budget of the session's thought level (`low`).", engine: { maxOutputTokens: 65_535, thinkingConfig: { includeThoughts: true, thinkingBudget: 1_024 } } },
  engineWireNames: { additions: [], reason: "agy names each call and its result with its own id on its own wire, and sends function responses in the model role; the request's model is the session's model option." },
  sharedTools: { additions: [{ part: "body", kind: "shared-tool:read" }], reason: "Every engine of a tree declares the tree's composed tool surface; the agent's grant narrows its calls at Flywheel's dispatch (P3, ARCH-PROVIDERS-073)." },
} as const satisfies { readonly [entry: string]: { readonly additions: readonly ProviderTransportAddition[]; readonly reason: string; readonly engine?: SchemaNode } }

/** The Google API route's adapter, through the Google SDK, against the fake host. */
async function googleApi(fake: FakeGemini): Promise<LLMClient> {
  const info = providerModelInfo({ provider: "google", id: MODEL, contextLimit: 230_000, outputLimit: 64_000, reasoning: true })
  const sdk = new GoogleGenAI({ apiKey: "flywheel-fake-key", httpOptions: { baseUrl: fake.url } })
  return createGoogleAdapter(Redacted.make("flywheel-fake-key"), MODEL, info, {
    client: { generateContentStream: (request) => sdk.models.generateContentStream(request), apiErrorStatus: (error) => error instanceof ApiError ? error.status : undefined },
  })
}

/** The scripted model: two calls in one response, an answer, then an answer to the next message. `call` names each call
 *  as the route's model sees the tool. */
const script = (call: (text: string) => { readonly name: string; readonly args: { readonly [name: string]: unknown } }): FakeAnswer[] => [
  { kind: "calls", calls: [call("a"), call("b")] },
  { kind: "text", text: "TWO DONE" },
  { kind: "text", text: "FINAL" },
]
const googleCall = (text: string) => ({ name: "echo", args: { text } })

type CallBlock = Sent["calls"][number]
type ToolResultMessage = Extract<ConversationMessage, { kind: "toolResult" }>
const echoResult = async (call: CallBlock): Promise<ToolResultMessage> => ({ kind: "toolResult", toolUseId: call.id, content: [{ type: "text", text: `RESULT ${String(call.input.text)}` }] })

/** Runs the conversation as the agent loop does: `answer` gives each call's result, and a request that ends with no
 *  call ends the turn. */
async function converse(client: LLMClient, accessProvider: string, options: { readonly history?: ConversationMessage[]; readonly words?: readonly string[]; readonly answer?: (call: CallBlock) => Promise<ToolResultMessage> } = {}) {
  const { history = [], words = ["HISTORY-MARKER echo a and b", "and now?"], answer = echoResult } = options
  const sent: Sent[] = []
  const turn = async () => {
    for (;;) {
      const response = await send(client, { messages: history, tools: [ECHO], systemPrompt: SYSTEM }, accessProvider)
      sent.push(response)
      history.push(response.assistant)
      if (response.calls.length === 0) return
      for (const call of response.calls) history.push(await answer(call))
    }
  }
  if (words.length === 0) await turn()
  for (const said of words) {
    history.push(user(said))
    await turn()
  }
  return { history, sent }
}

/** One canonical history item as both routes must agree on it: a call names its result by order, not by id. */
type Item =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "call"; readonly name: string; readonly input: unknown; readonly call: number }
  | { readonly kind: "result"; readonly call: number; readonly text: string; readonly isError?: true }

function items(history: readonly ConversationMessage[]): Item[] {
  const ids = new Map<string, number>()
  const ordinal = (id: string) => ids.get(id) ?? ids.set(id, ids.size).get(id)!
  return history.flatMap((message): Item[] => {
    if (message.kind === "user") return [{ kind: "user", text: String(message.content) }]
    if (message.kind === "toolResult") return [{ kind: "result", call: ordinal(message.toolUseId), text: message.content.map((part) => part.type === "text" ? part.text : "").join(""), ...message.isError === true ? { isError: true } : {} }]
    if (message.kind !== "assistant" || typeof message.content === "string") return []
    return message.content.flatMap((block): Item[] => block.type === "text" ? [{ kind: "answer", text: block.text }]
      : block.type === "tool_use" ? [{ kind: "call", name: block.name, input: block.input, call: ordinal(block.id) }] : [])
  })
}

/** Ledger `oneCallPerRequest`: the Google API route's results follow all calls of a response; place each after its call. */
function eachCallWithItsResult(history: readonly Item[]): Item[] {
  const results = new Map(history.flatMap((item) => item.kind === "result" ? [[item.call, item] as const] : []))
  return history.flatMap((item): Item[] => item.kind === "result" ? [] : item.kind === "call" ? [item, results.get(item.call)!] : [item])
}

interface GeminiPart {
  readonly text?: string
  readonly thought?: boolean
  readonly thoughtSignature?: string
  readonly functionCall?: { readonly name: string; readonly args: SchemaNode; readonly id?: string }
  readonly functionResponse?: { readonly name: string; readonly response: { readonly output?: string; readonly error?: string }; readonly id?: string }
}
interface GeminiContent { readonly role: string; readonly parts: readonly GeminiPart[] }
interface GeminiDeclaration { readonly name: string; readonly description: string; readonly parametersJsonSchema: Schema }
interface GeminiBody {
  readonly systemInstruction?: { readonly parts?: readonly GeminiPart[] }
  readonly contents?: readonly GeminiContent[]
  readonly tools?: readonly { readonly functionDeclarations?: readonly GeminiDeclaration[] }[]
  readonly generationConfig?: SchemaNode
}
interface SchemaNode { readonly [key: string]: unknown }
interface Schema extends SchemaNode { readonly properties?: { readonly [name: string]: Schema }; readonly required?: readonly string[]; readonly additionalProperties?: boolean }

const parsed = (request: FakeRequest): GeminiBody => JSON.parse(request.body)
const mains = (fake: FakeGemini) => fake.requests.filter((request) => request.kind === "main")
const systemText = (body: GeminiBody) => (body.systemInstruction?.parts ?? []).map((part) => part.text ?? "").join("")
const declarations = (body: GeminiBody) => (body.tools ?? []).flatMap((tool) => tool.functionDeclarations ?? [])

const ENGINE_TOOLS = new Set(["manage_task", "list_resources", "read_resource"])
const DESCRIPTION_PREFIX = "This is a tool from the runtime MCP server.\n"
const AGENT_FRAME = "<System Prompt>\nThe instructions for this session follow.\n</System Prompt>\n"
const ENGINE_PREFIX = "mcp_runtime_"
/** Ledger `promptWrapper`: agy's request tags around a prompt, with the local time and an optional settings notice. */
const PROMPT_WRAPPER = /^<USER_REQUEST>\n([\s\S]*)\n<\/USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: [^\n]+\.\n<\/ADDITIONAL_METADATA>(?:\n<USER_SETTINGS_CHANGE>\n[^\n]+\n<\/USER_SETTINGS_CHANGE>)?$/u
/** Ledger `messageEnvelope`: the envelope of a person's message in the route's prompt text. */
const MESSAGE_ENVELOPE = /^<message role="user" origin="person">\n([\s\S]*)\n<\/message>$/u
/** Ledger `resultTimestamps`. */
const RESULT_TIMESTAMPS = /^Created At: \S+\nCompleted At: \S+\n/u
/** Ledger `errorPrefix`. */
const ERROR_PREFIX = "Encountered error in tool execution: "

/** Ledger `schemaRewrites` undone: the schema without `toolSummary` and without the closing `additionalProperties`. */
function unrewritten(schema: Schema): Schema {
  const { additionalProperties, properties, required, ...rest } = schema
  expect(additionalProperties ?? false).toBe(false)
  return {
    ...rest,
    ...properties === undefined ? {} : { properties: Object.fromEntries(Object.entries(properties).filter(([name]) => name !== "toolSummary").map(([name, value]) => [name, unrewritten(value)])) },
    ...required === undefined ? {} : { required: required.filter((name) => name !== "toolSummary") },
  }
}

/** Flywheel's tools as the engine declared them, with ledger `engineTools` and `schemaRewrites` undone. */
function flywheelDeclarations(body: GeminiBody) {
  return declarations(body).filter((declaration) => !ENGINE_TOOLS.has(declaration.name)).map((declaration) => {
    expect(declaration.name.startsWith(ENGINE_PREFIX)).toBe(true)
    expect(declaration.description.startsWith(DESCRIPTION_PREFIX)).toBe(true)
    return { name: declaration.name.slice(ENGINE_PREFIX.length), description: declaration.description.slice(DESCRIPTION_PREFIX.length), parametersJsonSchema: unrewritten(declaration.parametersJsonSchema) }
  })
}

/** The text of a prompt of the person, with ledger `promptWrapper` undone. A prompt without agy's tags fails. */
function unwrapped(text: string): string {
  const inner = PROMPT_WRAPPER.exec(text)?.[1]
  expect(inner, text).toBeDefined()
  return inner!
}

/** One part as the Google API route sends it, with ledgers `promptWrapper`, `messageEnvelope`, `schemaRewrites`,
 *  `resultTimestamps`, `errorPrefix`, and `engineWireNames` undone. */
function unwrappedPart(part: GeminiPart, role: string): GeminiPart {
  if (part.functionCall !== undefined) {
    const { id: _id, name, args } = part.functionCall
    return { ...part, functionCall: { name: name.replace(ENGINE_PREFIX, ""), args: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "toolSummary")) } }
  }
  if (part.functionResponse !== undefined) {
    const { id: _id, name, response } = part.functionResponse
    const unprefixed = { name: name.replace(ENGINE_PREFIX, "") }
    if (response.error !== undefined) {
      expect(response.error.startsWith(ERROR_PREFIX)).toBe(true)
      return { ...part, functionResponse: { ...unprefixed, response: { error: response.error.slice(ERROR_PREFIX.length) } } }
    }
    expect(response.output).toMatch(RESULT_TIMESTAMPS)
    return { ...part, functionResponse: { ...unprefixed, response: { output: response.output!.replace(RESULT_TIMESTAMPS, "") } } }
  }
  if (role !== "user" || part.text === undefined) return part
  const prompt = unwrapped(part.text)
  return { ...part, text: MESSAGE_ENVELOPE.exec(prompt)?.[1] ?? prompt }
}

/**
 * A model request of the engine as the Google API route sends the same request: every difference that the ledger
 * names undone, and nothing else, so the whole body compares. Ledger `primerAndTitle`: the first content is the
 * primer that agy keeps in the session. Ledger `append`: the system text starts with agy's agent frame. Ledger
 * `engineTools`: agy's own tools. Ledger `generationConfig`: agy's own config, which the Google API route's replaces.
 */
function asGoogleRequest(engine: GeminiBody, google: GeminiBody): GeminiBody {
  const [primer, ...contents] = engine.contents ?? []
  expect(primer?.role).toBe("user")
  expect(primer?.parts.map((part) => unwrapped(part.text ?? ""))).toEqual([PRIMER_TEXT])
  expect(systemText(engine).startsWith(AGENT_FRAME)).toBe(true)
  expect(declarations(engine).map((declaration) => declaration.name).filter((name) => ENGINE_TOOLS.has(name)).toSorted()).toEqual([...ENGINE_TOOLS].toSorted())
  expect(engine.generationConfig).toEqual(LEDGER.generationConfig.engine)
  return {
    ...engine,
    systemInstruction: { ...engine.systemInstruction, parts: [{ text: systemText(engine).slice(AGENT_FRAME.length) }] },
    contents: contents.map((content) => {
      // Ledger `engineWireNames`: agy sends function responses in the model role.
      const role = content.parts.every((part) => part.functionResponse !== undefined) ? "user" : content.role
      return { ...content, role, parts: content.parts.map((part) => unwrappedPart(part, role)) }
    }),
    tools: [{ functionDeclarations: flywheelDeclarations(engine) }],
    ...google.generationConfig === undefined ? {} : { generationConfig: google.generationConfig },
  }
}

/** The additions that the ledger `entries` state for one model step of a session, in a canonical order: the `append`
 *  addition carries the size of the session's append, and each fixed prompt follows the `opensAt` messages of the
 *  request that the append holds. */
function ledgerAdditions(session: { readonly appendBytes: number; readonly opensAt: number }, ...entries: (keyof typeof LEDGER)[]): ProviderTransportAddition[] {
  return canonical(entries.flatMap((entry): ProviderTransportAddition[] => LEDGER[entry].additions.map((addition) =>
    addition.kind === "append" ? { ...addition, value: String(session.appendBytes) }
      : addition.kind === "primer" || addition.kind === "prompt:continuation" ? { ...addition, at: session.opensAt }
        : addition)))
}

const canonical = (additions: readonly ProviderTransportAddition[]): ProviderTransportAddition[] => additions.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))

/** The additions that each request's transport record states, in a canonical order. */
const statedAdditions = (sent: readonly Sent[]) => sent.map((answer) => {
  expect(answer.audit).toBeDefined()
  return canonical(answer.audit!.additions)
})

interface EngineRun {
  readonly harness: EngineHarness
  readonly login: HarnessLogin
  readonly rig: ReturnType<typeof openClientRig>
  readonly root: string
}

async function withEngine(use: (run: EngineRun) => Promise<void>): Promise<void> {
  const root = temporary("agc-")
  const harness = openEngineHarness(root)
  try {
    const login = await harness.login("w")
    const rig = openClientRig([login])
    try {
      await use({ harness, login, rig, root })
    } finally {
      await rig.close()
    }
  } finally {
    await harness.close()
  }
}

describe("the Google Antigravity route and the Google API route", () => {
  test("serve one scripted conversation to the same canonical history, outcomes, and model requests, apart from the ledger", async () => {
    const googleHost = openFakeGemini()
    googleHost.script(script(googleCall))
    let google: Awaited<ReturnType<typeof converse>>
    try {
      google = await converse(await googleApi(googleHost), "google_api")
    } finally {
      await googleHost.close()
    }

    await withEngine(async ({ harness, rig, login, root }) => {
      harness.fake.script(script(engineCall))
      const agent = await rig.agent({ login, tree: "tree", session: "agent", projectRoot: root })
      const engine = await converse(agent.client, "google_antigravity")

      // Outcomes: the same calls ran with the same arguments, and the model gave the same answers. Ledger
      // `oneCallPerRequest`: the Google API route's one request with two calls is two engine requests.
      expect(eachCallWithItsResult(items(google.history))).toEqual(items(engine.history))
      expect(google.sent.map((answer) => answer.stopReason)).toEqual(["tool_use", "end_turn", "end_turn"])
      expect(engine.sent.map((answer) => answer.stopReason)).toEqual(["tool_use", "tool_use", "end_turn", "end_turn"])
      // Ledger `engineWireNames`: neither route keeps the other's call ids, and only the Google API's calls carry its signature.
      expect(engine.history.some((message) => message.kind === "assistant" && Array.isArray(message.content) && message.content.some((block) => block.type === "tool_use" && block.thoughtSignature !== undefined))).toBe(false)

      // Ledger `primerAndTitle`: agy's own title requests carry only the primer, one for the process's gate probe and
      // one for the agent's session.
      const titles = harness.fake.requests.filter((request) => request.kind === "title")
      expect(titles).toHaveLength(2)
      expect(titles.every((request) => request.body.includes(PRIMER_TEXT) && !request.body.includes("MARKER"))).toBe(true)
      expect(harness.fake.requests.filter((request) => request.kind === "compaction")).toEqual([])
      expect(engine.sent.map((answer) => answer.audit?.hiddenRequests.map((request) => request.source))).toEqual([["title:gate-probe", "title:new-session"], [], [], []])

      // The model requests: one for each Google API request, in order, each the same request once the ledger's
      // differences are undone, also the model's own text and the generation config.
      const [googleMains, engineMains] = [mains(googleHost).map(parsed), mains(harness.fake).map(parsed)]
      expect(engineMains).toHaveLength(googleMains.length)
      for (const [index, ours] of googleMains.entries()) expect(asGoogleRequest(engineMains[index]!, ours)).toEqual(ours)

      // Every difference that changes a request is stated on the record of the request that it changed, and nothing
      // else is. Ledger `oneCallPerRequest`: the second request settles on the call that agy revealed without a step,
      // so it sent no model request and states no addition. The append is the system prompt alone.
      const step = { appendBytes: Buffer.byteLength(systemText(googleMains[0]!)), opensAt: 0 }
      const first = ["primerAndTitle", "append", "engineTools", "schemaRewrites", "promptWrapper", "generationConfig"] as const
      expect(statedAdditions(engine.sent)).toEqual([
        ledgerAdditions(step, ...first),
        [],
        ledgerAdditions(step, ...first, "resultTimestamps"),
        ledgerAdditions(step, ...first, "resultTimestamps"),
      ])
    })
  }, TIMEOUT_MS)

  test("continue a conversation that the Google API route started, with its results in the append, and refuse a call of a tree's tool outside the agent's grant", async () => {
    const googleHost = openFakeGemini()
    googleHost.script(script(googleCall).slice(0, 1))
    const started: ConversationMessage[] = [user("HISTORY-MARKER echo a and b")]
    try {
      const answer = await send(await googleApi(googleHost), { messages: started, tools: [ECHO], systemPrompt: SYSTEM }, "google_api")
      started.push(answer.assistant, ...answer.calls.map((call) => result(call.id, `RESULT ${String(call.input.text)}`)))
    } finally {
      await googleHost.close()
    }

    await withEngine(async ({ harness, rig, login, root }) => {
      // A sibling of the tree holds `read` as well; the agent's own grant is `echo`.
      const sibling = await rig.agent({ login, tree: "tree", session: "sibling", projectRoot: root })
      await send(sibling.client, { messages: [user("sibling")], tools: [ECHO, READ], systemPrompt: SYSTEM })
      const agent = await rig.agent({ login, tree: "tree", session: "agent", projectRoot: root })
      // The model calls the sibling's `read`, which the engine declares to every agent of the tree.
      harness.fake.script([{ kind: "calls", calls: [{ name: "mcp_runtime_read", args: { path: "secret.txt", toolSummary: "read" } }] }, { kind: "text", text: "TWO DONE" }])
      const runs = new Map<string, number>()
      // Flywheel's dispatch answers each call of the agent against the agent's own tools, as the agent loop does.
      const agentTools = runtimeTools([ECHO], runs)
      runtimeTools([ECHO, READ], runs)
      const dispatch = async (call: CallBlock): Promise<ToolResultMessage> => {
        const prepared = prepareToolCall({ id: call.id, name: call.name, input: call.input }, agentTools, () => ({ ok: true }))
        const dispatched = await executePreparedTool(prepared, makeContext())
        expect(typeof dispatched.content).toBe("string")
        return { kind: "toolResult", toolUseId: call.id, content: [{ type: "text", text: String(dispatched.content) }], ...dispatched.outcome === "ok" ? {} : { isError: true } }
      }
      const mark = harness.fake.requests.length
      const { history, sent } = await converse(agent.client, "google_antigravity", { history: [...started], words: [], answer: dispatch })
      const refusal = history.find((message): message is ToolResultMessage => message.kind === "toolResult" && !started.includes(message))
      expect(refusal?.isError).toBe(true)
      const refusalText = (refusal?.content ?? []).map((part) => part.type === "text" ? part.text : "").join("")
      expect(refusalText).toStartWith("Unknown tool 'read'")
      expect(items(history)).toEqual([
        ...items(started),
        { kind: "call", name: "read", input: { path: "secret.txt" }, call: 2 },
        { kind: "result", call: 2, text: refusalText, isError: true },
        { kind: "answer", text: "TWO DONE" },
      ])
      // No tool body ran: the refusal is Flywheel's dispatch's own.
      expect([...runs]).toEqual([])
      expect(rig.launched.filter(({ place }) => place.treeRootSessionId === "tree")).toHaveLength(1)

      const [rotation, delivery] = harness.fake.requests.slice(mark).filter((request) => request.kind === "main").map(parsed)
      expect(delivery).toBeDefined()
      // Ledger `append`, `continuationPrompt`: the calls and results that the Google API route recorded are text.
      expect(["RESULT a", "RESULT b", "HISTORY-MARKER"].every((text) => systemText(rotation!).includes(text))).toBe(true)
      expect((rotation!.contents ?? []).flatMap((content) => content.parts).filter((part) => part.functionCall !== undefined || part.functionResponse !== undefined)).toEqual([])
      expect((rotation!.contents ?? []).map((content) => content.parts.map((part) => unwrapped(part.text ?? "")))).toEqual([[PRIMER_TEXT], [CONTINUATION_PROMPT]])
      // Ledger `sharedTools`: the model sees the tree's `read` too.
      expect(flywheelDeclarations(rotation!).map((declaration) => declaration.name).toSorted()).toEqual(["echo", "read"])
      // The refusal went back to the call that agy waited on, and on to the model as the call's failed result, as the
      // Google API route sends a failed result.
      const responses = (delivery!.contents ?? []).flatMap((content) => content.parts.flatMap((part) => part.functionResponse === undefined ? [] : [unwrappedPart(part, content.role).functionResponse!]))
      expect(responses).toEqual([{ name: "read", response: { error: refusalText } }])

      const step = { appendBytes: Buffer.byteLength(systemText(rotation!).slice(AGENT_FRAME.length)), opensAt: started.length }
      const stated = ["primerAndTitle", "append", "continuationPrompt", "engineTools", "schemaRewrites", "promptWrapper", "generationConfig", "sharedTools"] as const
      expect(statedAdditions(sent)).toEqual([ledgerAdditions(step, ...stated), ledgerAdditions(step, ...stated, "errorPrefix")])
    })
  }, TIMEOUT_MS)
})

/** Runtime tools for `defs` whose bodies count their runs in `runs`, by name. */
function runtimeTools(defs: readonly ToolDef[], runs: Map<string, number>): ReadonlyMap<string, RuntimeTool> {
  return new Map(defs.map((def): [string, RuntimeTool] => [def.name, {
    name: def.name, action: "file_read", description: def.description, inputSchema: def.input_schema, isConcurrencySafe: true,
    execute: async () => {
      runs.set(def.name, (runs.get(def.name) ?? 0) + 1)
      return { content: `RAN ${def.name}`, outcome: "ok" }
    },
  }]))
}
