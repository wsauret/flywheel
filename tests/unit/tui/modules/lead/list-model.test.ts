import { describe, expect, it } from "bun:test"
import { followSelection, layoutLeadRow, leadAge, leadListWindow, leadTitleColumn } from "../../../../../src/tui/modules/lead/list-model.js"
import { displayWidth } from "../../../../../src/tui/utils/text.js"

const line = (layout: ReturnType<typeof layoutLeadRow>): string => `${layout.mark}${layout.title}${layout.longTitle}${layout.status}${layout.age}`
const named = (title: string, longTitle = "") => ({ title, longTitle })

describe("the lead list model", () => {
  it("lays a row out as mark, the title padded to the title column, the status, and the age", () => {
    const layout = layoutLeadRow({ state: "question", ...named("Fix login"), status: "Which provider should I use?", age: "3m" }, { width: 80, titleColumn: leadTitleColumn([named("Fix login"), named("Docs")], 80) })
    expect(line(layout)).toBe("? Fix login  Which provider should I use?  3m")
  })

  it("names a chat by its tab title, then its longer title, and cuts the longer title first so the tab title stays", () => {
    const name = named("Name Choice", "Choose a Markdown filename")
    const at = (width: number) => layoutLeadRow({ state: "working", ...name, status: "Asked", age: "3m" }, { width, titleColumn: leadTitleColumn([name, named("Docs")], width) })
    // A wide row shows the longer title whole, so it tells the chat apart; an 80-column row cuts it.
    expect(at(100).title).toBe("Name Choice")
    expect(at(100).longTitle).toBe("  Choose a Markdown filename  ")
    expect(at(80).longTitle).toBe("  Choose a Markdown…  ")
    // Room for 4 of its characters keeps the longer title; room for fewer, and it leaves while the tab title stays whole.
    expect(at(26).longTitle).toBe("  Choo…  ")
    for (const width of [24, 22]) {
      const narrow = at(width)
      expect(narrow.title).toBe("Name Choice")
      expect(narrow.longTitle.trim()).toBe("")
      expect(displayWidth(line(narrow))).toBeLessThanOrEqual(width)
    }
  })

  it("cuts the name at 24 columns on a narrow row and at 46 on a wide one, gives the status the rest, and never exceeds the width", () => {
    const status = "The migration plan is ready and it covers every table that the billing service writes and every report"
    const title = "Billing migration for the ledger tables and the audit log"
    const at = (width: number) => layoutLeadRow({ state: "working", ...named(title), status, age: "12m" }, { width, titleColumn: leadTitleColumn([named(title)], width) })
    for (const width of [40, 80, 140]) {
      const layout = at(width)
      expect(displayWidth(line(layout))).toBeLessThanOrEqual(width)
      expect(layout.status.trimEnd()).toEndWith("…")
      expect(layout.age).toBe("12m")
    }
    expect(at(40).title).toBe("Billing migration for t…")
    expect(displayWidth(at(140).title)).toBe(46)
    expect(displayWidth(line(at(140)))).toBe(140)
  })

  it("leaves the status out of a row that has none", () => {
    const layout = layoutLeadRow({ state: "result", ...named("Docs"), status: "", age: "now" }, { width: 40, titleColumn: 4 })
    expect(line(layout)).toBe("✓ Docs  now")
  })

  it("counts the age in whole minutes, hours, and days", () => {
    const now = 10 * 24 * 3_600_000
    expect(leadAge(now - 59_000, now)).toBe("now")
    expect(leadAge(now - 61_000, now)).toBe("1m")
    expect(leadAge(now - 2 * 3_600_000, now)).toBe("2h")
    expect(leadAge(now - 3 * 24 * 3_600_000, now)).toBe("3d")
  })

  it("shows 5 of 30 rows on 24 terminal rows, counts the rows above and below them, and moves the window with the selection", () => {
    expect(leadListWindow({ total: 30, selected: 0, start: 0, terminalRows: 24 })).toEqual({ start: 0, count: 5, above: 0, below: 25 })
    expect(leadListWindow({ total: 30, selected: 4, start: 0, terminalRows: 24 })).toEqual({ start: 0, count: 5, above: 0, below: 25 })
    expect(leadListWindow({ total: 30, selected: 5, start: 0, terminalRows: 24 })).toEqual({ start: 1, count: 5, above: 1, below: 24 })
    expect(leadListWindow({ total: 30, selected: 3, start: 1, terminalRows: 24 })).toEqual({ start: 1, count: 5, above: 1, below: 24 })
    expect(leadListWindow({ total: 30, selected: 0, start: 1, terminalRows: 24 })).toEqual({ start: 0, count: 5, above: 0, below: 25 })
  })

  it("keeps every line within a third of the terminal's rows and always shows one chat row", () => {
    expect(leadListWindow({ total: 3, selected: undefined, start: 0, terminalRows: 24 })).toEqual({ start: 0, count: 3, above: 0, below: 0 })
    expect(leadListWindow({ total: 5, selected: undefined, start: 0, terminalRows: 15 })).toEqual({ start: 0, count: 2, above: 0, below: 3 })
    expect(leadListWindow({ total: 5, selected: 4, start: 0, terminalRows: 6 })).toEqual({ start: 4, count: 1, above: 4, below: 0 })
  })

  it("keeps the selection on the same chat when rows reorder and moves it to the row that takes its place when its row goes", () => {
    expect(followSelection(["a", "b", "c"], ["new", "a", "b", "c"], "b")).toBe("b")
    expect(followSelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c")
    expect(followSelection(["a", "b", "c"], ["a", "b"], "c")).toBe("b")
    expect(followSelection(["a"], [], "a")).toBeUndefined()
    expect(followSelection(["a"], ["a"], undefined)).toBeUndefined()
  })
})
