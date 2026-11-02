import { expect, test } from "bun:test"
import { installedWorkspaceMigrations } from "../../../../src/orchestration/modules.js"
import { workflowsModule } from "../../../../src/orchestration/modules/workflows.js"
import { subagentsModule } from "../../../../src/orchestration/modules/subagents.js"
import { learningModule } from "../../../../src/orchestration/modules/learning.js"

const catalog = [learningModule, subagentsModule, workflowsModule]

test("installed owner migrations retain the historical semantic order across catalog order", () => {
  expect(installedWorkspaceMigrations("stored-facts", false, catalog).map(({ order, label }) => [order, label])).toEqual([
    [10, "queue step skill ids"],
    [15, "retired self-review policy, refused rows"],
    [16, "retired child ask_user scope"],
    [17, "step row content ids"],
    [18, "loop body rows"],
    [19, "resume revert attempt ids"],
    [20, "context recipient step ids"],
    [30, "workflow definition identity"],
    [40, "handoff filenames"],
    [50, "definition skill catalog"],
    [70, "workflow graph identities"],
    [75, "retired self-review identities"],
    [76, "retired child ask_user identities"],
    [77, "retired blocked identities"],
    [78, "persona shell identities"],
    [79, "handoff revision identities"],
    [80, "remove obsolete workflow prune evidence"],
    [85, "workflow child ownership"],
    [86, "workflow agent session ownership"], [87, "workflow agent session titles"],
    [90, "subagent prompts"],
    [100, "memory facts"],
    [110, "skill reach"],
  ])
})

test("overlay migration remains a separate pre-reader phase", () => {
  expect(installedWorkspaceMigrations("definition-overlays", false, catalog).map(({ label }) => label))
    .toEqual(["legacy step catalog"])
})

test("a live peer excludes only the migration that requires exclusive ownership", () => {
  const optionalCatalog = catalog.map((module) => ({ ...module, workspaceMigrations: module.workspaceMigrations.filter((migration) => migration.order !== 85 && migration.order !== 86) }))
  const exclusive = installedWorkspaceMigrations("stored-facts", false, optionalCatalog)
  const shared = installedWorkspaceMigrations("stored-facts", true, optionalCatalog)
  expect(exclusive.filter((migration) => !shared.includes(migration)).map(({ label }) => label))
    .toEqual(["remove obsolete workflow prune evidence"])
  expect(shared.map(({ order }) => order)).toEqual([10, 15, 16, 17, 18, 19, 20, 30, 40, 50, 70, 75, 76, 77, 78, 79, 87, 90, 100, 110])
  expect(installedWorkspaceMigrations("definition-overlays", true, catalog)).toEqual(installedWorkspaceMigrations("definition-overlays", false, catalog))
})

test("required adoption refuses shared migration admission rather than silently filtering", () => {
  expect(() => installedWorkspaceMigrations("stored-facts", true, catalog)).toThrow("while another process owns")
})
