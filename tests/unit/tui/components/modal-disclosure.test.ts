import { describe, expect, test } from "bun:test"
import {
  createModalDisclosureState,
  flattenModalDisclosureTree,
  modalDisclosureAction,
  modalDisclosureHelp,
  modalDisclosureMarker,
  type ModalDisclosureNode,
} from "../../../../src/tui/components/modal-disclosure.js"

interface Item {
  readonly id: string
}

const tree: readonly ModalDisclosureNode<Item>[] = [{
  item: { id: "outer" },
  disclosure: {
    id: "outer",
    interaction: "disclosure-only",
    children: [{
      item: { id: "inner" },
      disclosure: {
        id: "inner",
        interaction: "primary-and-disclosure",
        children: [{ item: { id: "leaf" } }],
      },
    }],
  },
}]

describe("modal disclosure", () => {
  test("flattens nested rows from one expansion set and records depth", () => {
    expect(flattenModalDisclosureTree(tree, new Set()).map(({ id, depth }) => ({ id, depth }))).toEqual([
      { id: "outer", depth: 0 },
    ])
    expect(flattenModalDisclosureTree(tree, new Set(["outer", "inner"])).map(({ id, depth }) => ({ id, depth }))).toEqual([
      { id: "outer", depth: 0 },
      { id: "inner", depth: 1 },
      { id: "leaf", depth: 2 },
    ])
  })

  test("can reveal a filtered branch without changing normal expansion", () => {
    const rows = flattenModalDisclosureTree(tree, new Set(), new Set(["outer", "inner"]))
    expect(rows.map((row) => row.id)).toEqual(["outer", "inner", "leaf"])
    expect(rows[0]?.disclosure?.expanded).toBe(true)
  })

  test("keeps primary activation separate from disclosure activation", () => {
    const primary = { id: "reviewer", expanded: false, interaction: "primary-and-disclosure" } as const
    const disclosureOnly = { id: "appearance", expanded: true, interaction: "disclosure-only" } as const
    expect(modalDisclosureAction(primary, "enter")).toBe("primary")
    expect(modalDisclosureAction(primary, "space")).toBe("toggle")
    expect(modalDisclosureAction(disclosureOnly, "enter")).toBe("toggle")
    expect(modalDisclosureAction(disclosureOnly, "space")).toBeUndefined()
    expect(modalDisclosureAction(disclosureOnly, "pointer")).toBe("toggle")
    expect(modalDisclosureAction(primary, "pointer")).toBeUndefined()
    expect(modalDisclosureHelp(primary)).toBe("space expand")
    expect(modalDisclosureHelp(disclosureOnly)).toBe("enter collapse")
    expect(modalDisclosureMarker(primary)).toBe("▸")
    expect(modalDisclosureMarker(disclosureOnly)).toBe("▾")
  })

  test("updates and resets the caller-owned expansion set", () => {
    let expandedIds: readonly string[] = []
    const state = createModalDisclosureState({
      expandedIds: () => expandedIds,
      setExpandedIds: (ids) => { expandedIds = ids },
    })
    state.toggle("appearance")
    expect(expandedIds).toEqual(["appearance"])
    state.toggle("appearance")
    expect(expandedIds).toEqual([])
    state.toggle("maintenance")
    state.reset()
    expect(expandedIds).toEqual([])
  })
})
