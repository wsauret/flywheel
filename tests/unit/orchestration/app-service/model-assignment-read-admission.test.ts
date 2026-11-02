import { expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import { RuntimeQuerySchema, runtimeQueryResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { authDir } from "../../../../src/infra/paths.js"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import { apiKey, captureProviderConnection, resolveAuthContext } from "../../../../src/infra/auth/auth-context.js"
import { loadAuthStoreWithDiagnostics } from "../../../../src/infra/auth/auth-store.js"
import { createAuthConditionOwner } from "../../../../src/orchestration/auth/auth-condition-owner.js"
import { credentialSlotClassifier } from "../../../../src/orchestration/auth/credential-slot-classifier.js"
import { createAdmittedModelAssignmentService, createModelAssignmentReadAdmission } from "../../../../src/orchestration/app-service/model-assignment-admission.js"
import { authProfileEligibilityInputRevision, createEligibilityPreparation } from "../../../../src/orchestration/app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { createDefinitionAvailability } from "../../../../src/orchestration/app-service/definition-availability.js"
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { installedCredentialProviderIds } from "../../../../src/orchestration/credential-provider-modules.js"
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js"
import { roleSlot } from "../../../../src/orchestration/config/role-selection.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { modelInfo } from "../../../helpers/model-tier-fixtures.js"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { testSessionAuthAdmission } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { managerDouble } from "./model-assignment-service-fixtures.js"
import { asAsyncEventReadSurface, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import { createProviderAvailability } from "../../../../src/orchestration/agent-runtime/llm/provider-availability.js"
import { createAvailabilityAuthority } from "../../../../src/infra/llm/availability-store.js"

const temporaryDirectory = temporaryDirectories()
const availability = await createDefinitionAvailability({ definitions: repoDefinitions(), modules: repoModules, capabilities: { state: () => decodeModuleState("") } })
const unusedEventWriter: AsyncEventWriter = {
  append: async () => { throw new Error("unused") },
  appendBatch: async () => { throw new Error("unused") },
  pruneSupersededEvents: async () => { throw new Error("unused") },
}
/** A profile with no saved paid-use permission and no allowance evidence. */
const noSubscriptionAdmission = () => async () => ({
  consent: { profileId: "default", rows: [], authorizations: new Map() },
  subscriptionAllowanceFor: () => ({ allowance: "unknown" as const }),
  bankedResetFor: () => false,
  expiringResetFor: () => undefined,
})

test.each(["cold", "stale"] as const)("reads %s eligibility without scheduling discovery or access audits", async (initial) => {
  const dir = temporaryDirectory("flywheel-saved-only-")
  const directories = testDirectories(dir)
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath: join(dir, "flywheel.toml"), watch: false })
  const preferences = createProviderModelPreferenceService({
    displayName: (id) => id, allowTrainingRoutes: () => false,
    persist: async () => { throw new Error("unused") },
    persistAllDeselected: async () => { throw new Error("unused") },
  })
  if (initial === "stale") preferences.publish(preferences.prepare({
    profileId: "default", authRevision: "old", preferenceRevision: "old",
    catalogs: new Map(), accountCatalogs: new Map(), inventoryCandidates: new Map(), releaseDates: new Map(),
  }))
  const modes: string[] = []
  let metadataRefreshes = 0
  const preparation = createEligibilityPreparation({
    allowTrainingRoutes: () => false,
    userDataRoot: directories.userDataRoot, resolveKey: async () => undefined,
    moduleSelection: () => composeFirstPartyModules(),
    prepare: preferences.prepare, publish: preferences.publish, current: preferences.state,
    inputRevision: () => ({ auth: "current", preferences: "current" }),
    resolveAuth: async () => testAuthContext({}),
    settlementTimeoutMs: 1,
    refreshMetadata: async () => { metadataRefreshes += 1 },
    resolveCatalog: async ({ discoveryMode }) => {
      modes.push(discoveryMode ?? "unspecified")
      const candidate = { kind: "subscription", providerId: "supergrok", instanceId: "primary", spendMode: "included" } as const
      return {
        providers: new Map(), modelInfos: new Map(), enabledModels: new Map(),
        accounts: new Map([[accessProviderAccountKey(candidate), {
          catalog: new Set<string>(), curatedDefault: new Set<string>(), enabled: new Set<string>(),
          disabled: new Set<string>(), effective: new Set<string>(),
        }]]),
        inventoryCandidates: new Map([[accessProviderAccountKey(candidate), {
          candidate, configured: true, currentConnection: true,
          enabledOfferings: null, inventoryOfferings: null,
          outcome: { kind: "unavailable", reason: "discovery-pending" },
          audit: { remaining: 1, refused: 0 },
        }]]),
      }
    },
  })
  const profiles = new AuthProfileManager({ userDataRoot: directories.userDataRoot, projectRoot: dir, env: {} })
  const access = await profiles.acquireAccess({ createDefault: true })
  access.close()
  const readAdmission = createModelAssignmentReadAdmission({
    userDataRoot: directories.userDataRoot,
    manager: { read: async () => null, captureAuthProfileIfAbsent: async () => false },
    authProfiles: profiles, materialize: async () => {}, prepareEligibility: preparation, runtimeConfig,
    captureSubscriptionAdmission: noSubscriptionAdmission,
  })
  try {
    const read = await readAdmission({ kind: "defaults" })
    expect(preferences.state(read.profile.effectiveId)?.authRevision).toBe("current")
    expect(read.capture.providers.selection.plan("unavailable-fixture-model", read.capture.connection, read.capture.eligibility, read.capture.allowTrainingRoutes).kind).toBe("unavailable")
    expect(modes).toEqual(["cached-first"])
    expect(metadataRefreshes).toBe(0)
  } finally {
    await preparation.dispose()
    await preferences.dispose()
    await runtimeConfig.dispose()
  }
})

test("reads saved model, assignment, and effort options for defaults and sessions before refresh settles", async () => {
  const dir = temporaryDirectory("flywheel-admitted-tier-")
  const directories = testDirectories(dir)
  const configPath = join(dir, "flywheel.toml")
  writeFileSync(configPath, '[profiles.default.roles.chat]\nmodel = "gpt-6.1-sol"\neffort = "medium"\n')
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath, watch: false })
  const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
  const subscriptions = ["account-a", "account-b"].map((instanceId) => ({ kind: "subscription", providerId: "chatgpt", instanceId, spendMode: "included" } as const))
  const model = "gpt-6.1-sol"
  const catalog = { kind: "available", provenance: "first-party", liveOutcome: "valid" } as const
  const offering = { wireModelId: model, metadata: null, dataUse: "standard", transport: "openai-responses", resolvedMetadata: modelInfo("openai", model, "gpt", 5, 30, "2026-04-01") } as const
  const models = [model, "gpt-5.4", "gpt-5.2"]
  const offerings = new Map(models.map((id) => [id, [{ ...offering, wireModelId: id, resolvedMetadata: modelInfo("openai", id, "gpt", 5, 30, "2026-04-01") }]]))
  const catalogs = new Map([["openai_api", { catalog: new Set(models), curatedDefault: new Set(models), enabled: new Set<string>(), disabled: new Set<string>(), effective: new Set(models) }]])
  catalogs.set("chatgpt", catalogs.get("openai_api")!)
  const preferences = createProviderModelPreferenceService({
    displayName: (id) => id,
    allowTrainingRoutes: () => false,
    persist: async () => { throw new Error("unused") },
    persistAllDeselected: async () => { throw new Error("unused") },
  })
  const eligibility = preferences.prepare({
    profileId: "default",
    authRevision: "auth",
    preferenceRevision: "preferences",
    catalogs,
    accountCatalogs: new Map([candidate, ...subscriptions].map((account) => [accessProviderAccountKey(account), catalogs.get("openai_api")!])),
    inventoryCandidates: new Map([candidate, ...subscriptions].map((account) => [accessProviderAccountKey(account), { candidate: account, configured: true, currentConnection: true, enabledOfferings: offerings, inventoryOfferings: offerings, catalog }])),
    releaseDates: new Map(),
  })
  preferences.publish(eligibility)
  const refresh = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const order: string[] = []
  let auth = testAuthContext({ apiKeys: { openai_api: "test-key" } })
  const preparation = createEligibilityPreparation({
    allowTrainingRoutes: () => false,
    userDataRoot: directories.userDataRoot,
    resolveKey: async () => undefined,
    moduleSelection: () => composeFirstPartyModules(),
    prepare: preferences.prepare,
    publish: preferences.publish,
    current: preferences.state,
    inputRevision: () => ({ auth: "auth", preferences: "preferences" }),
    resolveAuth: async () => auth,
    resolveCatalog: async () => {
      entered.resolve()
      await refresh.promise
      order.push("refresh")
      return { providers: catalogs, accounts: new Map(), inventoryCandidates: new Map(), modelInfos: new Map(), enabledModels: new Map() }
    },
  })
  const pendingRefresh = preparation({ id: "default", directory: authDir(directories.userDataRoot, "default") }, { force: true })
  await entered.promise
  const manager = managerDouble()
  manager.seed("chat-new", { chat: { model, effort: "medium" }, "workflow-agent": { model, effort: "medium" }, "title-generation": { model, effort: "low" } })
  let capturedProfile: string | undefined = "retired"
  let materializations = 0
  const profiles = new AuthProfileManager({ userDataRoot: directories.userDataRoot, projectRoot: dir, env: {} })
  const access = await profiles.acquireAccess({ createDefault: true })
  access.close()
  writeFileSync(join(authDir(directories.userDataRoot, "default"), "auth.json"), JSON.stringify({ openai_api: { type: "api_key", key: "!test-helper", lineageId: "00000000-0000-4000-8000-000000000001" } }))
  const plannedModels: string[] = []
  let lowerKeyResolutions = 0
  const readAdmission = createModelAssignmentReadAdmission({
    materialize: async (id, profileId, expectedAuthProfileId) => {
      expect(id).toBe("chat-new")
      expect(expectedAuthProfileId).toBe("retired")
      capturedProfile = profileId
      materializations += 1
    },
    userDataRoot: directories.userDataRoot,
    manager: {
      read: async (id) => {
        const session = await manager.read(id)
        return session === null ? null : { ...session, authProfileId: capturedProfile }
      },
      captureAuthProfileIfAbsent: async (_id, profileId) => { capturedProfile = profileId; return true },
    },
    authProfiles: { inspect: () => ({ ...profiles.inspect(), retirements: { retired: "default" } }) },
    prepareEligibility: preparation,
    runtimeConfig,
    captureSubscriptionAdmission: noSubscriptionAdmission,
  })
  const service = createAdmittedModelAssignmentService({
    userDataRoot: directories.userDataRoot,
    projectRoot: dir,
    manager,
    sessionStore: { get: () => undefined },
    eventReader: asAsyncEventReadSurface(inMemoryEventReader([])),
    eventWriter: unusedEventWriter,
    availability,
    runtimeConfig,
    resolveKey: async () => { lowerKeyResolutions += 1; return undefined },
    moduleSelection: () => composeFirstPartyModules(),
    sessionAuthAdmission: {
      ...testSessionAuthAdmission(),
      admitDefaults: async () => { throw new Error("read waited for request admission") },
      admit: async () => { throw new Error("read waited for session request admission") },
    },
    activeProfileId: () => "default",
    prepareEligibility: async () => { throw new Error("read waited for refresh barrier") },
    eligibilityState: () => eligibility,
    readAdmission: async (scope) => {
      const admitted = await readAdmission(scope)
      const selection = admitted.capture.providers.selection
      const connection = captureProviderConnection({
        profileId: "default",
        authDir: authDir(directories.userDataRoot, "default"),
        auth,
        subscriptionCredentials: new Map(auth.providers.size === 0 ? [] : [["chatgpt", subscriptions.map(({ instanceId }) => ({
          instanceId, credential: { type: "oauth" as const, access: Redacted.make("test-access"), refresh: Redacted.make("test-refresh"), expires: 1 },
        }))]]),
      })
      return { ...admitted, capture: { ...admitted.capture, connection, providers: { ...admitted.capture.providers, selection: {
        ...selection,
        plan: (...args) => { plannedModels.push(args[0]); return selection.plan(...args) },
      } } } }
    },
  })
  try {
    for (const scope of [{ kind: "defaults" }, { kind: "session", sessionId: "chat-new" }] as const) {
      plannedModels.length = 0
      const rows = await service.loadAssignments({ scope, slots: [roleSlot("chat")] })
      expect(rows[0]?.model).toBe(model)
      expect(plannedModels.toSorted()).toEqual(models.toSorted())
      plannedModels.length = 0
      expect(await service.listEffortOptions({ scope, slot: roleSlot("chat"), model })).not.toHaveLength(0)
      expect(plannedModels.toSorted()).toEqual(models.toSorted())
      plannedModels.length = 0
      const options = await service.listModelOptions({ scope, slot: roleSlot("chat") })
      expect(options.find((row) => row.model === model)?.selectable).toBe(true)
      expect(options.find((row) => row.model === model)?.providers).toEqual([
        { name: "ChatGPT Subscription", shortName: "ChatGPT", serving: true },
        { name: "OpenAI API Key", shortName: "OpenAI", serving: false },
      ])
      expect(plannedModels.toSorted()).toEqual(models.toSorted())
      expect(models.every((id) => options.some((row) => row.model === id))).toBe(true)
      expect(lowerKeyResolutions).toBe(0)
      order.push(scope.kind)
    }
    expect(capturedProfile).toBe("default")
    expect(materializations).toBe(1)
    expect((await service.globalDefaultRoles()).chat?.model).toBe(model)
    writeFileSync(configPath, '[profiles.default.roles.chat]\nmodel = "unavailable-saved-model"\neffort = "max"\n')
    await runtimeConfig.refresh()
    expect((await service.globalDefaultRoles()).chat).toEqual({ model, effort: "medium" })
    expect(order).toEqual(["defaults", "session"])
    manager.seed("chat-new", { chat: { model, effort: "medium" }, "workflow-agent": { model: "gpt-5.4", effort: "medium" }, "title-generation": { model, effort: "low" } })
    const query = { type: "sessionModelPlan", sessionId: "chat-new", slots: [roleSlot("chat"), roleSlot("workflow-agent"), roleSlot("title-generation")] } as const
    expect(Schema.decodeUnknownSync(RuntimeQuerySchema)(query)).toEqual(query)
    const appManager = fakeManager()
    const appStore = fakeSessionStore(new Map())
    const app = createFlywheelAppService({
      ...fakeProjections(),
      modelAssignments: service,
      projectRoot: dir,
      projection: createFrontendProjection({ sessionStore: appStore, manager: appManager, projectRoot: dir }),
      runtimeSupervisor: runtimeSupervisor(),
      bus: createRuntimeUiBus(),
    })
    const inspected = await app.query(query)
    await app.close()
    expect(inspected.profile).toEqual({ persistedId: "default", effectiveId: "default" })
    expect(inspected.assignments.map((row) => row.model)).toEqual([model, "gpt-5.4", model])
    expect(inspected.plans.map((plan) => plan.model)).toEqual([model, "gpt-5.4"])
    expect(inspected.plans[0]).toEqual({
      kind: "available",
      model,
      candidates: [
        { kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "included", wireModelId: model },
        { kind: "subscription", providerId: "chatgpt", instanceId: "account-b", spendMode: "included", wireModelId: model },
        { kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "prepaid", wireModelId: model },
        { kind: "subscription", providerId: "chatgpt", instanceId: "account-b", spendMode: "prepaid", wireModelId: model },
        { kind: "subscription", providerId: "chatgpt", instanceId: "account-a", spendMode: "automatic", wireModelId: model },
        { kind: "subscription", providerId: "chatgpt", instanceId: "account-b", spendMode: "automatic", wireModelId: model },
        { kind: "singleton", providerId: "openai_api", spendMode: "direct_api", wireModelId: model },
      ],
    })
    expect(Schema.decodeUnknownSync(runtimeQueryResultSchema("sessionModelPlan"))(JSON.parse(JSON.stringify(inspected)))).toEqual(inspected)
    expect(JSON.stringify(inspected)).not.toContain("test-access")
    expect(JSON.stringify(inspected)).not.toContain("test-key")
    auth = { providers: new Map(), credentialLineages: {}, droppedCredentials: [] }
    const disconnected = await service.listModelOptions({ scope: { kind: "defaults" }, slot: roleSlot("chat") })
    expect(disconnected).toEqual([])
    expect(await service.globalDefaultRoles()).toEqual({})
    const unavailable = await service.loadSessionModelPlan(query)
    expect(unavailable.plans).toEqual([])
  } finally {
    refresh.resolve()
    await pendingRefresh
    await preparation.dispose()
    await preferences.dispose()
    await runtimeConfig.dispose()
  }
  expect(order).toEqual(["defaults", "session", "refresh"])
})

test("a save names what serves when its saved model cannot serve, once for a mirrored save", async () => {
  const dir = temporaryDirectory("flywheel-save-serving-")
  const directories = testDirectories(dir)
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath: join(dir, "flywheel.toml"), watch: false })
  const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
  const models = ["gpt-6.1-sol", "gpt-5.4"]
  const offerings = new Map(models.map((id) => [id, [{ wireModelId: id, metadata: null, dataUse: "standard", transport: "openai-responses", resolvedMetadata: modelInfo("openai", id, "gpt", 5, 30, "2026-04-01") } as const]]))
  const catalog = { catalog: new Set(models), curatedDefault: new Set(models), enabled: new Set<string>(), disabled: new Set<string>(), effective: new Set(models) }
  const preferences = createProviderModelPreferenceService({
    displayName: (id) => id, allowTrainingRoutes: () => false,
    persist: async () => { throw new Error("unused") },
    persistAllDeselected: async () => { throw new Error("unused") },
  })
  const eligibility = preferences.prepare({
    profileId: "default", authRevision: "auth", preferenceRevision: "preferences",
    catalogs: new Map([["openai_api", catalog]]),
    accountCatalogs: new Map([[accessProviderAccountKey(candidate), catalog]]),
    inventoryCandidates: new Map([[accessProviderAccountKey(candidate), { candidate, configured: true, currentConnection: true, enabledOfferings: offerings, inventoryOfferings: offerings, catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } }]]),
    releaseDates: new Map(),
  })
  let auth = testAuthContext({ apiKeys: { openai_api: "test-key" } })
  const manager = managerDouble()
  manager.seed("chat-new", { chat: { model: "gpt-6.1-sol", effort: "medium" } })
  const providers = accessProviderRegistry(composeFirstPartyModules())
  const service = createAdmittedModelAssignmentService({
    userDataRoot: directories.userDataRoot,
    projectRoot: dir,
    manager,
    sessionStore: { get: () => undefined },
    eventReader: asAsyncEventReadSurface(inMemoryEventReader([])),
    eventWriter: unusedEventWriter,
    availability,
    runtimeConfig,
    resolveKey: async () => undefined,
    moduleSelection: () => composeFirstPartyModules(),
    sessionAuthAdmission: testSessionAuthAdmission(),
    activeProfileId: () => "default",
    prepareEligibility: async () => {},
    eligibilityState: () => eligibility,
    readAdmission: async () => ({
      auth,
      profile: { persistedId: "default", effectiveId: "default" },
      modelAssignmentEligibility: eligibility,
      capture: {
        providers,
        connection: captureProviderConnection({ profileId: "default", authDir: authDir(directories.userDataRoot, "default"), auth }),
        eligibility: eligibility.worker,
        allowTrainingRoutes: false,
        requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }),
      },
    }),
  })
  const session = { kind: "session", sessionId: "chat-new" } as const
  const unservable = "Saved Chat, but lost-model cannot serve now. gpt-6.1-sol at medium effort serves until it can."
  try {
    expect(await service.saveEffort({ scope: session, slot: roleSlot("chat"), model: "gpt-5.4", effort: "low" })).toEqual({ label: "Chat" })
    expect(await service.saveEffort({ scope: session, slot: roleSlot("chat"), model: "lost-model", effort: "high" })).toEqual({ label: "Chat", warning: unservable })
    expect(await service.saveEffort({ scope: { kind: "defaults-and-session", sessionId: "chat-new" }, slot: roleSlot("chat"), model: "lost-model", effort: "high" }))
      .toEqual({ label: "Chat", mirrored: true, warning: unservable })
    auth = testAuthContext({})
    expect(await service.saveEffort({ scope: session, slot: roleSlot("chat"), model: "gpt-5.4", effort: "low" }))
      .toEqual({ label: "Chat", warning: "Saved Chat, but no model can serve now." })
    expect((await manager.read("chat-new"))?.roleAssignments?.overrides.chat).toEqual({ model: "gpt-5.4", effort: "low" })
  } finally {
    await preferences.dispose()
    await runtimeConfig.dispose()
  }
})

test("each model row names the provider that would serve now, read afresh from the shared availability authority", async () => {
  const dir = temporaryDirectory("flywheel-serving-provider-")
  const directories = testDirectories(dir)
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath: join(dir, "flywheel.toml"), watch: false })
  const model = "gpt-6.1-sol"
  const keyed = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
  const accounts = ["account-a", "account-b"].map((instanceId) => ({ kind: "subscription", providerId: "chatgpt", instanceId, spendMode: "included" } as const))
  const offerings = new Map([[model, [{ wireModelId: model, metadata: null, dataUse: "standard", transport: "openai-responses", resolvedMetadata: modelInfo("openai", model, "gpt", 5, 30, "2026-04-01") } as const]]])
  const catalog = { catalog: new Set([model]), curatedDefault: new Set([model]), enabled: new Set<string>(), disabled: new Set<string>(), effective: new Set([model]) }
  const preferences = createProviderModelPreferenceService({
    displayName: (id) => id, allowTrainingRoutes: () => false,
    persist: async () => { throw new Error("unused") },
    persistAllDeselected: async () => { throw new Error("unused") },
  })
  const eligibility = preferences.prepare({
    profileId: "default", authRevision: "auth", preferenceRevision: "preferences",
    catalogs: new Map([["openai_api", catalog], ["chatgpt", catalog]]),
    accountCatalogs: new Map([keyed, ...accounts].map((account) => [accessProviderAccountKey(account), catalog])),
    inventoryCandidates: new Map([keyed, ...accounts].map((account) => [accessProviderAccountKey(account), { candidate: account, configured: true, currentConnection: true, enabledOfferings: offerings, inventoryOfferings: offerings, catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" } }])),
    releaseDates: new Map(),
  })
  const auth = testAuthContext({ apiKeys: { openai_api: "test-key" } })
  const connection = captureProviderConnection({
    profileId: "default", authDir: authDir(directories.userDataRoot, "default"), auth,
    subscriptionCredentials: new Map([["chatgpt", accounts.map(({ instanceId }) => ({
      instanceId, credential: { type: "oauth" as const, access: Redacted.make("test-access"), refresh: Redacted.make("test-refresh"), expires: 1 },
    }))]]),
  })
  // The picker and another process each own an availability authority on one file, as two runtimes do.
  const dbFile = join(temporaryDirectory("flywheel-serving-availability-"), "availability-authority.sqlite")
  const authorities = [createAvailabilityAuthority({ dbFile }), createAvailabilityAuthority({ dbFile })] as const
  const picker = createProviderAvailability({ authority: authorities[0] })
  const other = createProviderAvailability({ authority: authorities[1] }).forCandidates("default", [keyed, ...accounts])
  const service = createAdmittedModelAssignmentService({
    userDataRoot: directories.userDataRoot,
    projectRoot: dir,
    manager: managerDouble(),
    sessionStore: { get: () => undefined },
    eventReader: asAsyncEventReadSurface(inMemoryEventReader([])),
    eventWriter: unusedEventWriter,
    availability,
    runtimeConfig,
    resolveKey: async () => undefined,
    moduleSelection: () => composeFirstPartyModules(),
    sessionAuthAdmission: testSessionAuthAdmission(),
    activeProfileId: () => "default",
    prepareEligibility: async () => {},
    eligibilityState: () => eligibility,
    providerAvailability: picker,
    readAdmission: async () => ({
      auth,
      profile: { persistedId: "default", effectiveId: "default" },
      modelAssignmentEligibility: eligibility,
      capture: {
        providers: accessProviderRegistry(composeFirstPartyModules()),
        connection,
        eligibility: eligibility.worker,
        allowTrainingRoutes: false,
        requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }),
      },
    }),
  })
  const serving = async () => {
    const rows = await service.listModelOptions({ scope: { kind: "defaults" }, slot: roleSlot("chat") })
    const row = rows.find((entry) => entry.model === model)
    expect(row?.providers.map(({ name, shortName }) => [name, shortName])).toEqual([["ChatGPT Subscription", "ChatGPT"], ["OpenAI API Key", "OpenAI"]])
    return row?.providers.filter((provider) => provider.serving).map((provider) => provider.name)
  }
  try {
    expect(await serving()).toEqual(["ChatGPT Subscription"])
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600
    for (const account of accounts) other.observeChatGptQuotaExhausted(account, resetsAtSeconds)
    expect(await serving()).toEqual(["OpenAI API Key"])
    other.markQuotaExhausted(keyed, Date.now() + 3_600_000)
    expect(await serving()).toEqual([])
  } finally {
    await picker.dispose()
    for (const authority of authorities) await authority.dispose()
    await preferences.dispose()
    await runtimeConfig.dispose()
  }
})

test("keeps connection conditions with the credential capture when a transient fault repairs during key resolution", async () => {
  const dir = temporaryDirectory("flywheel-admission-conditions-")
  const directories = testDirectories(dir)
  const profiles = new AuthProfileManager({ userDataRoot: directories.userDataRoot, projectRoot: dir, env: {} })
  const access = await profiles.acquireAccess({ createDefault: true })
  access.close()
  const profile = { id: "default", directory: authDir(directories.userDataRoot, "default") }
  const file = join(profile.directory, "auth.json")
  const healthy = JSON.stringify({ openai_api: { type: "api_key", key: "!helper", lineageId: "00000000-0000-4000-8000-000000000001" } })
  writeFileSync(file, healthy)
  const composition = composeFirstPartyModules()
  const classifier = credentialSlotClassifier(composition)
  const conditions = createAuthConditionOwner()
  const observe = () => {
    const load = loadAuthStoreWithDiagnostics(profile.directory, installedCredentialProviderIds(), classifier, false)
    conditions.observeLoad(profile.directory, load)
    return load
  }
  const preferences = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
  const revision = authProfileEligibilityInputRevision(profile)
  preferences.publish(preferences.prepare({ profileId: profile.id, authRevision: revision.auth, preferenceRevision: revision.preferences, catalogs: new Map(), accountCatalogs: new Map(), inventoryCandidates: new Map(), releaseDates: new Map() }))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const preparation = createEligibilityPreparation({
    allowTrainingRoutes: () => false,
    userDataRoot: directories.userDataRoot, moduleSelection: () => composition,
    prepare: preferences.prepare, publish: preferences.publish, current: preferences.state,
    inputRevision: authProfileEligibilityInputRevision, observeAuth: observe,
    resolveKey: async () => undefined,
    resolveAuth: async () => resolveAuthContext({
      authDir: profile.directory, load: observe(), definitions: [], credentialSlotClassifier: classifier,
      resolveKey: async () => { entered.resolve(); await release.promise; return Redacted.make("captured-key") },
    }),
  })
  const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath: join(dir, "flywheel.toml"), watch: false })
  const admission = createModelAssignmentReadAdmission({
    userDataRoot: directories.userDataRoot,
    manager: {
      read: async () => { throw new Error("Default admission must not read a session") },
      captureAuthProfileIfAbsent: async () => { throw new Error("Default admission must not capture a session profile") },
    },
    authProfiles: profiles,
    materialize: async () => {}, prepareEligibility: preparation, runtimeConfig,
    captureSubscriptionAdmission: noSubscriptionAdmission,
  })
  try {
    const pending = admission({ kind: "defaults" })
    await entered.promise
    writeFileSync(file, "{malformed")
    observe()
    writeFileSync(file, healthy)
    release.resolve()
    const result = await pending
    expect(result.auth.conditions ?? []).toEqual([])
    expect(result.capture.connection.auth.conditions ?? []).toEqual([])
    expect(Redacted.value(apiKey(result.capture.connection.auth, "openai_api")!)).toBe("captured-key")
    expect(conditions.snapshot(profile.directory)).toMatchObject([{ kind: "malformed", scope: "file" }])
  } finally {
    release.resolve()
    await preparation.dispose()
    await preferences.dispose()
    await runtimeConfig.dispose()
  }
})
