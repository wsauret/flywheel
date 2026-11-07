import { describe, expect, it } from "bun:test"

import { createChatSession } from "../../../../src/orchestration/chat/session"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { CapabilityPlanner, RequestPreparer } from "../../../../src/orchestration/agent-runtime/request-preparation"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles"
import { createTestChatSessionDeps, makeMemoryTreeWriter } from "./_chat-session-agent-runtime-fixtures"
import { flushMicrotasks } from "./_chat-runner-lifecycle-fixtures"
import { fakeAttempt } from "../agent-runtime/_model-client"
import { preparedRequest, streamOptions } from "../agent-runtime/llm/_provider-chain-harness"

const turnEnded = { handoffWritten: false, turnCount: 1 }
const parked = { ...turnEnded, activeBackgroundCount: 0, parkedOnBackgroundWork: false, waitRequested: false, userResumeRequired: false, park: "idle" as const }

/** A chat whose sends park at once, or fail when the test says so, and whose pre-starts (`prepareRequest`) the test
 *  reads apart from its sends. Each anticipation returns a claim, which records its release. Each refresh of the
 *  chat's environment (`refreshDeps`) moves its serving revision, which each pre-start records. */
function makeChat() {
  let failSends = false
  let failed: (() => void) | undefined
  let roles: ResolvedRoles = new Map([["chat", { roleId: "chat", model: "claude-opus", effort: "high" }]])
  let roleChanged: (() => void) | undefined
  let servingRevision = 1
  const prestarts: AgentOptions[] = []
  /** The serving revision that each pre-start prepared on, by its index in `prestarts`. */
  const prestartRevisions: number[] = []
  const sends: AgentOptions[] = []
  /** The pre-start of each claim that its holder released, by its index in `prestarts`. */
  const released: number[] = []
  /** Each claim and each release, in the order they happened, by the pre-start's index in `prestarts`. */
  const claims: string[] = []
  const prepareRequest: RequestPreparer = async (options) => {
    const index = prestarts.push(options) - 1
    prestartRevisions.push(servingRevision)
    const attempt = { ...fakeAttempt("anthropic_api", options.model ?? ""), anticipatesRequests: true as const }
    const anticipate = async () => {
      claims.push(`claim ${index}`)
      return { release: async () => { released.push(index); claims.push(`release ${index}`) } }
    }
    return { candidate: { attempt, client: { ...attempt, anticipate, streamWithTools: () => { throw new Error("a pre-start sends nothing") } }, prepared: preparedRequest(attempt) }, request: streamOptions }
  }
  /** The options that each capability plan (`ChatRunner.capabilities`) planned, and the check it answers. */
  const capabilityPlans: AgentOptions[] = []
  const plannedCheck = (term: string) => term === "bash"
  const planCapabilities: CapabilityPlanner = async (options) => { capabilityPlans.push(options); return plannedCheck }
  const createAgent = (options: AgentOptions): Agent => {
    sends.push(options)
    const done = Promise.withResolvers<AgentRunResult>()
    return {
      send() {
        if (failSends) {
          options.lifecycle.onLogicalTurnStarted?.({ origin: "user", reason: "new_input" })
          failed = () => { done.reject(new Error("the provider failed the turn")) }
          return
        }
        void (async () => {
          options.lifecycle.onLogicalTurnStarted?.({ origin: "user", reason: "new_input" })
          await options.lifecycle.onTurnEnded?.(turnEnded)
          await options.lifecycle.onTurnParked?.(parked)
        })().catch(() => {})
      },
      end() {},
      abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
      done: done.promise,
    }
  }
  const deps = createTestChatSessionDeps({
    sessionId: "session-engines",
    createAgent,
    prepareRequest,
    planCapabilities,
    treeWriter: makeMemoryTreeWriter(),
    resolveRoles: async () => roles,
    subscribeRoleChanges: (listener) => { roleChanged = listener; return async () => { roleChanged = undefined } },
    refreshEnvironment: async () => { servingRevision++ },
  })
  const chat = createChatSession({ onError: () => {}, onEnded: () => {} }, deps)
  const planned = () => prestarts.map((options) => `${options.purpose.kind === "interactive-chat" ? "chat" : "host"} ${options.model}`)
  const settled = async () => { for (let i = 0; i < 4; i++) await flushMicrotasks() }
  return {
    chat, prestarts, prestartRevisions, sends, planned, settled, released, claims, capabilityPlans, plannedCheck,
    failSends: () => { failSends = true },
    failTurn: () => { failed?.() },
    switchChat: (model: string) => { roles = new Map([["chat", { roleId: "chat", model, effort: "high" }]]); roleChanged?.() },
  }
}

describe("a chat runner's engines", () => {
  it("start when a client shows the session, on the provider runtime that the chat's sends take, and again at a turn end, a role change, and a reattach", async () => {
    const h = makeChat()
    await h.settled()
    expect(h.planned()).toEqual([])

    h.chat.setShown(true)
    await h.settled()
    expect(h.planned()).toEqual(["chat claude-opus", "host claude-opus"])
    // Showing the session prepares its requests and builds no run, so it sends no model request.
    expect(h.sends).toEqual([])

    void h.chat.send("first")
    await h.settled()
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.providerSession).toBe(h.prestarts[0]?.providerSession)
    expect(h.prestarts[0]?.conversation.kind).toBe("durable-tree")
    // A turn end plans the chat alone, and its new claim replaces the chat's older one.
    expect(h.planned()).toEqual(["chat claude-opus", "host claude-opus", "chat claude-opus"])
    expect(h.released).toEqual([0])

    h.switchChat("claude-sonnet")
    await h.settled()
    expect(h.planned().slice(3)).toEqual(["chat claude-sonnet", "host claude-sonnet"])
    // The new selection's claims come first; the claims they replace go after them.
    expect(h.released).toEqual([0, 2, 1])

    // The last client's release releases every claim at once.
    h.chat.setShown(false)
    await h.settled()
    expect(h.released.toSorted()).toEqual([0, 1, 2, 3, 4])
    h.switchChat("claude-haiku")
    await h.settled()
    expect(h.planned()).toHaveLength(5)

    // A reattach plans again.
    h.chat.setShown(true)
    await h.settled()
    expect(h.planned().slice(5)).toEqual(["chat claude-haiku", "host claude-haiku"])
  })

  it("answer the capabilities of the chat's next send without starting a turn or a pre-start", async () => {
    const h = makeChat()

    expect(await h.chat.capabilities()).toBe(h.plannedCheck)
    expect(h.capabilityPlans.map((options) => `${options.purpose.kind} ${options.model}`)).toEqual(["interactive-chat claude-opus"])
    expect(h.capabilityPlans[0]?.conversation.kind).toBe("durable-tree")
    expect(h.sends).toEqual([])
    expect(h.prestarts).toEqual([])

    // The plan follows the chat's provider runtime, which its next send takes.
    void h.chat.send("first")
    await h.settled()
    expect(h.capabilityPlans[0]?.providerSession).toBe(h.sends[0]?.providerSession)
  })

  it("plan again when the environment that serves them is refreshed, before the earlier claims go, and not while hidden", async () => {
    const h = makeChat()
    h.chat.setShown(true)
    await h.settled()
    expect(h.planned()).toEqual(["chat claude-opus", "host claude-opus"])

    await h.chat.refreshDeps?.()
    await h.settled()
    expect(h.planned().slice(2)).toEqual(["chat claude-opus", "host claude-opus"])
    expect(h.prestartRevisions).toEqual([1, 1, 2, 2])
    // Each new claim is installed before the claim that it replaces is released.
    expect(h.claims).toEqual(["claim 0", "claim 1", "claim 2", "release 0", "claim 3", "release 1"])

    // The first send takes the provider runtime of the newest pre-start.
    void h.chat.send("first")
    await h.settled()
    expect(h.sends[0]?.providerSession).toBe(h.prestarts[2]?.providerSession)

    h.chat.setShown(false)
    await h.settled()
    const plans = h.planned().length
    await h.chat.refreshDeps?.()
    await h.settled()
    expect(h.planned()).toHaveLength(plans)
  })

  it("a chat model switch away during a turn applies at the turn's end, also a turn that fails, on the chat's provider runtime", async () => {
    const h = makeChat()
    h.chat.setShown(true)
    await h.settled()
    h.failSends()
    void h.chat.send("first")
    await h.settled()
    h.switchChat("gpt")
    await h.settled()
    // The running turn keeps the chat's client: the role change plans the hosts only, and the chat's claim stays.
    expect(h.planned()).toEqual(["chat claude-opus", "host claude-opus", "host gpt"])
    expect(h.released).toEqual([1])

    h.failTurn()
    await h.settled()
    expect(h.planned().slice(3)).toEqual(["chat gpt"])
    expect(h.prestarts[3]?.providerSession).toBe(h.prestarts[0]?.providerSession)
    expect(h.released).toEqual([1, 0])
  })
})
