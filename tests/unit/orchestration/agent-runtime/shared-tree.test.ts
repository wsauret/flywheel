import { describe, expect, it, spyOn } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { detectModelFamily } from "../../../../src/infra/llm/model-family.js"
import type { ConversationMessage, ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { createForegroundBashHoldController } from "../../../../src/orchestration/agent-runtime/foreground-bash-hold.js"
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { captureForkMessages } from "../../../../src/orchestration/agent-runtime/agent-loop-history.js"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { holdSharedTree } from "../../../../src/orchestration/agent-runtime/shared-tree.js"
import type { AgentOptions, RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import type { RuntimeToolInput } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { composeFirstPartyModules, type FirstPartyModuleComposition } from "../../../../src/orchestration/modules.js"
import { unusedSessionMessaging } from "../../../helpers/child-session-control.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testDirectories } from "../../../helpers/directories.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"
import { testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { makeContext } from "./tools/_fixtures.js"
import { asModelClient } from "./_model-client.js"

const ALL = composeFirstPartyModules()
const PAPERCUTS_OFF = composeFirstPartyModules(undefined, ["papercuts"])
const SUBAGENT: AgentOptions["purpose"] = { kind: "subagent", renderAs: "subagent", parentToolUseId: "call" }
const WORKFLOW_AGENT: AgentOptions["purpose"] = { kind: "workflow-agent", briefScope: { briefId: "implement" }, workflowAttemptId: "attempt" }

const modelClient = (model: string) => asModelClient({
  accessProvider: "anthropic_api" as const,
  modelFamily: detectModelFamily(model) ?? "anthropic",
  model,
  contextLimit: 100_000,
  outputLimit: 8_000,
  supportsReasoning: false,
  promptNotes: { progress: "", modelNotes: "" },
  priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
    yield { kind: "done", stopReason: "end_turn" }
  },
})

/** One tree-hosted agent of the chat tree `root`: its session, its durable opening turn, and its provider lifetime,
 *  which `end` closes as the runner does. With `runScope`, the provider lifetime outlives the run, as a session's
 *  pre-start's does, and `endRun` closes the run's scope alone. `shellWriteGuard` and `allowPersistentProcesses` are the
 *  configuration's values. */
async function treeAgent(root: string, sessionId: string, purpose: AgentOptions["purpose"], moduleSelection: () => FirstPartyModuleComposition, held: { readonly runScope?: Scope.Closeable; readonly shellWriteGuard?: boolean; readonly allowPersistentProcesses?: boolean; readonly capabilityAccess?: RunnableAgentOptions["capabilityAccess"] } = {}) {
  const appended: ConversationMessage[] = []
  const failing = { next: false }
  // The module selections that admitted this agent's providers.
  const providerModules: FirstPartyModuleComposition[] = []
  const task: ConversationMessage = { kind: "user", content: "task", origin: "system" }
  const scope = await Effect.runPromise(Scope.make())
  // A chat runner always gives its agents a background owner and a foreground hold, which bash requires to run.
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
  const options: RunnableAgentOptions = {
    model: "test",
    ...testDirectories(process.cwd()),
    purpose,
    agentsMd: "",
    onEvent: () => {},
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: () => ({ ...testRuntimeConfigCapture(), shellWriteGuard: held.shellWriteGuard ?? true, allowPersistentProcesses: held.allowPersistentProcesses ?? false }),
    captureProviderConnection: async () => { throw new Error("unused in this test") },
    runtimeSurfaces: {
      launcher: refusingLauncher,
      background,
      foregroundBashHold: createForegroundBashHoldController(() => {}),
      sessions: { ...unusedSessionMessaging(), identity: async () => ({ sessionId, conversationId: sessionId, kind: "subagent", rootSessionId: root }) },
    },
    moduleSelection,
    ...(held.capabilityAccess === undefined ? {} : { capabilityAccess: held.capabilityAccess }),
    conversation: {
      kind: "durable-tree", sessionId, conversationId: sessionId, priorMessages: [task],
      reserveMessageId: async () => crypto.randomUUID(), captureCommittedForkMessages: async () => [], resolveLeafId: async () => null,
      append: async (message) => {
        if (failing.next) { failing.next = false; throw new Error("append failed") }
        appended.push(message)
      },
      committedTree: async () => ({ leafId: null, entriesById: {} }),
    },
    lifecycle: { kind: "one-shot" },
  }
  const signal = new AbortController().signal
  const assembled = await assembleRuntimeForTurn({
    options,
    definitions: repoDefinitions(),
    conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: sessionId, artifactScopeId: sessionId, retrievalSessionId: sessionId }),
    signal,
    disposalSignal: signal,
    instruction: null,
    currentTurn: undefined,
    personas: new Map(),
    captureModelRuntime: async () => ({ generation: {}, createLLMClient: async (model, modules) => { if (modules) providerModules.push(modules); return modelClient(model) } }),
    createRunner: () => { throw new Error("unused in this test") },
    providerSessionLifetime: { providerSessionKey: sessionId, scope },
    ...(held.runScope === undefined ? {} : { runScope: held.runScope }),
  })
  const surface = await assembled.tools.resolve()
  const runtime = surface.providerRuntime
  if (!runtime) throw new Error("expected provider runtime")
  await surface.prepareStablePrompt(() => stableSystemPrompt(""), runtime.interactionProfile)
  const definitions = JSON.stringify(surface.prepareAttempt(runtime.plannedAttempt).tools)
  const call = async (name: string, input: RuntimeToolInput = {}) => {
    const tool = surface.tools.get(name)
    if (!tool) throw new Error(`expected the advertised tool ${name}`)
    return (await tool.execute(input, makeContext())).content
  }
  const advertised = [...surface.tools.keys()]
  // The opening turn's notice names the shorter list: the tools the agent may call, or those it may not.
  const notice = appended.map((message) => typeof message.content === "string" ? message.content : "").join("\n")
  const allowed = /You may call these tools: (.*)\. A call to any other tool is refused\./u.exec(notice)?.[1]?.split(", ")
  const refused = /These listed tools do not work for you: (.*)\. Do not call them/u.exec(notice)?.[1]?.split(", ") ?? []
  const callable = allowed ?? advertised.filter((name) => !refused.includes(name))
  return {
    definitions, advertised, call, callable, providerModules, appended,
    opening: assembled.seed.kind === "resume" ? assembled.seed.priorMessages : [],
    /** The narrowing statements that the agent's next request appends after `history`: the request is planned
     *  first, as the loop plans each request before it appends its reminders. */
    narrowing: async (history: readonly ConversationMessage[], afterPlan?: () => void) => {
      await assembled.tools.resolve()
      afterPlan?.()
      return (await assembled.turnReminders?.(history) ?? [])
        .flatMap((message) => typeof message.content === "string" && message.content.includes('mode="capabilities"') ? [message] : [])
    },
    /** Appends `message` to the agent's history, as the loop appends a request's reminders. */
    commit: async (message: ConversationMessage) => { await assembled.persistence.history.append(message) },
    /** Makes the next append of the agent's history reject. */
    failNextAppend: () => { failing.next = true },
    agentCheck: surface.capabilities, availability: surface.definitionAvailability,
    end: async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await background.close() },
    endRun: () => held.runScope === undefined ? Promise.resolve() : Effect.runPromise(Scope.close(held.runScope, Exit.void)),
  }
}

const REFUSAL = "The papercut_log tool is unavailable to this agent now: papercuts is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml. Do not call papercut_log again."

describe("the module capture of a chat tree's shared host", () => {
  it("gives an agent that starts after a module turned off the tree's tool bytes, and refuses that module's tools", async () => {
    let live = ALL
    const first = await treeAgent("root-turned-off", "agent-1", SUBAGENT, () => live)
    expect(first.callable).toContain("papercut_log")
    live = PAPERCUTS_OFF
    const second = await treeAgent("root-turned-off", "agent-2", SUBAGENT, () => live)

    expect(second.definitions).toBe(first.definitions)
    expect(await second.call("papercut_log")).toBe(REFUSAL)
    expect(second.callable).not.toContain("papercut_log")
    // Shared text reads the tree's availability; the agent check reads the agent's own selection.
    expect(second.availability.tree).toBe(first.availability.tree)
    expect(second.availability.live).not.toBe(first.availability.live)
    expect(first.agentCheck("papercut_log")).toBe(true)
    expect(second.agentCheck("papercut_log")).toBe(false)
    // The capture fixes advertised tools only: the live selection admits providers.
    expect(second.providerModules).toEqual([PAPERCUTS_OFF])
    await first.end()
    await second.end()
  })

  it("is released when the host and every runner of the tree end, and the next agent of the tree captures again", async () => {
    let live = ALL
    const agent = await treeAgent("root-released", "agent-1", SUBAGENT, () => live)
    // The host holds the tree as each other holder does (`SharedTree.hold`).
    const { release: releaseHost } = holdSharedTree("root-released", () => { throw new Error("the tree is held") })
    await agent.end()
    live = PAPERCUTS_OFF
    const whileHostLives = await treeAgent("root-released", "agent-2", SUBAGENT, () => live)
    expect(whileHostLives.advertised).toContain("papercut_log")
    await whileHostLives.end()
    releaseHost()

    const next = await treeAgent("root-released", "agent-3", SUBAGENT, () => live)
    expect(next.advertised).not.toContain("papercut_log")
    await next.end()
  })

  it("is released by a run whose provider lifetime outlives it, such as a session's pre-start, when the run ends", async () => {
    let live = ALL
    const prestart = await treeAgent("root-run-scope", "agent-1", SUBAGENT, () => live, { runScope: Scope.makeUnsafe("sequential") })
    await prestart.endRun()
    live = PAPERCUTS_OFF
    const next = await treeAgent("root-run-scope", "agent-2", SUBAGENT, () => live)
    expect(next.advertised).not.toContain("papercut_log")
    await next.end()
    await prestart.end()
  })

  it("gives an agent that starts after the shell write guard turned off the tree's shell bytes, until the tree is captured again", async () => {
    // Only the shell's description states the write roots.
    const writeRoots = "Keep writes inside the project"
    const first = await treeAgent("root-write-guard", "agent-1", SUBAGENT, () => ALL)
    const second = await treeAgent("root-write-guard", "agent-2", SUBAGENT, () => ALL, { shellWriteGuard: false })

    expect(second.definitions).toBe(first.definitions)
    expect(second.definitions).toContain(writeRoots)
    await first.end()
    await second.end()
    const next = await treeAgent("root-write-guard", "agent-3", SUBAGENT, () => ALL, { shellWriteGuard: false })
    expect(next.definitions).not.toContain(writeRoots)
    await next.end()
  })

  it("gives an agent that starts after persistent processes turned off the tree's shell bytes, and refuses persistence at execution", async () => {
    const first = await treeAgent("root-persistence", "agent-1", SUBAGENT, () => ALL, { allowPersistentProcesses: true })
    const second = await treeAgent("root-persistence", "agent-2", SUBAGENT, () => ALL, { allowPersistentProcesses: false })

    expect(first.definitions).toContain("persist_after_exit")
    expect(second.definitions).toBe(first.definitions)
    expect(await second.call("bash", { command: "server", background: true, persist_after_exit: true })).toBe("The persist_after_exit input of bash is unavailable to this agent now. Do not send it again.")
    await first.end()
    await second.end()
    const next = await treeAgent("root-persistence", "agent-3", SUBAGENT, () => ALL, { allowPersistentProcesses: false })
    expect(next.definitions).not.toContain("persist_after_exit")
    await next.end()
  })

  it("gives a workflow agent whose admission lacks a module the tree's tools, and refuses that module's tools from its first turn", async () => {
    const chatSubagent = await treeAgent("root-workflow", "agent-1", SUBAGENT, () => ALL)
    const workflowAgent = await treeAgent("root-workflow", "agent-2", WORKFLOW_AGENT, () => PAPERCUTS_OFF)

    expect(workflowAgent.advertised).toEqual(chatSubagent.advertised)
    expect(await workflowAgent.call("papercut_log")).toBe(REFUSAL)
    expect(chatSubagent.callable).toContain("papercut_log")
    expect(workflowAgent.callable).not.toContain("papercut_log")
    await chatSubagent.end()
    await workflowAgent.end()
  })
})

describe("the narrowing statement of a tree-hosted agent", () => {
  const PAPERCUTS_AND_LEARNING_OFF = composeFirstPartyModules(undefined, ["papercuts", "learning"])
  const PAPERCUTS_STATEMENT = "Turned off for you while this chat tree runs: Papercuts. Text about them in your tools, instructions, and earlier turns no longer applies, and their calls are refused."
  const text = (message: ConversationMessage | undefined) => typeof message?.content === "string" ? message.content : ""
  const narrowedRecords = (record: { mock: { calls: Parameters<typeof DebugLog.record>[] } }) => record.mock.calls
    .filter(([input]) => input.type === "agent.capabilities.narrowed")
    .map(([input]) => input.payload)

  it("states the modules that its first plan turned off in its tool notice, and no request repeats them", async () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    const first = await treeAgent("root-narrowed-first", "agent-1", SUBAGENT, () => ALL)
    const second = await treeAgent("root-narrowed-first", "agent-2", SUBAGENT, () => PAPERCUTS_OFF)
    try {
      const [notice] = second.appended
      expect(second.appended).toHaveLength(1)
      expect(text(notice)).toContain(`<system-reminder mode="capabilities" state="narrowed" modules="papercuts">\n${PAPERCUTS_STATEMENT}\n</system-reminder>`)
      expect(text(notice)).toContain("These listed tools do not work for you")
      expect(await second.narrowing(second.opening)).toEqual([])
      expect(narrowedRecords(record)).toEqual([{ via: "tool-notice", moduleIds: ["papercuts"], count: 1 }])
      // An agent that its tree's capture does not narrow is told nothing of it.
      expect(first.appended.map(text).join("\n")).not.toContain('mode="capabilities"')
      expect(await first.narrowing(first.opening)).toEqual([])
    } finally {
      record.mockRestore()
      await first.end()
      await second.end()
    }
  })

  it("states a later narrowing once before the next request, naming every module turned off", async () => {
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    let live = ALL
    const agent = await treeAgent("root-narrowed-later", "agent-1", SUBAGENT, () => live)
    try {
      const history = [...agent.opening]
      // A switch after the request's plan reaches the next request: this one's statement agrees with its refusals.
      expect(await agent.narrowing(history, () => { live = PAPERCUTS_OFF })).toEqual([])
      const [statement, ...extra] = await agent.narrowing(history)
      expect(extra).toEqual([])
      expect(statement).toEqual({ kind: "user", origin: "system", framing: "tool-notice", content: `<system-reminder mode="capabilities" state="narrowed" modules="papercuts">\n${PAPERCUTS_STATEMENT}\n</system-reminder>` })
      if (!statement) throw new Error("expected a statement")
      // The statement names this agent's own grants, so a fork does not copy it.
      expect((await captureForkMessages([...history, statement])).map(text)).toEqual(["task"])
      // Building a request's statement records nothing, as a pre-start's draft does; a rejected append records
      // nothing; the append that lands records once.
      expect(narrowedRecords(record)).toEqual([])
      agent.failNextAppend()
      await expect(agent.commit(statement)).rejects.toThrow("append failed")
      expect(narrowedRecords(record)).toEqual([])
      await agent.commit(statement)
      expect(narrowedRecords(record)).toEqual([{ via: "statement", moduleIds: ["papercuts"], count: 1 }])
      history.push(statement)
      // An unchanged request states nothing again.
      expect(await agent.narrowing(history)).toEqual([])

      live = PAPERCUTS_AND_LEARNING_OFF
      const [wider] = await agent.narrowing(history)
      expect(text(wider)).toMatch(/modules="(learning,papercuts|papercuts,learning)"/)
      expect(text(wider)).toContain("Papercuts")
      expect(text(wider)).toContain("Learning")
      if (!wider) throw new Error("expected a wider statement")
      await agent.commit(wider)
      history.push(wider)
      expect(narrowedRecords(record)).toMatchObject([{ count: 1 }, { count: 2 }])

      // Every module turned back on: one correction, which names what is on again, and then nothing.
      live = ALL
      const [correction, ...more] = await agent.narrowing(history)
      expect(more).toEqual([])
      expect(text(correction)).toContain('modules="">')
      expect(text(correction)).toMatch(/On again for you: (Learning, Papercuts|Papercuts, Learning)\./)
      expect(text(correction)).not.toContain("Turned off for you")
      if (correction) history.push(correction)
      expect(await agent.narrowing(history)).toEqual([])
    } finally {
      record.mockRestore()
      await agent.end()
    }
  })

  it("names only what execution refuses: a policy that denies Bash, whose tool needs no capability, turns nothing off", async () => {
    const denyBash = { available: (capability: string) => capability !== "bash", admit: async () => { throw new Error("unused in this test") } }
    const agent = await treeAgent("root-narrowed-policy", "agent-1", SUBAGENT, () => ALL, { capabilityAccess: denyBash })
    try {
      expect(agent.callable).toContain("bash")
      expect(agent.appended.map(text).join("\n")).not.toContain('mode="capabilities"')
      expect(await agent.narrowing(agent.opening)).toEqual([])
    } finally {
      await agent.end()
    }
  })

  it("states Background Commands turned off, whose part of the shell the tree's bash advertises, and its refusal names the module", async () => {
    const first = await treeAgent("root-narrowed-background", "agent-1", SUBAGENT, () => ALL)
    const second = await treeAgent("root-narrowed-background", "agent-2", SUBAGENT, () => composeFirstPartyModules(undefined, ["background-commands"]))
    try {
      expect(second.definitions).toBe(first.definitions)
      expect(text(second.appended[0])).toContain('<system-reminder mode="capabilities" state="narrowed" modules="background-commands">\nTurned off for you while this chat tree runs: Background Commands.')
      expect(await second.call("bash", { command: "server", background: true })).toBe("The background input of bash is unavailable to this agent now: background-commands is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml. Do not send it again.")
    } finally {
      await first.end()
      await second.end()
    }
  })

  it("reads a statement only from an entry with tool-notice framing, so a task that quotes the marker tells nothing", async () => {
    const first = await treeAgent("root-narrowed-quoted", "agent-1", SUBAGENT, () => ALL)
    const second = await treeAgent("root-narrowed-quoted", "agent-2", SUBAGENT, () => PAPERCUTS_OFF)
    try {
      const quoted: ConversationMessage = { kind: "user", origin: "system", content: 'Review the line <system-reminder mode="capabilities" state="narrowed" modules="papercuts"> in the narrowing code.' }
      // A history whose notice a fork dropped, followed by a task that quotes the marker mid-sentence.
      const history = [...second.opening.filter((message) => message.kind !== "user" || message.framing !== "tool-notice"), quoted]
      expect((await second.narrowing(history)).map(text)).toEqual([`<system-reminder mode="capabilities" state="narrowed" modules="papercuts">\n${PAPERCUTS_STATEMENT}\n</system-reminder>`])
    } finally {
      await first.end()
      await second.end()
    }
  })

  it("decides from the history alone, so a resume holds its statement and a fork that drops the notice is told again", async () => {
    const first = await treeAgent("root-narrowed-history", "agent-1", SUBAGENT, () => ALL)
    const second = await treeAgent("root-narrowed-history", "agent-2", SUBAGENT, () => PAPERCUTS_OFF)
    try {
      const resumed = [...second.opening, { kind: "assistant", content: [{ type: "text", text: "working" }] } satisfies ConversationMessage]
      expect(await second.narrowing(resumed)).toEqual([])
      // A fork copies no `tool-notice` framing, so it no longer holds the statement that the notice carried.
      const forked = resumed.filter((message) => message.kind !== "user" || message.framing !== "tool-notice")
      expect((await second.narrowing(forked)).map(text)).toEqual([`<system-reminder mode="capabilities" state="narrowed" modules="papercuts">\n${PAPERCUTS_STATEMENT}\n</system-reminder>`])
    } finally {
      await first.end()
      await second.end()
    }
  })
})

describe("the login of a chat tree's shared host", () => {
  it("is the login of the newest live host that holds the tree, and no login once no host holds it", () => {
    const { tree, release } = holdSharedTree("root-login", () => ({ modules: ALL, shellWriteGuard: true, allowPersistentProcesses: false }))
    const endFirst = tree.hold("login-1")
    const endSecond = tree.hold("login-2")
    expect(tree.login).toBe("login-2")
    endSecond()
    expect(tree.login).toBe("login-1")
    endFirst()
    expect(tree.login).toBeUndefined()
    release()
  })
})
