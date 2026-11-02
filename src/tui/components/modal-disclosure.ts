type ModalDisclosureInteraction = "disclosure-only" | "primary-and-disclosure"

export interface ModalDisclosure {
  readonly id: string
  readonly expanded: boolean
  readonly interaction: ModalDisclosureInteraction
}

export interface ModalDisclosureNode<T extends object> {
  readonly item: T
  readonly children?: readonly ModalDisclosureNode<T>[]
  readonly disclosure?: {
    readonly id: string
    readonly interaction: ModalDisclosureInteraction
    readonly children: readonly ModalDisclosureNode<T>[]
  }
}

export type ModalDisclosureItem<T extends object> = T & {
  readonly depth: number
  readonly disclosure?: ModalDisclosure
}

interface ModalDisclosureStateDeps {
  readonly expandedIds: () => readonly string[]
  readonly setExpandedIds: (ids: readonly string[]) => void
}

export interface ModalDisclosureState {
  readonly expandedIds: () => readonly string[]
  readonly reset: () => void
  readonly toggle: (id: string) => void
}

/** Owns one modal's transient disclosure set while leaving its storage in the modal's state domain. */
export function createModalDisclosureState(deps: ModalDisclosureStateDeps): ModalDisclosureState {
  return {
    expandedIds: deps.expandedIds,
    reset: () => deps.setExpandedIds([]),
    toggle: (id) => {
      const expanded = deps.expandedIds()
      deps.setExpandedIds(expanded.includes(id) ? expanded.filter((candidate) => candidate !== id) : [...expanded, id])
    },
  }
}

/** Flattens a modal row tree into the visible rows for the current expansion set. */
export function flattenModalDisclosureTree<T extends object>(
  nodes: readonly ModalDisclosureNode<T>[],
  expandedIds: ReadonlySet<string>,
  forcedExpandedIds: ReadonlySet<string> = new Set(),
): ModalDisclosureItem<T>[] {
  const rows: ModalDisclosureItem<T>[] = []

  function append(visibleNodes: readonly ModalDisclosureNode<T>[], depth: number): void {
    for (const node of visibleNodes) {
      const branch = node.disclosure
      const expanded = branch !== undefined && (expandedIds.has(branch.id) || forcedExpandedIds.has(branch.id))
      rows.push({
        ...node.item,
        depth,
        ...(branch === undefined ? {} : {
          disclosure: { id: branch.id, expanded, interaction: branch.interaction },
        }),
      })
      if (node.children !== undefined) append(node.children, depth + 1)
      if (branch !== undefined && expanded) append(branch.children, depth + 1)
    }
  }

  append(nodes, 0)
  return rows
}

export type ModalDisclosureTrigger = "enter" | "space" | "pointer"
export type ModalDisclosureAction = "primary" | "toggle"

export function modalDisclosureAction(disclosure: ModalDisclosure, trigger: ModalDisclosureTrigger): ModalDisclosureAction | undefined {
  if (disclosure.interaction === "disclosure-only") return trigger === "enter" || trigger === "pointer" ? "toggle" : undefined
  if (trigger === "enter") return "primary"
  return trigger === "space" ? "toggle" : undefined
}

export function modalDisclosureMarker(disclosure: ModalDisclosure): "▾" | "▸" {
  return disclosure.expanded ? "▾" : "▸"
}

export function modalDisclosureHelp(disclosure: ModalDisclosure): string {
  const trigger = modalDisclosureAction(disclosure, "enter") === "toggle" ? "enter" : "space"
  return `${trigger} ${disclosure.expanded ? "collapse" : "expand"}`
}
