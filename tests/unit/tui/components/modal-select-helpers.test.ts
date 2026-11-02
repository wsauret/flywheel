import { describe, it, expect } from "bun:test"
import {
  filterOptions,
  flattenWithCategories,
  moveCursor,
  firstSelectableRow,
  matchAction,
} from "../../../../src/tui/components/modal-select-helpers.js"
import type { Action, ModalSelectOption } from "../../../../src/tui/components/modal-select-types.js"

function option(id: string, title: string, category?: string, disabled = false): ModalSelectOption {
  return { id, title, value: id, category, disabled, description: `Desc for ${title}` }
}

describe("filterOptions", () => {
  const options = [
    option("sessions", "Sessions", "App"),
    option("theme", "Theme", "Settings"),
    option("models", "Models", "App"),
    option("plan-implement", "Plan + Implement", "Workflow"),
    option("debug", "Debug", "Workflow"),
  ]

  it("title matches rank above category-only matches", () => {
    const result = filterOptions(options, "plan")
    expect(result[0]?.id).toBe("plan-implement")
  })

  it("excludes disabled options from results", () => {
    const withDisabled = [
      ...options,
      option("disabled-cmd", "Disabled Command", "App", true),
    ]
    const result = filterOptions(withDisabled, "")
    expect(result.find((r) => r.id === "disabled-cmd")).toBeUndefined()
  })

  it("excludes disabled options even when query matches", () => {
    const withDisabled = [
      option("active", "Font Active", "App"),
      option("disabled-font", "Font Disabled", "App", true),
    ]
    const result = filterOptions(withDisabled, "font")
    expect(result.length).toBe(1)
    expect(result[0]?.id).toBe("active")
  })
})

describe("flattenWithCategories", () => {
  const options = [
    option("new", "New Chat", "App"),
    option("sessions", "Sessions", "App"),
    option("plan-implement", "Plan + Implement", "Workflow"),
    option("debug", "Debug", "Workflow"),
  ]

  it("includes category headers when showCategories is true", () => {
    const result = flattenWithCategories(options, true)
    const categoryRows = result.rows.filter((r) => r.kind === "category")
    expect(categoryRows.length).toBe(2)
    expect(categoryRows[0]?.categoryLabel).toBe("App")
    expect(categoryRows[1]?.categoryLabel).toBe("Workflow")
  })

  it("omits category headers when showCategories is false", () => {
    const result = flattenWithCategories(options, false)
    const categoryRows = result.rows.filter((r) => r.kind === "category")
    expect(categoryRows.length).toBe(0)
  })

  it("caps rendering at bounded limit and reports capped status", () => {
    const large = Array.from({ length: 500 }, (_, i) => option(`opt-${i}`, `Option ${i}`))
    const result = flattenWithCategories(large, false)
    expect(result.capped).toBe(true)
    expect(result.totalMatches).toBe(500)
    expect(result.rows.length).toBeLessThanOrEqual(200)
  })

})

describe("moveCursor", () => {
  const options = [
    option("new", "New Chat", "App"),
    option("sessions", "Sessions", "App"),
    option("plan-implement", "Plan + Implement", "Workflow"),
  ]

  it("wraps backward from first to last", () => {
    const { rows } = flattenWithCategories(options, true)
    const firstOption = rows.find((r) => r.kind === "option")!
    const next = moveCursor(rows, firstOption.rowIndex, -1)
    const lastOption = rows.filter((r) => r.kind === "option").at(-1)!
    expect(next).toBe(lastOption.rowIndex)
  })

})

describe("firstSelectableRow", () => {
  it("returns 0 for empty rows", () => {
    expect(firstSelectableRow([])).toBe(0)
  })
})

describe("matchAction", () => {
  const actions: Action<string>[] = [
    { key: "a", label: "Archive", onTrigger: () => {} },
    { key: "A", label: "Apply", onTrigger: () => {} },
  ]

  it("returns the first case-sensitive matching action", () => {
    expect(matchAction("a", actions)).toBe(actions[0])
    expect(matchAction("A", actions)).toBe(actions[1])
  })

  it("returns undefined for non-matching keys", () => {
    expect(matchAction("x", actions)).toBeUndefined()
  })

})
