import { describe, expect, it } from "bun:test"
import { followSelection, layoutLeadRow, leadAge, leadListWindow } from "../../../../../src/tui/modules/lead/list-model.js"
import { displayWidth } from "../../../../../src/tui/utils/text.js"

const line = (layout: ReturnType<typeof layoutLeadRow>): string => `${layout.prefix}${layout.title}${layout.separator}${layout.update}${layout.gap}${layout.age}`

describe("the lead list model", () => {
  it("lays a row out as mark, state word, title, update, and a right-aligned age that fills the width exactly", () => {
    const layout = layoutLeadRow({ state: "question", title: "Fix login", update: "Which provider should I use?", age: "3m" }, 60)
    expect(line(layout)).toBe(`? question  Fix login  Which provider should I use?${" ".repeat(7)}3m`)
    expect(displayWidth(line(layout))).toBe(60)
  })

  it("never wraps: at widths 80 and 140 a long update is cut with an ellipsis and the row fills the width", () => {
    const update = "The migration plan is ready and it covers every table that the billing service writes, with a dry run first ".repeat(2)
    for (const width of [80, 140]) {
      const layout = layoutLeadRow({ state: "working", title: "Billing migration", update, age: "12m" }, width)
      expect(displayWidth(line(layout))).toBe(width)
      expect(layout.update.endsWith("…")).toBe(true)
      expect(layout.title).toBe("Billing migration")
      expect(layout.age).toBe("12m")
    }
  })

  it("leaves the update out of a row whose chat has posted none", () => {
    const layout = layoutLeadRow({ state: "result", title: "Docs", update: null, age: "now" }, 40)
    expect(line(layout)).toBe(`✓ result    Docs${" ".repeat(21)}now`)
  })

  it("counts the age in whole minutes, hours, and days", () => {
    const now = 10 * 24 * 3_600_000
    expect(leadAge(now - 59_000, now)).toBe("now")
    expect(leadAge(now - 61_000, now)).toBe("1m")
    expect(leadAge(now - 2 * 3_600_000, now)).toBe("2h")
    expect(leadAge(now - 3 * 24 * 3_600_000, now)).toBe("3d")
  })

  it("shows 6 of 30 rows, a more line, and the hint line on 24 terminal rows, and moves the window with the selection", () => {
    expect(leadListWindow({ total: 30, selected: 0, start: 0, terminalRows: 24 })).toEqual({ start: 0, count: 6, more: 24 })
    expect(leadListWindow({ total: 30, selected: 5, start: 0, terminalRows: 24 })).toEqual({ start: 0, count: 6, more: 24 })
    expect(leadListWindow({ total: 30, selected: 6, start: 0, terminalRows: 24 })).toEqual({ start: 1, count: 6, more: 24 })
    expect(leadListWindow({ total: 30, selected: 3, start: 1, terminalRows: 24 })).toEqual({ start: 1, count: 6, more: 24 })
    expect(leadListWindow({ total: 30, selected: 0, start: 1, terminalRows: 24 })).toEqual({ start: 0, count: 6, more: 24 })
  })

  it("keeps every line within a third of the terminal's rows and always shows one chat row", () => {
    expect(leadListWindow({ total: 3, selected: undefined, start: 0, terminalRows: 24 })).toEqual({ start: 0, count: 3, more: 0 })
    expect(leadListWindow({ total: 5, selected: undefined, start: 0, terminalRows: 12 })).toEqual({ start: 0, count: 2, more: 3 })
    expect(leadListWindow({ total: 5, selected: 4, start: 0, terminalRows: 6 })).toEqual({ start: 4, count: 1, more: 4 })
  })

  it("keeps the selection on the same chat when rows reorder and moves it to the row that takes its place when its row goes", () => {
    expect(followSelection(["a", "b", "c"], ["new", "a", "b", "c"], "b")).toBe("b")
    expect(followSelection(["a", "b", "c"], ["a", "c"], "b")).toBe("c")
    expect(followSelection(["a", "b", "c"], ["a", "b"], "c")).toBe("b")
    expect(followSelection(["a"], [], "a")).toBeUndefined()
    expect(followSelection(["a"], ["a"], undefined)).toBeUndefined()
  })
})
