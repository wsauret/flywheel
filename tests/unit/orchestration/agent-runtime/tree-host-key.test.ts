import { describe, expect, it } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Effect, Exit, Scope } from "effect"
import { providerModelInfo } from "../../../../src/infra/llm/provider-model-info.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import type { AccessProviderBuild } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import type { ProviderSessionLifetime } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import { holdSharedTree } from "../../../../src/orchestration/agent-runtime/shared-tree.js"
import type { AgentOptions, RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { HOST_SPLIT_EXCEPTIONS, hostKey, hostPlaceDifference, type HostPlace, type HostRegistry } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js"
import { createClaudeAgentSdkClient } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/client.js"
import { SUBAGENT_HANDOFF_SCHEMA } from "../../../../src/orchestration/modules/subagents/execution/prompts.js"
import { unusedSessionMessaging } from "../../../helpers/child-session-control.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { asModelClient } from "./_model-client.js"
import { fakeAvailability } from "./llm/_provider-chain-harness.js"

/*
 * The guard of the one shared engine agent host of a chat tree. Every Claude call of one tree, other than the
 * chat's own engine, must send the same host place, so that one engine process serves them all. Each kind of
 * agent and side call here runs its first request through the production path: runtime assembly, the agent loop, the
 * Claude Agent SDK client, and the hosted agent's placement, which leases the host. When this test fails, a value of
 * the place differs for one kind, and that kind starts another engine process. Make the value the same. Add the
 * field to HOST_SPLIT_EXCEPTIONS only when the difference is absolutely necessary.
 */

const directory = temporaryDirectories()
const ROOT = "tree-root"
const MODULES = composeFirstPartyModules()
const CONFIG_DIR = "/scratch/claude-config"

/** The facts of each Claude model that this test runs on. Each adaptive model allows the hosted max_tokens. */
const MODELS = new Map<string, ReturnType<typeof providerModelInfo>>(([
  ["claude-sonnet-5-5", 1_000_000, 128_000],
  ["claude-opus-5-5", 1_000_000, 128_000],
  ["claude-haiku-5-5", 200_000, 64_000],
  ["claude-sonnet-4-5", 200_000, 64_000],
] as const).map(([id, contextLimit, outputLimit]) => [id, providerModelInfo({
  provider: "anthropic", id, contextLimit, outputLimit, reasoning: true, reasoningEfforts: ["low", "medium", "high"],
})]))

/** A host registry that records the place of each lease and then fails the request, so that no engine starts. */
function recordingHosts(places: HostPlace[]): HostRegistry {
  return {
    lease: (place) => {
      places.push(place)
      throw new Error("the test reads the host place only")
    },
    drain: async () => {},
  }
}

interface Login {
  readonly configDir?: string
  readonly spendMode?: "included" | "automatic"
}

/** The Claude Agent SDK client of `model` for one runner, as the client factory builds it for a runner whose
 *  provider lifetime is `lifetime`. */
async function claudeClient(model: string, lifetime: ProviderSessionLifetime, places: HostPlace[], login: Login) {
  const info = MODELS.get(model)
  if (info === undefined) throw new Error(`no facts for ${model}`)
  const candidate = { kind: "subscription", providerId: "claude_agent_sdk", instanceId: "login", spendMode: login.spendMode ?? "included" } as const
  const build: AccessProviderBuild = {
    notify: () => {},
    candidate, providerIdentity: { name: "Anthropic Sub", credential: "oauth" },
    model, wireModelId: model, family: "anthropic",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "connection", authDir: "/scratch/auth", oauthPersistence: "memory-only",
      auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map([[candidate.providerId, [{ instanceId: candidate.instanceId, identity: "person@example.com", lineageId: candidate.instanceId, credential: { type: "external", configDir: login.configDir ?? CONFIG_DIR } }]]]),
    },
    classifySlot: () => "subscription", availability: fakeAvailability({}).availability, projectRoot: process.cwd(),
    attribution: { candidate, wireModelId: model, dataUse: "standard", resolvedModelMetadata: info },
    recordModelRefusal: () => {},
    accountOfferings: () => [],
    launcher: {
      spawnOwned: () => Promise.reject(new Error("no launch in a unit test")),
      adoptOwned: () => Promise.reject(new Error("no adoption in a unit test")),
      open() { return this },
      close: async () => ({ settled: true }),
    },
    providerSessionLifetime: lifetime,
  }
  const staged = await createClaudeAgentSdkClient(build, {
    enginePath: "/scratch/bin/claude",
    createLauncher: () => () => { throw new Error("a tree-hosted runner starts no engine of its own") },
    createHostLauncher: () => () => { throw new Error("the recording registry opens no host") },
    agentHosts: recordingHosts(places),
  })
  const connected = await staged.connect()
  return asModelClient({ ...staged.attempt, streamWithTools: (options) => connected.streamWithTools(options) })
}

/** The production inputs of one kind of runner of the tree. */
interface Kind {
  readonly purpose: AgentOptions["purpose"]
  readonly model: string
  readonly effort: string
  /** The session identity that names the tree, for an agent with a session of its own; else the side call names it. */
  readonly ownSession?: boolean
  readonly options?: (surfaces: { readonly background: ReturnType<typeof createBackgroundExecutionOwner> }) => Partial<RunnableAgentOptions>
  readonly conversation: "durable" | "replay" | "context-only" | "ephemeral" | "stateless"
}

const SUBAGENT_GRANT = ["read", "search", "list", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]
const GENERAL_GRANT = ["bash", "edit", "list", "read", "search", "write", "web", "skill", "subagent", "process", "handoff", "checkpoint_read", "checkpoint_replace", "checkpoint_decide"]

const childOf = (renderAs: "chat" | "workflow-agent" | "subagent", toolGrant: readonly string[]): Kind["options"] => ({ background }) => ({
  toolGrant, maxLLMCalls: 30,
  runtimeSurfaces: { background, handoff: { onContent: () => {}, schema: SUBAGENT_HANDOFF_SCHEMA } },
  ...(renderAs === "subagent" ? { readOnly: true } : {}),
})

/** Every kind of Claude call of one chat tree that its shared host serves, each on its own model and effort. */
const KINDS = new Map<string, Kind>(Object.entries({
  "persona subagent": { purpose: { kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" }, model: "claude-haiku-5-5", effort: "low", ownSession: true, conversation: "durable", options: childOf("subagent", SUBAGENT_GRANT) },
  "general subagent": { purpose: { kind: "subagent", renderAs: "chat", parentToolUseId: "call-2" }, model: "claude-opus-5-5", effort: "high", ownSession: true, conversation: "durable", options: childOf("chat", GENERAL_GRANT) },
  "depth-3 subagent": { purpose: { kind: "subagent", renderAs: "chat", parentToolUseId: "call-3" }, model: "claude-sonnet-5-5", effort: "medium", ownSession: true, conversation: "durable", options: childOf("chat", GENERAL_GRANT.filter((name) => name !== "subagent" && name !== "process")) },
  "workflow agent": {
    purpose: { kind: "workflow-agent", briefScope: { briefId: "implement" }, workflowAttemptId: "attempt" }, model: "claude-opus-5-5", effort: "medium", ownSession: true, conversation: "durable",
    // A workflow's admission can leave out a module that the chat holds.
    options: () => ({ moduleSelection: () => composeFirstPartyModules(undefined, ["papercuts"]), runtimeSurfaces: { handoff: { onContent: () => {}, schema: { input: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } } } } }),
  },
  "workflow agent's subagent": { purpose: { kind: "subagent", renderAs: "workflow-agent", parentToolUseId: "call-4" }, model: "claude-sonnet-5-5", effort: "low", ownSession: true, conversation: "durable", options: childOf("workflow-agent", GENERAL_GRANT) },
  "chat title": { purpose: { kind: "session-title" }, model: "claude-haiku-5-5", effort: "low", conversation: "stateless", options: () => ({ memorySnapshot: null }) },
  "workflow title": { purpose: { kind: "session-title" }, model: "claude-sonnet-5-5", effort: "medium", conversation: "stateless", options: () => ({ memorySnapshot: null }) },
  "chat learning review": { purpose: { kind: "chat-learning-review", review: { reviewRunId: "chat-review" } }, model: "claude-sonnet-5-5", effort: "high", conversation: "replay", options: ({ background }) => ({ runtimeSurfaces: { background }, maxLLMCalls: 8 }) },
  "workflow learning review": { purpose: { kind: "workflow-learning-review", review: { reviewRunId: "workflow-review" } }, model: "claude-opus-5-5", effort: "low", conversation: "replay" },
  "learning-review audit": { purpose: { kind: "learning-review-audit", prompt: { kind: "literal", systemPrompt: "Audit the candidate." } }, model: "claude-haiku-5-5", effort: "medium", conversation: "ephemeral", options: () => ({ maxLLMCalls: 1 }) },
  "failure summary": { purpose: { kind: "subagent-failure-summary", prompt: { kind: "literal", systemPrompt: "Summarize the work." } }, model: "claude-haiku-5-5", effort: "high", conversation: "replay", options: () => ({ maxLLMCalls: 1 }) },
  "side question": { purpose: { kind: "chat-side-call" }, model: "claude-opus-5-5", effort: "high", conversation: "context-only" },
} satisfies { readonly [name: string]: Kind }))

function conversationOf(kind: Kind["conversation"], sessionId: string): AgentOptions["conversation"] {
  const task = { kind: "user", content: "Do the task.", origin: "system" } as const
  switch (kind) {
    case "durable": return {
      kind: "durable-tree", sessionId, conversationId: sessionId, priorMessages: [task],
      reserveMessageId: async () => crypto.randomUUID(), captureCommittedForkMessages: async () => [], resolveLeafId: async () => null,
      append: () => {}, committedTree: async () => ({ leafId: null, entriesById: {} }),
    }
    case "replay": return { kind: "replay", providerSessionKey: sessionId, priorMessages: [task] }
    case "context-only": return { kind: "replay", providerSessionKey: sessionId, historyProjection: "context-only", priorMessages: [task] }
    case "ephemeral": return { kind: "ephemeral", append: () => {} }
    case "stateless": return { kind: "stateless" }
  }
}

interface Variation {
  readonly login?: Login
  readonly executionCwd?: string
  readonly model?: string
  readonly providerOptions?: AgentOptions["providerOptions"]
}

/** The host place that the first request of `name` leases, in `cwd`. */
async function hostPlace(name: string, cwd: string, variation: Variation = {}): Promise<HostPlace> {
  const kind = KINDS.get(name)
  if (kind === undefined) throw new Error(`no kind ${name}`)
  const sessionId = `session-${name.replaceAll(/\W/gu, "-")}`
  const places: HostPlace[] = []
  const scope = await Effect.runPromise(Scope.make())
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
  const extra = kind.options?.({ background }) ?? {}
  const options: RunnableAgentOptions = {
    ...testDirectories(process.cwd()),
    executionCwd: variation.executionCwd ?? cwd,
    model: variation.model ?? kind.model,
    effort: kind.effort,
    purpose: kind.purpose,
    agentsMd: "",
    onEvent: () => {},
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    captureProviderConnection: async () => { throw new Error("unused in this test") },
    moduleSelection: () => MODULES,
    conversation: conversationOf(kind.conversation, sessionId),
    lifecycle: { kind: "one-shot" },
    ...(variation.providerOptions === undefined ? {} : { providerOptions: variation.providerOptions }),
    ...extra,
    runtimeSurfaces: {
      ...extra.runtimeSurfaces,
      ...(kind.ownSession === true ? { sessions: { ...unusedSessionMessaging(), identity: async () => ({ sessionId, conversationId: sessionId, kind: "subagent" as const, rootSessionId: ROOT }) } } : {}),
    },
    ...(kind.ownSession === true ? {} : { treeRootSessionId: ROOT }),
  }
  const signal = new AbortController().signal
  try {
    const assembled = await assembleRuntimeForTurn({
      options,
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: sessionId, artifactScopeId: sessionId, retrievalSessionId: sessionId }),
      signal,
      disposalSignal: signal,
      instruction: null,
      currentTurn: undefined,
      personas: new Map(),
      captureModelRuntime: async () => ({ generation: {}, createLLMClient: async (model, _snapshot, _config, lifetime) => claudeClient(model, lifetime, places, variation.login ?? {}) }),
      createRunner: () => { throw new Error("unused in this test") },
      providerSessionLifetime: { providerSessionKey: sessionId, scope },
    })
    await runAgentLoop({ ...assembled, instruction: kind.conversation === "stateless" || kind.conversation === "ephemeral" ? "Do the task." : null }).catch(() => undefined)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await background.close()
  }
  const [place] = places
  if (place === undefined) throw new Error(`${name} leased no host`)
  return place
}

describe("the host key of a chat tree", () => {
  it("is one key for every kind of agent and side call of the tree, whatever its model, effort, and directory, and splits only on a listed exception", async () => {
    // The tree's host holds the tree's module capture while the tree's agents run.
    const { release } = holdSharedTree(ROOT, () => ({ modules: MODULES, shellWriteGuard: true, allowPersistentProcesses: false, disabledTypes: [] }))
    try {
      const cwd = directory("tree-host-")
      const reference = await hostPlace("persona subagent", cwd)
      // The place holds the request values that the path prepared, not an empty shape.
      expect(reference.values.tools.map(({ name }) => name)).toEqual(expect.arrayContaining(GENERAL_GRANT))
      expect(reference.values).toMatchObject({ thinking: { type: "adaptive" }, statesEffort: true })
      // The key decides which host serves an agent; the difference names why two keys differ.
      const sameHost = (place: HostPlace) => ({ key: hostKey(place) === hostKey(reference), differs: hostPlaceDifference(reference, place) })
      for (const name of KINDS.keys()) {
        expect({ name, ...sameHost(await hostPlace(name, cwd)) }).toEqual({ name, key: true, differs: [] })
      }
      // Two directories of one git status share the host: the agent's directory travels in its meta file.
      expect(sameHost(await hostPlace("persona subagent", directory("tree-host-other-")))).toEqual({ key: true, differs: [] })

      const repository = directory("tree-host-repository-")
      mkdirSync(join(repository, ".git"))
      const splits: readonly (readonly [string, Variation])[] = [
        ["another login", { login: { configDir: "/scratch/other-claude-config" } }],
        ["the paid spend mode", { login: { spendMode: "automatic" } }],
        ["a directory of another git status", { executionCwd: repository }],
        ["a role that sets thinking_display", { providerOptions: { anthropic: { thinking_display: "omitted" } } }],
        ["a role that sets extra_body", { providerOptions: { anthropic: { extra_body: { service_tier: "auto" } } } }],
        ["a model without adaptive thinking", { model: "claude-sonnet-4-5" }],
      ]
      for (const [why, variation] of splits) {
        const { key, differs } = sameHost(await hostPlace("persona subagent", cwd, variation))
        expect({ why, key, split: differs.length > 0, unlisted: differs.filter((field) => !HOST_SPLIT_EXCEPTIONS.has(field)) }).toEqual({ why, key: false, split: true, unlisted: [] })
      }
      // An empty object is a value of the key, so the difference names it.
      const emptyBodyField: HostPlace = { ...reference, values: { ...reference.values, extraBody: { ...reference.values.extraBody, context_management: {} } } }
      expect(sameHost(emptyBodyField)).toEqual({ key: false, differs: ["values.extraBody"] })

      // A difference outside the list, such as another tool list, is a defect that this guard names.
      const otherTools: HostPlace = { ...reference, values: { ...reference.values, tools: reference.values.tools.slice(1) } }
      expect(hostPlaceDifference(reference, otherTools)).toEqual(["values.tools"])
      expect(HOST_SPLIT_EXCEPTIONS.has("values.tools")).toBe(false)
    } finally {
      release()
    }
  })
})
