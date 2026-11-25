import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { isExternalLoginDefinition } from "../../../../../src/infra/auth/provider-account.js"
import { accessProviderRegistry } from "../../../../../src/orchestration/config/models/access-provider-registry.js"
import { composePortableModuleServices } from "../../../../../src/orchestration/app-service/executor/execution/module-service-host.js"
import { installedAccessProviderDefinitions, composeFirstPartyModules } from "../../../../../src/orchestration/module-contract/module-composition.js"
import { moduleProtocolRows } from "../../../../../src/orchestration/module-contract/module-catalog.js"
import { SHIPPED_MODULES } from "../../../../../scripts/shipped-modules.js"
import type { EngineLaunchOptions, EngineProcess } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/engine-process.js"
import { Effect, Exit, Scope } from "effect"
import { providerModelInfo } from "../../../../../src/infra/llm/catalog/provider-model-info.js"
import type { AccessProviderBuild } from "../../../../../src/orchestration/agent-runtime/llm/routing/client-factory.js"
import { RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import { ProviderAuthenticationError } from "../../../../../src/orchestration/agent-runtime/llm/stream/provider-failure.js"
import { fakeAvailability } from "../../agent-runtime/llm/_provider-chain-harness.js"
import { currentEngineRuntime, openEngineRuntime } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/engine-runtime.js"
import { registerLiveEngine } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/live-engines.js"
import { loginGateAddress } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/login-gate.js"
import { createGoogleAntigravityModule, googleAntigravityModule } from "../../../../../src/orchestration/modules/provider-google-antigravity/module.js"
import { MODULE_IDS } from "../../../../../src/protocol/runtime/module-ids.js"
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js"
import { moduleProcessServices } from "../../../../helpers/module-kernel.js"
import { AGY, fakeAgy, pastePorts } from "./_fake-agy.js"

const temporaryDirectory = temporaryDirectories()
const ID = "provider-google-antigravity"
const PROVIDER = "google_antigravity"

/** An engine process that starts nothing: its prompt stays open until `busy` settles, and it records each close and
 *  ends at once. */
function fakeEngine(options: EngineLaunchOptions, closes: string[], busy: Promise<void>): EngineProcess {
  const ended = Promise.withResolvers<Awaited<EngineProcess["ended"]>>()
  const unused = () => Promise.reject(new Error("the test engine serves no session"))
  return {
    processId: crypto.randomUUID(), loginDir: options.loginDir, toolNames: new Set(options.tools.map((tool) => tool.name)), served: false, ended: ended.promise,
    openSession: unused, releaseSession: () => {}, prompt: unused, cancel: unused, conversationRows: () => { throw new Error("the test engine serves no session") }, configure: unused, idle: () => false, whenIdle: () => busy,
    close: async (reason) => {
      closes.push(reason)
      ended.resolve({ reason, served: false })
      return await ended.promise
    },
  }
}

describe("the Google Antigravity provider module", () => {
  test("turned off, it stays listed for the auth actions but admits no model and builds no process service", () => {
    const definition = installedAccessProviderDefinitions().find((candidate) => candidate.id === PROVIDER)
    expect(definition).toMatchObject({ displayName: "Google Antigravity", billing: "subscription", accountRotation: "never", cli: { flag: "google-antigravity" }, dynamicCatalog: { membership: "first-party" } })
    if (definition === undefined || !isExternalLoginDefinition(definition)) throw new Error("the provider has no external login")
    expect({ paidModes: "paidModes" in definition, usage: definition.usage, tokenLogin: definition.auth.tokenLogin, profileConversions: definition.profileConversions }).toEqual({ paidModes: false, usage: undefined, tokenLogin: undefined, profileConversions: undefined })

    const on = composeFirstPartyModules(SHIPPED_MODULES, [])
    const off = composeFirstPartyModules(SHIPPED_MODULES, [ID])
    const admitted = (composition: typeof on) => accessProviderRegistry(composition).selection.definitions.map(({ id }) => id)
    expect(admitted(on)).toContain(PROVIDER)
    expect(admitted(off)).not.toContain(PROVIDER)
    const provider = on.contributions.find((contribution) => contribution.domain === "providers" && contribution.id === PROVIDER)
    expect(provider?.domain === "providers" && provider.value.usageReader).toBeUndefined()
    expect(on.contributions.some((contribution) => contribution.domain === "health" && contribution.id === ID)).toBe(true)
    expect(moduleProtocolRows(MODULE_IDS, SHIPPED_MODULES).find((row) => row.id === ID)).toMatchObject({ installed: true, effective: true, setting: { control: "binary", group: "Model providers", label: "Google Antigravity" } })

    const kernel = { ...moduleProcessServices({ onSelectionChanged: () => () => {} }), directories: testDirectories(temporaryDirectory("flywheel-antigravity-module-")) }
    const services = (enabled: readonly string[]) => {
      const composed = composePortableModuleServices([googleAntigravityModule], () => enabled, kernel)
      composed.reconcile()
      return composed
    }
    const withModule = services(on.enabledModuleIds)
    const withoutModule = services(off.enabledModuleIds)
    expect(withModule.instances.map(([id]) => id)).toContain(ID)
    expect(withoutModule.instances.map(([id]) => id)).not.toContain(ID)
    return Promise.all([withModule.dispose(), withoutModule.dispose()])
  })

  test("its process service lets live engine uses go only when the module turns off, names the account whose engine serves a tree, holds a logout until that engine closed, and closes every engine at its end", async () => {
    const root = temporaryDirectory("flywheel-antigravity-service-")
    const authDir = join(root, "auth")
    const agy = fakeAgy({ identity: "person@example.com" })
    const launched: EngineLaunchOptions[] = []
    const closes: string[] = []
    const prompt = Promise.withResolvers<void>()
    const module = createGoogleAntigravityModule({ enginePath: () => AGY, launchEngine: async (options) => { launched.push(options); return fakeEngine(options, closes, prompt.promise) } })
    const provider = module.contributions[0].value.definition
    const account = await provider.auth.login(authDir, pastePorts(agy.launcher).ports)

    let enabled = true
    const listeners: (() => void | Promise<void>)[] = []
    let releases = 0
    const unregister = registerLiveEngine(() => { releases += 1 })
    const instance = module.service.create(moduleProcessServices({ enabled: () => enabled, onSelectionChanged: (listener) => { listeners.push(listener); return () => {} } }))
    try {
      for (const listener of listeners) await listener()
      expect(releases).toBe(0)
      enabled = false
      for (const listener of listeners) await listener()
      expect(releases).toBe(1)

      const runtime = currentEngineRuntime()
      if (runtime === undefined) throw new Error("the service opened no engine runtime")
      expect(provider.preferredAccount("tree")).toBeUndefined()
      const lease = runtime.registry.lease({ treeRootSessionId: "tree", loginDir: account.configDir, accountId: account.accountId, tools: [] })
      await lease.engine()
      expect(provider.preferredAccount("tree")).toBe(account.accountId)
      expect(provider.preferredAccount("other-tree")).toBeUndefined()
      // The engine asks the login's own step gate, which is open before the engine launches.
      const gate = loginGateAddress(account.configDir)
      expect(launched[0]?.gateHook.command).toContain(gate.address)
      expect(launched[0]?.gateHook.command).toContain(gate.gateId)
      expect(runtime.gate(account.configDir)).toBeDefined()

      // The logout waits while a prompt of the login's engine is open, then closes the engine before agy's logout.
      const logout = provider.auth.logout(authDir, account.accountId, { launcher: agy.launcher })
      await Bun.sleep(5)
      expect({ closes, loggedOut: agy.methods.some((call) => call.method === "logout") }).toEqual({ closes: [], loggedOut: false })
      prompt.resolve()
      await logout
      expect(closes).toEqual(["logout"])
      await lease.release()
      expect({ loggedOut: agy.methods.some((call) => call.method === "logout"), folderKept: existsSync(account.configDir) }).toEqual({ loggedOut: true, folderKept: false })

      await runtime.registry.lease({ treeRootSessionId: "tree", loginDir: join(authDir, "antigravity", "second"), accountId: "second", tools: [] }).engine()
      await instance.dispose()
      expect(closes).toEqual(["logout", "shutdown"])
      expect(currentEngineRuntime()).toBeUndefined()
      expect(provider.preferredAccount("tree")).toBeUndefined()
    } finally {
      unregister()
      await instance.dispose()
    }
  })

  test("a refused login of a request through its client opens one login question that the request's wait joins, and a decline answers the wait", async () => {
    const root = temporaryDirectory("flywheel-antigravity-refusal-")
    const authDir = join(root, "auth")
    const agy = fakeAgy({ identity: "person@example.com" })
    const refusing = (options: EngineLaunchOptions): EngineProcess => ({
      ...fakeEngine(options, [], Promise.resolve()),
      openSession: () => Promise.reject(new ProviderAuthenticationError("Google Antigravity is not signed in (Authentication required)")),
    })
    const module = createGoogleAntigravityModule({ enginePath: () => AGY, launchEngine: async (options) => refusing(options) })
    const provider = module.contributions[0].value
    const account = await provider.definition.auth.login(authDir, pastePorts(agy.launcher).ports)
    const instance = module.service.create(moduleProcessServices({ onSelectionChanged: () => () => {} }))
    const scope = Scope.makeUnsafe()
    try {
      const model = "gemini-3.1-pro"
      const metadata = providerModelInfo({ provider: "google", id: model, contextLimit: 230_000, outputLimit: 64_000, reasoning: true })
      const candidate = { kind: "subscription", providerId: PROVIDER, instanceId: account.accountId, spendMode: "included" } as const
      const build: AccessProviderBuild = {
        notify: () => {}, candidate, providerIdentity: { name: "Google Antigravity", credential: "oauth" },
        model, wireModelId: model, family: "google",
        modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
        connection: {
          id: "connection", authDir, oauthPersistence: "memory-only",
          auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
          subscriptionCredentials: new Map([[PROVIDER, [{ instanceId: account.accountId, identity: account.identity, lineageId: account.accountId, credential: { type: "external", configDir: account.configDir } }]]]),
        },
        classifySlot: () => "subscription", availability: fakeAvailability({}).availability, projectRoot: root,
        attribution: { candidate, wireModelId: model, dataUse: "standard", resolvedModelMetadata: metadata },
        recordModelRefusal: () => {},
        providerSessionLifetime: { providerSessionKey: "conversation", treeRootSessionId: "tree", scope },
      }
      const client = await (await (await provider.createClient(build)).stage({ attribution: build.attribution, accountOfferings: [] })).connect()
      const request = async () => {
        for await (const _event of client.streamWithTools({ messages: [{ kind: "user", content: "hello", origin: "human" }], tools: [], systemPrompt: { stable: "stable", session: "", conversation: "" } })) { /* drained */ }
      }
      await expect(request()).rejects.toBeInstanceOf(ProviderAuthenticationError)

      const wait = provider.definition.auth.awaitLogin(authDir, account.accountId, new AbortController().signal)
      const joined = provider.definition.auth.awaitLogin(authDir, account.accountId, new AbortController().signal)
      const questions = provider.definition.auth.loginQuestions()
      expect(questions).toMatchObject([{ authDir, account: { accountId: account.accountId }, phase: "asking" }])
      provider.definition.auth.answerLogin(questions[0]?.id ?? "", "declined")
      expect(await Promise.all([wait, joined])).toEqual(["declined", "declined"])
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await instance.dispose()
    }
  })

  test("a login's step gate closes with the login's last engine, so another runtime serves the login while the first stays open", async () => {
    const loginDir = join(temporaryDirectory("flywheel-antigravity-gate-"), "login")
    const closes: string[] = []
    const runtime = () => openEngineRuntime({ launcher: { spawnOwned: () => Promise.reject(new Error("no process in this test")) }, launch: async (options) => fakeEngine(options, closes, Promise.resolve()) })
    const first = runtime()
    const second = runtime()
    try {
      const lease = first.registry.lease({ treeRootSessionId: "first", loginDir, accountId: "account", tools: [] })
      await lease.engine()
      expect(first.gate(loginDir)).toBeDefined()
      await lease.release()
      expect(() => first.gate(loginDir)).toThrow(RouteUnavailableError)

      const next = second.registry.lease({ treeRootSessionId: "second", loginDir, accountId: "account", tools: [] })
      await next.engine()
      expect(second.gate(loginDir)).toBeDefined()
      await next.release()
      expect(closes).toEqual(["released", "released"])
    } finally {
      await second.dispose()
      await first.dispose()
    }
  })
})
