import { describe, expect, test } from "bun:test"
import type { FirstPartyModuleComposition, ModuleId } from "../../../../../../src/orchestration/module-contract/module-catalog.js"
import { composeRealmModuleSnapshot } from "../../../../../../src/orchestration/module-contract/module-composition.js"
import { createCommandCatalogProjection } from "../../../../../../src/orchestration/app-service/definitions/commands/command-catalog-projection.js"
import { composeModules } from "../../../../../../src/infra/module-descriptor.js"
import { fixedDefinitions, repoModules } from "../../../../../helpers/project-definitions.js"
import { availabilityOwner } from "../../model-assignment-service-fixtures.js"

/** The built-in commands the catalog publishes while `modules` are enabled. */
async function publishedBuiltIns(modules: FirstPartyModuleComposition) {
  const catalog = createCommandCatalogProjection({
    definitions: fixedDefinitions(),
    availability: await availabilityOwner([]),
    moduleSelection: () => modules,
    publish: () => {},
    watch: { bind: () => {} },
  })
  const { builtInCommands } = catalog.snapshot()
  await catalog.dispose()
  return builtInCommands
}

describe("built-in command availability", () => {
  test("publishes exactly one always-available fork command independent of optional modules", async () => {
    for (const moduleIds of [[], ["skills", "learning"]] satisfies readonly ModuleId[][]) {
      const forks = (await publishedBuiltIns(composeRealmModuleSnapshot({ moduleIds }))).filter((command) => command.id === "fork")
      expect(forks).toEqual([{
        id: "fork",
        title: "Fork conversation",
        description: "Fork the active conversation into a new chat",
        aliases: [],
      }])
    }
  })

  const backgroundManagement = async (capabilities: readonly ModuleId[]) =>
    (await publishedBuiltIns(composeRealmModuleSnapshot({ moduleIds: capabilities }))).some((command) => command.id === "bg")

  test("background management survives while any producer of background work is enabled", async () => {
    expect(await backgroundManagement(["workflows", "skills"])).toBe(true)
    expect(await backgroundManagement(["subagents"])).toBe(true)
    expect(await backgroundManagement(["background-commands"])).toBe(true)
  })

  test("the experiment command is published only while the experiments module is enabled", async () => {
    const experiment = async (moduleIds: readonly ModuleId[]) =>
      (await publishedBuiltIns(composeRealmModuleSnapshot({ moduleIds }))).find((command) => command.id === "experiment")

    expect(await experiment(["experiments"])).toEqual({
      id: "experiment",
      title: "Experiment",
      description: "Run an experiment loop: design <goal>, start, off, clear, finalize, or dashboard",
      aliases: [],
    })
    expect(await experiment(["skills", "learning"])).toBeUndefined()
    expect(await experiment([])).toBeUndefined()
  })

  test("a source run publishes /bug-report-triage as the development module's built-in", async () => {
    const builtIns = await publishedBuiltIns(composeModules(repoModules, { disabledModuleIds: [] }))
    expect(builtIns.map((command) => command.id)).toContain("bug-report-triage")
  })

  test("background management is unavailable when no producer is enabled", async () => {
    expect(await backgroundManagement(["skills", "learning"])).toBe(false)
    expect(await backgroundManagement([])).toBe(false)
  })
})
