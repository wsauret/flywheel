import { describe, expect, it } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import type { ConversationMessage, ProviderSessionLifetime } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { AgentLoopOptions } from "../../../../src/orchestration/agent-runtime/agent-loop-types.js"
import { seedAgentLoopTurn } from "../../../../src/orchestration/agent-runtime/agent-loop-history.js"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { holdSharedTree } from "../../../../src/orchestration/agent-runtime/shared-tree.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { createConversationMessageEntry } from "../../../../src/orchestration/session/conversation/conversation-tree.js"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { unusedSessionMessaging } from "../../../helpers/child-session-control.js"
import { assembledRuntime, CALL_NO_TOOLS, providerRuntime } from "./_runtime-assembly-harness.js"

describe("side calls of a chat tree", () => {
  const sideCalls: readonly AgentOptions["purpose"][] = [
    { kind: "session-title" },
    { kind: "chat-side-call" },
    { kind: "learning-review-audit", prompt: { kind: "literal", systemPrompt: "audit" } },
    { kind: "subagent-failure-summary", prompt: { kind: "literal", systemPrompt: "summarize" } },
    { kind: "chat-learning-review", review: { reviewRunId: "review" } },
    { kind: "workflow-learning-review", review: { reviewRunId: "review" } },
  ]
  async function hosted(purpose: AgentOptions["purpose"], override: Partial<AgentOptions> = {}) {
    const scope = Effect.runSync(Scope.make())
    let lifetime: ProviderSessionLifetime | undefined
    try {
      const assembled = await assembledRuntime("chat", { purpose, treeRootSessionId: "root-chat", ...override }, repoDefinitions(), undefined, { providerSessionKey: "side-call", scope }, (seen) => { lifetime = seen })
      const surface = await assembled.tools.resolve()
      return { assembled, surface, root: lifetime?.sharedHost?.treeRootSessionId, lifetime }
    } finally { Effect.runSync(Scope.close(scope, Exit.void)) }
  }

  for (const purpose of sideCalls) it(`runs ${purpose.kind} on its tree's host, advertised the tools of the tree's agents, and refuses calls outside its grant`, async () => {
    const side = await hosted(purpose)
    const agent = await hosted({ kind: "subagent", renderAs: "subagent", parentToolUseId: "call" }, { toolGrant: ["read"] })
    expect(side.root).toBe("root-chat")
    expect([...side.surface.tools.keys()]).toEqual([...agent.surface.tools.keys()])
    const usable = [...side.surface.tools.keys()].filter((name) => side.surface.usableToolNames.has(side.surface.registrationIdentities.get(name) ?? name))
    if (purpose.kind === "chat-learning-review" || purpose.kind === "workflow-learning-review") {
      // Without a conversation to keep notes in, the checkpoint tools are advertised and refuse their calls.
      expect(usable.toSorted()).toEqual(["memory", "skill", "skill_manage"])
      expect(side.assembled.initialRequestContext).toContain(`## Tools\n\nYou may call these tools: ${usable.join(", ")}.`)
    } else {
      expect(usable).toEqual([])
      expect(side.assembled.initialRequestContext).toBe(CALL_NO_TOOLS)
    }
  })

  it("keeps a chat on its own process, which prefers the login of its tree's live host", async () => {
    const { tree, release } = holdSharedTree("root-chat", () => ({ modules: composeFirstPartyModules(), shellWriteGuard: true }))
    const endHost = tree.hold("login-b")
    try {
      const chat = await hosted({ kind: "interactive-chat" })
      expect(chat.root).toBeUndefined()
      expect(chat.lifetime?.treeLogin?.()).toBe("login-b")
    } finally { endHost(); release() }
  })
})

describe("prompt-cache key of a run", () => {
  const ROOT = "root-chat"
  /** An agent with a durable conversation of its own, in the session tree rooted at ROOT. */
  const treeAgent = (purpose: AgentOptions["purpose"]): Partial<AgentOptions> => ({
    purpose,
    conversation: {
      kind: "durable-tree", sessionId: "agent-session", conversationId: "agent-conversation", priorMessages: [{ kind: "user", content: "task", origin: "system" }],
      reserveMessageId: async () => crypto.randomUUID(), captureCommittedForkMessages: async () => [], resolveLeafId: async () => null,
      append: () => {}, committedTree: async () => ({ leafId: null, entriesById: {} }),
    },
    runtimeSurfaces: {
      sessions: { ...unusedSessionMessaging(), identity: async () => ({ sessionId: "agent-session", conversationId: "agent-conversation", kind: "subagent", rootSessionId: ROOT }) },
      handoff: { onContent: () => {}, schema: { input: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
    },
  })

  it("is the tree root for every agent and side call of a chat tree, and the run's own key outside a tree", async () => {
    const subagent = await assembledRuntime("chat", treeAgent({ kind: "subagent", renderAs: "subagent", parentToolUseId: "call" }))
    const workflowAgent = await assembledRuntime("chat", treeAgent({ kind: "workflow-agent", briefScope: { briefId: "implement" }, workflowAttemptId: "attempt" }))
    const sideCall = await assembledRuntime("chat", { purpose: { kind: "chat-side-call" }, treeRootSessionId: ROOT })
    const outside = await assembledRuntime("headless")
    // The identity stays the run's own key; only the cache group is the tree's.
    for (const run of [subagent, workflowAgent, sideCall]) expect({ providerSessionKey: run.providerSessionKey, promptCacheKey: run.promptCacheKey }).toEqual({ providerSessionKey: "conversation-1", promptCacheKey: ROOT })
    expect(outside.promptCacheKey).toBe("conversation-1")
  })
})

describe("tree-hosted tool notice", () => {
  const subagent: AgentOptions["purpose"] = { kind: "subagent", renderAs: "subagent", parentToolUseId: "call" }
  /** A durable conversation whose appends land in an in-memory tree. */
  function durableTree() {
    const entries = new Map<string, ConversationEntry>()
    const appended: { message: ConversationMessage; entryId: string | undefined }[] = []
    const conversation = (priorMessages: readonly ConversationMessage[]): AgentOptions["conversation"] => ({
      kind: "durable-tree", sessionId: "session", conversationId: "agent", priorMessages,
      reserveMessageId: async () => crypto.randomUUID(), captureCommittedForkMessages: async () => [], resolveLeafId: async () => null,
      append: (message, entryId) => {
        appended.push({ message, entryId })
        if (entryId !== undefined) entries.set(entryId, createConversationMessageEntry(message, entryId, null, new Date().toISOString()))
      },
      committedTree: async () => ({ leafId: null, entriesById: Object.fromEntries(entries) }),
    })
    return { appended, conversation }
  }
  const seeded = (assembled: AgentLoopOptions): readonly ConversationMessage[] => assembled.seed.kind === "resume" ? assembled.seed.priorMessages : []

  it("commits the refused tools once into a durable agent's opening turn, and a resume commits nothing again", async () => {
    const tree = durableTree()
    const task: ConversationMessage = { kind: "user", content: "task", origin: "system" }
    const first = await assembledRuntime("chat", { purpose: subagent, conversation: tree.conversation([task]), toolGrant: ["read", "handoff"] })
    const surface = await first.tools.resolve()
    const advertised = [...surface.tools.keys()]
    const usable = advertised.filter((name) => surface.usableToolNames.has(surface.registrationIdentities.get(name) ?? name))
    expect(usable).toContain("read")
    expect(usable).not.toContain("edit")

    expect(tree.appended).toHaveLength(1)
    const [notice] = tree.appended
    if (notice === undefined) throw new Error("expected the notice entry")
    expect(notice.entryId).toBe("tool-notice:agent")
    const text = notice.message.kind === "user" && typeof notice.message.content === "string" ? notice.message.content : ""
    const named = /You may call these tools: (.*)\. A call to any other tool is refused\./.exec(text)?.[1]?.split(", ")
      ?? /These listed tools do not work for you: (.*)\. Do not call them/.exec(text)?.[1]?.split(", ")
    expect(named).toEqual(text.startsWith("## Tools\n\nYou may call") ? usable : advertised.filter((name) => !usable.includes(name)))
    expect(seeded(first)).toEqual([task, notice.message])
    // The notice lives in the opening turn only, never in the tools or the system text.
    if (typeof first.systemPrompt !== "function") throw new Error("expected assembled prompt")
    expect(renderSystemPrompt(await first.systemPrompt(providerRuntime(surface).plannedAttempt, providerRuntime(surface).interactionProfile))).not.toContain(text)
    expect(first.initialRequestContext).toBeUndefined()

    // The life's echo and reply debt read the task, never the notice that follows it.
    const echoed: unknown[] = []
    const seed = { seed: first.seed, instruction: null, pushUser: () => undefined, onUserMessage: (content: unknown) => { echoed.push(content) } }
    expect(await seedAgentLoopTurn({ ...seed, messages: seeded(first) })).toBe(false)
    expect(echoed).toEqual(["task"])
    expect(await seedAgentLoopTurn({ ...seed, messages: [{ kind: "user", content: "hello", origin: "human" }, notice.message] })).toBe(true)
    expect(echoed).toEqual(["task", "hello"])

    const resumed = await assembledRuntime("chat", { purpose: subagent, conversation: tree.conversation(seeded(first)), toolGrant: ["read", "handoff"] })
    expect(tree.appended).toHaveLength(1)
    expect(seeded(resumed)).toEqual(seeded(first))
  })

  it("gives a tree-hosted agent that keeps no history the notice as request context", async () => {
    const assembled = await assembledRuntime("chat", { purpose: subagent, toolGrant: ["read", "handoff"] })
    expect(assembled.initialRequestContext).toStartWith("## Tools\n\n")
  })

  it("gives a chat no notice", async () => {
    const tree = durableTree()
    const task: ConversationMessage = { kind: "user", content: "hello" }
    const assembled = await assembledRuntime("chat", { purpose: { kind: "interactive-chat" }, conversation: tree.conversation([task]), toolGrant: ["read", "handoff"] })
    expect(tree.appended).toEqual([])
    expect(seeded(assembled)).toEqual([task])
    expect(assembled.initialRequestContext).toBeUndefined()
  })
})
