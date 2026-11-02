import { expect, test } from "bun:test"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import { createModuleProjection } from "../../../../src/orchestration/app-service/module-projection.js"
import { startModulePolicy, type ModulePolicy } from "../../../../src/orchestration/config/module-policy.js"
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { decodeModuleState, type ModuleState } from "../../../../src/orchestration/config/module-descriptor.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const invalidState = decodeModuleState('modules = ["unknown-module"]')
const validState = decodeModuleState("")
const temporaryDirectory = temporaryDirectories()

test("disposal waits for an active config refresh before releasing the projection", async () => {
  const configPath = join(temporaryDirectory("fw-module-dispose-"), "flywheel.toml")
  writeFileSync(configPath, "")
  const runtimeConfig = await createRuntimeConfigOwner({ configPath, watch: false })
  const started = await startModulePolicy({ configPath }, runtimeConfig)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const projection = await createModuleProjection({
    location: { configPath },
    capabilities: { ...started.policy, refresh: async () => { entered.resolve(); await release.promise; await started.policy.refresh() } },
    runtimeConfig,
    persistentProcesses: { persisted: false, forcedByCli: false, effective: false },
    publish: () => {},
    settlePublication: async () => {},
  })
  try {
    writeFileSync(configPath, "show_thinking = true\n")
    await runtimeConfig.refresh()
    await entered.promise
    let disposed = false
    const disposal = projection.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    await disposal
    expect(disposed).toBe(true)
  } finally {
    release.resolve()
    await projection.dispose()
    await started.dispose()
    await runtimeConfig.dispose()
  }
})

test("a config publication clears a repaired selection error even when the effective module IDs are unchanged", async () => {
  const configPath = join(temporaryDirectory("fw-module-repair-"), "flywheel.toml")
  writeFileSync(configPath, '[self_improvement]\nenabled = "invalid"\n')
  const runtimeConfig = await createRuntimeConfigOwner({ configPath, watch: false })
  const started = await startModulePolicy({ configPath }, runtimeConfig)
  const settled = Promise.withResolvers<void>()
  const projection = await createModuleProjection({
    location: { configPath },
    capabilities: started.policy,
    runtimeConfig,
    persistentProcesses: { persisted: false, forcedByCli: false, effective: false },
    publish: () => {},
    settlePublication: async () => { settled.resolve() },
  })
  try {
    const modules = projection.view().moduleIds
    expect(projection.view().error).toContain("self_improvement.enabled")
    writeFileSync(configPath, "")
    await runtimeConfig.refresh()
    await settled.promise
    expect(projection.view().moduleIds).toEqual(modules)
    expect(projection.view().error).toBeUndefined()
  } finally {
    await projection.dispose()
    await started.dispose()
    await runtimeConfig.dispose()
  }
})

async function handEditFixture(prefix: string, source: string) {
  const configPath = join(temporaryDirectory(prefix), "flywheel.toml")
  writeFileSync(configPath, source)
  const runtimeConfig = await createRuntimeConfigOwner({ configPath, watch: false })
  const started = await startModulePolicy({ configPath }, runtimeConfig)
  const projection = await createModuleProjection({
    location: { configPath },
    capabilities: started.policy,
    runtimeConfig,
    persistentProcesses: { persisted: false, forcedByCli: false, effective: false },
    publish: () => {},
    settlePublication: async () => {},
  })
  return {
    configPath,
    runtimeConfig,
    projection,
    dispose: async () => { await projection.dispose(); await started.dispose(); await runtimeConfig.dispose() },
  }
}

test("a refused stale capability change republishes the hand-edited file so the next change succeeds", async () => {
  const fixture = await handEditFixture("fw-module-stale-", "require_workflow_confirmation = false\n")
  try {
    expect(fixture.projection.view().workflowsMode).toBe("on")
    // The hand edit lands before any watcher publishes it.
    writeFileSync(fixture.configPath, "require_workflow_confirmation = true\n")
    const refused = await fixture.projection.setWorkflowMode("on", "off")
    expect(refused.ok).toBe(false)
    expect(fixture.projection.view().workflowsMode).toBe("ask")
    expect(await fixture.projection.setWorkflowMode(fixture.projection.view().workflowsMode, "off")).toEqual({ ok: true })
    expect(fixture.projection.view().workflowsMode).toBe("off")
  } finally {
    await fixture.dispose()
  }
})

test("publishes one curated notification condition for module warnings", async () => {
  let state: ModuleState = invalidState
  let listener: ((state: ModuleState) => void) | undefined
  const capabilities = {
    state: () => state,
    enabled: (capability) => state.moduleIds.includes(capability),
    admit: async () => { throw new Error("unused") },
    select: async () => { throw new Error("unused") },
    refresh: async () => {},
    onChange: (next) => { listener = next; return () => {} },
  } satisfies ModulePolicy
  const notifications: unknown[] = []
  const publicationOrder: string[] = []
  const projection = await createModuleProjection({
    location: { configPath: join(temporaryDirectory("fw-module-notification-"), "flywheel.toml") },
    capabilities,
    persistentProcesses: { persisted: false, forcedByCli: false, effective: false },
    preparePublication: () => { publicationOrder.push("prepare") },
    publish: () => { publicationOrder.push("publish") },
    settlePublication: async () => {},
    notify: (operation) => { notifications.push(operation) },
  })

  state = validState
  listener?.(state)

  expect(publicationOrder).toEqual(["prepare", "publish"])
  expect(notifications).toEqual([
    { type: "raise", occurrence: { sourceId: "runtime:module-warning", title: "Module configuration needs attention", message: "Some modules could not be configured. Open Settings for details.", severity: "warning", action: { kind: "open-settings" } } },
    { type: "resolve", sourceId: "runtime:module-warning" },
  ])
  expect(JSON.stringify(notifications)).not.toContain("unknown-module")
  await projection.dispose()
})
