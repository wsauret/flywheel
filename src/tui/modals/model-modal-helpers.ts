import type { ModelAssignmentRow } from "../../protocol/model-assignment-protocol-types.js"
import { DEFAULT_ROLES, parentRoleId, ROLE_GROUP_ORDER } from "../../orchestration/config/roles.js"
import type { ModelAssignmentContent, ModelAssignmentItem } from "./model-modal-types.js"
import { flattenModalDisclosureTree, type ModalDisclosureNode } from "../components/modal-disclosure.js"

export function buildModelModalItems(
  assignments: readonly ModelAssignmentRow[],
  expandedGroups: ReadonlySet<string>,
): readonly ModelAssignmentItem[] {
  const partitioned = partitionAssignments(assignments)
  // Chat leads unheaded: it is the assignment most users came to change.
  // Other roles follow the one group order every model surface shares.
  const titles = { agents: "Agents", background: "Background" }
  const assignmentItems: ModelAssignmentItem[] = []
  for (const group of ROLE_GROUP_ORDER) {
    const items = hierarchyItems(partitioned[group], expandedGroups)
    if (group === "core") assignmentItems.push(...items)
    else appendHeadedItems(assignmentItems, titles[group], items)
  }

  return assignmentItems
}

function visibleLeaves(items: readonly ModelAssignmentContent[]): ModelAssignmentItem[] {
  return flattenModalDisclosureTree(items.map((item) => ({ item })), new Set())
}

function appendHeadedItems(out: ModelAssignmentItem[], title: string, items: readonly ModelAssignmentItem[]): void {
  if (items.length === 0) return
  if (out.length > 0) out.push(...visibleLeaves([{ kind: "spacer" }]))
  out.push(...visibleLeaves([{ kind: "heading", title }]), ...items)
}

interface PartitionResult {
  core: ModelAssignmentRow[]
  agents: ModelAssignmentRow[]
  background: ModelAssignmentRow[]
}

function partitionAssignments(assignments: readonly ModelAssignmentRow[]): PartitionResult {
  const result: PartitionResult = {
    core: [],
    agents: [],
    background: [],
  }

  for (const row of assignments) {
    const group = DEFAULT_ROLES[row.slot.roleId]?.group ?? "agents"
    result[group].push(row)
  }
  return result
}

function hierarchyItems(rows: readonly ModelAssignmentRow[], expandedGroups: ReadonlySet<string>): ModelAssignmentItem[] {
  return flattenModalDisclosureTree(hierarchyNodes(rows), expandedGroups)
}

function hierarchyNodes(rows: readonly ModelAssignmentRow[]): ModalDisclosureNode<ModelAssignmentContent>[] {
  const rowIds = new Set(rows.map((row) => row.slot.roleId))
  const childrenByParent = new Map<string, ModelAssignmentRow[]>()
  for (const row of rows) {
    const parent = parentRoleId(row.slot.roleId)
    if (!parent || !rowIds.has(parent)) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(row)
    childrenByParent.set(parent, children)
  }

  function nodeFor(row: ModelAssignmentRow): ModalDisclosureNode<ModelAssignmentContent> {
    const item: ModelAssignmentContent = { kind: "assignment", row }
    const children = (childrenByParent.get(row.slot.roleId) ?? []).toSorted((left, right) => roleOrder(left) - roleOrder(right)).map(nodeFor)
    return children.length === 0
      ? { item }
      : { item, disclosure: { id: row.slot.roleId, interaction: "primary-and-disclosure", children } }
  }

  return rows.filter((row) => {
    const parent = parentRoleId(row.slot.roleId)
    return !parent || !rowIds.has(parent)
  }).toSorted((left, right) => roleOrder(left) - roleOrder(right)).map(nodeFor)
}

function roleOrder(row: ModelAssignmentRow): number {
  return DEFAULT_ROLES[row.slot.roleId]?.order ?? Number.POSITIVE_INFINITY
}

export function isSelectableItem(
  item: ModelAssignmentItem | undefined,
): item is Extract<ModelAssignmentItem, { kind: "assignment" }> {
  return item?.kind === "assignment"
}
