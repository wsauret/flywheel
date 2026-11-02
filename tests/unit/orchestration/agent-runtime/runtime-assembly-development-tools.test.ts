import { describe, expect, it, setSystemTime } from "bun:test"
import { createEnvCaptureResolver, localDate } from "../../../../src/infra/env-detection.js"
import { fakeOwnedCommandRunner } from "../../../helpers/owned-command-fake.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"
import { FUNCTION_TOOL_PRESENTATION, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { PromptKind } from "../../../../src/orchestration/agent-runtime/system-prompt.js"
import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js"
import type { AgentLoopOptions } from "../../../../src/orchestration/agent-runtime/agent-loop-types.js"
import type { ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js"
import { completeRuntimeToolSurfaces } from "../../../../src/orchestration/agent-runtime/factory.js"
import type { AgentOptions, RunnableAgentOptions, RuntimeToolSurfaces } from "../../../../src/orchestration/agent-runtime/types.js"
import type { RequestProviderRuntime, RequestToolSurfaceOwner } from "../../../../src/orchestration/agent-runtime/request-tool-surface.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { codeModeServices } from "../../../helpers/code-mode-worker.js"
import { composeModuleServices } from "../../../../src/infra/module-service.js"
import type { McpPorts } from "../../../../src/orchestration/modules/mcp/manager.js"
import type { WebSearchPort } from "../../../../src/orchestration/agent-runtime/web-search/types.js"
import { capabilityAccessFor } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { createForegroundBashHoldController } from "../../../../src/orchestration/agent-runtime/foreground-bash-hold.js"

import { publishSkillRevision } from "../../../../src/workflows/skill-schema.js"
import { testSkill } from "../../../helpers/skill-fixtures.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { composeFirstPartyModules, composeRealmModuleSnapshot } from "../../../../src/orchestration/modules.js"
import { checkpointTestPersistences } from "../../../helpers/checkpoint-store.js"
import { join } from "node:path"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { compactInput } from "../../../../src/infra/agent-loop-events.js"
import { renderSystemPrompt, stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { assembledRuntime, CALL_NO_TOOLS, modelClient, providerRuntime } from "./_runtime-assembly-harness.js"

const codeModeService = codeModeServices()
const checkpointTestPersistence = checkpointTestPersistences()

async function assembledSurface(promptKind: PromptKind, override: Partial<AgentOptions> = {}) {
  const assembled = await assembledRuntime(promptKind, override)
  if (!("resolve" in assembled.tools) || typeof assembled.tools.resolve !== "function") throw new Error("expected request tool surface owner")
  const surface: RequestToolSurfaceOwner = assembled.tools
  return await surface.resolve()
}

async function preparedTools(surface: Awaited<ReturnType<typeof assembledSurface>>) {
  const runtime = providerRuntime(surface)
  await surface.prepareStablePrompt(() => stableSystemPrompt(""), runtime.interactionProfile)
  return (await surface.prepareAttempt(runtime.plannedAttempt)).tools
}

describe("request model ownership", () => {
  it("keeps the host-selected model for interactive chat", async () => {
    const roles = new Map([["chat", { roleId: "chat", model: "stale-model", effort: "medium" }]])
    const surface = await assembledSurface("chat", {
      model: "gpt-6.1-sol",
      resolveRoles: async () => roles,
    })
    expect(providerRuntime(surface).mainRoute.client.model).toBe("gpt-6.1-sol")
  })

  it("keeps the host-selected model for workflow step agents", async () => {
    const roles = new Map([["workflow-agent", { roleId: "workflow-agent", model: "stale-model", effort: "medium" }]])
    const surface = await assembledSurface("workflow-agent", {
      model: "gpt-6.1-sol",
      purpose: { kind: "workflow-agent", briefScope: { briefId: "implement" }, workflowAttemptId: "step-1" },
      resolveRoles: async () => roles,
    })
    expect(providerRuntime(surface).mainRoute.client.model).toBe("gpt-6.1-sol")
  })

})

describe("model interaction profile admission order", () => {
  it("admits after environment preparation completes", async () => {
    const events: string[] = []
    const base = modelClient()
    const client = { ...base, admitRequest: async () => { events.push("admit"); return base.admitRequest() } }
    await assembledRuntime("headless", {
      resolveEnvSnapshot: async () => {
        await Promise.resolve()
        events.push("environment")
        return { envBlock: "environment" }
      },
    }, repoDefinitions(), client)
    expect(events).toEqual(["environment", "admit"])
  })

  it.each(["assembled", "literal"] as const)("uses one admission from %s prompt assembly through the first provider request", async (promptKind) => {
    let admissions = 0
    let requests = 0
    const base = modelClient("test", () => { requests += 1 })
    const client = {
      ...base,
      async admitRequest() {
        admissions += 1
        return base.admitRequest()
      },
    }
    const modules = testCapabilityModules()
    const assembled = await assembledRuntime("headless", {
      moduleSelection: () => composeRealmModuleSnapshot({ moduleIds: modules.enabledModuleIds }),
      ...(promptKind === "literal" ? {
        purpose: { kind: "headless-task" as const, prompt: { kind: "literal" as const, systemPrompt: "literal" } },
        sessionDir: "/scratch/flywheel-admission-notes",
        conversation: { kind: "durable-tree" as const, reserveMessageId: async () => crypto.randomUUID(), sessionId: "session", conversationId: "conversation", priorMessages: [{ kind: "user" as const, content: "Reply once." }], append: () => {}, captureCommittedForkMessages: async () => [], resolveLeafId: async () => "leaf", committedTree: async () => ({ leafId: null, entriesById: {} }) },
      } : {}),
    }, repoDefinitions(), client)

    expect(admissions).toBe(1)
    await runAgentLoop({ ...assembled, instruction: "Reply once." })
    const initialSurface = assembled.tools.current()

    // The composition is one value per selection, so the first request finds
    // the assembly capture unchanged and reuses its admission.
    expect(requests).toBe(1)
    expect(admissions).toBe(1)
    expect(assembled.tools.current()).toBe(initialSurface)

    await assembled.tools.resolve()
    expect(admissions).toBe(2)
  })

  it.each(["revision", "profile", "modules", "selection"] as const)("recaptures admission when %s changes during assembly", async (transition) => {
    let admissions = 0
    let roleReads = 0
    let revision = 0
    let profileId = "default"
    let selection = { model: "test", effort: "low" }
    const base = modelClient()
    const client = {
      ...base,
      async admitRequest() {
        admissions += 1
        return base.admitRequest()
      },
    }
    let modules = testCapabilityModules()
    const assembled = await assembledRuntime("headless", {
      moduleSelection: () => modules,
      captureRuntimeConfig: () => ({ ...testRuntimeConfigCapture(), revision, profileId }),
      resolveRoles: async () => {
        roleReads += 1
        return new Map()
      },
      requestSelection: async () => selection,
    }, repoDefinitions(), client)
    if (transition === "revision") revision += 1
    else if (transition === "profile") profileId = "other"
    else if (transition === "selection") selection = { model: "other", effort: "high" }
    else modules = composeFirstPartyModules(undefined, ["provider-chatgpt"])

    await runAgentLoop({ ...assembled, instruction: "Reply once." })

    expect(admissions).toBe(2)
    expect(roleReads).toBe(2)
    expect(assembled.tools.current().runtimeConfig).toMatchObject({ revision, profileId })
    expect(assembled.tools.current().moduleSnapshot).toBe(modules)
    expect(assembled.tools.current().providerRuntime?.role).toEqual(selection)
  })

  it("captures fixed-model effort for requests instead of reading it again during provider execution", async () => {
    let effort = "LOW"
    const sent: StreamOptions[] = []
    const assembled = await assembledRuntime("headless", {
      effort: async () => effort,
    }, repoDefinitions(), modelClient("test", (options) => { sent.push(options) }))
    const surface = await assembled.tools.resolve()
    effort = "high"
    await runAgentLoop({ ...assembled, tools: { resolve: async () => surface, current: () => surface }, instruction: "Reply once." })
    expect(sent[0]?.reasoningEffort).toBe("low")
    expect(surface.providerRuntime?.role?.effort).toBe("low")
  })

  it("routes a retained runtime from the current selection and leaves the previous request pinned", async () => {
    let selection: NonNullable<RequestProviderRuntime["role"]> = { model: "claude-sonnet-4.6", effort: "low", providerOptions: { anthropic: { thinking_display: "summarized" } } }
    const assembled = await assembledRuntime("headless", {
      requestSelection: async () => selection,
    })
    const first = await assembled.tools.resolve()
    selection = { model: "claude-opus-4.6", effort: "high", providerOptions: { anthropic: { thinking_display: "omitted" } } }
    const second = await assembled.tools.resolve()
    expect(first.providerRuntime?.mainRoute.client.model).toBe("claude-sonnet-4.6")
    expect(first.providerRuntime?.role?.effort).toBe("low")
    expect(first.providerRuntime?.mainRoute.providerOptions).toEqual({ anthropic: { thinking_display: "summarized" } })
    expect(second.providerRuntime?.mainRoute.client.model).toBe("claude-opus-4.6")
    expect(second.providerRuntime?.role?.effort).toBe("high")
    expect(second.providerRuntime?.mainRoute.providerOptions).toEqual({ anthropic: { thinking_display: "omitted" } })
  })

  it("resolves the serving client profile before immutable admission and planning", async () => {
    const events: string[] = []
    let admitted = false
    const base = modelClient("gpt-5")
    const client = {
      ...base,
      get modelFamily() {
        return admitted ? "anthropic" as const : "openai" as const
      },
      async admitRequest() {
        events.push("admit")
        admitted = true
        const request = await base.admitRequest()
        return {
          ...request,
          async plannedAttempt(options: Parameters<typeof request.plannedAttempt>[0]) {
            events.push("plan")
            return request.plannedAttempt(options)
          },
        }
      },
    }

    const assembled = await assembledRuntime("chat", {}, repoDefinitions(), client)

    expect(assembled.initialInteractionProfile?.fileEditContract).toBe("apply_patch")
    expect(events).toEqual(["admit", "plan"])
  })
})

describe("direct headless system prompt override", () => {
  it("uses the historical headless core with normal guidance unless the complete prompt is overridden", async () => {
    const production = await assembledRuntime("headless", { purpose: { kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } }, engineeringDoctrine: false })
    const overridden = await assembledRuntime("headless", { purpose: { kind: "headless-task", prompt: { kind: "literal", systemPrompt: "literal\nbytes" } }, engineeringDoctrine: false })
    await production.tools.resolve()
    await overridden.tools.resolve()
    if (typeof production.systemPrompt !== "function" || typeof overridden.systemPrompt !== "function") throw new Error("expected request-local system prompts")

    const productionPrompt = renderSystemPrompt(await production.systemPrompt(await modelClient().plannedAttempt(), providerRuntime(production.tools.current()).interactionProfile))
    expect(productionPrompt).toStartWith("You are a helpful AI Agent.")
    expect(productionPrompt).toContain("Available tools:")
    expect(productionPrompt).not.toContain("Universal Principles of Elegant Code")
    expect(renderSystemPrompt(await overridden.systemPrompt(await modelClient().plannedAttempt(), providerRuntime(overridden.tools.current()).interactionProfile))).toBe("literal\nbytes")
    expect((await preparedTools(overridden.tools.current())).map((tool) => tool.name)).toEqual((await preparedTools(production.tools.current())).map((tool) => tool.name))
  })
})

describe("environment date", () => {
  it("keeps the date that a turn's assembly read for every request of the turn, and the next turn states the new date", async () => {
    const resolveEnvSnapshot = createEnvCaptureResolver(fakeOwnedCommandRunner().run)
    const turnPrompt = async (assembled: AgentLoopOptions) => {
      const surface = await assembled.tools.resolve()
      if (typeof assembled.systemPrompt !== "function") throw new Error("expected request-local system prompt")
      return renderSystemPrompt(await assembled.systemPrompt(providerRuntime(surface).plannedAttempt, providerRuntime(surface).interactionProfile))
    }
    // A day apart, so the two instants name different local dates in every zone.
    const today = new Date("2026-10-09T12:00:00Z")
    const tomorrow = new Date("2026-10-10T12:00:00Z")
    try {
      setSystemTime(today)
      const turn = await assembledRuntime("headless", { resolveEnvSnapshot })
      expect(await turnPrompt(turn)).toContain(`Date: ${localDate(today)}`)
      setSystemTime(tomorrow)
      expect(await turnPrompt(turn)).toContain(`Date: ${localDate(today)}`)
      expect(await turnPrompt(await assembledRuntime("headless", { resolveEnvSnapshot }))).toContain(`Date: ${localDate(tomorrow)}`)
    } finally {
      setSystemTime()
    }
  })
})

describe("universal scoped notes assembly", () => {
  const sessionDir = "/session"
  const conversation = (conversationId: string): AgentOptions["conversation"] => ({
    kind: "durable-tree", reserveMessageId: async () => crypto.randomUUID(), sessionId: "session", conversationId, priorMessages: [{ kind: "user", content: "work" }],
    append: () => {}, captureCommittedForkMessages: async () => [], resolveLeafId: async () => "leaf", committedTree: async () => ({ leafId: null, entriesById: {} }),
  })
  const purposes: readonly (readonly [string, AgentOptions["purpose"]])[] = [
    ["chat", { kind: "interactive-chat" }],
    ["step", { kind: "workflow-agent", briefScope: { briefId: "implement" }, workflowAttemptId: "step-1" }],
    ["persona", { kind: "subagent", renderAs: "subagent", parentToolUseId: "persona-call" }],
    ["general", { kind: "subagent", renderAs: "chat", parentToolUseId: "general-call" }],
    ["followup", { kind: "workflow-follow-up" }],
  ]
  for (const [id, purpose] of purposes) it(`assembles complete notes for ${id} with no selected file tools`, async () => {
    const assembled = await assembledRuntime("chat", { ...checkpointTestPersistence(), purpose, sessionDir, conversation: conversation(id), toolNames: [], capabilityAccess: { available: () => false, admit: async () => ({ ok: false, missing: [], reason: "disabled" }) } })
    const surface = await assembled.tools.resolve()
    expect(assembled.scratchDir).toBe(join(sessionDir, "scratch"))
    expect(assembled.checkpoint).toBeDefined()
    for (const name of ["checkpoint_read", "checkpoint_replace", "checkpoint_decide"]) expect(surface.tools.has(name)).toBe(true)
    for (const name of ["read", "write", "edit"]) expect(surface.tools.has(name)).toBe(false)
    if (typeof assembled.systemPrompt !== "function") throw new Error("expected assembled prompt")
    const prompt = renderSystemPrompt(await assembled.systemPrompt(providerRuntime(surface).plannedAttempt, providerRuntime(surface).interactionProfile))
    expect(prompt).toContain("use `checkpoint_read`")
    expect(prompt).toContain('Keep a short "Relevant skills" section')
  })

  for (const kind of ["chat-learning-review", "workflow-learning-review"] as const) it(`isolates ${kind} notes by review ID`, async () => {
    const owner = kind === "workflow-learning-review" ? { kind: "workflow" as const, workflowId: "workflow" } : { kind: "session" as const, sessionId: "session" }
    const persistence = checkpointTestPersistence(owner)
    const checkpoints = []
    for (const reviewRunId of ["review-one", "review-two"]) {
      const assembled = await assembledRuntime("chat", {
        ...persistence,
        purpose: { kind, review: { reviewRunId } }, sessionDir, toolNames: [],
        conversation: {
          kind: "replay", priorMessages: [{ kind: "user", content: "review" }],
          ...(owner.kind === "session" ? { sessionId: owner.sessionId } : {
            requestAccounting: { owner, streamId: `learning-review:${reviewRunId}`, reader: persistence.sessionEventReader, writer: persistence.sessionEventWriter },
          }),
        },
      })
      const surface = await assembled.tools.resolve()
      expect(assembled.conversationId).toBeUndefined()
      expect(assembled.checkpoint).toBeDefined()
      expect(assembled.scratchDir).toBe(join(sessionDir, "scratch"))
      checkpoints.push(assembled.checkpoint)
      await assembled.checkpoint!.replace("currentState", reviewRunId)
      const usable = (name: string) => surface.usableToolNames.has(surface.registrationIdentities.get(name) ?? name)
      for (const name of ["checkpoint_read", "checkpoint_replace", "checkpoint_decide"]) expect([surface.tools.has(name), usable(name)]).toEqual([true, true])
      for (const name of ["read", "write", "edit"]) expect(usable(name)).toBe(false)
      // One grant feeds the review's notice and its refusals.
      expect(assembled.initialRequestContext).toContain(`## Tools\n\nYou may call these tools: ${[...surface.tools.keys()].filter(usable).join(", ")}.`)
    }
    expect((await checkpoints[0]!.read())?.currentState).toBe("review-one")
    expect((await checkpoints[1]!.read())?.currentState).toBe("review-two")
  })

  it("keeps literal system bytes and adds note guidance beside the supplied request context", async () => {
    const requests: StreamOptions[] = []
    const assembled = await assembledRuntime("headless", {
      ...checkpointTestPersistence(), purpose: { kind: "headless-task", prompt: { kind: "literal", systemPrompt: "literal\nbytes\n" } },
      sessionDir, conversation: conversation("literal"), requestContext: "caller context", toolNames: [],
      captureRuntimeConfig: () => testRuntimeConfigCapture(),
    }, repoDefinitions(), modelClient("test", (request) => requests.push(request)))
    const surface = await assembled.tools.resolve()
    if (typeof assembled.systemPrompt !== "function") throw new Error("expected literal prompt")
    expect(renderSystemPrompt(await assembled.systemPrompt(providerRuntime(surface).plannedAttempt, providerRuntime(surface).interactionProfile))).toBe("literal\nbytes\n")
    expect(assembled.initialRequestContext).toStartWith("caller context")
    expect(assembled.initialRequestContext).toContain("use `checkpoint_read`")
    let queued = false
    await runAgentLoop({ ...assembled, inputSource: { drainPending: () => { if (queued) return null; queued = true; return compactInput() } } })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(renderSystemPrompt(request.systemPrompt)).toBe("literal\nbytes\n")
      expect(JSON.stringify(request.messages)).toContain("caller context")
      expect(JSON.stringify(request.messages)).toContain("use `checkpoint_read`")
    }
    expect(JSON.stringify(requests[1]?.messages)).toContain("fresh context window")
  })

  it("does not give a stateless audit a notes directory or note guidance", async () => {
    const assembled = await assembledRuntime("headless", {
      purpose: { kind: "learning-review-audit", prompt: { kind: "literal", systemPrompt: "audit" } },
      requestContext: "audit context",
    })
    expect(assembled.checkpoint).toBeUndefined()
    expect(assembled.initialRequestContext).toBe(`audit context\n\n${CALL_NO_TOOLS}`)
  })
})

describe("model interaction profile provider boundary", () => {
  it("sends and records native bash and apply_patch for gpt-6-luna under the default profile", async () => {
    const providerRequests: StreamOptions[] = []
    const auditRequests: Parameters<ProviderRequestAuditWriter["recordRequest"]>[0][] = []
    const client = modelClient("gpt-6-luna", (options) => providerRequests.push(options))
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
    const assembled = await assembledRuntime("headless", {
      model: "gpt-6-luna",
      purpose: { kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } },
      engineeringDoctrine: false,
      runtimeSurfaces: { background },
    })
    const surface = await assembled.tools.resolve()
    const runtime = providerRuntime(surface)
    const systemPrompt = assembled.systemPrompt
    if (typeof systemPrompt !== "function") throw new Error("expected request-local system prompt")
    await surface.prepareStablePrompt(
      () => systemPrompt(runtime.plannedAttempt, runtime.interactionProfile),
      runtime.interactionProfile,
    )
    const requestAudit: ProviderRequestAuditWriter = {
      async recordRequest(input) {
        auditRequests.push(input)
        return { requestId: "request-1", turn: input.turn }
      },
      recordResponse() {},
      recordUsage() {},
      recordStreamStarted() {},
      recordStreamEvent() {},
      recordStreamCompleted() {},
    }

    await streamAssistantTurn({
      client,
      executionCwd: "/scratch",
      interactionProfile: runtime.interactionProfile,
      messages: [{ kind: "user", content: "verify the request" }],
      tools: [],
      systemPrompt: stableSystemPrompt(""),
      prepareAttempt: (attempt) => surface.prepareAttempt(attempt),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: "1h",
      providerSessionKey: "conversation-1", promptCacheKey: "conversation-1",
      providerOptions: undefined,
      requestAudit,
      staleMasking: undefined,
      requestContext: undefined,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 1,
      onEvent: () => {},
    })

    expect(providerRequests).toHaveLength(1)
    const request = providerRequests[0]
    if (!request) throw new Error("expected provider request")
    expect(renderSystemPrompt(request.systemPrompt)).not.toContain("send a brief preamble")
    const bash = request.tools.find((tool) => tool.name === "bash")
    if (!bash) throw new Error("expected native bash tool")
    expect(bash.input_schema).toEqual(surface.tools.get("bash")?.inputSchema ?? {})
    expect(request.tools.some((tool) => tool.name === "apply_patch")).toBe(true)
    expect(request.tools.some((tool) => tool.name === "exec")).toBe(false)
    expect(auditRequests).toHaveLength(1)
    expect(auditRequests[0]?.interactionProfileId).toBe("default")
    expect(auditRequests[0]?.systemPrompt).toBe(renderSystemPrompt(request.systemPrompt))
    // The audit records the presented kind, description, and input-format hash in place of the wire declaration.
    expect(auditRequests[0]?.tools.map(({ registrationId: _registrationId, executableId: _executableId, kind: _kind, inputFormatSha256: _inputFormatSha256, ...tool }) => tool))
      .toEqual(request.tools.map((tool) => {
        const { wire: _wire, ...declared } = tool
        return { ...declared, description: FUNCTION_TOOL_PRESENTATION.present(tool).description }
      }))
    expect(auditRequests[0]?.tools.every((tool) => tool.registrationId.length > 0 && tool.executableId === tool.name)).toBe(true)
  })

  it("preserves literal headless prompt bytes while exposing native bash to gpt-6-luna", async () => {
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
    const literalPrompt = "literal\nheadless\nbytes"
    const assembled = await assembledRuntime("headless", {
      model: "gpt-6-luna",
      purpose: { kind: "headless-task", prompt: { kind: "literal", systemPrompt: literalPrompt } },
      engineeringDoctrine: false,
      runtimeSurfaces: { background },
    })
    const surface = await assembled.tools.resolve()
    const runtime = providerRuntime(surface)
    const systemPrompt = assembled.systemPrompt
    if (typeof systemPrompt !== "function") throw new Error("expected request-local system prompt")
    await surface.prepareStablePrompt(
      () => systemPrompt(runtime.plannedAttempt, runtime.interactionProfile),
      runtime.interactionProfile,
      assembled.literalSystemPrompt,
    )

    const prepared = await surface.prepareAttempt(runtime.plannedAttempt)
    expect(renderSystemPrompt(prepared.systemPrompt)).toBe(literalPrompt)
    expect(prepared.tools.some((tool) => tool.name === "bash")).toBe(true)
  })
})

describe("read-only runner shell", () => {
  // The read-only rule lives in the child's task, so a read-only shell shows
  // the same bytes as every other agent's and shares its prompt-cache prefix.
  it("gives a runner marked read-only the same shell schema and description as a writer", async () => {
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
    const shellOf = async (model: string, readOnly: boolean) => {
      const assembled = await assembledRuntime("headless", { model, ...(readOnly ? { readOnly } : {}), runtimeSurfaces: { background } })
      const tools = (await assembled.tools.resolve()).tools
      const shell = tools.get("bash")
      if (!shell) throw new Error(`expected a shell tool for ${model}`)
      return shell
    }
    for (const model of ["test", "gpt-6-luna"]) {
      const reader = await shellOf(model, true)
      const writer = await shellOf(model, false)
      expect(reader.description).toBe(writer.description)
      expect(reader.inputSchema).toEqual(writer.inputSchema)
      expect(reader.description).not.toContain("read-only")
    }
  })
})

describe("development tool runtime assembly", () => {
  // The benchmark tool is a contribution of the development module, which the
  // shipped catalog this process composes does not install; the runtime
  // factory's own gating is proved in the module's test.
  it("never advertises benchmark from the shipped catalog, even with the launch surfaces a benchmark needs", async () => {
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
    const foregroundBashHold = createForegroundBashHoldController(() => {})
    const benchmarkHost: Partial<RunnableAgentOptions> = {
      runtimeSurfaces: {
        launcher: refusingLauncher,
        background,
        foregroundBashHold,
      },
      usageProfile: {
        profileId: "default",
        authorityIncarnation: "test-authority",
        acquireAuthority: async () => { throw new Error("unused in this test") },
      },
    }
    try {
      for (const promptKind of ["chat", "workflow-agent"] as const) {
        const surface = await assembledSurface(promptKind, benchmarkHost)
        expect(surface.tools.has("benchmark"), promptKind).toBe(false)
        expect((await preparedTools(surface)).some((tool) => tool.name === "benchmark"), promptKind).toBe(false)
      }
    } finally {
      await background.close()
      await foregroundBashHold.awaitSettlement()
      foregroundBashHold.dispose()
    }
  })

  it("materializes code mode for every runner realm", async () => {
    let materializations = 0
    const hit = { server: "github", name: "issue_get", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }
    const ports = {
      servers: () => ["github"],
      tools: () => {
        materializations += 1
        return [hit]
      },
      call: async () => { throw new Error("unused in this test") },
    } satisfies McpPorts
    const moduleServices = composeModuleServices([["mcp", { ports }], ["code-mode", codeModeService()]])

    const chat = await assembledSurface("chat", { runtimeSurfaces: { moduleServices } })
    expect(chat.tools.has("code")).toBe(true)
    expect(chat.tools.has("github.issue_get")).toBe(false)
    expect(materializations).toBe(1)

    const worker = await assembledSurface("workflow-agent", { runtimeSurfaces: { moduleServices } })
    expect(worker.tools.has("code")).toBe(true)
    expect(worker.tools.has("github.issue_get")).toBe(false)
    expect(materializations).toBe(2)
  })
})

describe("request-local skill revision", () => {
  it("adds and removes chat review guidance with the next request's advertised roster", async () => {
    let revision = publishSkillRevision(1, new Map([["other", testSkill("other")]]))
    const definitions = { ...repoDefinitions(), skills: () => revision }
    const assembled = await assembledRuntime("chat", {
      capabilityAccess: capabilityAccessFor({
        state: () => ({ moduleIds: [], capabilities: ["skills"], requireWorkflowConfirmation: true, workflowsMode: "off", identity: "skills" }),
        admit: async (request) => ({ ok: false, missing: request.required, reason: "prompt test does not admit work" }),
      }),
    }, definitions)
    if (!assembled.tools || !("resolve" in assembled.tools)) throw new Error("expected request tool surface owner")
    const systemPrompt = assembled.systemPrompt
    if (typeof systemPrompt !== "function") throw new Error("expected request-local system prompt")
    const attempt = await modelClient().plannedAttempt()
    const prompt = async () => renderSystemPrompt(await systemPrompt(attempt, providerRuntime(assembled.tools.current()).interactionProfile))

    await assembled.tools.resolve()
    expect(await prompt()).not.toContain("load the `code-review` skill")
    expect(await prompt()).not.toContain("code-review:")

    revision = publishSkillRevision(2, new Map([
      ["code-review", testSkill("code-review")],
      ["other", testSkill("other")],
    ]))
    await assembled.tools.resolve()
    expect(await prompt()).toContain("load the `code-review` skill")
    expect(await prompt()).toContain("code-review:")

    revision = publishSkillRevision(3, new Map([["other", testSkill("other")]]))
    await assembled.tools.resolve()
    expect(await prompt()).not.toContain("load the `code-review` skill")
    expect(await prompt()).not.toContain("code-review:")
  })
})

describe("runtime tool surface completion", () => {
  it("preserves all generation-owned surfaces under admission", () => {
    const moduleServices = composeModuleServices([])
    const webSearchCapability = { available: () => true, run: async () => ({ results: [] }) } satisfies WebSearchPort
    const webSearch = () => webSearchCapability
    const gitAiAttribution: NonNullable<RuntimeToolSurfaces["gitAiAttribution"]> = {
      canonicalRepositoryRoot: "/repo",
      status: () => ({ kind: "available" }), subscribe: () => () => {}, checkAvailability: async () => ({ kind: "available" }),
      registerRequest: () => undefined, direct: () => {}, dispose: async () => {},
    }
    const generation = { moduleServices, webSearch, gitAiAttribution }

    expect(completeRuntimeToolSurfaces({}, generation)).toEqual(generation)
  })

  it("keeps every runner-local surface, including a workflow attempt's child-skill grant", () => {
    const externalSkillChildGrant = { skillIds: ["fixture.child"], run: async () => ({ skillId: "fixture.child", output: {} }) }
    const local = { externalSkillChildGrant, workflowMode: () => "on" as const }
    const generation = { moduleServices: composeModuleServices([]) }

    expect(completeRuntimeToolSurfaces(local, generation)).toEqual({ ...local, ...generation })
  })

})
