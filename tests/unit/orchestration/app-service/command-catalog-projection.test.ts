import { describe, expect, test } from "bun:test"
import type { ModuleId } from "../../../../src/orchestration/modules.js"
import { composeRealmModuleSnapshot } from "../../../../src/orchestration/modules.js"
import { getBuiltInCommands } from "../../../../src/orchestration/app-service/command-catalog-projection.js"
import { composeModules } from "../../../../src/infra/module-descriptor.js"
import { repoModules } from "../../../helpers/project-definitions.js"

describe("built-in command availability", () => {
  test("publishes exactly one always-available fork command independent of optional modules", () => {
    for (const moduleIds of [[], ["skills", "learning"]] satisfies readonly ModuleId[][]) {
      const forks = getBuiltInCommands(composeRealmModuleSnapshot({ moduleIds })).filter((command) => command.id === "fork")
      expect(forks).toEqual([{
        id: "fork",
        title: "Fork conversation",
        description: "Fork the active conversation into a new chat",
        aliases: [],
      }])
    }
  })

  const backgroundManagement = async (capabilities: readonly ModuleId[]) =>
    getBuiltInCommands(composeRealmModuleSnapshot({ moduleIds: capabilities })).some((command) => command.id === "bg")

  test("background management survives while any producer of background work is enabled", async () => {
    expect(await backgroundManagement(["workflows", "skills"])).toBe(true)
    expect(await backgroundManagement(["subagents"])).toBe(true)
    expect(await backgroundManagement(["background-commands"])).toBe(true)
  })

  test("the experiment command is published only while the experiments module is enabled", () => {
    const experiment = (moduleIds: readonly ModuleId[]) =>
      getBuiltInCommands(composeRealmModuleSnapshot({ moduleIds })).find((command) => command.id === "experiment")

    expect(experiment(["experiments"])).toEqual({
      id: "experiment",
      title: "Experiment",
      description: "Run an experiment loop: design <goal>, start, off, clear, finalize, or dashboard",
      aliases: [],
    })
    expect(experiment(["skills", "learning"])).toBeUndefined()
    expect(experiment([])).toBeUndefined()
  })

  test("a source run publishes /bug-report-triage as the development module's built-in", () => {
    const builtIns = getBuiltInCommands(composeModules(repoModules, { disabledModuleIds: [] }))
    expect(builtIns.map((command) => command.id)).toContain("bug-report-triage")
  })

  test("background management is unavailable when no producer is enabled", async () => {
    expect(await backgroundManagement(["skills", "learning"])).toBe(false)
    expect(await backgroundManagement([])).toBe(false)
  })
})
