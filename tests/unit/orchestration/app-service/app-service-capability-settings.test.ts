import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { createModuleProjection } from "../../../../src/orchestration/app-service/module-projection.js"
import { createModulePolicy } from "../../../../src/orchestration/config/module-policy.js"
import type { RuntimeModulesView } from "../../../../src/protocol/module-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

describe("FlywheelAppService capability settings", () => {
  const temporaryDirectory = temporaryDirectories()

  async function capabilityHarness(source: string) {
    const configPath = join(temporaryDirectory("flywheel-app-service-capabilities-"), "flywheel.toml")
    writeFileSync(configPath, source)
    const store = fakeSessionStore(new Map())
    const manager = fakeManager()
    const published: RuntimeModulesView[] = []
    const capabilities = await createModuleProjection({
      location: { configPath },
      capabilities: await createModulePolicy({ configPath }),
      publish: (input: RuntimeUiPatchInput) => {
        if (input.payload.kind === "modules.changed") published.push(input.payload.capabilities)
      },
      settlePublication: async () => {},
      persistentProcesses: { persisted: false, effective: false, forcedByCli: false },
    })
    const service = createFlywheelAppService({
      projectRoot: "/workspace",
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: "/workspace" }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      capabilities,
      runtimeSupervisor: runtimeSupervisor(),
    })
    return { service, capabilities, published, configPath, text: () => readFileSync(configPath, "utf8") }
  }

  const moduleSelection = (disabled: readonly string[] = []) => disabled.length === 0 ? "" : `disabled_modules = [${MODULE_IDS.filter((id) => disabled.includes(id)).map((id) => `"${id}"`).join(", ")}]\n`
  const FULL_SELECTION = moduleSelection()

  test("settings.set_persistent_processes publishes committed policy in both directions", async () => {
    const harness = await capabilityHarness(FULL_SELECTION)

    await expect(harness.service.dispatch({ type: "settings.set_persistent_processes", expected: false, enabled: true })).resolves.toEqual({ ok: true })
    expect(harness.text()).toContain("allow_persistent_processes = true")
    expect(harness.published.at(-1)?.persistentProcesses).toEqual({ persisted: true, effective: true, forcedByCli: false })

    await expect(harness.service.dispatch({ type: "settings.set_persistent_processes", expected: true, enabled: false })).resolves.toEqual({ ok: true })
    expect(harness.text()).toContain("allow_persistent_processes = false")
    expect(harness.published.at(-1)?.persistentProcesses).toEqual({ persisted: false, effective: false, forcedByCli: false })
  })

  test("CLI authorization stays effective without changing persisted intent", async () => {
    const configPath = join(temporaryDirectory("flywheel-app-service-capabilities-"), "flywheel.toml")
    writeFileSync(configPath, FULL_SELECTION)
    const published: RuntimeModulesView[] = []
    const capabilities = await createModuleProjection({
      location: { configPath },
      capabilities: await createModulePolicy({ configPath }),
      persistentProcesses: { persisted: false, effective: true, forcedByCli: true },
      publish: (input) => { if (input.payload.kind === "modules.changed") published.push(input.payload.capabilities) },
      settlePublication: async () => {},
    })

    expect(capabilities.view().persistentProcesses).toEqual({ persisted: false, effective: true, forcedByCli: true })
    await expect(capabilities.setPersistentProcesses(false, true)).resolves.toEqual({ ok: true })
    await expect(capabilities.setPersistentProcesses(true, false)).resolves.toEqual({ ok: true })
    expect(readFileSync(configPath, "utf8")).toContain("allow_persistent_processes = false")
    expect(published.at(-1)?.persistentProcesses).toEqual({ persisted: false, effective: true, forcedByCli: true })
  })

  test("settings.set_module changes one member and publishes the committed selection", async () => {
    const harness = await capabilityHarness(`${FULL_SELECTION}require_workflow_confirmation = true\n`)

    await expect(harness.service.dispatch({ type: "settings.set_module", moduleId: "learning", expected: true, enabled: false })).resolves.toEqual({ ok: true })

    expect(harness.text()).toContain(moduleSelection(["learning"]).trim())
    // Every unrelated preference survives an atomic member change.
    expect(harness.text()).toContain("require_workflow_confirmation = true")
    expect(harness.published.at(-1)?.capabilities).toEqual(MODULE_IDS.filter((id) => id !== "learning"))
    expect(harness.published.at(-1)?.workflowsMode).toBe("ask")
  })

  test("concurrent distinct-member mutations lose no update", async () => {
    const harness = await capabilityHarness(FULL_SELECTION)

    await Promise.all([
      harness.service.dispatch({ type: "settings.set_module", moduleId: "learning", expected: true, enabled: false }),
      harness.service.dispatch({ type: "settings.set_module", moduleId: "subagents", expected: true, enabled: false }),
    ])

    expect(harness.text()).toContain(moduleSelection(["subagents", "learning"]).trim())
  })

  test("settings.set_modules replaces the whole selection with the named preset", async () => {
    const harness = await capabilityHarness(FULL_SELECTION)

    await expect(harness.service.dispatch({ type: "settings.set_modules", preset: "minimal", expected: harness.capabilities.view() })).resolves.toEqual({ ok: true })
    expect(harness.text()).toContain(moduleSelection(MODULE_IDS).trim())
    expect(harness.published.at(-1)?.moduleIds).toEqual([])

    await expect(harness.service.dispatch({ type: "settings.set_modules", preset: "full", expected: harness.capabilities.view() })).resolves.toEqual({ ok: true })
    expect(harness.published.at(-1)?.moduleIds).toEqual(MODULE_IDS)
  })

  test("invalid parseable selection permits only explicit complete replacement", async () => {
    const invalid = 'disabled_modules = ["unknown-uat"]\n'
    const memberHarness = await capabilityHarness(invalid)
    const member = await memberHarness.service.dispatch({ type: "settings.set_module", moduleId: "skills", expected: true, enabled: true })
    expect(member.ok).toBe(false)
    expect(memberHarness.text()).toBe(invalid)
    expect(memberHarness.published).toEqual([])

    const minimalHarness = await capabilityHarness(invalid)
    await expect(minimalHarness.service.dispatch({ type: "settings.set_modules", preset: "minimal", expected: minimalHarness.capabilities.view() })).resolves.toEqual({ ok: true })
    expect(minimalHarness.text()).toContain(moduleSelection(MODULE_IDS).trim())

    const fullHarness = await capabilityHarness(invalid)
    await expect(fullHarness.service.dispatch({ type: "settings.set_modules", preset: "full", expected: fullHarness.capabilities.view() })).resolves.toEqual({ ok: true })
    expect(fullHarness.published.at(-1)?.moduleIds).toEqual(MODULE_IDS)
  })

  test("mixed capability authorities refuse presets without publication", async () => {
    const mixed = 'modules = []\nfeatures = []\n'
    for (const preset of ["minimal", "full"] as const) {
      const harness = await capabilityHarness(mixed)
      const result = await harness.service.dispatch({ type: "settings.set_modules", preset, expected: harness.capabilities.view() })
      expect(result.ok).toBe(false)
      expect(harness.text()).toBe(mixed)
      expect(harness.published).toEqual([])
    }
  })

  test("settings.set_workflow_mode writes the capability and its confirmation preference in one commit", async () => {
    const harness = await capabilityHarness(`${moduleSelection(MODULE_IDS.filter((id) => id !== "skills"))}require_workflow_confirmation = true\n`)

    await expect(harness.service.dispatch({ type: "settings.set_workflow_mode", expected: "off", mode: "on" })).resolves.toEqual({ ok: true })

    expect(harness.text()).toContain(moduleSelection(MODULE_IDS.filter((id) => id !== "skills" && id !== "workflows")).trim())
    expect(harness.text()).toContain("require_workflow_confirmation = false")
    expect(harness.published.at(-1)?.workflowsMode).toBe("on")

    await expect(harness.service.dispatch({ type: "settings.set_workflow_mode", expected: "on", mode: "off" })).resolves.toEqual({ ok: true })
    expect(harness.text()).toContain(moduleSelection(MODULE_IDS.filter((id) => id !== "skills")).trim())
    expect(harness.published.at(-1)?.workflowsMode).toBe("off")
  })

  test("ON to ASK publishes one view whose only change is the derived mode", async () => {
    // The selection does not move: only the confirmation preference does, and
    // the mode is derived from the one committed descriptor, so the change
    // publishes exactly once rather than once per source it could be read from.
    const harness = await capabilityHarness(`${FULL_SELECTION}require_workflow_confirmation = false\n`)
    const before = harness.published.length

    await expect(harness.service.dispatch({ type: "settings.set_workflow_mode", expected: "on", mode: "ask" })).resolves.toEqual({ ok: true })

    expect(harness.published.length).toBe(before + 1)
    expect(harness.published.at(-1)?.workflowsMode).toBe("ask")
    expect(harness.published.at(-1)?.capabilities).toEqual(MODULE_IDS)
    expect(harness.text()).toContain("require_workflow_confirmation = true")
  })

  test("Workflows chosen while Skills is off stays off until Skills is on", async () => {
    const harness = await capabilityHarness(moduleSelection(MODULE_IDS.filter((id) => id !== "subagents" && id !== "ask-user")))

    expect(await harness.service.dispatch({ type: "settings.set_workflow_mode", expected: "off", mode: "ask" })).toEqual({ ok: true })
    expect(harness.published.at(-1)?.moduleIds).toContain("workflows")
    expect(harness.published.at(-1)?.workflowsMode).toBe("off")

    expect(await harness.service.dispatch({ type: "settings.set_module", moduleId: "skills", expected: false, enabled: true })).toEqual({ ok: true })
    expect(harness.published.at(-1)?.workflowsMode).toBe("ask")
  })

  test("a failed write leaves the file and the published view untouched", async () => {
    // An unrelated setting the config schema refuses: the capability patch is
    // built, then the whole commit is rejected before the file is touched.
    const invalid = "proactive_compaction_threshold = 1\n"
    const harness = await capabilityHarness(invalid)

    const result = await harness.service.dispatch({ type: "settings.set_module", moduleId: "learning", expected: true, enabled: false })

    expect(result).toEqual({ ok: false, error: expect.stringContaining("proactive_compaction_threshold") })
    expect(harness.text()).toBe(invalid)
    expect(harness.published).toEqual([])
  })

  test("stale capability commands preserve the newer persisted view", async () => {
    const moduleHarness = await capabilityHarness(FULL_SELECTION)
    writeFileSync(moduleHarness.configPath, moduleSelection(["learning"]))
    await expect(moduleHarness.service.dispatch({ type: "settings.set_module", moduleId: "learning", expected: true, enabled: false }))
      .resolves.toEqual(expect.objectContaining({ ok: false, kind: "stale" }))
    expect(moduleHarness.text()).toBe(moduleSelection(["learning"]))

    const workflowHarness = await capabilityHarness(FULL_SELECTION)
    writeFileSync(workflowHarness.configPath, `${FULL_SELECTION}require_workflow_confirmation = false\n`)
    await expect(workflowHarness.service.dispatch({ type: "settings.set_workflow_mode", expected: "ask", mode: "off" }))
      .resolves.toEqual(expect.objectContaining({ ok: false, kind: "stale" }))

    const processHarness = await capabilityHarness(FULL_SELECTION)
    writeFileSync(processHarness.configPath, `${FULL_SELECTION}allow_persistent_processes = true\n`)
    await expect(processHarness.service.dispatch({ type: "settings.set_persistent_processes", expected: false, enabled: false }))
      .resolves.toEqual(expect.objectContaining({ ok: false, kind: "stale" }))
  })

  test("a stale preset cannot repair a selection changed after publication", async () => {
    const harness = await capabilityHarness(FULL_SELECTION)
    writeFileSync(harness.configPath, moduleSelection(MODULE_IDS.filter((id) => id !== "workflows")))
    await harness.capabilities.refresh()
    const published = harness.capabilities.view()
    writeFileSync(harness.configPath, moduleSelection(MODULE_IDS))

    await expect(harness.service.dispatch({
      type: "settings.set_modules",
      preset: "minimal",
      expected: published,
    })).resolves.toEqual(expect.objectContaining({ ok: false, kind: "stale" }))
    expect(harness.text()).toBe(moduleSelection(MODULE_IDS))
  })
})
