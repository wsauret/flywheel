import { describe, expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import { createSessionEngines } from "../../../../src/orchestration/chat/session-engines.js"
import type { ResolvedRole, ResolvedRoles } from "../../../../src/orchestration/config/roles.js"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import type { ProviderSession } from "../../../../src/orchestration/agent-runtime/provider-runtime-cache.js"
import type { Claim } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RequestPreparer } from "../../../../src/orchestration/agent-runtime/request-preparation.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { fakeAttempt, withRequestAdmission } from "../agent-runtime/_model-client.js"
import { preparedRequest, streamOptions } from "../agent-runtime/llm/_provider-chain-harness.js"

interface Prestart {
  readonly target: "chat" | "host"
  readonly model: string | undefined
  readonly provider: ProviderSession
  readonly signal: AbortSignal
  /** Ends the pre-start's preparation. */
  readonly finish: () => void
}

/** A session whose pre-starts the test sees and ends: each preparation waits until `finish`, or ends at once when
 *  `instant`. Each anticipation returns a claim of its own, and `events` records each claim and each release in
 *  order. */
function harness(initial: readonly (readonly [string, string])[], instant = true) {
  let roles = new Map(initial)
  let chatFails = false
  let declining = false
  // A preparation that settles after its stop, as one whose walk had passed its last stop check.
  let settlesAfterStop = false
  let anticipations = 0
  const prestarts: Prestart[] = []
  const events: string[] = []
  /** The claims that no holder released yet. */
  const held = new Set<Claim>()
  const authorities = {
    resolveRoles: async (): Promise<ResolvedRoles> => new Map([...roles].map(([roleId, model]): [string, ResolvedRole] => [roleId, { roleId, model, effort: "medium" }])),
    prepareRequest: (async (options, { signal }) => {
      const ended = Promise.withResolvers<void>()
      if (!settlesAfterStop) signal.addEventListener("abort", () => { ended.reject(signal.reason) }, { once: true })
      const target = options.purpose.kind === "interactive-chat" ? "chat" : "host"
      prestarts.push({ target, model: options.model, provider: options.providerSession, signal, finish: () => { ended.resolve() } })
      events.push(`start ${target} ${options.model}`)
      if (instant) ended.resolve()
      await ended.promise
      if (target === "host" && declining) return undefined
      const attempt = { ...fakeAttempt("anthropic_api", options.model ?? ""), anticipatesRequests: true as const }
      const name = `${target} ${options.model} #${prestarts.length}`
      const anticipate = async (): Promise<Claim> => {
        anticipations += 1
        events.push(`claim ${name}`)
        const claim: Claim = { release: async () => { held.delete(claim); events.push(`release ${name}`) } }
        held.add(claim)
        return claim
      }
      return { candidate: { attempt, client: { ...attempt, anticipate, streamWithTools: () => { throw new Error("a pre-start sends nothing") } }, prepared: preparedRequest(attempt) }, request: streamOptions }
    }) satisfies RequestPreparer,
  }
  const counter = countStateRequests(authorities)
  const options = (model: string, kind: "interactive-chat" | "session-title", provider: ProviderSession): AgentOptions & { readonly providerSession: ProviderSession } => ({
    ...testDirectories("/scratch"), model, purpose: { kind }, providerSession: provider, moduleSelection: composeFirstPartyModules,
    onEvent: () => {}, runtimeSurfaces: {}, conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" },
  })
  const engines = createSessionEngines({
    sessionId: "session",
    prepareRequest: (prepared, preparation) => counter.reader.prepareRequest(prepared, preparation),
    resolveRoles: () => counter.reader.resolveRoles(),
    chatOptions: async (provider) => {
      if (chatFails) throw new Error("the environment probe could not launch git")
      return { options: options(roles.get("chat") ?? "", "interactive-chat", provider), readHistory: async () => [] }
    },
    hostOptions: (role, provider) => options(role.model, "session-title", provider),
  })
  /** Records `name` when `scope` closes. */
  const onClose = (scope: Scope.Scope | undefined, name: string) => {
    if (scope !== undefined) Effect.runSync(Scope.addFinalizer(scope, Effect.sync(() => { events.push(`close ${name}`) })))
  }
  /** Gives the chat's provider runtime a client, as a send does, which records its close. */
  const chatClient = (name: string) => engines.chat.cache.resolve(composeFirstPartyModules(), engines, name, async (lifetime) => {
    onClose(lifetime?.scope, name)
    return withRequestAdmission({ model: name, modelFamily: "anthropic", plannedAttempt: async () => { throw new Error("no request") }, streamWithTools: () => { throw new Error("no request") } })
  }, {
    lifetime: { providerSessionKey: "chat", scope: engines.chat.scope },
  })
  return {
    engines, prestarts, events, onClose, chatClient, held,
    settled: () => new Promise((resolve) => setTimeout(resolve, 5)),
    setRoles: (next: readonly (readonly [string, string])[]) => { roles = new Map(next) },
    failChat: () => { chatFails = true },
    /** Whether the hosts' route anticipates no request, as while the subscription is exhausted and another provider serves. */
    declineHosts: (decline: boolean) => { declining = decline },
    settleAfterStop: () => { settlesAfterStop = true },
    anticipations: () => anticipations,
    /** The preparations since the last call. */
    preparations: () => counter.take().filter(({ method }) => method === "prepareRequest").length,
    /** Asks the session to plan again, as a provider does at an engine end that a plan can repair. */
    stale: () => { engines.chat.demand?.stale() },
    planned: () => prestarts.map(({ target, model }) => `${target} ${model}`),
  }
}

describe("a session's engines", () => {
  test("plan only once a client shows the session: then the chat on its own provider runtime and one host for each distinct selection of every role, the chat's included", async () => {
    const h = harness([["chat", "claude-opus"], ["session-title", "claude-haiku"], ["reviewer", "claude-haiku"], ["planner", "gpt"]])
    h.engines.rolesChanged()
    h.engines.turnEnded()
    h.stale()
    await h.settled()
    expect(h.planned()).toEqual([])

    h.engines.setShown(true)
    await h.settled()
    expect(h.planned()).toEqual(["chat claude-opus", "host claude-opus", "host claude-haiku", "host gpt"])
    expect(h.prestarts[0]?.provider).toBe(h.engines.chat)
    expect(new Set(h.prestarts.slice(1).map(({ provider }) => provider)).size).toBe(3)
    // Every provider runtime of the session carries its one demand.
    expect(new Set(h.prestarts.map(({ provider }) => provider.demand)).size).toBe(1)
    expect(h.held.size).toBe(4)
  })

  test("a replan installs each new claim before it releases the claim that it replaces, and an unchanged selection keeps its provider runtime", async () => {
    const h = harness([["chat", "claude-opus"]])
    h.engines.setShown(true)
    await h.settled()
    h.onClose(h.prestarts[1]?.provider.scope, "host claude-opus")
    h.engines.servingChanged()
    await h.settled()
    expect(h.events.slice(4)).toEqual([
      "start chat claude-opus", "claim chat claude-opus #3", "release chat claude-opus #1",
      "start host claude-opus", "claim host claude-opus #4", "release host claude-opus #2",
    ])
    expect(h.prestarts[3]?.provider).toBe(h.prestarts[1]?.provider)
    expect(h.held.size).toBe(2)
  })

  test("a chat model switch during a turn plans the hosts at once and the chat at the turn's end, and every turn end plans the chat alone", async () => {
    const h = harness([["chat", "claude-opus"]])
    h.engines.setShown(true)
    await h.settled()
    h.onClose(h.prestarts[1]?.provider.scope, "host claude-opus")
    h.engines.turnStarted()
    h.setRoles([["chat", "claude-sonnet"]])
    h.engines.rolesChanged()
    await h.settled()
    expect(h.planned()).toEqual(["chat claude-opus", "host claude-opus", "host claude-sonnet"])
    // The new selection's claim comes before the old selection's release and close.
    expect(h.events.slice(-4)).toEqual(["start host claude-sonnet", "claim host claude-sonnet #3", "release host claude-opus #2", "close host claude-opus"])

    h.engines.turnEnded()
    await h.settled()
    h.engines.turnEnded()
    await h.settled()
    h.engines.turnStarted()
    h.engines.turnEnded()
    await h.settled()
    expect(h.planned().slice(3)).toEqual(["chat claude-sonnet", "chat claude-sonnet"])
    expect(h.prestarts.filter(({ target }) => target === "chat").every(({ provider }) => provider === h.engines.chat)).toBe(true)
  })

  test("a profile that resolves no chat role releases the chat's claim and closes its engine at once while no turn runs, and a later chat role plans again", async () => {
    const h = harness([["chat", "claude-opus"]])
    h.engines.setShown(true)
    await h.settled()
    await h.chatClient("chat engine")
    h.setRoles([])
    h.engines.rolesChanged()
    await h.settled()
    expect(h.held.size).toBe(0)
    expect(h.events.slice(4)).toEqual(["release chat claude-opus #1", "close chat engine", "release host claude-opus #2"])

    h.setRoles([["chat", "claude-sonnet"]])
    h.engines.rolesChanged()
    await h.settled()
    expect(h.planned().slice(2)).toEqual(["chat claude-sonnet", "host claude-sonnet"])
    expect(h.held.size).toBe(2)
  })

  test("a profile that resolves no chat role during a turn keeps the chat's claim and engine until the turn ends, then releases them", async () => {
    const h = harness([["chat", "claude-opus"]])
    h.engines.setShown(true)
    await h.settled()
    await h.chatClient("running turn's engine")
    h.engines.turnStarted()
    h.setRoles([])
    h.engines.rolesChanged()
    await h.settled()
    expect(h.held.size).toBe(1)
    expect(h.events.slice(4)).toEqual(["release host claude-opus #2"])

    h.engines.turnEnded()
    await h.settled()
    expect(h.held.size).toBe(0)
    expect(h.events.slice(5)).toEqual(["release chat claude-opus #1", "close running turn's engine"])
    expect(h.planned()).toHaveLength(2)
  })

  test("a turn that starts stops the chat's pre-start that runs, so the pre-start never replaces the turn's client and anticipates nothing, also when its preparation settles after the stop", async () => {
    const h = harness([["chat", "claude-opus"]], false)
    h.settleAfterStop()
    h.engines.setShown(true)
    await h.settled()
    expect(h.prestarts[0]?.signal.aborted).toBe(false)
    h.engines.turnStarted()
    expect(h.prestarts[0]?.signal.aborted).toBe(true)
    h.prestarts[0]?.finish()
    await h.settled()
    expect(h.anticipations()).toBe(0)
  })

  test("the last client's release releases every claim, then ends the show's demand and closes the hosts and the chat's engine at once, or the chat's when the running turn ends, and a client that shows the session again plans again on a new demand", async () => {
    const h = harness([["chat", "claude-opus"], ["reviewer", "claude-haiku"]])
    h.engines.setShown(true)
    await h.settled()
    const shown = h.engines.chat.demand
    expect(h.prestarts.every(({ provider }) => provider.demand === shown)).toBe(true)
    h.onClose(h.prestarts[1]?.provider.scope, "host")
    h.onClose(shown?.scope, "demand")
    await h.chatClient("chat engine")
    h.engines.setShown(false)
    await h.settled()
    expect(h.held.size).toBe(0)
    expect(h.events.filter((event) => event.startsWith("close"))).toEqual(["close host", "close demand", "close chat engine"])
    expect(h.engines.chat.demand).toBeUndefined()

    h.engines.setShown(true)
    await h.settled()
    expect(h.planned().slice(3)).toEqual(["chat claude-opus", "host claude-opus", "host claude-haiku"])
    expect(h.engines.chat.demand).toBeDefined()
    expect(h.engines.chat.demand).not.toBe(shown)
    expect(h.prestarts.slice(3).every(({ provider }) => provider.demand === h.engines.chat.demand)).toBe(true)
    await h.chatClient("running turn's engine")
    h.engines.turnStarted()
    h.engines.setShown(false)
    await h.settled()
    expect(h.held.size).toBe(0)
    expect(h.events.at(-1)).not.toBe("close running turn's engine")
    h.engines.turnEnded()
    await h.settled()
    expect(h.events.at(-1)).toBe("close running turn's engine")
    expect(h.planned()).toHaveLength(6)
  })

  test("a provider's asks to plan again plan every selection once for all the asks that come before that plan starts, and none while no client shows the session", async () => {
    const h = harness([["chat", "claude-opus"], ["reviewer", "claude-haiku"]], false)
    h.engines.setShown(true)
    await h.settled()
    // The asks come while the show's plan runs, so one plan follows it.
    h.stale()
    h.stale()
    h.stale()
    for (let step = 0; step < 6; step++) {
      for (const prestart of h.prestarts) prestart.finish()
      await h.settled()
    }
    expect(h.planned()).toEqual(["chat claude-opus", "host claude-opus", "host claude-haiku", "chat claude-opus", "host claude-opus", "host claude-haiku"])

    h.engines.setShown(false)
    await h.settled()
    h.stale()
    await h.settled()
    expect(h.planned()).toHaveLength(6)
  })

  test.each([1, 3, 6])("with %d roles on one selection, a host end costs one plan with one host preparation, and a turn end one chat preparation", async (count) => {
    const h = harness(Array.from({ length: count }, (_, index) => [index === 0 ? "chat" : `role-${index}`, "claude-opus"] as const))
    h.engines.setShown(true)
    await h.settled()
    h.preparations()

    // Every role on the host place hears the one end of its one host; the session plans once.
    h.stale()
    await h.settled()
    expect(h.preparations()).toBe(2)
    expect(h.planned().slice(2)).toEqual(["chat claude-opus", "host claude-opus"])

    h.engines.turnStarted()
    h.engines.turnEnded()
    await h.settled()
    expect(h.preparations()).toBe(1)
  })

  test.each([1, 3, 6])("with %d roles, role-change notices that change no selection prepare nothing, and a role's model change plans the session again", async (count) => {
    // The last role alone holds its selection, so its change leaves that selection to no role.
    const roles = Array.from({ length: count }, (_, index) => [
      index === 0 ? "chat" : `role-${index}`,
      index === count - 1 ? "claude-last" : index % 2 === 0 ? "claude-opus" : "claude-haiku",
    ] as const)
    const h = harness(roles)
    h.engines.setShown(true)
    await h.settled()
    const shownPlan = h.planned().length
    h.preparations()

    // A send and a turn end change the session's metadata, and each change notices its roles.
    for (const notices of [1, 4, 16]) {
      for (let notice = 0; notice < notices; notice++) h.engines.rolesChanged()
      await h.settled()
      expect(h.preparations()).toBe(0)
    }
    expect(h.planned()).toHaveLength(shownPlan)

    const edited = [...roles.slice(0, -1), [roles.at(-1)?.[0] ?? "", "claude-sonnet"] as const]
    h.setRoles(edited)
    h.engines.rolesChanged()
    await h.settled()
    const hosts = [...new Set(edited.map(([, model]) => model))]
    expect(h.planned().slice(shownPlan)).toEqual([`chat ${edited[0]?.[1]}`, ...hosts.map((model) => `host ${model}`)])
    expect(h.events.filter((event) => event.startsWith("release host claude-last"))).toHaveLength(1)
    expect(h.held.size).toBe(1 + hosts.length)
  })

  test.each([
    ["a chat model switch that a running turn puts off", (h: ReturnType<typeof harness>) => {
      h.engines.turnStarted()
      h.setRoles([["chat", "claude-sonnet"], ["reviewer", "claude-haiku"]])
      h.engines.rolesChanged()
    }],
    ["a chat pre-start that fails", (h: ReturnType<typeof harness>) => { h.failChat() }],
  ])("after %s, role-change notices that change no selection prepare nothing", async (_, setUp) => {
    const h = harness([["chat", "claude-opus"], ["reviewer", "claude-haiku"]])
    setUp(h)
    h.engines.setShown(true)
    await h.settled()
    h.preparations()
    for (const notices of [1, 4, 16]) {
      for (let notice = 0; notice < notices; notice++) h.engines.rolesChanged()
      await h.settled()
      expect(h.preparations()).toBe(0)
    }
  })

  test("a chat model change that leaves every host selection in place plans the chat", async () => {
    const h = harness([["chat", "claude-opus"], ["reviewer", "claude-opus"], ["planner", "claude-haiku"]])
    h.engines.setShown(true)
    await h.settled()
    h.setRoles([["chat", "claude-haiku"], ["reviewer", "claude-opus"], ["planner", "claude-haiku"]])
    h.engines.rolesChanged()
    await h.settled()
    expect(h.planned().slice(3)).toEqual(["chat claude-haiku", "host claude-haiku", "host claude-opus"])
  })

  test("a host selection whose route anticipates no request holds no claim, and the next plan asks it again", async () => {
    const h = harness([["chat", "claude-opus"]])
    h.declineHosts(true)
    h.engines.setShown(true)
    await h.settled()
    expect(h.events.filter((event) => event.startsWith("claim"))).toEqual(["claim chat claude-opus #1"])

    h.declineHosts(false)
    h.engines.servingChanged()
    await h.settled()
    expect(h.events.filter((event) => event.startsWith("claim")).slice(1)).toEqual(["claim chat claude-opus #3", "claim host claude-opus #4"])
  })

  test("a chat pre-start that fails is recorded and the hosts are planned after it", async () => {
    const h = harness([["chat", "claude-opus"]])
    h.failChat()
    h.engines.setShown(true)
    await h.settled()
    expect(h.planned()).toEqual(["host claude-opus"])
  })

  test("close releases every claim, ends every provider runtime and the session's demand, and plans nothing after", async () => {
    const h = harness([["chat", "claude-opus"], ["reviewer", "claude-haiku"]])
    h.engines.setShown(true)
    await h.settled()
    h.onClose(h.engines.chat.scope, "chat")
    h.onClose(h.engines.chat.demand?.scope, "demand")
    for (const prestart of h.prestarts.slice(1)) h.onClose(prestart.provider.scope, `host ${prestart.model}`)
    await h.engines.close()
    expect(h.held.size).toBe(0)
    expect(h.events.filter((event) => event.startsWith("close")).toSorted()).toEqual(["close chat", "close demand", "close host claude-haiku", "close host claude-opus"])
    h.engines.setShown(true)
    h.engines.rolesChanged()
    h.stale()
    await h.settled()
    expect(h.prestarts).toHaveLength(3)
  })
})
