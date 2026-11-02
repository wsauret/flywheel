import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../../../../src/orchestration/config/schema.js"
import { CONFIG_VALUE_ABSENT, createRuntimeConfigOwner, type ConfigMutationResult, type RuntimeConfigOwner, type RuntimeConfigSnapshot } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { ConfigWriteError } from "../../../../src/orchestration/config/writer.js"
import { createRuntimeConfigProjection, projectRuntimeConfig as projectConfig } from "../../../../src/orchestration/app-service/runtime-config-projection.js"
import { RuntimeUiPatchSchema, runtimeQueryResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const PROJECT = "/scratch/project"
const projectRuntimeConfig = (source: RuntimeConfigSnapshot) => projectConfig(source, PROJECT)
const temporaryDirectory = temporaryDirectories()

const snapshot = (overrides: Partial<RuntimeConfigSnapshot> = {}): RuntimeConfigSnapshot => ({
  revision: 4,
  config: CONFIG_DEFAULTS,
  warnings: [],
  diagnostics: [],
  sourceIdentity: "secret-source-identity",
  status: { kind: "valid" },
  ...overrides,
})

type RuntimeConfigOwnerInput = Omit<RuntimeConfigOwner, "revalidateUseTime" | "useTimeObserver" | "mutateProfileBoolean" | "mutateProjectShowBuild" | "mutateProfileProviderSetting" | "mutateModuleSetting" | "mutateSection" | "resetSettings">
  & Partial<Pick<RuntimeConfigOwner, "mutateProfileBoolean" | "mutateProjectShowBuild" | "mutateProfileProviderSetting" | "mutateModuleSetting">>

const completeOwner = (owner: RuntimeConfigOwnerInput): RuntimeConfigOwner => ({
  resetSettings: async () => { throw new Error("unused") },
  mutateModuleSetting: async () => { throw new Error("unused") },
  mutateSection: async () => { throw new Error("unused") },
  mutateProfileBoolean: async () => { throw new Error("unused") },
  mutateProjectShowBuild: async () => { throw new Error("unused") },
  mutateProfileProviderSetting: async () => { throw new Error("unused") },
  ...owner,
  revalidateUseTime: async () => { throw new Error("unused") },
  useTimeObserver: () => async () => { throw new Error("unused") },
})

describe("runtime config projection", () => {
  test("publishes only catalog ui-safe values", () => {
    const config: FlywheelConfig = {
      ...structuredClone(CONFIG_DEFAULTS),
      theme: "midnight",
      auto_delete_session_days: 14,
      auth: { project_profiles: { "/secret/project": "private-profile" } },
      custom_providers: { private: { base_url: "https://secret.example", models: ["private-model"] } },
      profiles: {
        work: { roles: { reviewer: { model: "safe-model", effort: "high", provider_options: { openai: { service_tier: "nested-role-secret" } } }, chat: { model: "profile-model", provider_options: { openai: { service_tier: "nested-profile-secret" } } } }, git_ai_attribution: true, allow_training_routes: true, providers: { github_copilot: { monthly_credit_cap: 1_200 } } },
        personal: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: {} },
      },
    }

    const view = projectRuntimeConfig(snapshot({ config }))

    expect(view.revision).toBe(4)
    expect(view.values.theme).toBe("midnight")
    expect(view.values.autoDeleteSessionDays).toBe(14)
    const serialized = JSON.stringify(view)
    for (const sentinel of ["secret-source-identity", "/secret/project", "private-profile", "https://secret.example", "private-model", "nested-role-secret", "nested-profile-secret"]) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(view.values).not.toHaveProperty("mcp")
    expect(view.values).not.toHaveProperty("auth")
    expect(view.values).not.toHaveProperty("custom_providers")
    expect(view.values).not.toHaveProperty("modelEfforts")
    expect(view.values).not.toHaveProperty("roles")
    expect(view.values).not.toHaveProperty("copilotMonthlyCreditCap")
    expect(view.values.profiles).toEqual({
      work: { roles: { reviewer: { model: "safe-model", effort: "high" }, chat: { model: "profile-model" } }, gitAiAttribution: true, allowTrainingRoutes: true, providers: { github_copilot: { monthly_credit_cap: 1_200 } } },
      // An unauthored key is projected with its declared default.
      personal: { roles: {}, gitAiAttribution: false, allowTrainingRoutes: false, providers: { github_copilot: { monthly_credit_cap: 3_900 } } },
    })
  })

  test("malformed status retains values and valid recovery clears status", () => {
    const good = projectRuntimeConfig(snapshot())
    const malformed = projectRuntimeConfig(snapshot({ revision: 5, warnings: ["unknown secret-value"], status: { kind: "malformed", fallback: "last-valid", message: "bad secret-value" } }))
    const recovered = projectRuntimeConfig(snapshot({ revision: 6, status: { kind: "valid" } }))

    expect(malformed.values).toEqual(good.values)
    expect(JSON.stringify(malformed)).not.toContain("secret-value")
    expect(malformed.status).toEqual({ kind: "malformed", fallback: "last-valid", message: "The configuration is malformed. The last valid values remain active." })
    expect(malformed.warnings).toEqual([{ code: "config-normalized", message: "Some configuration values were ignored or normalized." }])
    expect(recovered.status).toEqual({ kind: "valid" })
    expect(recovered.warnings).toEqual([])
  })

  test("projects only the represented setting identity and reason", () => {
    const malformed = projectRuntimeConfig(snapshot({
      status: { kind: "malformed", fallback: "defaults", message: "raw" },
      diagnostics: [{ kind: "setting", settingId: "allowPersistentProcesses", path: ["allow_persistent_processes"], reason: "normalized-value" }],
    }))

    expect(malformed.status).toEqual({ kind: "malformed", fallback: "defaults", message: "The configuration is malformed. Default values are active." })
    expect(malformed.diagnostics).toEqual([{ kind: "setting", settingId: "allowPersistentProcesses", reason: "normalized-value" }])
  })

  test("wire schema rejects recursive sentinels and excess fields", () => {
    const config = projectRuntimeConfig(snapshot())
    const patch = { cursor: { scope: "workspace", domain: "config" }, position: 2, prevPosition: 1, payload: { kind: "config.changed", config } }
    // The query result decodes with the codec its discriminant selects.
    const queryResult = Schema.decodeUnknownSync(runtimeQueryResultSchema("configSnapshot"), { onExcessProperty: "error" })({ snapshotPosition: 2, config })
    const decodedPatch = Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })(patch)
    if (decodedPatch.payload.kind !== "config.changed") throw new Error("config protocol patch did not narrow")
    expect(queryResult).toEqual({ snapshotPosition: 2, config: decodedPatch.payload.config })
    expect(decodedPatch.payload.config.values).not.toHaveProperty("modelEfforts")

    const retiredEfforts = structuredClone(patch)
    Object.assign(retiredEfforts.payload.config.values, { modelEfforts: {} })
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })(retiredEfforts)).toThrow()

    const nestedSentinel = structuredClone(patch)
    Object.assign(nestedSentinel.payload.config.values, { mcp: { env: { TOKEN: "sentinel" } } })
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })(nestedSentinel)).toThrow()

    const nestedRoleSentinel = structuredClone(patch)
    Object.assign(nestedRoleSentinel.payload.config.values, { roles: {} })
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })(nestedRoleSentinel)).toThrow()

    const nestedProfileSentinel = structuredClone(patch)
    Object.assign(nestedProfileSentinel.payload.config.values.profiles, { work: { roles: { chat: { provider_options: { TOKEN: "sentinel" } } } } })
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })(nestedProfileSentinel)).toThrow()

    const excess = structuredClone(patch)
    Object.assign(excess.payload.config, { sourceIdentity: "sentinel" })
    expect(() => Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })(excess)).toThrow()
  })

  test("wire schema rejects unknown ids, paths, prose, and document diagnostics", () => {
    const decode = Schema.decodeUnknownSync(RuntimeUiPatchSchema, { onExcessProperty: "error" })
    const config = projectRuntimeConfig(snapshot({ diagnostics: [{ kind: "setting", settingId: "showThinking", path: ["show_thinking"], reason: "invalid-value" }] }))
    const patch = { cursor: { scope: "workspace", domain: "config" }, position: 2, prevPosition: 1, payload: { kind: "config.changed", config } }
    const diagnostic = patch.payload.config.diagnostics[0]
    if (diagnostic === undefined) throw new Error("Expected diagnostic")
    for (const invalid of [
      { ...diagnostic, settingId: "arbitrary" },
      { ...diagnostic, path: ["show_thinking"] },
      { ...diagnostic, message: "This setting was normalized for safety." },
      { kind: "document", reason: "unreadable" },
    ]) {
      const candidate = structuredClone({ ...patch, payload: { ...patch.payload, config: { ...patch.payload.config, diagnostics: [invalid] } } })
      expect(() => decode(candidate)).toThrow()
    }
  })

  test("mutation acknowledgement follows one matching publication and subscriber settlement", async () => {
    let current = snapshot()
    let subscriber: ((next: RuntimeConfigSnapshot) => void | Promise<void>) | undefined
    let releaseSubscriber: (() => void) | undefined
    const subscriberSettled = new Promise<void>((resolve) => { releaseSubscriber = resolve })
    const owner = completeOwner({
      snapshot: () => current,
      refresh: async () => current,
      subscribe: (_id, nextSubscriber) => { subscriber = nextSubscriber; return async () => {} },
      subscribeAll: () => async () => {},
      mutate: async (_id, expected, value): Promise<ConfigMutationResult> => {
        expect(expected).toBe(CONFIG_VALUE_ABSENT)
        expect(value).toBe("exa")
        const config = { ...structuredClone(CONFIG_DEFAULTS), web_search: { ...CONFIG_DEFAULTS.web_search, provider: "exa" as const } }
        current = snapshot({ revision: 5, config })
        await subscriber?.(current)
        await subscriberSettled
        return { ok: true, snapshot: current, subscriberOutcome: { kind: "settled" } }
      },
      dispose: async () => {},
    })
    const patches: unknown[] = []
    const projection = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: (patch) => { patches.push(patch) } })
    let acknowledged = false
    const pending = projection.mutate({ type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "absent" }, desired: "exa" } }).then((result) => { acknowledged = true; return result })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    releaseSubscriber?.()
    expect(await pending).toEqual({ kind: "committed", revision: 5 })
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ payload: { kind: "config.changed", config: { revision: 5, values: { webSearchProvider: "exa" } } } })
  })

  test("requires a declared provider setting within bounds and publishes only committed decoded revisions", async () => {
    let current = snapshot()
    const calls: unknown[] = []
    const owner = completeOwner({
      snapshot: () => current,
      refresh: async () => current,
      subscribe: () => async () => {},
      subscribeAll: () => async () => {},
      mutate: async (...args): Promise<ConfigMutationResult> => { calls.push(args); throw new Error("workspace mutation must not run") },
      mutateModuleSetting: async (section, key, expected, desired): Promise<ConfigMutationResult> => {
        calls.push([section.key, key, expected, desired])
        current = snapshot({ revision: current.revision + 1, config: current.config })
        return { ok: true, snapshot: current, subscriberOutcome: { kind: "settled" } }
      },
      mutateProfileProviderSetting: async (profileId, providerId, key, expected, desired, defaultValue): Promise<ConfigMutationResult> => {
        calls.push([profileId, providerId, key, expected, desired, defaultValue])
        if (expected !== 3_900) return { ok: false, kind: "stale", error: new ConfigWriteError("stale") }
        current = snapshot({
          revision: 5,
          config: { ...structuredClone(CONFIG_DEFAULTS), profiles: { work: { roles: {}, git_ai_attribution: false, allow_training_routes: false, providers: { github_copilot: { monthly_credit_cap: desired } } } } },
        })
        return { ok: true, snapshot: current, subscriberOutcome: { kind: "settled" } }
      },
      dispose: async () => {},
    })
    const patches: unknown[] = []
    const projection = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: (patch) => { patches.push(patch) } })
    const setting = { id: "provider", providerId: "github_copilot", key: "monthly_credit_cap" } as const
    const stale = await projection.mutate({ type: "config.mutate", target: { kind: "profile", profileId: "work" }, setting: { ...setting, expected: { kind: "value", value: 1_000 }, desired: 0 } })
    expect(stale.kind).toBe("stale")
    expect(patches).toEqual([])
    // A key no module declares, and a value outside the declared bounds, are malformed requests.
    expect((await projection.mutate({ type: "config.mutate", target: { kind: "profile", profileId: "work" }, setting: { ...setting, key: "unknown_key", expected: { kind: "absent" }, desired: 1 } })).kind).toBe("parse-or-decode-failed")
    expect((await projection.mutate({ type: "config.mutate", target: { kind: "profile", profileId: "work" }, setting: { ...setting, expected: { kind: "absent" }, desired: -1 } })).kind).toBe("parse-or-decode-failed")
    const committed = await projection.mutate({ type: "config.mutate", target: { kind: "profile", profileId: "work" }, setting: { ...setting, expected: { kind: "absent" }, desired: 0 } })
    expect(committed).toEqual({ kind: "committed", revision: 5 })
    expect(calls).toEqual([["work", "github_copilot", "monthly_credit_cap", 1_000, 0, 3_900], ["work", "github_copilot", "monthly_credit_cap", 3_900, 0, 3_900]])
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ payload: { config: { values: { profiles: { work: { providers: { github_copilot: { monthly_credit_cap: 0 } } } } } } } })
  })

  test("routes registered profile booleans through the typed profile mutation", async () => {
    let current = snapshot()
    const calls: unknown[] = []
    const owner = completeOwner({
      snapshot: () => current,
      refresh: async () => current,
      subscribe: () => async () => {},
      subscribeAll: () => async () => {},
      mutate: async () => { throw new Error("workspace mutation must not run") },
      mutateProfileBoolean: async (...args): Promise<ConfigMutationResult> => {
        calls.push(args)
        current = snapshot({ revision: 5 })
        return { ok: true, snapshot: current, subscriberOutcome: { kind: "settled" } }
      },
      dispose: async () => {},
    })
    const projection = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: () => {} })
    const result = await projection.mutate({ type: "config.mutate", target: { kind: "profile", profileId: "work" }, setting: { id: "allowTrainingRoutes", expected: { kind: "absent" }, desired: true } })
    expect(result).toEqual({ kind: "committed", revision: 5 })
    expect(calls).toEqual([["allowTrainingRoutes", "work", false, true]])
  })

  test("resolves Show build for the attached project only and mutates only that project", async () => {
    const other = { show_build: true }
    let current = snapshot({ config: { ...structuredClone(CONFIG_DEFAULTS), projects: { "/scratch/other": other } } })
    const calls: unknown[] = []
    const owner = completeOwner({
      snapshot: () => current,
      refresh: async () => current,
      subscribe: () => async () => {},
      subscribeAll: () => async () => {},
      mutate: async () => { throw new Error("workspace mutation must not run") },
      mutateProjectShowBuild: async (...args): Promise<ConfigMutationResult> => {
        calls.push(args)
        current = snapshot({ revision: 5, config: { ...current.config, projects: { ...current.config.projects, [args[0]]: { show_build: args[2] } } } })
        return { ok: true, snapshot: current, subscriberOutcome: { kind: "settled" } }
      },
      dispose: async () => {},
    })
    const patches: unknown[] = []
    const projection = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: (patch) => { patches.push(patch) } })
    expect(projection.view().values.showBuild).toBe(false)
    const result = await projection.mutate({ type: "config.mutate", target: { kind: "project" }, setting: { id: "showBuild", expected: { kind: "absent" }, desired: true } })
    expect(result).toEqual({ kind: "committed", revision: 5 })
    expect(calls).toEqual([[PROJECT, false, true]])
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({ payload: { kind: "config.changed", config: { revision: 5, values: { showBuild: true } } } })
    expect(JSON.stringify(patches[0])).not.toContain("/scratch/other")
  })

  test("config.reset persists common defaults in one publication and preserves unrelated settings", async () => {
    const configPath = join(temporaryDirectory("config-reset-"), "flywheel.toml")
    writeFileSync(configPath, `# retained
theme = "aura"
show_thinking = true
write_syntax_theme = "vesper"
diff_colors = "standard"
compatible_rendering = "on"
proactive_compaction_threshold = 500000
disabled_modules = ["remote"]
allow_persistent_processes = true
require_workflow_confirmation = false
[updates]
auto_install = false
[notifications]
desktop = false
[web_search]
provider = "exa"
[remote]
keep_awake = false
[subscription_usage]
alert_thresholds = [80, 95]
[profiles.other.roles.chat]
model = "test-model"
[auth.project_profiles]
"/scratch/project" = "work"
[profiles.work]
git_ai_attribution = true
allow_training_routes = true
[profiles.work.roles.chat]
model = "profile-model"
[profiles.work.providers.github_copilot]
monthly_credit_cap = 100
[profiles.personal.providers.github_copilot]
monthly_credit_cap = 200
`)
    const owner = await createRuntimeConfigOwner({ configPath, watch: false, env: {} })
    const patches: unknown[] = []
    const projection = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: (patch) => { patches.push(patch) } })
    const attached = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: () => {} })
    const before = owner.snapshot()
    try {
      const result = await projection.mutate({ type: "config.reset", profileId: "work" })
      expect(result).toEqual({ kind: "committed", revision: before.revision + 1 })
      expect(patches).toHaveLength(1)
      expect(attached.view().values).toEqual(projection.view().values)
      const text = readFileSync(configPath, "utf8")
      expect(text).toContain("# retained")
      expect(Bun.TOML.parse(text)).toMatchObject({
        theme: "flywheel", show_thinking: false, write_syntax_theme: "nord", diff_colors: "theme",
        compatible_rendering: "auto", proactive_compaction_threshold: 270_000,
        notifications: { desktop: true }, web_search: { provider: "chatgpt" },
        subscription_usage: { alert_thresholds: [70, 90, 100] },
        disabled_modules: ["remote"], remote: { keep_awake: false },
        allow_persistent_processes: true, require_workflow_confirmation: false, updates: { auto_install: false },
        auth: { project_profiles: { [PROJECT]: "work" } },
        profiles: {
          other: { roles: { chat: { model: "test-model" } } },
          work: { git_ai_attribution: true, allow_training_routes: true, roles: { chat: { model: "profile-model" } }, providers: { github_copilot: { monthly_credit_cap: 3_900 } } },
          personal: { providers: { github_copilot: { monthly_credit_cap: 200 } } },
        },
      })
      const fresh = await createRuntimeConfigOwner({ configPath, watch: false, env: {} })
      try {
        expect(projectRuntimeConfig(fresh.snapshot()).values).toEqual(projection.view().values)
        expect(fresh.snapshot().config.theme).toBe("flywheel")
        expect(fresh.snapshot().config.notifications.desktop).toBe(true)
      } finally { await fresh.dispose() }
    } finally {
      await attached.dispose()
      await projection.dispose()
      await owner.dispose()
    }
  })

  test("failed mutations expose only closed public messages", async () => {
    const failureKinds = ["stale", "disposed", "lock-failed", "parse-or-decode-failed", "write-not-applied", "write-outcome-unknown"] as const
    let currentFailure: (typeof failureKinds)[number] = failureKinds[0]
    const sentinel = "/private/path secret-token raw = \"toml\""
    const owner = completeOwner({
      snapshot: () => snapshot(),
      refresh: async () => snapshot(),
      subscribe: () => async () => {},
      subscribeAll: () => async () => {},
      mutate: async (): Promise<ConfigMutationResult> => ({ ok: false, kind: currentFailure, error: new ConfigWriteError(sentinel) }),
      dispose: async () => {},
    })
    const projection = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: () => {} })
    for (const kind of failureKinds) {
      currentFailure = kind
      const serialized = JSON.stringify(await projection.mutate({ type: "config.mutate", setting: { id: "showThinking", expected: { kind: "value", value: false }, desired: true } }))
      expect(JSON.parse(serialized).kind).toBe(kind)
      expect(serialized).not.toContain(sentinel)
      expect(serialized).not.toContain("secret-token")
      expect(serialized).not.toContain("/private/path")
    }
  })

  test("config.reset waits for live application and reports a committed subscriber failure", async () => {
    const configPath = join(temporaryDirectory("config-reset-settlement-"), "flywheel.toml")
    writeFileSync(configPath, 'theme = "aura"\n[notifications]\ndesktop = false\n')
    const owner = await createRuntimeConfigOwner({ configPath, watch: false, env: {} })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    owner.subscribe("notificationsDesktop", async () => {
      entered.resolve()
      await release.promise
      throw new Error("private application failure")
    })
    const projection = createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: () => {} })
    let acknowledged = false
    const pending = projection.mutate({ type: "config.reset", profileId: "work" }).then((result) => { acknowledged = true; return result })
    try {
      await entered.promise
      expect(acknowledged).toBe(false)
      expect(Bun.TOML.parse(readFileSync(configPath, "utf8"))).toMatchObject({ theme: "flywheel", notifications: { desktop: true } })
      release.resolve()
      expect(await pending).toEqual({
        kind: "committed-with-degraded-application",
        revision: 1,
        errors: ["A runtime component could not apply the configuration change."],
      })
    } finally {
      release.resolve()
      await pending
      await projection.dispose()
      await owner.dispose()
    }
  })

  test("owner-wide publication sends malformed and recovery revisions", async () => {
    let current = snapshot()
    let subscriber: ((next: RuntimeConfigSnapshot) => void | Promise<void>) | undefined
    const owner = completeOwner({
      snapshot: () => current,
      refresh: async () => current,
      subscribe: () => async () => {},
      subscribeAll: (nextSubscriber) => { subscriber = nextSubscriber; return async () => {} },
      mutate: async (): Promise<ConfigMutationResult> => { throw new Error("unused") },
      dispose: async () => {},
    })
    const patches: unknown[] = []
    createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: (patch) => { patches.push(patch) } })
    current = snapshot({ revision: 5, status: { kind: "malformed", fallback: "last-valid", message: "raw TOML sentinel" } })
    await subscriber?.(current)
    current = snapshot({ revision: 6, status: { kind: "valid" } })
    await subscriber?.(current)
    expect(patches).toHaveLength(2)
    expect(JSON.stringify(patches)).not.toContain("raw TOML sentinel")
  })

  test("publishes notifications only for represented setting diagnostics", async () => {
    let current = snapshot()
    let subscriber: ((next: RuntimeConfigSnapshot) => void | Promise<void>) | undefined
    const owner = completeOwner({
      snapshot: () => current,
      refresh: async () => current,
      subscribe: () => async () => {},
      subscribeAll: (nextSubscriber) => { subscriber = nextSubscriber; return async () => {} },
      mutate: async (): Promise<ConfigMutationResult> => { throw new Error("unused") },
      dispose: async () => {},
    })
    const notifications: unknown[] = []
    createRuntimeConfigProjection({ owner, projectRoot: PROJECT, publish: () => {}, notify: (operation) => { notifications.push(operation) } })

    current = snapshot({ revision: 5, warnings: ["raw config warning"], diagnostics: [{ kind: "document", reason: "unmapped-setting" }], status: { kind: "malformed", fallback: "last-valid", message: "raw config error" } })
    await subscriber?.(current)
    current = snapshot({ revision: 6, diagnostics: [{ kind: "setting", settingId: "moduleSelection", path: ["disabled_modules"], reason: "normalized-value" }] })
    await subscriber?.(current)
    expect(notifications).toEqual([])

    current = snapshot({ revision: 7, diagnostics: [{ kind: "setting", settingId: "showThinking", path: ["show_thinking"], reason: "invalid-value" }] })
    await subscriber?.(current)
    current = snapshot({ revision: 8, diagnostics: [{ kind: "document", reason: "unmapped-setting" }] })
    await subscriber?.(current)
    current = snapshot({ revision: 9, diagnostics: [{ kind: "setting", settingId: "moduleSelection", path: ["disabled_modules"], reason: "normalized-value" }] })
    await subscriber?.(current)
    // A rejected file drops its valid edits too, so the notice says so.
    current = snapshot({ revision: 10, diagnostics: [{ kind: "setting", settingId: "diffColors", path: ["diff_colors"], reason: "invalid-value" }], status: { kind: "malformed", fallback: "last-valid", message: "raw config error" } })
    await subscriber?.(current)

    expect(notifications).toEqual([
      { type: "raise", occurrence: { sourceId: "runtime:config-warning", title: "Configuration needs attention", message: "Open Settings to review highlighted configuration values.", severity: "warning", action: { kind: "open-settings" } } },
      { type: "resolve", sourceId: "runtime:config-warning" },
      { type: "raise", occurrence: { sourceId: "runtime:config-warning", title: "Configuration needs attention", message: "The configuration is malformed. The last valid values remain active. Open Settings to review highlighted configuration values.", severity: "warning", action: { kind: "open-settings" } } },
    ])
    expect(JSON.stringify(notifications)).not.toContain("raw config")
  })
})
