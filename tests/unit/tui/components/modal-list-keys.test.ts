import { describe, expect, it, mock } from "bun:test"
import { createListModalKeys } from "../../../../src/tui/components/modal-list-keys.js"

interface Row {
  kind: "option" | "category"
  id: string
}

const ROWS: Row[] = [
  { kind: "category", id: "cat" },
  { kind: "option", id: "a" },
  { kind: "option", id: "b" },
  { kind: "option", id: "c" },
]

function harness(overrides: Partial<Parameters<typeof createListModalKeys<Row>>[0]> = {}) {
  let cursor = 1
  const onSelect = mock((_index: number) => {})
  const onClose = mock(() => {})
  const handleKey = createListModalKeys<Row>({
    rows: () => ROWS,
    cursor: () => cursor,
    setCursor: (index) => { cursor = index },
    onSelect,
    onClose,
    ...overrides,
  })
  return { handleKey, cursor: () => cursor, onSelect, onClose }
}

describe("createListModalKeys", () => {
  it("moves over selectable rows with arrows and vim keys, skipping non-options and wrapping", () => {
    const h = harness()
    h.handleKey({ name: "down" })
    expect(h.cursor()).toBe(2)
    h.handleKey({ name: "j" })
    expect(h.cursor()).toBe(3)
    h.handleKey({ name: "j" })
    expect(h.cursor()).toBe(1)
    h.handleKey({ name: "k" })
    expect(h.cursor()).toBe(3)
    h.handleKey({ name: "up" })
    expect(h.cursor()).toBe(2)
  })

  it("activates the cursor row on return and enter, and closes on escape", () => {
    const h = harness()
    h.handleKey({ name: "return" })
    expect(h.onSelect).toHaveBeenCalledWith(1)
    h.handleKey({ name: "Enter" })
    expect(h.onSelect).toHaveBeenCalledTimes(2)
    h.handleKey({ name: "escape" })
    expect(h.onClose).toHaveBeenCalledTimes(1)
  })

  it("types j/k into a text field instead of moving the cursor, which still moves with arrows", () => {
    const typed: string[] = []
    const h = harness({ textInput: (evt) => { typed.push(evt.name) } })
    h.handleKey({ name: "j" })
    h.handleKey({ name: "k" })
    expect(h.cursor()).toBe(1)
    expect(typed).toEqual(["j", "k"])
    h.handleKey({ name: "down" })
    expect(h.cursor()).toBe(2)
  })

  it("lets extra consume a key before the shared dispatch", () => {
    const h = harness({ extra: (evt) => evt.name === "escape" })
    h.handleKey({ name: "escape" })
    expect(h.onClose).not.toHaveBeenCalled()
    h.handleKey({ name: "down" })
    expect(h.cursor()).toBe(2)
  })

  it("honors a custom selectable predicate", () => {
    const h = harness({ selectable: (row) => row.id !== "b" })
    h.handleKey({ name: "down" })
    expect(h.cursor()).toBe(3)
  })
})
