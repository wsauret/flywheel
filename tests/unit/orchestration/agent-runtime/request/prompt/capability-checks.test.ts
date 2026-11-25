import { describe, expect, it } from "bun:test"
import { agentCapabilityCheck, treeCapabilityCheck } from "../../../../../../src/orchestration/agent-runtime/request/prompt/capability-checks.js"
import { Effect, Exit, Scope } from "effect"
import { requestKernel } from "../../../../../../src/orchestration/agent-runtime/request/request-kernel.js"
import { openRequestInputs, planRunCapabilities, type RunCapabilitySource } from "../../../../../../src/orchestration/agent-runtime/request/request-inputs.js"
import { resolveRuntimeConversation } from "../../../../../../src/orchestration/agent-runtime/request/runtime-conversation.js"
import { holdSharedTree } from "../../../../../../src/orchestration/agent-runtime/request/shared-tree.js"
import { deriveChildRuntimeSurfaces, toolRegistryFromComposition } from "../../../../../../src/orchestration/agent-runtime/tools/dispatch/tool-registry.js"
import { FUNCTION_TOOL_PRESENTATION } from "../../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { LLMClientFactory } from "../../../../../../src/orchestration/agent-runtime/request/model-runtime-capture.js"
import type { RunnableAgentOptions } from "../../../../../../src/orchestration/agent-runtime/types.js"
import { asModelClient } from "../../_model-client.js"
import { makeOptions } from "../../_runner-options.js"
import { definitionAvailabilityOf } from "../../../../../../src/orchestration/app-service/definitions/definition-availability.js"
import { composeFirstPartyModules, type FirstPartyModuleComposition } from "../../../../../../src/orchestration/modules.js"
import { repoDefinitions } from "../../../../../helpers/project-definitions.js"
import { codeModeServices } from "../../../../../helpers/code-mode-worker.js"
import { composeModuleServices } from "../../../../../../src/infra/modules/module-service.js"
import { createBackgroundExecutionOwner } from "../../../../../../src/orchestration/agent-runtime/background-execution/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../../../src/orchestration/agent-runtime/background-work/background-work.js"
import { personaInstructions } from "../../../../../../src/workflows/agents/persona-instructions.js"
import { testRuntimeConfigCapture } from "../../../../../helpers/request-tool-surface.js"
import { subagentsRuntime } from "../../../../../../src/orchestration/modules/subagents/execution/control/runtime-binding.js"
import { makeDeps as makeSubagentDeps } from "../../subagent/_fixtures.js"

const ALL = composeFirstPartyModules()
const codeModeService = codeModeServices()
const SUBAGENTS_OFF = composeFirstPartyModules(undefined, ["subagents"])
const definitions = repoDefinitions().captureRevision()

const client: LLMClientFactory = async () => asModelClient({
  accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION,
  contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, 
  priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } },
})

/** What a capability plan and a request of the run that `options` describe read. */
const runSource = (options: RunnableAgentOptions) => ({
  options, definitions: repoDefinitions(), personas: new Map(),
  conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: "agent", artifactScopeId: "artifact", retrievalSessionId: "retrieval" }),
  captureModelRuntime: async () => ({ generation: client, createLLMClient: client }),
  createRunner: () => { throw new Error("neither plan builds a run") },
})

/** The logical tools that the first request of the run that `source` describes may call. */
async function usableTools(source: RunCapabilitySource, scope: Scope.Scope): Promise<ReadonlySet<string>> {
  const opened = await openRequestInputs({ ...source, providerSessionLifetime: { providerSessionKey: "agent", scope } }, { kind: "prestart", signal: new AbortController().signal })
  return (await (await opened.build()).request.tools.resolve()).usableToolNames
}

/** The kernel of one tree-hosted agent whose tree captured `ALL` with `treeDisabledTypes` off, and whose own
 *  selection is `live` with `disabledTypes` off in its configuration. */
const siblingKernel = (live: FirstPartyModuleComposition, types: { readonly tree?: readonly string[]; readonly live?: readonly string[] } = {}) => {
  const config = testRuntimeConfigCapture()
  return requestKernel(
    { options: { userDataRoot: "/scratch/account", purpose: { kind: "subagent", renderAs: "subagent", parentToolUseId: "call" } }, surfaces: {}, personas: new Map(), treeHosted: true },
    { moduleSnapshot: ALL, live, runtimeConfig: { ...config, moduleSections: { ...config.moduleSections, subagents: { disabled_types: types.live ?? [] } } }, shellWriteGuard: true, persistentProcessesAdvertised: false, treeDisabledTypes: types.tree ?? [], definitions, servingModel: { model: "test", modelFamily: "anthropic" }, fileEditContract: "edit" },
  )
}

describe("capability checks", () => {
  it("gives two agents of one tree the same tree check when their own selections differ", () => {
    const first = siblingKernel(ALL)
    const second = siblingKernel(SUBAGENTS_OFF)

    expect(second.treeCapabilities).toBe(first.treeCapabilities)
    for (const term of ["subagent", "skill:code-review", "persona:implementer"]) expect(second.treeCapabilities(term)).toBe(true)
    // The tree check of the advertised tools is the same value for equal inputs, so shared prompt text agrees.
    const advertised = ["bash", "skill", "subagent"]
    expect(treeCapabilityCheck(ALL, second.definitionAvailability.tree, advertised)).toBe(treeCapabilityCheck(ALL, first.definitionAvailability.tree, advertised.toReversed()))
    // Each agent's own availability still follows its selection.
    expect(first.definitionAvailability.live.skills.get("code-review")?.available).toBe(true)
    expect(second.definitionAvailability.live.skills.get("code-review")?.available).toBe(false)
  })

  it("reads the tree's agent types for shared text and the agent's own configuration for what it may dispatch", () => {
    const before = siblingKernel(ALL)
    const turnedOffSince = siblingKernel(ALL, { live: ["advisor", "reviewer"] })
    // The tree captured every type on: its shared check, roster terms included, stays the same value.
    expect(turnedOffSince.treeCapabilities).toBe(before.treeCapabilities)
    expect(turnedOffSince.treeCapabilities("persona:advisor")).toBe(true)
    expect(turnedOffSince.definitionAvailability.live.personas.get("advisor")?.available).toBe(false)
    expect(turnedOffSince.definitionAvailability.live.personas.get("reviewer-code-security")?.available).toBe(false)
    // A tree that captured the types off leaves them out of the roster terms of every agent.
    const capturedOff = siblingKernel(ALL, { tree: ["advisor"], live: ["advisor"] })
    expect(capturedOff.treeCapabilities("persona:advisor")).toBe(false)
    expect(capturedOff.treeCapabilities("persona:explorer")).toBe(true)
  })

  it("holds a skill term for an agent only with the skill tool, and a skill that declares agents only with the subagent tool", () => {
    const availability = definitionAvailabilityOf(definitions, ALL.enabledModuleIds, [])
    const withDispatch = agentCapabilityCheck(new Set(["skill", "subagent"]), availability, undefined)
    const withoutDispatch = agentCapabilityCheck(new Set(["skill"]), availability, undefined)

    expect(withDispatch("skill:code-review")).toBe(true)
    expect(withoutDispatch("skill:code-review")).toBe(false)
    expect(withoutDispatch("skill:verification")).toBe(true)
    expect(agentCapabilityCheck(new Set(["subagent"]), availability, undefined)("skill:verification")).toBe(false)
    expect(withoutDispatch("persona:implementer")).toBe(true)
    expect(withoutDispatch("bash")).toBe(false)
  })

  it("holds a skill that declares agents for an agent with a restricted dispatch set only while the set holds each declared agent", () => {
    const availability = definitionAvailabilityOf(definitions, ALL.enabledModuleIds, [])
    const declared = definitions.skills.skills.get("code-review")?.agents ?? []
    expect(declared.length).toBeGreaterThan(1)
    const dispatching = (allowed: readonly string[]) => agentCapabilityCheck(new Set(["skill", "subagent"]), availability, new Set(allowed))

    expect(dispatching(["advisor"])("skill:code-review")).toBe(false)
    expect(dispatching(declared.slice(1))("skill:code-review")).toBe(false)
    expect(dispatching([...declared, "advisor"])("skill:code-review")).toBe(true)
    expect(dispatching(["advisor"])("skill:verification")).toBe(true)
  })

  it("holds a type term for an agent with a restricted dispatch set only while a persona of the set covers the type", () => {
    const availability = definitionAvailabilityOf(definitions, ALL.enabledModuleIds, [])
    const dispatching = (allowed: readonly string[]) => agentCapabilityCheck(new Set(["subagent"]), availability, new Set(allowed))

    expect(dispatching(["explorer"])("type:explorer")).toBe(true)
    expect(dispatching(["explorer"])("type:implementer")).toBe(false)
    // A persona covers its parent role, so a set of one reviewer persona holds the role term.
    expect(dispatching(["reviewer-code-quality"])("type:reviewer")).toBe(true)
    expect(dispatching(["reviewer-code-quality"])("type:reviewer-quality")).toBe(true)
    // An agent that may dispatch every available persona reads every offered type.
    expect(agentCapabilityCheck(new Set(["subagent"]), availability, undefined)("type:implementer")).toBe(true)
  })

  it("answers a workflow agent's opening check, before any model route, as its first request's plan leaves each tool usable", async () => {
    const BASH_OFF = composeFirstPartyModules(undefined, ["bash"])
    const policyDenies = { available: () => false, admit: async () => { throw new Error("unused in this test") } }
    // A tree that a sibling agent holds, captured with every module on.
    const sibling = holdSharedTree("workflow-tree", () => ({ modules: ALL, shellWriteGuard: true, allowPersistentProcesses: false, disabledTypes: [] }))
    // An agent of a workflow has no workflow starter, and this host has no web retrieval backend.
    const cases = [
      { name: "all on" },
      { name: "own selection turned Bash off", live: BASH_OFF },
      { name: "persona grant", toolGrant: ["read", "bash", "workflow", "web", "code", "subagent", "process", "skill"] },
      { name: "tree held by a sibling, own selection turned Bash off", live: BASH_OFF, treeRootSessionId: "workflow-tree" },
      { name: "live policy denies every optional capability", capabilityAccess: policyDenies },
    ] as const
    const terms = [...new Set([...toolRegistryFromComposition(ALL).values()].map((registration) => registration.tool))]
    const scope = Scope.makeUnsafe("sequential")
    try {
      for (const entry of cases) {
        const live = "live" in entry ? entry.live : ALL
        const options: RunnableAgentOptions = {
          ...makeOptions({ purpose: { kind: "workflow-agent", briefScope: { briefId: "review" }, workflowAttemptId: "review:attempt:1" }, agentRegistry: new Map(), agentsMd: "" }),
          ...("toolGrant" in entry ? { toolGrant: entry.toolGrant } : {}),
          ...("capabilityAccess" in entry ? { capabilityAccess: entry.capabilityAccess } : {}),
          ...("treeRootSessionId" in entry ? { treeRootSessionId: entry.treeRootSessionId } : {}),
          captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
          runtimeSurfaces: {}, moduleSelection: () => live,
        }
        const source = runSource(options)
        const opening = await planRunCapabilities(source)
        const usable = await usableTools(source, scope)
        for (const term of terms) expect(opening(term), `${entry.name}: ${term}`).toBe(usable.has(term))
        expect(opening("workflow"), entry.name).toBe(false)
        expect(opening("web"), entry.name).toBe(false)
      }
    } finally {
      sibling.release()
      Effect.runSync(Scope.close(scope, Exit.void))
    }
  })

  it("answers a child's check from the child's own first plan, not from the grant of the agent that dispatches it", async () => {
    // A chat whose grant lacks code and holds the workflow starter dispatches a child that declares both. A chat
    // dispatches only from a durable session with a child-session authority and a persona to dispatch.
    const shared = {
      captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
      conversation: {
        kind: "durable-tree", sessionId: "parent", conversationId: "parent-conversation", priorMessages: [], append: () => {},
        reserveMessageId: async () => crypto.randomUUID(), captureCommittedForkMessages: async () => [], resolveLeafId: async () => null,
        committedTree: async () => ({ leafId: null, entriesById: {} }),
      },
      subagentSessions: makeSubagentDeps().subagentSessions,
      moduleSelection: () => ALL,
    } satisfies Partial<RunnableAgentOptions>
    const backgroundOwner = () => createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
    const parentSurfaces: RunnableAgentOptions["runtimeSurfaces"] = {
      startWorkflow: async () => ({ error: "no launch happens in this test" }), workflowMode: () => "on",
      moduleServices: composeModuleServices([["code-mode", codeModeService()]]),
      background: backgroundOwner(),
    }
    const parent: RunnableAgentOptions = {
      ...makeOptions({ purpose: { kind: "interactive-chat" }, agentRegistry: new Map(), agentsMd: "" }),
      ...shared, toolGrant: ["read", "subagent", "workflow"], runtimeSurfaces: parentSurfaces,
    }
    const childRun = { purpose: { kind: "subagent", renderAs: "subagent", parentToolUseId: "call" }, toolGrant: ["read", "code", "workflow", "handoff"] } as const
    // The options that a dispatch publishes the child with: its own handoff, background owner, and recall over the
    // surfaces that it inherits from the parent.
    const child: RunnableAgentOptions = {
      ...makeOptions({ purpose: childRun.purpose, agentRegistry: new Map(), agentsMd: "" }),
      ...shared, toolGrant: [...childRun.toolGrant],
      runtimeSurfaces: {
        ...deriveChildRuntimeSurfaces(parentSurfaces, { handoff: { onContent: () => {} }, background: backgroundOwner() }),
        recall: async () => { throw new Error("no recall happens in this test") },
      },
    }
    const terms = [...new Set([...toolRegistryFromComposition(ALL).values()].map((registration) => registration.tool))]
    const source = { ...runSource(parent), personas: definitions.personas }
    const scope = Scope.makeUnsafe("sequential")
    try {
      const parentCheck = await planRunCapabilities(source)
      // The check that a dispatch from the parent's first request renders its child's text from.
      const opened = await openRequestInputs({ ...source, providerSessionLifetime: { providerSessionKey: "agent", scope } }, { kind: "prestart", signal: new AbortController().signal })
      const subagents = (await opened.build()).moduleRuntimes.get(subagentsRuntime)
      if (!subagents) throw new Error("the parent's first request planned no subagent dispatch")
      const dispatch = subagents.toolDeps({ model: "test", modelFamily: "anthropic" }, definitionAvailabilityOf(definitions, ALL.enabledModuleIds, []))
      const childCheck = await dispatch.planChildCapabilities({ purpose: childRun.purpose, toolGrant: [...childRun.toolGrant] })
      expect([parentCheck("code"), parentCheck("workflow")]).toEqual([false, true])
      expect([childCheck("code"), childCheck("workflow")]).toEqual([true, false])
      // The child's real first request, built from the options it is published with, agrees on every tool.
      const usable = await usableTools({ ...runSource(child), personas: definitions.personas }, scope)
      for (const term of terms) expect(childCheck(term), term).toBe(usable.has(term))
      // So a persona whose composed method offers a workflow file route renders no such route for that child.
      const persona = { kind: "persona", name: "planner", description: "Plans.", role: "planner", tools: ["read", "code", "workflow"], requiredSkills: ["design"], maxTurns: 5, systemPrompt: "Plan the work." } as const
      const route = "a workflow file that you write when later agents read earlier results"
      expect(personaInstructions(persona, definitions.skills, parentCheck)).toContain(route)
      expect(personaInstructions(persona, definitions.skills, childCheck)).not.toContain(route)
    } finally {
      Effect.runSync(Scope.close(scope, Exit.void))
    }
  })
})
