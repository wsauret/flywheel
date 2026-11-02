import { detectModelFamily } from "../../../../src/infra/llm/model-family.js"
import { testProviderSessionLifetime } from "../../../helpers/provider-authority.js";
import type { ProviderSessionLifetime, ProviderStreamEvent, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import type { PromptKind } from "../../../../src/orchestration/agent-runtime/system-prompt.js"
import type { AgentLoopOptions } from "../../../../src/orchestration/agent-runtime/agent-loop-types.js"
import type { AgentOptions, RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import type { RequestToolSurfaceOwner } from "../../../../src/orchestration/agent-runtime/request-tool-surface.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testDirectories } from "../../../helpers/directories.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { asModelClient } from "./_model-client.js"

/** The notice of an agent that may call no tool. */
export const CALL_NO_TOOLS = "## Tools\n\nCall no tools. Every tool call is refused; answer in text."

const testPersonas = new Map([["explorer", { kind: "persona", name: "explorer", description: "Explore", maxTurns: 1, systemPrompt: "Explore.", tools: [], role: "explorer" } as const]])

export function modelClient(model = "test", capture?: (options: StreamOptions) => void) {
  return asModelClient({
    accessProvider: "anthropic_api" as const,
    modelFamily: detectModelFamily(model) ?? "anthropic",
    model,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    async *streamWithTools(options): AsyncGenerator<ProviderStreamEvent> {
      capture?.(options)
      yield { kind: "done", stopReason: "end_turn" }
    },
  })
}

function purposeFor(promptKind: PromptKind): AgentOptions["purpose"] {
  switch (promptKind) {
    case "chat": return { kind: "interactive-chat" }
    case "workflow-agent": return { kind: "workflow-follow-up" }
    case "subagent": return { kind: "persona-benchmark" }
    case "headless": return { kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } }
  }
}

/** The loop options that runtime assembly builds for one turn of a runner of `promptKind`, with `override` applied
 *  to its options. `onLifetime` sees the provider lifetime that each client of the runner is built with. */
export async function assembledRuntime(
  promptKind: PromptKind,
  override: Partial<RunnableAgentOptions> = {},
  definitions = repoDefinitions(),
  runtimeClient?: ReturnType<typeof modelClient>,
  providerSessionLifetime?: ProviderSessionLifetime,
  onLifetime?: (lifetime: ProviderSessionLifetime | undefined) => void,
): Promise<AgentLoopOptions> {
  const modules = testCapabilityModules()
  const options: RunnableAgentOptions = {
    model: "test",
    ...testDirectories(process.cwd()),
    purpose: purposeFor(promptKind),
    agentsMd: "",
    onEvent: () => {},
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    captureProviderConnection: () => { throw new Error("unused in this test") },
    runtimeSurfaces: { launcher: refusingLauncher },
    moduleSelection: () => modules,
    conversation: { kind: "stateless" },
    lifecycle: { kind: "one-shot" },
    ...override,
  }
  const signal = new AbortController().signal
  return assembleRuntimeForTurn({
    options,
    definitions,
    conversation: resolveRuntimeConversation(options.conversation, {
      providerSessionKey: "conversation-1",
      artifactScopeId: "artifacts-1",
      retrievalSessionId: "retrieval-1",
    }),
    signal,
    disposalSignal: signal,
    instruction: null,
    currentTurn: undefined,
    personas: testPersonas,
    captureModelRuntime: async () => ({ generation: {}, createLLMClient: async (model, _snapshot, _config, lifetime) => { onLifetime?.(lifetime); return runtimeClient ?? modelClient(model) } }),
    createRunner: () => { throw new Error("unused in this test") },
    providerSessionLifetime: providerSessionLifetime ?? testProviderSessionLifetime(),
  })
}

export function providerRuntime(surface: Awaited<ReturnType<RequestToolSurfaceOwner["resolve"]>>) {
  const runtime = surface.providerRuntime
  if (!runtime) throw new Error("expected provider runtime")
  return runtime
}
