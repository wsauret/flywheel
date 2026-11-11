import { describe, it, expect } from "bun:test"
import { Effect, Exit, Schema, Scope } from "effect"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import type { CapabilityCheck } from "../../../../src/infra/capability-text"
import type { AgentOptions, RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { LLMClientFactory } from "../../../../src/orchestration/agent-runtime/factory"
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types"
import { planCapabilitiesOfRun } from "../../../../src/orchestration/agent-runtime/request-preparation"
import { openRequestInputs } from "../../../../src/orchestration/agent-runtime/request-inputs"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation"
import { toolRegistryFromComposition } from "../../../../src/orchestration/agent-runtime/tools/tool-registry"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import type { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema"
import { planEveryCapability } from "../../../helpers/attempt-brief"
import { temporaryDirectories } from "../../../helpers/directories"
import { repoDefinitions } from "../../../helpers/project-definitions"
import { testRuntimeConfigCapture } from "../../../helpers/request-tool-surface"
import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { handoverAuthority } from "../agent-runtime/_command-handover-fixtures"
import { asModelClient } from "../agent-runtime/_model-client"
import { CONVERSATION, handoverWorker, publishStep, STEP, WORKFLOW } from "./_worker-step-fixtures"

const temporary = temporaryDirectories()

describe("a step's opening turn", () => {
  const definitions = repoDefinitions()
  const client: LLMClientFactory = async () => asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", contextLimit: 100_000, outputLimit: 8_000,
    supportsReasoning: false, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> { yield { kind: "done", stopReason: "end_turn" } },
  })
  /** The run's options as the agent factory completes them (`hostedOptions`), with the authorities that plan its requests. */
  const runSource = (options: AgentOptions) => {
    const runnable: RunnableAgentOptions = {
      ...options, runtimeSurfaces: options.runtimeSurfaces ?? {}, moduleSelection: options.moduleSelection ?? composeFirstPartyModules,
      captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
    }
    return { options: runnable, definitions, captureModelRuntime: async () => ({ generation: client, createLLMClient: client }), createRunner: () => { throw new Error("no child runs here") } }
  }

  /** Runs one step of `persona` whose opening renders from `planCapabilities`, and returns the check that its brief
   *  received, the tools that its agent's first request may call, and its committed conversation. */
  async function openStep(persona: string, planCapabilities: Parameters<typeof createWorkerCallback>[0]["planCapabilities"]) {
    const dir = temporary("step-opening-check-")
    const { store, sessionId } = await publishStep(dir)
    const scope = Scope.makeUnsafe("sequential")
    try {
      const authority = handoverAuthority({ reader: store, writer: asAsyncEventWriter(store) })
      const resolved = resolveWorkflowAgents(Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
        id: "wf", name: "Workflow", phases: [{ phase: "work", persona, brief: "Do the work.", name: "Work" }],
      }))
      let agentOptions: AgentOptions | undefined
      let opening: CapabilityCheck | undefined
      const worker = handoverWorker(dir, (options) => {
        agentOptions = options
        return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }) }
      }, authority, undefined, workflowAgentInputs(authority.projectionReader, WORKFLOW), resolved, definitions.personas(), undefined, WORKFLOW, { planCapabilities })
      await worker(STEP, async (has) => { opening = has; return { userPrompt: "Do the work.", task: "" } }, undefined, CONVERSATION)
      if (!agentOptions || !opening) throw new Error("the step built no agent")
      const run = runSource(agentOptions)
      const opened = await openRequestInputs({
        ...run, personas: run.options.agentRegistry ?? new Map(), providerSessionLifetime: { providerSessionKey: "step", scope },
        conversation: resolveRuntimeConversation(run.options.conversation, { providerSessionKey: "step", artifactScopeId: "step", retrievalSessionId: "step" }),
      }, { kind: "prestart", signal: new AbortController().signal })
      const usable = (await (await opened.build()).request.tools.resolve()).usableToolNames
      const tree = await tryOpenConversationTree({ conversationId: CONVERSATION, sessionId, store: authority.projectionReader, writer: authority.writer })
      if (!tree) throw new Error("Missing worker conversation")
      const committed = JSON.stringify(await tree.getState())
      tree.getStorage().dispose()
      return { check: opening, usable, committed }
    } finally {
      Effect.runSync(Scope.close(scope, Exit.void))
      store.close()
    }
  }
  const realPlanner = (options: AgentOptions) => planCapabilitiesOfRun(runSource(options))
  const terms = [...new Set([...toolRegistryFromComposition(composeFirstPartyModules()).values()].map((registration) => registration.tool))]

  it.each(["implementer", "explorer"])("renders a %s step's persona instructions for the tools its first request may call, with no workflow starter and no web backend", async (persona) => {
    const { check, usable, committed } = await openStep(persona, realPlanner)
    for (const term of terms) expect(check(term), term).toBe(usable.has(term))
    expect([check("workflow"), check("web"), check("bash")]).toEqual([false, false, true])
    // The explorer's web line and the implementer's Git rule follow that check, not the persona's declared tools.
    expect(committed.includes("Use web only for data that your other tools cannot provide")).toBe(false)
    expect(committed.includes("## Git Discipline")).toBe(persona === "implementer")
    if (persona === "explorer") expect((await openStep(persona, planEveryCapability)).committed).toContain("Use web only for data that your other tools cannot provide")
  })
})
