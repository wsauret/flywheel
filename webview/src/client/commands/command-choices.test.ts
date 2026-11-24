import { describe, expect, test } from "bun:test"

import { catalogSummary, createCommandRoster } from "./command-choices.js"

describe("catalogSummary", () => {
  test("names the count of commands with its plural, and nothing for an empty list", () => {
    const papercuts = { id: "papercuts", title: "Papercuts", description: "Log a papercut", aliases: ["record", "paper"] }
    expect(catalogSummary([papercuts])).toBe("Type to search 1 command")
    expect(catalogSummary([papercuts, { ...papercuts, id: "fork", aliases: [] }])).toBe("Type to search 2 commands")
    expect(catalogSummary([])).toBeUndefined()
  })
})

test("resolves a built-in by id or alias at the published revision, and no command of a turned-off module", () => {
  const roster = createCommandRoster()
  roster.accept({
    revision: 4,
    builtInCommands: [{ id: "review", title: "Review", description: "Probe a change", aliases: ["probe"] }],
    offCommands: [{ id: "update", aliases: ["upgrade"], modules: ["Updates"] }],
  })

  expect(roster.builtIn("review")).toEqual({ id: "review", revision: 4 })
  expect(roster.builtIn("probe")).toEqual({ id: "review", revision: 4 })
  expect(roster.builtIn("update")).toBeUndefined()
})
