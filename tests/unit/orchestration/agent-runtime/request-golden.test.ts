import { describe, expect, spyOn, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import Anthropic from "@anthropic-ai/sdk"
import { Effect, Exit, Redacted, Scope } from "effect"
import { z } from "zod"
import { providerModelInfo } from "../../../../src/infra/providers/llm/catalog/provider-model-info.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/loop/agent-loop.js"
import { createAnthropicAdapter, operationsFromAnthropicClient, type AnthropicOperations } from "../../../../src/orchestration/agent-runtime/llm/adapters/anthropic/anthropic.js"
import type { AccessProviderBuild } from "../../../../src/orchestration/agent-runtime/llm/routing/client-factory.js"
import type { SystemOriginMessage, ToolPresentation } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ConversationMessage } from "../../../../src/infra/providers/llm/conversation/conversation-message.js"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/session/control/background-work/background-work.js"
import * as systemPromptModule from "../../../../src/orchestration/agent-runtime/request/prompt/system-prompt.js"
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { composeFirstPartyModules, composeRealmModuleSnapshot } from "../../../../src/orchestration/module-contract/module-composition.js"
import type { FirstPartyModule } from "../../../../src/orchestration/module-contract/module-catalog.js"
import { cliView, orderedJson } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-view.js"
import { createClaudeAgentSdkClient } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/client.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"
import { fixedDefinitions } from "../../../helpers/project-definitions.js"
import { asModelClient } from "./_model-client.js"
import { assembledRuntime } from "./_runtime-assembly-harness.js"
import { fakeAvailability } from "./llm/_provider-chain-harness.js"
import { wireResponse } from "./llm/_wire-fixtures.js"

/** One JSON object of the wire: a stream frame or a request body. */
interface WireJson { readonly [key: string]: unknown }
const WireJsonSchema = z.record(z.string(), z.unknown())

/**
 * The provider request bodies of one fixed three-hop tool turn, recorded before request preparation held its
 * surfaces across hops. Provider prompt caching depends on byte-stable prefixes, so every request of an unchanged hop
 * must keep these bytes. Run with `FLYWHEEL_UPDATE_GOLDEN=1` to record them again after an intended prompt change.
 */
const GOLDEN = join(import.meta.dir, "golden", "three-hop-requests.json")
const MODEL = "claude-sonnet-5-5"
const PROJECT_ROOT = "/scratch/project"
const MODULE_IDS = ["file-tools", "skills", "subagents", "workflows", "experiments"]

/** The model's answers: `toolHops` calls of `tool`, then a text answer that ends the turn. By default two reads whose
 *  input names no path, so each settles to the same validation failure on every host without touching the file
 *  system. */
function hopFrames(hop: number, toolHops = 2, tool = "read"): WireJson[] {
  const start = { type: "message_start", message: { id: `msg_${hop}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }
  const end = (reason: string) => [{ type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }]
  if (hop > toolHops) return [
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
    { type: "content_block_stop", index: 0 },
    ...end("end_turn"),
  ]
  return [
    start,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${hop}`, name: tool, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"record":"${hop}"}` } },
    { type: "content_block_stop", index: 0 },
    ...end("tool_use"),
  ]
}

/** A real Anthropic SDK client over a scripted transport that answers each request with the next hop's frames. */
function scriptedOperations(onBody: (body: WireJson) => void, frames: (hop: number) => WireJson[] = hopFrames): AnthropicOperations {
  let hop = 0
  return operationsFromAnthropicClient(new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (input, init) => {
      onBody(WireJsonSchema.parse(await new Request(input, init).json()))
      hop += 1
      return wireResponse(frames(hop))
    },
  }))
}

/** The tool presentation of the Claude engine route, read from a staged client: staging starts no engine. */
async function claudeEnginePresentation(): Promise<ToolPresentation> {
  const candidate = { kind: "subscription", providerId: "claude_agent_sdk", instanceId: "login", spendMode: "included" } as const
  const metadata = providerModelInfo({ provider: "anthropic", id: MODEL, contextLimit: 200_000, outputLimit: 64_000, reasoning: false })
  const lifetime = Effect.runSync(Scope.make())
  const build: AccessProviderBuild = {
    notify: () => {},
    candidate, providerIdentity: { name: "Anthropic Sub", credential: "oauth" },
    model: metadata.id, wireModelId: metadata.id, family: "anthropic",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "connection", authDir: "/scratch/auth", oauthPersistence: "memory-only",
      auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map([[candidate.providerId, [{ instanceId: candidate.instanceId, identity: "person@example.com", lineageId: candidate.instanceId, credential: { type: "external", configDir: "/scratch/claude-config" } }]]]),
    },
    classifySlot: () => "subscription", availability: fakeAvailability({}).availability, projectRoot: PROJECT_ROOT,
    attribution: { candidate, wireModelId: metadata.id, dataUse: "standard", resolvedModelMetadata: metadata },
    recordModelRefusal: () => {},
    providerSessionLifetime: { providerSessionKey: "conversation", scope: lifetime },
  }
  try {
    const staged = await (await createClaudeAgentSdkClient(build)).stage({ attribution: build.attribution, accountOfferings: [] })
    return staged.attempt.toolPresentation
  } finally {
    await Effect.runPromise(Scope.close(lifetime, Exit.void))
  }
}

const ROUTE_REMINDER = "<system-reminder>Route reminder.</system-reminder>"

/** A provider append that the route writes once, before its first request, as a route's opening reminders do. */
function appendOnce(messages: readonly ConversationMessage[]): SystemOriginMessage[] {
  return messages.some((message) => message.kind === "user" && message.content === ROUTE_REMINDER) ? [] : [{ kind: "user", content: ROUTE_REMINDER, origin: "system" }]
}

/** Runs the three-hop turn through runtime assembly and the agent loop on an Anthropic adapter whose transport
 *  `operations` builds, and returns what `record` collected from each request. */
async function threeHopTurn(route: "anthropic" | "claude-engine"): Promise<unknown[]> {
  const recorded: unknown[] = []
  const metadata = providerModelInfo({ provider: "anthropic", id: MODEL, contextLimit: 200_000, outputLimit: 64_000, reasoning: false })
  const transport = scriptedOperations((body) => { if (route === "anthropic") recorded.push(body) })
  const operations: AnthropicOperations = route === "anthropic" ? transport : {
    ...transport,
    createStream: async (params, options) => {
      recorded.push(JSON.parse(orderedJson(cliView(params, options.origins, PROJECT_ROOT))))
      return transport.createStream(params, options)
    },
  }
  const presentation = route === "claude-engine" ? await claudeEnginePresentation() : undefined
  const adapter = await createAnthropicAdapter(Redacted.make("test-key"), MODEL, metadata, {
    operations,
    ...(presentation === undefined ? {} : { toolPresentation: presentation, accessProvider: "claude_agent_sdk" as const }),
  })
  const client = asModelClient({ ...adapter, messagesToAppend: appendOnce })
  const modules = composeRealmModuleSnapshot({ moduleIds: MODULE_IDS })
  const assembled = await assembledRuntime("headless", {
    model: MODEL, engineeringDoctrine: false, moduleSelection: () => modules,
  }, fixedDefinitions(), client)
  const terminal = await runAgentLoop({ ...assembled, instruction: "Read records 1 and 2." })
  expect(terminal).toEqual({ kind: "completed" })
  return recorded
}

describe("provider request bytes of a three-hop tool turn", () => {
  test("equal the golden bodies on the Anthropic adapter and the Claude engine route", async () => {
    const actual = { anthropic: await threeHopTurn("anthropic"), claudeEngine: await threeHopTurn("claude-engine") }
    expect(actual.anthropic).toHaveLength(3)
    expect(actual.claudeEngine).toHaveLength(3)
    if (process.env.FLYWHEEL_UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`)
    const golden = z.object({ anthropic: z.array(z.unknown()), claudeEngine: z.array(z.unknown()) }).parse(JSON.parse(readFileSync(GOLDEN, "utf8")))
    expect(actual).toEqual(golden)
  })
})

const RequestBody = z.object({
  system: z.array(z.object({ text: z.string() })),
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
})

describe("held request preparation", () => {
  test("equal hops build the prompt once, materialize a schema once, and append route messages once, and a changed input reaches the next request", async () => {
    // Each live input the prompt or the tool list reads: a tool's prompt fields, a module's prompt fragment, and the
    // background work that decides whether the process tool is advertised.
    let description = "Probe a record."
    let fragment = "Probe fragment one."
    let fragmentRenders = 0
    let schemaSerializations = 0
    const probeSchema = { type: "object", properties: {}, examples: { toJSON: () => { schemaSerializations += 1; return [{}] } } }
    const probe = (): RuntimeTool => ({
      name: "probe", action: "file_read", description, inputSchema: probeSchema, isConcurrencySafe: true,
      execute: async () => ({ content: "probed", outcome: "ok" }),
    })
    const module: FirstPartyModule = {
      id: "development", dependencies: [],
      contributions: [
        { domain: "tools", id: "probe", value: { kind: "tool", name: "probe", declaration: {
          category: "core", action: "file_read", cloneInheritance: "inherit", learningReviewExecutable: false,
          semanticBundle: null, personaBaseline: false, registryOrder: 80,
          registrations: { probe: { capabilities: [], create: () => ({ tool: probe() }) } },
        } } },
        { domain: "promptFragments", id: "probe-fragment", value: { order: 9, render: () => { fragmentRenders += 1; return fragment } } },
      ],
    }
    const modules = composeFirstPartyModules([module])
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    let activeTasks = 0
    const activeTaskCount = spyOn(tasks, "activeTaskCount").mockImplementation(() => activeTasks)
    const builds = spyOn(systemPromptModule, "buildSystemPromptParts")
    const bodies: z.infer<typeof RequestBody>[] = []
    const transport = scriptedOperations((body) => {
      bodies.push(RequestBody.parse(body))
      if (bodies.length === 3) {
        description = "Probe a record, changed."
        fragment = "Probe fragment two."
        activeTasks = 1
      }
    }, (hop) => hopFrames(hop, 3, "probe"))
    const metadata = providerModelInfo({ provider: "anthropic", id: MODEL, contextLimit: 200_000, outputLimit: 64_000, reasoning: false })
    try {
      let routeAppendReads = 0
      const adapter = await createAnthropicAdapter(Redacted.make("test-key"), MODEL, metadata, { operations: transport })
      const client = asModelClient({ ...adapter, messagesToAppend: () => { routeAppendReads += 1; return [] } })
      const assembled = await assembledRuntime("chat", {
        model: MODEL, engineeringDoctrine: false, moduleSelection: () => modules,
        runtimeSurfaces: { launcher: refusingLauncher, background: createBackgroundExecutionOwner(tasks) },
      }, fixedDefinitions(), client)
      expect(await runAgentLoop({ ...assembled, instruction: "Probe three records." })).toEqual({ kind: "completed" })

      expect(bodies).toHaveLength(4)
      const [first, second, third, changed] = bodies
      expect(second?.system).toEqual(first?.system ?? [])
      expect(third?.system).toEqual(first?.system ?? [])
      expect(third?.tools).toEqual(first?.tools ?? [])
      expect(first?.tools.map((tool) => tool.name)).not.toContain("process")
      expect(first?.system.map((block) => block.text).join("")).toContain("Probe fragment one.")

      expect(changed?.tools.find((tool) => tool.name === "probe")?.description).toBe("Probe a record, changed.")
      expect(changed?.tools.map((tool) => tool.name)).toContain("process")
      expect(changed?.system.map((block) => block.text).join("")).toContain("Probe fragment two.")

      // The first three requests share one build; the changed request builds once more. Every request renders the
      // fragments, and the probe's schema object is materialized once for all four.
      expect(builds).toHaveBeenCalledTimes(2)
      expect(fragmentRenders).toBe(4)
      expect(schemaSerializations).toBe(1)
      // The route's messages are appended once per request: the walk's first candidate is the attempt that the
      // request's cycle already appended for.
      expect(routeAppendReads).toBe(4)
    } finally {
      builds.mockRestore()
      activeTaskCount.mockRestore()
    }
  })
})
