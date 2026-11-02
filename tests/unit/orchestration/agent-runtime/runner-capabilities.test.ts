import { createHash } from "node:crypto"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { testDirectories } from "../../../helpers/directories.js"
import { capabilityAccessFor, type CapabilityAccess } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import type { LLMClientFactory } from "../../../../src/orchestration/agent-runtime/factory.js"
import { asModelClient } from "./_model-client.js"
import { composeRealmModuleSnapshot, type ModuleId } from "../../../../src/orchestration/modules.js"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { moduleRuntimeHandle } from "../../../../src/infra/module-runtime.js"

const MEMORY_ENTRY = "the-durable-memory-probe-entry"

const projectRoots: string[] = []

function projectWithMemory(): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-runner-capabilities-"))
  projectRoots.push(root)
  mkdirSync(join(root, ".flywheel", "memory"), { recursive: true })
  writeFileSync(join(root, ".flywheel", "memory", "MEMORY.json"), JSON.stringify({ version: 1, entries: [{ content: MEMORY_ENTRY, protected: false }] }))
  return root
}

/** Captures the system prompt of every request the run makes, which is where a
 *  loaded memory snapshot becomes model-visible. */
function capturingClientFactory(prompts: string[], onRequest?: (index: number) => boolean): LLMClientFactory {
  return async () => asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" } },
    async *streamWithTools(options) {
      const index = prompts.length
      prompts.push(renderSystemPrompt(options.systemPrompt))
      // A tool call keeps the run going, so the next request re-resolves its
      // surface and its prompt contributions.
      if (onRequest?.(index)) {
        yield { kind: "tool_use", toolCall: { id: `tc_${index}`, name: "read", input: { path: "/nonexistent-memory-probe" } } }
        yield { kind: "done", stopReason: "tool_use" }
        return
      }
      yield { kind: "done", stopReason: "end_turn" }
    },
  })
}

interface CapabilityRequestObservation {
  readonly providerIds: readonly string[]
  readonly systemPromptHash: string
  readonly toolSurfaceHash: string
  readonly systemPrompt: string
  readonly toolNames: readonly string[]
}

function coherentClientFactory(
  observations: CapabilityRequestObservation[],
  afterRequest: (index: number) => void,
): LLMClientFactory {
  return async (_model, moduleSnapshot) => {
    if (!moduleSnapshot) throw new Error("request client requires a capability composition")
    const providerIds = moduleSnapshot.contributions.flatMap((contribution) =>
      contribution.domain === "providers" ? [contribution.value.definition.id] : [],
    )
    return asModelClient({
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      priceFor() { return { status: "unavailable", reason: "missing-rate-card" } },
      async *streamWithTools(options) {
        const index = observations.length
        observations.push({
          providerIds,
          systemPromptHash: createHash("sha256").update(renderSystemPrompt(options.systemPrompt)).digest("hex"),
          toolSurfaceHash: createHash("sha256").update(JSON.stringify(options.tools)).digest("hex"),
          systemPrompt: renderSystemPrompt(options.systemPrompt),
          toolNames: options.tools.map((tool) => tool.name),
        })
        afterRequest(index)
        if (index < 2) {
          yield { kind: "tool_use", toolCall: { id: `tc_${index}`, name: "read", input: { path: "/nonexistent-capability-probe" } } }
          yield { kind: "done", stopReason: "tool_use" }
          return
        }
        yield { kind: "done", stopReason: "end_turn" }
      },
    })
  }
}

function access(held: readonly ModuleId[]): CapabilityAccess {
  return mutableAccess(new Set(held))
}

/** The same boundary over a selection a case can change mid-run. */
function mutableAccess(held: Set<ModuleId>): CapabilityAccess {
  return capabilityAccessFor({
    state: () => ({ capabilities: [...held], moduleIds: [...held], requireWorkflowConfirmation: true, workflowsMode: "off", identity: [...held].join("+") }),
    admit: async (request) => {
      const missing = request.required.filter((capability) => !held.has(capability))
      return missing.length === 0
        ? {
            ok: true,
            grant: {
              operation: request.operation,
              required: request.required,
              capabilities: [...held],
              moduleIds: [...held],
              requireWorkflowConfirmation: true,
              workflowsMode: "off",
              identity: [...held].join("+"),
            },
          }
        : { ok: false, missing, reason: `${request.operation} is unavailable` }
    },
  })
}

async function runWith(capabilityAccess: CapabilityAccess, moduleSelection: () => ReturnType<typeof composeRealmModuleSnapshot>, onRequest?: (index: number) => boolean): Promise<string[]> {
  const prompts: string[] = []
  const projectRoot = projectWithMemory()
  const runner = newTestRunner(
    {
      model: "claude-haiku-4-5-20251001",
      ...testDirectories(projectRoot),
      agentRegistry: new Map(),
      agentsMd: "",
      onEvent: () => {},
      runtimeSurfaces: {},
      purpose: { kind: "interactive-chat" },
      conversation: { kind: "stateless" },
      lifecycle: { kind: "one-shot" },
      capabilityAccess,
      moduleSelection,
    },
    capturingClientFactory(prompts, onRequest),
  )
  runner.send("hello")
  await runner.done
  return prompts
}

afterEach(() => {
  for (const root of projectRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("agent runner memory reads under capability policy", () => {
  test("loads the durable memory store into the prompt while Learning is held", async () => {
    const prompt = (await runWith(access(["learning"]), () => composeRealmModuleSnapshot({ moduleIds: ["learning"] }))).join("\n")

    expect(prompt).toContain("Durable Memory")
    expect(prompt).toContain(MEMORY_ENTRY)
  })

  test("never reads the memory store while Learning is off", async () => {
    const prompt = (await runWith(access([]), () => composeRealmModuleSnapshot({ moduleIds: [] }))).join("\n")

    expect(prompt).not.toContain("Durable Memory")
    expect(prompt).not.toContain(MEMORY_ENTRY)
  })

  test("omits the memory bytes from the next request after Learning is turned off", async () => {
    const held = new Set<ModuleId>(["learning"])
    // The request in flight keeps the prompt it opened with; the disable lands
    // between requests, exactly as it does for a parked runner.
    const prompts = await runWith(
      mutableAccess(held),
      () => composeRealmModuleSnapshot({ moduleIds: [...held] }),
      (index) => {
        if (index > 0) return false
        held.delete("learning")
        return true
      },
    )

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain(MEMORY_ENTRY)
    expect(prompts[1]).not.toContain(MEMORY_ENTRY)
    expect(prompts[1]).not.toContain("Durable Memory")
  })
})

describe("parked runner request capability composition", () => {
  test("captures tools, prompt guidance, and provider registry together on every request", async () => {
    const projectRoot = projectWithMemory()
    const enabled = ["file-tools", "learning", "provider-anthropic-api"]
    const disabled = ["file-tools", "provider-openai-api"]
    let moduleIds = enabled
    const observations: CapabilityRequestObservation[] = []
    const runner = newTestRunner(
      {
        model: "claude-haiku-4-5-20251001",
        ...testDirectories(projectRoot),
        agentRegistry: new Map(),
        agentsMd: "",
        onEvent: () => {},
        runtimeSurfaces: {},
        purpose: { kind: "interactive-chat" },
        conversation: { kind: "stateless" },
        lifecycle: { kind: "one-shot" },
        capabilityAccess: access(["learning"]),
        moduleSelection: () => composeRealmModuleSnapshot({ moduleIds }),
      },
      coherentClientFactory(observations, (index) => {
        if (index === 0) moduleIds = disabled
        else if (index === 1) moduleIds = enabled
      }),
    )

    runner.send("hello")
    await runner.done

    expect(observations).toHaveLength(3)
    expect(observations.map(({ providerIds }) => providerIds)).toEqual([
      ["anthropic_api"],
      ["openai_api"],
      ["anthropic_api"],
    ])
    expect(observations[0]?.toolNames).toContain("memory")
    expect(observations[0]?.systemPrompt).toContain(MEMORY_ENTRY)
    expect(observations[1]?.toolNames).not.toContain("memory")
    expect(observations[1]?.systemPrompt).not.toContain(MEMORY_ENTRY)
    expect(observations[2]?.toolNames).toContain("memory")
    expect(observations[2]?.systemPrompt).toContain(MEMORY_ENTRY)
    expect(observations[0]?.toolSurfaceHash).not.toBe(observations[1]?.toolSurfaceHash)
    expect(observations[0]?.systemPromptHash).not.toBe(observations[1]?.systemPromptHash)
    expect(observations[2]?.toolSurfaceHash).toBe(observations[0]?.toolSurfaceHash)
    expect(observations[2]?.systemPromptHash).toBe(observations[0]?.systemPromptHash)
  })

  test("serves a module turned on after the runner was assembled from the next request", async () => {
    const projectRoot = projectWithMemory()
    let moduleIds = ["file-tools", "provider-anthropic-api"]
    const assembled: boolean[] = []
    const observations: CapabilityRequestObservation[] = []
    const runner = newTestRunner(
      {
        model: "claude-haiku-4-5-20251001",
        ...testDirectories(projectRoot),
        agentRegistry: new Map(),
        agentsMd: "",
        onEvent: () => {},
        runtimeSurfaces: {},
        purpose: { kind: "interactive-chat" },
        conversation: { kind: "stateless" },
        lifecycle: { kind: "one-shot", onRuntimeAssembled: ({ modules }) => { assembled.push(modules.get(moduleRuntimeHandle("learning")) !== undefined) } },
        capabilityAccess: access(["learning"]),
        moduleSelection: () => composeRealmModuleSnapshot({ moduleIds }),
      },
      coherentClientFactory(observations, (index) => {
        if (index === 0) moduleIds = [...moduleIds, "learning"]
        else if (index === 1) moduleIds = moduleIds.filter((id) => id !== "learning")
      }),
    )

    runner.send("hello")
    await runner.done

    expect(observations.map(({ toolNames }) => toolNames.includes("memory"))).toEqual([false, true, false])
    expect(observations[1]?.systemPrompt).toContain(MEMORY_ENTRY)
    expect(assembled).toEqual([false, true, false])
  })
})
