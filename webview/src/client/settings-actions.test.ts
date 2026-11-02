import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendMutation, MutationResult } from "../../../src/protocol/app-service-types.js"
import type { RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { RuntimeConfigMutationResult } from "../../../src/protocol/runtime-config-protocol-types.js"
import type { HostCapabilities } from "../host.js"
import { createClientActions } from "./actions.js"
import { fakeConnection } from "./session-connection-fixture.js"
import { fakeRuntimeSession } from "../app/client-context-fixture.js"
import type { PanelModuleSetting, PanelSettings } from "./session-settings.js"
import { applyInlineSetting, parseProviderSetting, validCompactionThreshold } from "./settings-actions.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

/** The settings sheet edits values as text, so what the runtime receives is
 *  decided here: a typo must be refused with a reason, and an accepted draft
 *  must be exactly the value the runtime's schema admits. */


const creditCap = { providerId: "github_copilot", key: "monthly_credit_cap", label: "Monthly credit cap", description: "Monthly AI credits", min: 0, max: 1_000_000, off: 0, value: 3900 }

describe("parseProviderSetting", () => {
  test("reads a whole number inside the declared bounds, off included", () => {
    assert.deepEqual(parseProviderSetting("3,900", creditCap), { value: 3900 })
    assert.deepEqual(parseProviderSetting("0", creditCap), { value: 0 })
  })

  test("refuses out-of-bounds, fractional, and non-numeric values", () => {
    assert.ok("problem" in parseProviderSetting("-1", creditCap))
    assert.ok("problem" in parseProviderSetting("1000001", creditCap))
    assert.ok("problem" in parseProviderSetting("12.5", creditCap))
    assert.ok("problem" in parseProviderSetting("lots", creditCap))
  })
})

describe("validCompactionThreshold", () => {
  test("accepts off and windows worth summarising, refuses the rest", () => {
    assert.equal(validCompactionThreshold(0), true)
    assert.equal(validCompactionThreshold(50_000), true)
    assert.equal(validCompactionThreshold(49_999), false)
    assert.equal(validCompactionThreshold(50_000.5), false)
  })
})

const nordSettings: PanelSettings = {
  capabilities: {
    capabilities: ["web"], moduleIds: ["web"], descriptorIdentity: "one", modules: [], warnings: [], requireWorkflowConfirmation: false, workflowsMode: "ask",
    persistentProcesses: { effective: false, persisted: false, forcedByCli: false },
  },
  moduleIds: [], capabilitiesOn: 0,
  capabilitiesTotal: 0,
  capabilityPreset: "minimal",
  workflowMode: "ask",
  persistentProcesses: { effective: false, persisted: false, forcedByCli: false },
  moduleSettings: [],
  compactionThreshold: 50_000,
  idleCompaction: true,
  autoDeleteSessionDays: 0,
  webSearchProvider: "chatgpt",
  showThinking: true,
  showBuild: false,
  writeSyntaxTheme: "nord",
  diffColors: "theme",
  profileId: "default",
  providerSettings: [],
  gitAiAttribution: false,
  allowTrainingRoutes: false,
  problems: [],
  profile: { displayName: "Default", count: 1 },
  configProblems: [],
  seatSlot: { kind: "role", roleId: "chat" },
  seatEfforts: [],
}

test("a refused capability write reports the runtime's reason", async () => {
  const mutations: FrontendMutation[] = []
  const refuse = async () => ({ ok: false as const, error: "Disable ChatGPT web search and Exa web search before disabling Web." })
  const dispatch = recordedDispatch((mutation) => { mutations.push(mutation) }, runtimeDispatch({ "settings.set_module": refuse, "settings.set_workflow_mode": refuse }))
  const connection: RuntimeConnection = { ...fakeConnection([]), dispatch }
  const refusal = { kind: "notice", severity: "warning", message: "Flywheel did not change that capability: Disable ChatGPT web search and Exa web search before disabling Web." }
  assert.deepEqual(await applyInlineSetting(connection, { kind: "set-module", moduleId: "web", on: false }, nordSettings, undefined), refusal)
  assert.deepEqual(await applyInlineSetting(connection, { kind: "set-workflow-mode", mode: "on" }, nordSettings, undefined), refusal)
  assert.deepEqual(await applyInlineSetting(connection, { kind: "cycle-workflow-mode", direction: 1 }, nordSettings, undefined), refusal)
  assert.deepEqual(mutations, [
    { type: "settings.set_module", moduleId: "web", expected: true, enabled: false },
    { type: "settings.set_workflow_mode", expected: "ask", mode: "on" },
    { type: "settings.set_workflow_mode", expected: "ask", mode: "off" },
  ])
})

test("an overridden runtime policy still writes its stored setting and says the change waits for the next run", async () => {
  const mutations: FrontendMutation[] = []
  const results: MutationResult[] = [{ ok: true }, { ok: true }, { ok: false, error: "The setting changed in another client." }]
  const next = async () => {
    const result = results.shift()
    if (result === undefined) throw new Error("no scripted result left")
    return result
  }
  const dispatch = recordedDispatch((mutation) => { mutations.push(mutation) }, runtimeDispatch({ "settings.set_persistent_processes": next, "settings.set_update_auto_install": next }))
  const connection: RuntimeConnection = { ...fakeConnection([]), dispatch }
  const forced = { ...nordSettings, persistentProcesses: { effective: true, persisted: true, forcedByCli: true } }
  assert.deepEqual(await applyInlineSetting(connection, { kind: "toggle-persistent-processes" }, forced, undefined),
    { kind: "notice", severity: "info", message: "Persistent processes disabled for future runs; still on for this run by the command line" })
  assert.deepEqual(await applyInlineSetting(connection, { kind: "toggle-auto-install" }, nordSettings, { persisted: true, forcedOff: true, effective: false }),
    { kind: "notice", severity: "info", message: "Automatic updates disabled" })
  assert.deepEqual(await applyInlineSetting(connection, { kind: "toggle-auto-install" }, nordSettings, { persisted: false, forcedOff: false, effective: false }),
    { kind: "notice", severity: "warning", message: "Flywheel did not change that setting: The setting changed in another client." })
  assert.deepEqual(mutations, [
    { type: "settings.set_persistent_processes", expected: true, enabled: false },
    { type: "settings.set_update_auto_install", expected: true, value: false },
    { type: "settings.set_update_auto_install", expected: false, value: true },
  ])
})

test("profile cycling reports fulfilled refusals and masked-default warnings", async () => {
  const mutations: FrontendMutation[] = []
  const snapshot: RuntimeAuthStatusSnapshotResult = {
    snapshotPosition: 0,
    auth: {
      providers: [],
      warnings: [],
      profile: {
        id: "personal", displayName: "Personal", source: "default",
        availableProfiles: [{ id: "personal", displayName: "Personal" }, { id: "work", displayName: "Work" }],
      },
      subscriptionSpendConsent: { kind: "unavailable", profileId: "personal", message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." },
    },
  }
  await Promise.all(([
    { ok: false, error: "cannot switch the environment-selected auth profile" },
    { id: "work", warning: "This project still uses Personal." },
  ] as const).map(async (result) => {
    const query = runtimeQuery({ authStatusSnapshot: async () => snapshot })
    const dispatch = runtimeDispatch({ "auth.profile.select": async (mutation) => { mutations.push(mutation); return result } })
    const connection: RuntimeConnection = { ...fakeConnection([]), query, dispatch }
    assert.deepEqual(await applyInlineSetting(connection, { kind: "cycle-profile", direction: 1 }, nordSettings, undefined), {
      kind: "notice", severity: "warning", message: "error" in result ? result.error : result.warning,
    })
  }))
  assert.deepEqual(mutations, Array.from({ length: 2 }, () => ({ type: "auth.profile.select", scope: { kind: "defaults" }, id: "work" })))
})

function settingsActionsFixture(
  result: RuntimeConfigMutationResult,
  refreshed: PanelSettings = nordSettings,
  initial: PanelSettings = nordSettings,
) {
  const mutations: FrontendMutation[] = []
  const reports: { severity: "info" | "warning"; message: string }[] = []
  let settings = initial
  let refreshes = 0
  const answer = async () => result
  const dispatch = recordedDispatch((mutation) => { mutations.push(mutation) }, runtimeDispatch({ "config.mutate": answer, "config.reset": answer }))
  const connection: RuntimeConnection = { ...fakeConnection([]), dispatch }
  const session = fakeRuntimeSession({
    get settings() {
      return settings
    },
    async refreshSettings() {
      refreshes += 1
      settings = refreshed
    },
  })
  const actions = createClientActions({
    connection,
    session,
    capabilities: {} satisfies HostCapabilities,
    report: (severity, message) => reports.push({ severity, message }),
    captureSurfaceOpener: () => () => {},
  })
  return { actions, mutations, reports, settings: () => settings, refreshes: () => refreshes }
}

test("automatic deletion writes whole days with the published value as its expectation", async () => {
  const fixture = settingsActionsFixture({ kind: "committed", revision: 2 }, { ...nordSettings, autoDeleteSessionDays: 14 })
  assert.deepEqual(await fixture.actions.applySetting({ kind: "set-auto-delete-session-days", days: 14 }), { kind: "applied" })
  assert.deepEqual(fixture.mutations, [{ type: "config.mutate", setting: { id: "autoDeleteSessionDays", expected: { kind: "value", value: 0 }, desired: 14 } }])
  assert.equal(fixture.settings().autoDeleteSessionDays, 14)
  assert.deepEqual(await fixture.actions.applySetting({ kind: "set-auto-delete-session-days", days: 14 }), { kind: "applied" })
  assert.equal(fixture.mutations.length, 1)
})

describe("Idle compaction settings action", () => {
  test("writes the workspace opt-out and refreshes the projection", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 }, { ...nordSettings, idleCompaction: false })

    assert.deepEqual(await fixture.actions.applySetting({ kind: "set-idle-compaction", on: false }), { kind: "applied" })
    assert.deepEqual(fixture.mutations, [{
      type: "config.mutate",
      setting: { id: "idleCompaction", expected: { kind: "value", value: true }, desired: false },
    }])
    assert.equal(fixture.settings().idleCompaction, false)
    assert.equal(fixture.refreshes(), 1)
  })

  test("does not dispatch when the selected value is unchanged", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 })

    assert.deepEqual(await fixture.actions.applySetting({ kind: "set-idle-compaction", on: true }), { kind: "applied" })
    assert.deepEqual(fixture.mutations, [])
  })

  test("can re-enable idle compaction from the current opt-out", async () => {
    const fixture = settingsActionsFixture(
      { kind: "committed", revision: 2 },
      nordSettings,
      { ...nordSettings, idleCompaction: false },
    )

    await fixture.actions.applySetting({ kind: "set-idle-compaction", on: true })
    assert.deepEqual(fixture.mutations, [{
      type: "config.mutate",
      setting: { id: "idleCompaction", expected: { kind: "value", value: false }, desired: true },
    }])
    assert.equal(fixture.settings().idleCompaction, true)
  })
})

describe("Show build settings action", () => {
  test("writes to the connected project scope and refreshes the projection", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 }, { ...nordSettings, showBuild: true })

    const outcome = await fixture.actions.applySetting({ kind: "set-show-build", on: true })

    assert.deepEqual(outcome, { kind: "applied" })
    assert.deepEqual(fixture.mutations, [{
      type: "config.mutate",
      target: { kind: "project" },
      setting: { id: "showBuild", expected: { kind: "value", value: false }, desired: true },
    }])
    assert.equal(fixture.settings().showBuild, true)
  })
})

describe("Write syntax settings actions", () => {
  test("writes Vesper with the canonical Nord expectation and refreshes the projection", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 }, { ...nordSettings, writeSyntaxTheme: "vesper" })

    const outcome = await fixture.actions.applySetting({ kind: "set-write-syntax-theme", theme: "vesper" })

    assert.deepEqual(outcome, { kind: "applied" })
    assert.deepEqual(fixture.mutations, [{
      type: "config.mutate",
      setting: {
        id: "writeSyntaxTheme",
        expected: { kind: "value", value: "nord" },
        desired: "vesper",
      },
    }])
    assert.equal(fixture.settings().writeSyntaxTheme, "vesper")
    assert.equal(fixture.refreshes(), 1)
  })

  test("does not dispatch when the selected theme is unchanged", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 })

    assert.deepEqual(await fixture.actions.applySetting({ kind: "set-write-syntax-theme", theme: "nord" }), { kind: "applied" })
    assert.deepEqual(fixture.mutations, [])
    assert.equal(fixture.refreshes(), 1)
  })

  test("surfaces stale refusal and keeps the refreshed canonical theme", async () => {
    const fixture = settingsActionsFixture({ kind: "stale", message: "The configuration changed before this update. Try again." })

    const outcome = await fixture.actions.applySetting({ kind: "set-write-syntax-theme", theme: "vesper" })

    assert.deepEqual(outcome, {
      kind: "notice",
      severity: "warning",
      message: "The setting did not change. The configuration changed before this update. Try again.",
    })
    assert.deepEqual(fixture.reports, [{
      severity: "warning",
      message: "The setting did not change. The configuration changed before this update. Try again.",
    }])
    assert.equal(fixture.settings().writeSyntaxTheme, "nord")
  })

  test("reports an unknown save without claiming that the setting did not change", async () => {
    const message = "Saving the configuration could not be verified. Refresh before trying again."
    const fixture = settingsActionsFixture(
      { kind: "write-outcome-unknown", message },
      { ...nordSettings, writeSyntaxTheme: "vesper" },
    )

    assert.deepEqual(await fixture.actions.applySetting({ kind: "set-write-syntax-theme", theme: "vesper" }), {
      kind: "notice",
      severity: "warning",
      message,
    })
    assert.deepEqual(fixture.reports, [{ severity: "warning", message }])
    assert.equal(fixture.settings().writeSyntaxTheme, "vesper")
    assert.equal(fixture.refreshes(), 1)
  })

  test("reports degraded application with any publication verification or durability warning", async () => {
    for (const durabilityWarning of [undefined, "The configuration was saved, but publication verification or durability could not be confirmed."] as const) {
      const fixture = settingsActionsFixture({
        kind: "committed-with-degraded-application",
        revision: 2,
        errors: ["A runtime component could not apply the configuration change."],
        ...(durabilityWarning === undefined ? {} : { durabilityWarning }),
      }, { ...nordSettings, writeSyntaxTheme: "vesper" })
      const message = `Saved, but not fully in effect: A runtime component could not apply the configuration change. Restarting the runtime should apply it.${durabilityWarning === undefined ? "" : ` ${durabilityWarning}`}`

      assert.deepEqual(await fixture.actions.applySetting({ kind: "set-write-syntax-theme", theme: "vesper" }), {
        kind: "notice",
        severity: "warning",
        message,
      })
      assert.deepEqual(fixture.reports, [{ severity: "warning", message }])
      assert.equal(fixture.settings().writeSyntaxTheme, "vesper")
    }
  })

  test("reset dispatches through config reset and refreshes the projected Nord default", async () => {
    const fixture = settingsActionsFixture(
      { kind: "committed", revision: 3 },
      nordSettings,
      { ...nordSettings, writeSyntaxTheme: "vesper" },
    )

    assert.deepEqual(await fixture.actions.applySetting({ kind: "reset-defaults" }), { kind: "applied" })
    assert.deepEqual(fixture.mutations, [{ type: "config.reset", profileId: "default" }])
    assert.equal(fixture.settings().writeSyntaxTheme, "nord")
    assert.equal(fixture.refreshes(), 1)
  })
})

describe("module configuration settings", () => {
  test("writes a section boolean with the displayed expectation", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 })
    const setting = { control: "config-boolean" as const, section: "synthetic", key: "enabled", defaultValue: true, value: true, label: "Synthetic switch", description: "An independently registered setting" }
    await fixture.actions.applySetting({ kind: "set-module-setting", setting, on: false })
    assert.deepEqual(fixture.mutations, [{ type: "config.mutate", setting: { id: "module", section: "synthetic", key: "enabled", expected: { kind: "value", value: true }, desired: false } }])
  })

  test("preserves the kernel boolean row contract", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 })
    const setting = { control: "config-boolean" as const, setting: "notificationsDesktop" as const, value: true, label: "Desktop notifications", description: "Notify on this machine" }
    await fixture.actions.applySetting({ kind: "set-module-setting", setting, on: false })
    assert.deepEqual(fixture.mutations, [{ type: "config.mutate", setting: { id: "notificationsDesktop", expected: { kind: "value", value: true }, desired: false } }])
  })
})

describe("a queued write states the value in force when it runs", () => {
  // A write that waited behind another one for the same setting must state
  // what that write left, not what the row showed at the tap, or the runtime
  // refuses it as stale and the latest choice is lost.
  const numberList: Extract<PanelModuleSetting, { readonly control: "config-number-list" }> = { control: "config-number-list", section: "synthetic", key: "steps", min: 1, max: 9, defaultValue: [1], value: [1, 2], label: "Steps", description: "A list" }
  const toggle = { control: "config-boolean" as const, section: "synthetic", key: "enabled", defaultValue: true, value: true, label: "Synthetic switch", description: "A switch" }
  const inForce: PanelSettings = {
    ...nordSettings,
    providerSettings: [{ ...creditCap, value: 20 }],
    moduleSettings: [{ ...numberList, value: [3] }, { ...toggle, value: false }],
  }

  test("a provider setting", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 }, inForce, inForce)
    await fixture.actions.applySetting({ kind: "set-provider-setting", profileId: "default", setting: { ...creditCap, value: 10 }, value: 30 })
    assert.deepEqual(fixture.mutations, [{
      type: "config.mutate", target: { kind: "profile", profileId: "default" },
      setting: { id: "provider", providerId: "github_copilot", key: "monthly_credit_cap", expected: { kind: "value", value: 20 }, desired: 30 },
    }])
    const switched = settingsActionsFixture({ kind: "committed", revision: 3 }, { ...inForce, profileId: "other" }, { ...inForce, profileId: "other" })
    await switched.actions.applySetting({ kind: "set-provider-setting", profileId: "default", setting: { ...creditCap, value: 10 }, value: 30 })
    assert.deepEqual(switched.mutations, [{
      type: "config.mutate", target: { kind: "profile", profileId: "default" },
      setting: { id: "provider", providerId: "github_copilot", key: "monthly_credit_cap", expected: { kind: "value", value: 10 }, desired: 30 },
    }], "a field disposed by a profile switch still writes the profile it showed")
  })

  test("a module number list", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 }, inForce, inForce)
    await fixture.actions.applySetting({ kind: "set-module-number-list", setting: numberList, value: [4] })
    assert.deepEqual(fixture.mutations, [{ type: "config.mutate", setting: { id: "module", section: "synthetic", key: "steps", expected: { kind: "value", value: [3] }, desired: [4] } }])
  })

  test("a module switch, which writes nothing when the value in force is already the choice", async () => {
    const fixture = settingsActionsFixture({ kind: "committed", revision: 2 }, inForce, inForce)
    await fixture.actions.applySetting({ kind: "set-module-setting", setting: toggle, on: false })
    assert.deepEqual(fixture.mutations, [])
    await fixture.actions.applySetting({ kind: "set-module-setting", setting: { ...toggle, value: false }, on: true })
    assert.deepEqual(fixture.mutations, [{ type: "config.mutate", setting: { id: "module", section: "synthetic", key: "enabled", expected: { kind: "value", value: false }, desired: true } }])
  })
})
