import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { createAuthStatusProjection } from "../../../../src/orchestration/app-service/auth-status-projection.js"
import { createAuthAttentionPublisher } from "../../../../src/orchestration/app-service/auth-attention-publisher.js"
import { RuntimeAuthStatusSnapshotResultSchema } from "../../../../src/protocol/auth-status-protocol-schemas.js"
import { disconnectProviderInstance, loginWithApiKey, logoutProvider, renameProviderInstance } from "../../../../src/orchestration/auth/auth-actions.js"
import { plainApiKey } from "../../../helpers/auth-context.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { installCustomProvidersFromConfig } from "../../../../src/orchestration/config/custom-providers.js"
import { customProviderRejections, installCustomProviders } from "../../../../src/infra/llm/custom-provider-registry.js"
import { refusingLauncher } from "../../../helpers/launcher-fake.js"
import { processLoginObservations } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js"
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../../../src/infra/notification-episode.js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { LOGIN_ACCOUNTS_DIRECTORY, LOGIN_PROGRAM_LABEL } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/names.js"
import { appendCredentialInstance } from "../../../../src/infra/auth/auth-store-mutations.js"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import { installedCredentialSlotClassifier } from "../../../../src/orchestration/credential-provider-modules.js"
import { createProviderModelPreferenceService, type ProviderModelInventoryCandidate } from "../../../../src/orchestration/app-service/provider-model-preference-service.js"

const completeModuleSelection = () => composeFirstPartyModules()
const emptyConsent = (profileId: string) => ({ kind: "available", profileId, authorityIncarnation: "test-authority", authorityRevision: 0, usageGeneration: 0, accounts: [] }) as const
/** The notification episodes a publication of `view` states. */
const attentionOf = async (view: RuntimeAuthView): Promise<NotificationEpisodeInput[]> => {
  const episodes: NotificationEpisodeInput[] = []
  const publisher = createAuthAttentionPublisher({ deliver: async (episode) => { episodes.push(episode) } })
  publisher.state(view)
  await publisher.dispose()
  return episodes
}
describe("auth status projection", () => {
  const temporaryDirectory = temporaryDirectories()

  test("keeps rejected custom configuration separate from the first-party credential", async () => {
    const directory = join(temporaryDirectory("fw-rejected-custom-"), "auth")
    mkdirSync(directory)
    const profile = { id: "default", displayName: "Default", source: "default" as const, directory, availableProfiles: [], persistedId: "default", projectBinding: undefined, retirements: {} }
    await loginWithApiKey("openai_api", "dummy-key-059", directory, async (key) => Redacted.make(key), undefined, async () => {})
    try {
      installCustomProvidersFromConfig({ openai_api: { base_url: "http://127.0.0.1:9/v1", models: ["shadow2"] } }, [])
      const view = await createAuthStatusProjection({ initialProfile: profile, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent }).snapshot()
      const firstParty = view.providers.filter((provider) => provider.providerId === "openai_api")
      const rejected = view.providers.find((provider) => provider.source === "misconfigured")
      expect(firstParty).toHaveLength(1)
      expect(firstParty[0]).toMatchObject({ displayName: "OpenAI API Key", source: "stored_key" })
      expect(rejected).toMatchObject({
        providerId: "rejected-custom:openai_api",
        displayName: "[custom_providers.openai_api] (rejected)",
        source: "misconfigured",
        configured: false,
        accounts: [],
        detail: customProviderRejections()[0]?.reason,
      })
      expect(rejected?.servingCandidate).toBeUndefined()
      expect(rejected?.catalog).toBeUndefined()
      expect(rejected?.keyHint).toBeUndefined()
      expect(rejected?.keyPrefix).toBeUndefined()
      const context = await logoutProvider("anthropic_api", directory, async (key) => Redacted.make(key), { launcher: refusingLauncher })
      expect(plainApiKey(context, "openai_api")).toBe("dummy-key-059")
    } finally {
      installCustomProviders([])
    }
  })

  test("groups provider capability above secret-free account entries", async () => {
    // An auth mutation creates `profile-locks` beside the auth directory, so
    // the auth directory sits one level inside the temporary directory.
    const directory = join(temporaryDirectory("fw-auth-status-"), "auth")
    mkdirSync(directory)
    const profile = {
      id: "work",
      displayName: "Work Account",
      source: "project" as const,
      directory,
      availableProfiles: [{ id: "work", displayName: "Work Account" }, { id: "default", displayName: "Default" }],
      projectBinding: "work",
      persistedId: "work",
      retirements: {},
    }
    await loginWithApiKey("opencode_go", "!security find-generic-password -w -s go-api-key", directory, async () => Redacted.make("resolved-secret-1234"), undefined, async () => {})
    const view = await createAuthStatusProjection({ initialProfile: profile, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent }).snapshot()
    const openCodeGo = view.providers.find((provider) => provider.providerId === "opencode_go")
    const anthropic = view.providers.find((provider) => provider.providerId === "anthropic_api")

    expect(openCodeGo).toEqual(expect.objectContaining({
      providerId: "opencode_go",
      kind: "subscription",
      source: "stored_key",
      modelCapable: true,
      displayName: "OpenCode Go Subscription",
    }))
    expect(openCodeGo?.accounts).toHaveLength(1)
    expect(openCodeGo?.accounts[0]).toEqual(expect.objectContaining({ identity: "••••1234", displayLabel: "••••1234", source: "stored_key", expired: false }))
    expect(openCodeGo?.accounts[0]).toEqual(expect.not.objectContaining({ credential: expect.anything(), key: expect.anything() }))
    expect(anthropic).toEqual({
      providerId: "anthropic_api",
      kind: "singleton",
      source: "unconfigured",
      expired: false,
      configured: false,
      modelCapable: true,
      loginMethod: "api-key",
      statusRank: 10,
      group: "model",
      displayName: "Anthropic API Key",
      keyPrefix: "sk-ant-",
      accounts: [],
    })
    expect(view.profile.availableProfiles).toEqual([{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work Account" }])

    const instanceId = openCodeGo?.accounts[0]?.instanceId
    if (instanceId === undefined) throw new Error("expected OpenCode Go account")
    await renameProviderInstance("opencode_go", instanceId, "Work", directory)
    const projection = createAuthStatusProjection({ initialProfile: profile, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent })
    expect((await projection.snapshot()).providers.find((provider) => provider.providerId === "opencode_go")?.accounts[0]?.displayLabel).toBe("Work")
    await disconnectProviderInstance("opencode_go", instanceId, directory, { launcher: refusingLauncher })
    expect(projection.replace(profile).providers.find((provider) => provider.providerId === "opencode_go")?.accounts).toEqual([])
  })

  test("filters disabled providers and derives auth row metadata from the selected composition", async () => {
    const directory = temporaryDirectory("fw-auth-filtered-")
    const profile = {
      id: "default",
      displayName: "Default",
      source: "default" as const,
      directory,
      availableProfiles: [{ id: "default", displayName: "Default" }],
      persistedId: "default",
      projectBinding: undefined,
      retirements: {},
    }
    let composition = composeFirstPartyModules()
    const projection = createAuthStatusProjection({ initialProfile: profile, moduleSelection: () => composition, subscriptionSpendConsent: emptyConsent })
    expect((await projection.snapshot()).providers.find((provider) => provider.providerId === "chatgpt")).toEqual(expect.objectContaining({ loginMethod: "browser-auth", statusRank: 60, group: "model" }))
    expect((await projection.snapshot()).providers.find((provider) => provider.providerId === "exa")).toEqual(expect.objectContaining({ loginMethod: "api-key", group: "web" }))
    // The program that owns an external login names each account by its email, so its accounts take no label.
    expect((await projection.snapshot()).providers.find((provider) => provider.providerId === "claude_agent_sdk")).toEqual(expect.objectContaining({ loginMethod: "browser-auth", loginProgram: LOGIN_PROGRAM_LABEL, group: "model" }))

    composition = composeFirstPartyModules(undefined, ["provider-anthropic-api", "web-exa"])
    const filtered = projection.replace(profile)
    expect(filtered.providers.find((provider) => provider.providerId === "anthropic_api")).toBeUndefined()
    expect(filtered.providers.find((provider) => provider.providerId === "exa")).toBeUndefined()
  })

  test("stale provider diagnostics do not block projection, login, logout, or healthy chat auth", async () => {
    const accountHome = temporaryDirectory("fw-stale-auth-")
    const directory = join(accountHome, ".flywheel", "auth")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "auth.json"), JSON.stringify({
      removed_provider: { type: "api_key", key: "[redacted stale secret]" },
      openai_api: { type: "api_key", key: "[redacted healthy secret]" },
    }))
    const profile = {
      id: "default",
      displayName: "Default",
      source: "default" as const,
      directory,
      availableProfiles: [{ id: "default", displayName: "Default" }],
      persistedId: "default",
      projectBinding: undefined,
      retirements: {},
    }

    const initial = await createAuthStatusProjection({ initialProfile: profile, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent }).snapshot()
    expect(initial.providers.find((provider) => provider.providerId === "openai_api")?.source).toBe("stored_key")
    expect(initial.warnings).toEqual([
      'Credential provider "removed_provider" is not installed. Remove its entry from auth.json.',
    ])

    const loggedIn = await loginWithApiKey("anthropic_api", "[redacted new secret]", directory, async (key) => Redacted.make(key), undefined, async () => {})
    expect(plainApiKey(loggedIn, "openai_api")).toBe("[redacted healthy secret]")
    await logoutProvider("anthropic_api", directory, async (key) => Redacted.make(key), { launcher: refusingLauncher })

    const final = await createAuthStatusProjection({ initialProfile: profile, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent }).snapshot()
    expect(final.providers.find((provider) => provider.providerId === "anthropic_api")?.source).toBe("unconfigured")
    expect(final.providers.find((provider) => provider.providerId === "openai_api")?.source).toBe("stored_key")
    expect(final.warnings[0]).toContain("removed_provider")
  })

  test("publishes provider attention as stable provider-specific notification episodes", async () => {
    const directory = temporaryDirectory("fw-auth-notification-")
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ openai_api: { type: "api_key" } }))
    const profile = {
      id: "default",
      displayName: "Default",
      source: "default" as const,
      directory,
      availableProfiles: [{ id: "default", displayName: "Default" }],
      persistedId: "default",
      projectBinding: undefined,
      retirements: {},
    }
    const projection = createAuthStatusProjection({
      initialProfile: profile,
      moduleSelection: completeModuleSelection,
      subscriptionSpendConsent: emptyConsent,
    })
    const notifications: NotificationEpisodeInput[] = []
    const attention = createAuthAttentionPublisher({ deliver: async (episode) => { notifications.push(episode) } })
    const publish = async (view: RuntimeAuthView) => {
      attention.state(view)
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      return view
    }

    const initial = await publish(await projection.snapshot())
    expect(initial.authFilePath).toBe(join(directory, "auth.json"))
    expect(initial.providers.find((provider) => provider.providerId === "openai_api")?.attention).toEqual({
      kind: "malformed",
      message: "Stored authentication data is malformed.",
    })
    expect(initial.warnings).toEqual([])
    // Reads state nothing, and a publication of unchanged attention states nothing.
    await projection.snapshot()
    projection.view(profile)
    await publish(await projection.snapshot())
    writeFileSync(join(directory, "auth.json"), "{}")
    const repaired = await publish(projection.replace(profile))
    expect(repaired.providers.find((provider) => provider.providerId === "openai_api")?.attention).toBeUndefined()
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ openai_api: { type: "api_key" } }))
    await publish(projection.replace(profile))
    await attention.dispose()

    // Each change states the profile's whole attention set; the seam's
    // observer raises what is new and resolves what cleared. The legacy
    // diagnostics source is stated beside it.
    const providerAttention: NotificationOccurrence = { sourceId: "runtime:auth-attention:default:provider:openai_api", title: "OpenAI API Key needs attention", message: "Reconnect OpenAI API Key.", severity: "warning", action: { kind: "open-auth-provider", providerId: "openai_api" } }
    const legacy: NotificationEpisodeInput = { type: "resolve", sourceId: "runtime:auth-status-warning:default" }
    expect(notifications).toEqual([
      { type: "reconcile", prefix: "runtime:auth-attention:default:", desired: [providerAttention] }, legacy,
      { type: "reconcile", prefix: "runtime:auth-attention:default:", desired: [] }, legacy,
      { type: "reconcile", prefix: "runtime:auth-attention:default:", desired: [providerAttention] }, legacy,
    ])
    expect(JSON.stringify(notifications)).not.toContain("revision")
  })

  test("an external login shows each account's plan and the problems of its logins, and a notice only for an account that has a problem", async () => {
    // The provider finds the Claude logins in the profile directory, and the observations are this
    // process's; the test removes its login and clears what it observed at the end.
    const directory = join(temporaryDirectory("fw-auth-external-"), "auth")
    mkdirSync(directory, { recursive: true })
    const login = { configDir: join(directory, LOGIN_ACCOUNTS_DIRECTORY, "a"), accountId: "uuid-person" }
    try {
      const profile = { id: "default", displayName: "Default", source: "default" as const, directory, availableProfiles: [{ id: "default", displayName: "Default" }], persistedId: "default", projectBinding: undefined, retirements: {} }
      const projection = createAuthStatusProjection({ initialProfile: profile, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent })
      const claude = (view: RuntimeAuthView) => view.providers.find((provider) => provider.providerId === "claude_agent_sdk")
      const desired = async (view: RuntimeAuthView) => (await attentionOf(view)).flatMap((episode) => episode.type === "reconcile" ? [episode.desired.map(({ sourceId, message }) => ({ sourceId, message }))] : []).at(-1)

      // Nobody logged in: the engine ships with Flywheel, so the row has nothing to install and no notice.
      const unusedView = await projection.snapshot()
      const unused = claude(unusedView)
      expect(unused).toMatchObject({ source: "unconfigured", accounts: [] })
      expect(unused?.attention).toBeUndefined()
      expect(await desired(unusedView)).toEqual([])

      mkdirSync(login.configDir, { recursive: true })
      writeFileSync(join(login.configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-person", emailAddress: "person@example.com", planDisplayName: "Claude Max" } }))
      processLoginObservations.recordRequest(login, "login-rejected")
      const rejectedView = projection.replace(profile)
      const rejected = claude(rejectedView)
      expect(rejected?.accounts).toEqual([expect.objectContaining({
        identity: "person@example.com", plan: "Claude Max", expired: true,
        attention: { kind: "login-rejected", message: "Claude refused this account's login in this profile. Log in again." },
      })])
      expect(await desired(rejectedView)).toEqual([
        { sourceId: `runtime:auth-attention:default:account:claude_agent_sdk:${rejected?.accounts[0]?.accountCorrelationId}`, message: "Claude refused this account's login in this profile. Log in again." },
      ])
      expect(Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)({ snapshotPosition: 1, auth: projection.replace(profile) })).toBeDefined()

      // A served request clears the account's problem and its notice.
      processLoginObservations.recordRequest(login, "served")
      const servedView = projection.replace(profile)
      const served = claude(servedView)?.accounts[0]
      expect(served).toMatchObject({ expired: false })
      expect(served?.attention).toBeUndefined()
      expect(await desired(servedView)).toEqual([])
    } finally {
      processLoginObservations.clearRequest(login)
      rmSync(login.configDir, { recursive: true, force: true })
    }
  })

  test("an idle free-plan account stays connected, its row says why, and the person gets one notice (PI-MODEL-038)", async () => {
    const directory = join(temporaryDirectory("fw-auth-free-plan-"), "auth")
    mkdirSync(directory)
    const credential = { type: "oauth" as const, access: "at", refresh: "rt", expires: Date.now() + 60_000 }
    await appendCredentialInstance("chatgpt", { id: "11111111-0000-4000-8000-00000000000a", identity: "paid@example.com", credential }, directory, installedCredentialSlotClassifier())
    await appendCredentialInstance("chatgpt", { id: "11111111-0000-4000-8000-00000000000b", identity: "free@example.com", credential }, directory, installedCredentialSlotClassifier())
    const service = createProviderModelPreferenceService({ displayName: (id) => id, allowTrainingRoutes: () => false, persist: async () => "next", persistAllDeselected: async () => "next" })
    const candidate = (instanceId: string) => ({ kind: "subscription", providerId: "chatgpt", instanceId, spendMode: "included" }) as const
    const entry = (instanceId: string, idle: boolean): [string, ProviderModelInventoryCandidate] => [accessProviderAccountKey(candidate(instanceId)), {
      candidate: candidate(instanceId), configured: true, currentConnection: true, enabledOfferings: new Map(), inventoryOfferings: new Map(),
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" }, ...(idle ? { idleFreePlan: {} } : {}),
    }]
    const instances = ["11111111-0000-4000-8000-00000000000a", "11111111-0000-4000-8000-00000000000b"]
    const models = { catalog: new Set<string>(), curatedDefault: new Set<string>(), enabled: new Set<string>(), disabled: new Set<string>(), effective: new Set<string>() }
    const state = service.prepare({
      profileId: "default", autoEnableNewModels: true, authRevision: "a", preferenceRevision: "p", catalogs: new Map(), releaseDates: new Map(),
      accountCatalogs: new Map(instances.map((instanceId) => [accessProviderAccountKey(candidate(instanceId)), models])),
      inventoryCandidates: new Map([entry(instances[0] ?? "", false), entry(instances[1] ?? "", true)]),
    })
    const profile = { id: "default", displayName: "Default", source: "default" as const, directory, availableProfiles: [{ id: "default", displayName: "Default" }], persistedId: "default", projectBinding: undefined, retirements: {} }
    const view = await createAuthStatusProjection({ initialProfile: profile, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent, eligibilityState: () => state }).snapshot()
    const accounts = view.providers.find((provider) => provider.providerId === "chatgpt")?.accounts ?? []

    expect(accounts.map(({ identity, expired, attention }) => ({ identity, expired, kind: attention?.kind }))).toEqual([
      { identity: "paid@example.com", expired: false, kind: undefined },
      { identity: "free@example.com", expired: false, kind: "free-plan" },
    ])
    const message = accounts[1]?.attention?.message ?? ""
    expect(message).toContain("only paid accounts rotate")
    const notices = (await attentionOf(view)).flatMap((episode) => episode.type === "reconcile" ? episode.desired : [])
    expect(notices.map((notice) => notice.message)).toEqual([message])
    await service.dispose()
  })

  test("projects one curated root file attention without condition internals", async () => {
    const directory = temporaryDirectory("fw-auth-file-attention-")
    const path = join(directory, "auth.json")
    writeFileSync(path, "{")
    const profile = {
      id: "default",
      displayName: "Default",
      source: "default" as const,
      directory,
      availableProfiles: [{ id: "default", displayName: "Default" }],
      persistedId: "default",
      projectBinding: undefined,
      retirements: {},
    }

    const view = await createAuthStatusProjection({
      initialProfile: profile,
      moduleSelection: completeModuleSelection,
      subscriptionSpendConsent: emptyConsent,
    }).snapshot()

    expect(view.fileAttention).toEqual({
      kind: "malformed",
      path,
      message: "The authentication file is malformed.",
    })
    expect(JSON.stringify(view.fileAttention)).not.toContain("revision")
    expect(view.providers.every((provider) => provider.attention === undefined)).toBe(true)
    expect(await attentionOf(view)).toEqual([
      { type: "reconcile", prefix: "runtime:auth-attention:default:", desired: [{
        sourceId: "runtime:auth-attention:default:file",
        title: "Authentication file needs attention",
        message: `Repair the authentication file at ${path}.`,
        severity: "warning",
        action: { kind: "open-auth" },
      }] },
      { type: "resolve", sourceId: "runtime:auth-status-warning:default" },
    ])
  })

  test("keeps the generic warning source for legacy diagnostics only", async () => {
    const directory = temporaryDirectory("fw-auth-legacy-warning-")
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ removed_provider: { type: "api_key", key: "not-exposed" } }))
    const view = await createAuthStatusProjection({
      initialProfile: { id: "default", displayName: "Default", source: "default", directory, availableProfiles: [{ id: "default", displayName: "Default" }], persistedId: "default", projectBinding: undefined, retirements: {} },
      moduleSelection: completeModuleSelection,
      subscriptionSpendConsent: emptyConsent,
    }).snapshot()
    expect(await attentionOf(view)).toEqual([
      { type: "reconcile", prefix: "runtime:auth-attention:default:", desired: [] },
      {
        type: "raise",
        occurrence: {
          sourceId: "runtime:auth-status-warning:default",
          title: "Authentication needs attention",
          message: "The authentication file names a provider that Flywheel does not recognize.",
          severity: "warning",
          action: { kind: "open-auth" },
        },
      },
    ])
  })

  test("an invalid instance raises only its provider episode", async () => {
    const directory = temporaryDirectory("fw-auth-invalid-instance-")
    writeFileSync(join(directory, "auth.json"), JSON.stringify({ chatgpt: [{ id: "", identity: "bad", credential: { type: "oauth", access: "x", expires: 1 } }] }))
    const view = await createAuthStatusProjection({
      initialProfile: { id: "default", displayName: "Default", source: "default", directory, availableProfiles: [{ id: "default", displayName: "Default" }], persistedId: "default", projectBinding: undefined, retirements: {} },
      moduleSelection: completeModuleSelection,
      subscriptionSpendConsent: emptyConsent,
    }).snapshot()
    expect(await attentionOf(view)).toEqual([
      expect.objectContaining({ type: "reconcile", desired: [expect.objectContaining({ sourceId: "runtime:auth-attention:default:provider:chatgpt" })] }),
      { type: "resolve", sourceId: "runtime:auth-status-warning:default" },
    ])
  })

  test("schema round-trips auth status snapshots", () => {
    const snapshot = {
      snapshotPosition: 7,
      auth: {
        providers: [{ providerId: "openai_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 20, group: "model", displayName: "OpenAI API Key", accounts: [] }],
        warnings: [],
        authFilePath: "/profiles/default/auth.json",
        profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
        subscriptionSpendConsent: emptyConsent("default"),
      },
    }

    expect<unknown>(Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)(snapshot)).toEqual(snapshot)
    const question = { questionId: "episode", providerId: "claude_agent_sdk", instanceId: "account", profileId: "other", profileDisplayName: "Other", providerDisplayName: "Anthropic Subscription", accountDisplayName: "person@example.com" }
    const withQuestion = { ...snapshot, auth: { ...snapshot.auth, loginQuestions: [question] } }
    expect<unknown>(Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)(withQuestion, { onExcessProperty: "error" })).toEqual(withQuestion)
    expect(() => Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)({
      ...snapshot, auth: { ...snapshot.auth, loginQuestions: [{ ...question, authDir: "/private/auth" }] },
    }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)({
      snapshotPosition: 7,
      auth: {
        providers: [{ providerId: "openai_api", kind: "singleton", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 20, group: "model", displayName: "OpenAI API Key", accounts: [], key: "secret" }],
        warnings: [],
        authFilePath: "/profiles/default/auth.json",
        profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
        subscriptionSpendConsent: emptyConsent("default"),
      },
    }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)({
      ...snapshot,
      auth: {
        ...snapshot.auth,
        fileAttention: { kind: "malformed", path: "/auth.json", message: "Repair the file.", revision: "secret-internal" },
      },
    }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(RuntimeAuthStatusSnapshotResultSchema)({
      ...snapshot,
      auth: {
        ...snapshot.auth,
        providers: [{
          ...snapshot.auth.providers[0],
          attention: { kind: "malformed", message: "Repair the provider.", revision: "secret-internal" },
        }],
      },
    }, { onExcessProperty: "error" })).toThrow()
  })
  test("projects defaults and session credentials through separate server scopes", async () => {
    const root = temporaryDirectory("fw-auth-scopes-")
    const defaultsDirectory = join(root, "defaults")
    const sessionDirectory = join(root, "session")
    mkdirSync(defaultsDirectory, { recursive: true })
    mkdirSync(sessionDirectory, { recursive: true })
    await loginWithApiKey("opencode_go", "!default", defaultsDirectory, async () => Redacted.make("alpha-secret"), undefined, async () => {})
    await loginWithApiKey("opencode_go", "!session", sessionDirectory, async () => Redacted.make("beta-token"), undefined, async () => {})
    const defaults = {
      id: "default",
      displayName: "Default",
      source: "default" as const,
      directory: defaultsDirectory,
      availableProfiles: [{ id: "default", displayName: "Default" }, { id: "session", displayName: "Session" }],
      persistedId: "default",
      projectBinding: undefined,
      retirements: {},
    }
    const session = { ...defaults, id: "session", persistedId: "session", displayName: "Session", directory: sessionDirectory }
    const projection = createAuthStatusProjection({
      initialProfile: defaults,
      moduleSelection: completeModuleSelection,
      subscriptionSpendConsent: emptyConsent,
      resolveProfile: async (scope) => scope.kind === "session" ? session : defaults,
    })
    const defaultView = await projection.snapshot({ kind: "defaults" })
    const sessionView = await projection.snapshot({ kind: "session", sessionId: "session-1" })

    expect(defaultView.providers.find((provider) => provider.providerId === "opencode_go")?.accounts[0]?.identity).toBe("••••cret")
    expect(sessionView.providers.find((provider) => provider.providerId === "opencode_go")?.accounts[0]?.identity).toBe("••••oken")
    expect(sessionView.profile.id).toBe("session")
    expect(defaultView.profile.id).toBe("default")
  })
  test("projects a hidden profile's asking episode in every scope without adding it to notification history", async () => {
    const root = temporaryDirectory("fw-login-questions-")
    const defaults = { id: "a", persistedId: "a", displayName: "Profile A", source: "default" as const, directory: join(root, "a"), projectBinding: undefined, retirements: {}, availableProfiles: [{ id: "a", displayName: "Profile A" }, { id: "b", displayName: "Profile B" }] }
    const hidden = { ...defaults, id: "b", persistedId: "b", displayName: "Profile B", directory: join(root, "b") }
    const account = { accountId: "hidden-account", identity: "person@example.com", configDir: join(hidden.directory, LOGIN_ACCOUNTS_DIRECTORY, "a") }
    mkdirSync(account.configDir, { recursive: true })
    writeFileSync(join(account.configDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account.accountId, emailAddress: account.identity } }))
    const projection = createAuthStatusProjection({
      initialProfile: defaults, moduleSelection: completeModuleSelection, subscriptionSpendConsent: emptyConsent,
      resolveProfile: async (scope) => scope.kind === "session" ? hidden : defaults,
      resolveLoginProfile: (directory) => directory === hidden.directory ? hidden : directory === defaults.directory ? defaults : undefined,
    })
    processLoginObservations.recordRequest(account, "login-rejected")
    const waiting = processLoginObservations.awaitLogin(hidden.directory, account, new AbortController().signal)
    try {
      const defaultView = await projection.snapshot()
      const sessionView = await projection.snapshot({ kind: "session", sessionId: "background" })
      expect(defaultView.loginQuestions).toHaveLength(1)
      expect(defaultView.loginQuestions).toEqual(sessionView.loginQuestions)
      expect(defaultView.loginQuestions?.[0]).toMatchObject({ profileId: "b", profileDisplayName: "Profile B", accountDisplayName: account.identity, instanceId: account.accountId })
      expect(JSON.stringify(defaultView.loginQuestions)).not.toContain(root)
      expect(JSON.stringify([...await attentionOf(defaultView), ...await attentionOf(sessionView)])).not.toContain("questionId")
      const question = defaultView.loginQuestions?.[0]
      if (question === undefined) throw new Error("The hidden account has no login question")
      processLoginObservations.answerLogin(question.questionId, "renewed")
      expect((await projection.snapshot()).loginQuestions).toEqual([])
      expect((await projection.snapshot({ kind: "session", sessionId: "background" })).loginQuestions).toEqual([])
      processLoginObservations.settleLogin(question.questionId, "declined")
      expect(await waiting).toBe("declined")
      expect((await projection.snapshot()).profile.id).toBe("a")
    } finally {
      processLoginObservations.clearRequest(account)
      await waiting
    }
  })
})
