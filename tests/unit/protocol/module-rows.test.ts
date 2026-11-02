import { describe, expect, test } from "bun:test"
import { moduleDomainReader } from "../../../src/protocol/client/module-domain.js"
import { moduleRows, type ProtocolModuleDomainName, type ProtocolModuleView } from "../../../src/protocol/modules.js"
import { defineProtocolModule, protocolModuleRows, type DomainReader, type ProtocolModule } from "../../../src/protocol/protocol-module.js"

type Views = { readonly [Name in ProtocolModuleDomainName]?: ProtocolModuleView<Name> | null }

/** The reader both clients build: one lookup over what they hold per domain. */
function reader(views: Views): DomainReader {
  return moduleDomainReader((domain) => views[domain.domain])
}

const staleness = {
  overrides: [{ family: "skill" as const, id: "ship", layer: "user" as const, path: "/home/me/.flywheel/skills/ship/SKILL.md", status: "upstream-changed" as const, snapshotAvailable: true }],
  diagnostics: [{ path: "/repo/.flywheel/workflows/broken.yaml", layer: "project" as const, message: "unreadable" }],
  reviewCount: 1,
}

describe("module rows", () => {
  test("the papercuts module nudges the intro card only from the threshold and always reports on the status surface", () => {
    expect(moduleRows("intro", reader({ papercuts: { undisposedCount: 9 } }))).toEqual([])
    expect(moduleRows("intro", reader({ papercuts: { undisposedCount: 10 } }))).toEqual([
      { id: "papercuts", label: "papercuts", value: "10 logged", action: { kind: "command", id: "papercuts" } },
    ])
    expect(moduleRows("status", reader({ papercuts: { undisposedCount: 0 } }))).toEqual([{ id: "papercuts", label: "Papercuts", value: "none recorded" }])
    const waiting = moduleRows("status", reader({ papercuts: { undisposedCount: 3 } }))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ label: "Papercuts", value: "3 waiting", action: { kind: "command", id: "papercuts" } })
    expect(waiting[0]?.hint).toContain("Small annoyances")
  })

  test("the definition-overrides module reports what waits for review and spells every problem out in the status hint", () => {
    expect(moduleRows("intro", reader({ definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 0 } }))).toEqual([])
    expect(moduleRows("intro", reader({ definitionStaleness: staleness }))).toEqual([
      { id: "definition-overrides", label: "overrides", value: "1 with upstream updates", hint: "ask to review them" },
    ])
    expect(moduleRows("status", reader({ definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 0 } }))).toEqual([
      { id: "definition-overrides", label: "Definitions", value: "all current" },
    ])
    const status = moduleRows("status", reader({ definitionStaleness: staleness }))
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ label: "Definitions", value: "1 overridden, 1 to review, 1 problem", tone: "warning" })
    expect(status[0]?.hint).toBe("/repo/.flywheel/workflows/broken.yaml (project): unreadable\nskill ship overridden by the user copy at /home/me/.flywheel/skills/ship/SKILL.md")
  })

  test("a view that has not landed contributes no row, and rows follow registry order", () => {
    expect(moduleRows("status", reader({}))).toEqual([])
    const rows = moduleRows("status", reader({ papercuts: { undisposedCount: 0 }, definitionStaleness: { overrides: [], diagnostics: [], reviewCount: 0 } }))
    expect(rows.map((row) => row.id)).toEqual(["definition-overrides", "papercuts"])
  })

  test("a synthetic module contributes rows through the generic fold with no registry edit", () => {
    const synthetic = defineProtocolModule({
      id: "development",
      domains: [],
      rows: { intro: () => [{ id: "bench", label: "bench", value: "3 runs", action: { kind: "surface", id: "bench-board" } }] },
    })
    const modules: readonly ProtocolModule[] = [synthetic]
    expect(protocolModuleRows(modules, "intro", reader({}))).toEqual([{ id: "bench", label: "bench", value: "3 runs", action: { kind: "surface", id: "bench-board" } }])
    expect(protocolModuleRows(modules, "status", reader({}))).toEqual([])
    expect(protocolModuleRows(modules, "intro", reader({}), [])).toEqual([])
    expect(protocolModuleRows(modules, "intro", reader({}), ["development"])).toHaveLength(1)
  })
})
