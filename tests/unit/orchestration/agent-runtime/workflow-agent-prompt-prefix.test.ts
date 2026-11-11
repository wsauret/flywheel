import { describe, expect, test } from "bun:test"
import { testProviderSessionLifetime } from "../../../helpers/provider-authority.js";
import { join } from "node:path"
import { prepareAnthropicRequest } from "../../../../src/orchestration/agent-runtime/llm/anthropic.js"
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import type { RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import type { HandoffToolSchema } from "../../../../src/orchestration/workflow-host/handoff-tool-schema.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { asModelClient, ownHistoryTarget } from "./_model-client.js"
import { checkpointTestPersistences } from "../../../helpers/checkpoint-store.js"
import { providerModelInfo } from "../../../../src/infra/llm/provider-model-info.js"

const temporaryDirectory = temporaryDirectories()
const checkpointTestPersistence = checkpointTestPersistences()

const servingAttempt = { historyTarget: ownHistoryTarget,
  accessProvider: "anthropic_api",
  modelFamily: "anthropic",
  model: "claude-test",
  toolPresentation: FUNCTION_TOOL_PRESENTATION,
  contextLimit: 200_000,
  outputLimit: 8_000,
  supportsReasoning: false,
  promptNotes: { progress: "", modelNotes: "" },
  priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
    yield { kind: "done", stopReason: "end_turn" }
  },
} satisfies LLMClient

/** The Anthropic request that one branch of a map sends first: the runtime
 *  assembles the step's prompt and tools exactly as the workflow host asks it
 *  to, and the adapter lowers them with prompt caching on. */
async function siblingRequest(sessionDir: string, attemptId: string, conversationId: string, item: string, step: { readonly handoff?: HandoffToolSchema; readonly inheritedIntent?: string; readonly kind?: "workflow-agent" | "subagent" } = {}) {
  const sessionId = `session-${attemptId}`
  const options: RunnableAgentOptions = {
    ...checkpointTestPersistence({ kind: "session", sessionId }),
    model: "claude-test",
    ...testDirectories(process.cwd()),
    sessionDir,
    purpose: {
      ...(step.kind === "subagent"
        ? { kind: "subagent", renderAs: "subagent", parentToolUseId: `dispatch-${attemptId}` } as const
        : { kind: "workflow-agent", briefScope: { briefId: "review" }, workflowAttemptId: attemptId } as const),
      ...(step.inheritedIntent === undefined ? {} : { inheritedIntent: step.inheritedIntent }),
    },
    agentsMd: "",
    onEvent: () => {},
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    runtimeSurfaces: { handoff: { onContent: () => {}, ...(step.handoff ? { schema: step.handoff } : {}) }, recall: async () => ({ hits: [] }) },
    conversation: { kind: "durable-tree", reserveMessageId: async () => crypto.randomUUID(), sessionId, conversationId, priorMessages: [], append: () => {}, captureCommittedForkMessages: async () => [], resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }) },
    lifecycle: { kind: "one-shot" },
  }
  const signal = new AbortController().signal
  const assembled = await assembleRuntimeForTurn({
    providerSessionLifetime: testProviderSessionLifetime(),
    options,
    definitions: repoDefinitions(),
    conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: conversationId, artifactScopeId: sessionId, retrievalSessionId: sessionId }),
    signal,
    disposalSignal: signal,
    instruction: null,
    currentTurn: undefined,
    personas: new Map(),
    captureModelRuntime: async () => ({ generation: {}, createLLMClient: async () => asModelClient(servingAttempt) }),
    createRunner: () => { throw new Error("unused in this test") },
  })
  if (!("resolve" in assembled.tools)) throw new Error("expected request tool surface owner")
  const surface = await assembled.tools.resolve()
  const build = assembled.systemPrompt
  if (typeof build !== "function") throw new Error("expected a per-attempt system prompt")
  await surface.prepareStablePrompt(() => build(servingAttempt, DEFAULT_MODEL_INTERACTION_PROFILE), DEFAULT_MODEL_INTERACTION_PROFILE)
  const prepared = surface.prepareAttempt(servingAttempt)
  return {
    tools: [...surface.tools.keys()],
    request: prepareAnthropicRequest({
      accessProvider: "anthropic_api", model: "claude-test", wireModel: "claude-test", info: providerModelInfo({ provider: "anthropic", id: "claude-test" }),
      options: { messages: [{ kind: "user", content: `## For Item Context\n\n${item}` }], tools: prepared.tools, systemPrompt: prepared.systemPrompt, cacheRetention: "1h" },
    }),
  }
}

/** The bytes a provider caches up to a system block that ends a cache
 *  breakpoint: every tool, then every system block up to the last marked one,
 *  or up to the one before it with `beforeLast`. */
function sharedPrefix(request: Awaited<ReturnType<typeof siblingRequest>>["request"], beforeLast = false): string {
  const system = request.params.system
  if (!Array.isArray(system)) throw new Error("expected system blocks")
  const marked = system.flatMap((block, index) => block.cache_control === undefined ? [] : [index])
  return JSON.stringify([request.params.tools, system.slice(0, (marked.at(beforeLast ? -2 : -1) ?? -1) + 1)])
}

// Agents of a workflow share their session tier, so two branches of one map
// share every cached byte. A subagent's session tier also holds its own
// scratchpad, so sibling subagents share every byte before it, and the
// inherited intent in that tier changes none of them.
describe("sibling agents with inherited intent", () => {
  test.each(["workflow-agent", "subagent"] as const)("two %s siblings send the same bytes up to their last shared cache breakpoint", async (kind) => {
    const root = temporaryDirectory("flywheel-sibling-prefix-")
    const firstDir = join(root, "agent-a")
    const secondDir = join(root, "agent-b")
    const inheritedIntent = "# Inherited design intent\n\n# Design intent (approved)\n\nKeep the user's exact intent.\n\n# Decisions\n\nDo not share working notes."
    const first = await siblingRequest(firstDir, "attempt-1", "conversation-a", "src/a.ts", { inheritedIntent, kind })
    const second = await siblingRequest(secondDir, "attempt-2", "conversation-b", "src/b.ts", { inheritedIntent, kind })
    expect(first.tools).toContain("checkpoint_replace")

    const subagent = kind === "subagent"
    expect(sharedPrefix(second.request, subagent)).toBe(sharedPrefix(first.request, subagent))
    expect(sharedPrefix(first.request)).toContain(JSON.stringify(inheritedIntent).slice(1, -1))
    if (subagent) expect(sharedPrefix(first.request, true)).not.toContain("Keep the user's exact intent.")
    expect(JSON.stringify(first.request.params.messages)).not.toContain("Keep the user's exact intent.")
    expect(JSON.stringify(first.request.params).split("Keep the user's exact intent.")).toHaveLength(2)
    const scratch = (directory: string) => JSON.stringify(join(directory, "scratch")).slice(1, -1)
    expect(JSON.stringify(first.request.params.system)).toContain(scratch(firstDir))
    expect(JSON.stringify(second.request.params.system)).toContain(scratch(secondDir))
    expect(sharedPrefix(first.request, subagent)).not.toContain(scratch(firstDir))
  })
})

describe("steps of different phases", () => {
  // Every step gets the same tools, the handoff tool shows one generic
  // schema, and a step's task is its opening turn, not part of the system
  // prompt, so a review step and an implementation step of one workflow share
  // every cached byte up to the session breakpoint (ARCH-CONTEXT-018).
  test("send the same bytes up to the last shared cache breakpoint", async () => {
    const sessionDir = temporaryDirectory("flywheel-phase-prefix-")
    const contract: HandoffToolSchema = { input: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false } }
    const review = await siblingRequest(sessionDir, "attempt-1", "conversation-a", "src/a.ts", { handoff: contract })
    const implement = await siblingRequest(sessionDir, "attempt-2", "conversation-b", "src/a.ts")

    expect(review.tools).toContain("skill")
    expect(sharedPrefix(review.request)).toBe(sharedPrefix(implement.request))
  })
})
