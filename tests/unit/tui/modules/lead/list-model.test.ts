import { describe, expect, it } from "bun:test"
import { followSelection, layoutLeadRow, leadAge, leadListWindow, leadTitleColumn } from "../../../../../src/tui/modules/lead/list-model.js"
import { displayWidth } from "../../../../../src/tui/utils/text.js"

const line = (layout: ReturnType<typeof layoutLeadRow>): string => `${layout.mark}${layout.title}${layout.status}${layout.age}`

describe("the lead list model", () => {
  it("lays a row out as mark, the title padded to the title column, the status, and the age", () => {
    const layout = layoutLeadRow({ state: "question", title: "Fix login", status: "Which provider should I use?", age: "3m" }, { width: 80, titleColumn: leadTitleColumn(["Fix login", "Docs"]) })
    expect(line(layout)).toBe("? Fix login  Which provider should I use?  3m")
  })

  it("cuts the title at 24 columns and the status at 48 with an ellipsis after a word, and never exceeds the width", () => {
    const status = "The migration plan is ready and it covers every table that the billing service writes"
    const title = "Billing migration for the ledger tables"
    for (const width of [40, 80, 140]) {
      const layout = layoutLeadRow({ state: "working", title, status, age: "12m" }, { width, titleColumn: leadTitleColumn([title]) })
      expect(displayWidth(line(layout))).toBeLessThanOrEqual(width)
      expect(layout.status.trimEnd()).toEndWith("…")
      expect(layout.age).toBe("12m")
    }
    const wide = layoutLeadRow({ state: "working", title, status, age: "12m" }, { width: 140, titleColumn: leadTitleColumn([title]) })
    expect(wide.title).toBe("Billing migration for t…  ")
    expect(displayWidth(wide.status.trimEnd())).toBeLessThanOrEqual(48)
  })

  it("leaves the status out of a row that has none", () => {
    const layout = layoutLeadRow({ state: "result", title: "Docs", status: "", age: "now" }, { width: 40, titleColumn: 4 })
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
