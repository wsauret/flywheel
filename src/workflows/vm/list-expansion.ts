import type { ItemVote } from "../reducers/reducer.js";
import { requireReducer } from "../reducers/registry.js";
import type { WorkflowInputValue } from "../output-contract/compile.js";
import { ITEM_POSITION_KEY, WORKFLOW_INPUT_SOURCE_ID } from "../workflow-schema.js";
import type { WorkflowProposalEncoding } from "./events.js";
import { applyGraphChanges, type GraphChange, type GraphStructure } from "./graph-changes.js";
import type { Attempt, ListNode } from "./graph-types.js";
import { worstCaseAttempts } from "./structural-admission.js";

// The expansion of a list into its items: the manifest of a source list and
// the graph changes it adds. Each item has one item node, or in a list with
// votes one item node for each vote, and each item node holds one agent for
// each phase of the list's stream. A list expands when it is ready
// (list-transitions.ts). A list over the launch input that no repeat holds
// expands at launch, during compilation, through `expandLaunchInput`.

/** One manifest item: its key, its display label, and its value. */
export interface ManifestItem {
  readonly key: string;
  readonly label: string;
  readonly item: Attempt["item"];
}

/** The manifest of one source list, or why the list cannot be one. It is
 *  refused when it is not a list or when it is longer than the declared
 *  width. A keyed list is also refused when an item has no non-empty string
 *  key or when two items share a key. A list that declares no key names each
 *  item by its position (refer to {@link ITEM_POSITION_KEY}), so its items
 *  can be any value, and a string item is its own label. */
export function manifestOf(list: unknown, node: ListNode): readonly ManifestItem[] | string {
  const named = `source "${node.source.nodeId}.${node.source.field}"`;
  if (!Array.isArray(list)) return `${named} is not a list`;
  if (list.length > node.width) return `${named} holds ${list.length} items, more than its declared max of ${node.width}`;
  const items: ManifestItem[] = [];
  const keys = new Set<string>();
  const digits = String(list.length).length;
  for (const [index, item] of list.entries()) {
    const record = typeof item === "object" && item !== null && !Array.isArray(item) ? item : undefined;
    const key: unknown = node.key === ITEM_POSITION_KEY ? String(index + 1).padStart(digits, "0") : record?.[node.key];
    if (typeof key !== "string" || key.length === 0) return `item ${index + 1} has no string "${node.key}"`;
    if (keys.has(key)) return `items repeat the key "${key}"`;
    keys.add(key);
    const label: unknown = node.label === null ? item : record?.[node.label];
    items.push({ key, label: typeof label === "string" && label.length > 0 ? label : key, item });
  }
  return items;
}

/** The graph changes of one expansion, in preorder: each item, then its
 *  agents and the edges between them, then the join over every item.
 *  `ordinals` gives each agent node the manifest position of its item. */
interface Expansion {
  readonly changes: readonly GraphChange[];
  readonly ordinals: ReadonlyMap<string, number>;
}

/** One item node of an expansion: a manifest item, and in a list with votes
 *  also the vote that the item node casts on it. */
interface ItemEntry extends ManifestItem {
  readonly vote?: ItemVote;
}

/** The item nodes of a manifest: one for each item, or in a list with votes
 *  one for each vote of each item, in item order and then vote order. A vote
 *  takes the item's key and `#<vote>` as its key and the item's label and
 *  ` #<vote>` as its label. A vote number holds no `#`, so two item nodes of
 *  distinct items or votes never share a key. */
function entriesOf(node: ListNode, items: readonly ManifestItem[]): readonly ItemEntry[] {
  const { votes } = node;
  if (votes === undefined) return items;
  return items.flatMap(({ key, label, item }) => Array.from({ length: votes }, (_, index): ItemEntry => ({
    key: `${key}#${index + 1}`,
    label: `${label} #${index + 1}`,
    item,
    vote: { number: index + 1, itemKey: key, itemLabel: label },
  })));
}

/** The id segments of the nodes an expansion adds. A proposal of encoding 9
 *  or earlier re-derives the segments that its build wrote, so strict
 *  replay of a run from before phases compares equal ids. Remove these
 *  stored spellings (`branch` and `stage`) after 2027-04-30. */
function idSegments(encoding: WorkflowProposalEncoding): { readonly item: string; readonly phase: string } {
  return encoding >= 10 ? { item: "item", phase: "phase" } : { item: "branch", phase: "stage" }; // stored spellings of encoding 9
}

/** The node id of the item at manifest position `ordinal` of a list's run
 *  `run`. A Resume that runs a list again expands it as run 2 and later,
 *  beside the items of its earlier runs, which keep their ids. */
function itemNodeId(listNodeId: string, ordinal: number, encoding: WorkflowProposalEncoding, run: number): string {
  return `${listNodeId}${run === 1 ? "" : `:run:${run}`}:${idSegments(encoding).item}:${ordinal}`;
}

export function expansionChanges(node: ListNode, items: readonly ManifestItem[], encoding: WorkflowProposalEncoding, run = 1): Expansion {
  const changes: GraphChange[] = [];
  const ordinals = new Map<string, number>();
  const segments = idSegments(encoding);
  let order = node.order;
  const owned = { workflowDefinitionId: node.workflowDefinitionId, outputId: node.outputId };
  const entries = entriesOf(node, items);
  for (const [index, { key, label, item, vote }] of entries.entries()) {
    const ordinal = index + 1;
    const itemId = itemNodeId(node.id, ordinal, encoding, run);
    changes.push({
      kind: "add_node",
      item: null,
      node: {
        kind: "item", id: itemId, workflowDefinitionId: node.workflowDefinitionId, order: order += 1,
        ownership: { _tag: "list", ...owned, parentNodeId: node.id }, state: { _tag: "pending" },
        key, label, ordinal, item, ...(vote === undefined ? {} : { vote }),
      },
    });
    for (const [position, phase] of node.phases.entries()) {
      const agentId = `${itemId}:${segments.phase}:${position + 1}`;
      ordinals.set(agentId, ordinal);
      changes.push({
        kind: "add_node",
        item,
        node: {
          kind: "agent", id: agentId, workflowDefinitionId: node.workflowDefinitionId, order: order += 1,
          ownership: { _tag: "item", ...owned, key, parentNodeId: itemId }, state: { _tag: "pending" },
          definitionId: phase.definitionId, name: phase.name, retry: phase.retry, condition: null,
        },
      });
      if (position > 0) changes.push({ kind: "add_dependency", dependency: { nodeId: agentId, dependsOn: `${itemId}:${segments.phase}:${position}` } });
    }
  }
  changes.push({
    kind: "add_join",
    join: { kind: "collect_all", nodeId: node.id, requiredNodeIds: entries.map((_, index) => itemNodeId(node.id, index + 1, encoding, run)) },
  });
  return { changes, ordinals };
}

/** The provenance of each attempt that one expansion adds: the manifest
 *  position of the agent's item. A proposal of encoding 9 or earlier states
 *  it as its build did. */
export function itemProvenance(ordinals: ReadonlyMap<string, number>) {
  return ({ node }: Extract<GraphChange, { kind: "add_node" }>): Attempt["provenance"] => {
    const ordinal = ordinals.get(node.id);
    if (ordinal === undefined) throw new Error(`Workflow invariant rejected expansion attempt for node "${node.id}", which no item holds`);
    return { _tag: "item", ordinal };
  };
}

/** The launch input that stands for every launch where no launch exists:
 *  load-time validation and the verifier judge one sampled launch. */
export const SAMPLED_LAUNCH = "sampled";

/** The number of items that a sampled launch gives each list over the
 *  launch input, or fewer when the declared width is smaller. */
export const SAMPLED_LAUNCH_ITEMS = 2;

/** `count` synthetic items of a list's source, at most its declared width:
 *  each holds a distinct key when the list declares one, a label when the
 *  phase names one, and each item field that the join's reducer reads. */
export function sampleItems(node: ListNode, count: number): readonly { [field: string]: string }[] {
  const read = requireReducer(node.reducer.id, node.reducer.version).itemFields(node.reducer.params);
  return Array.from({ length: Math.min(count, node.width) }, (_, index) => ({
    ...Object.fromEntries(read.map((field) => [field, `synthetic-${field}-${index + 1}`])),
    ...(node.key === ITEM_POSITION_KEY ? {} : { [node.key]: `synthetic-${index + 1}` }),
    ...(node.label === null ? {} : { [node.label]: `Synthetic ${index + 1}` }),
  }));
}

/** The lists that expand at launch: each list over the launch input that
 *  the workflow or round 1 of a repeat owns. Control does not keep the
 *  input, so a later round's copy expands over round 1's items (refer to
 *  `laterRoundItems`). */
function launchLists(nodes: GraphStructure["graph"]["nodes"]): readonly ListNode[] {
  return nodes.filter((node): node is ListNode => node.kind === "list" && node.source.nodeId === WORKFLOW_INPUT_SOURCE_ID
    && (node.ownership._tag === "workflow" || (node.ownership._tag === "round" && node.ownership.round === 1)));
}

/** Count a launch without expanding its items. The returned graph is only
 *  for admission; zero-width lists represent empty launch lists. */
export function prospectiveLaunchInput<Control extends GraphStructure>(
  control: Control,
  input: WorkflowInputValue | null,
  inferMaxAttempts: boolean,
): Control {
  const counted = {
    ...control,
    graph: {
      ...control.graph,
      nodes: control.graph.nodes.map((node) => {
        if (node.kind !== "list" || node.source.nodeId !== WORKFLOW_INPUT_SOURCE_ID) return node;
        const list = input?.[node.source.field];
        return { ...node, width: Array.isArray(list) ? list.length : 0 };
      }),
    },
  };
  return inferMaxAttempts
    ? { ...counted, guardrails: { ...counted.guardrails, maxAttempts: Math.max(1, worstCaseAttempts(counted)) } }
    : counted;
}

/** Expand every list over the launch input of {@link launchLists}, at
 *  launch. The input is known, so each such list gets exactly one item node
 *  per item, with its agents and its join, and structural admission counts
 *  the exact items instead of the declared worst case. An absent list,
 *  which an optional field allows, has no items. {@link SAMPLED_LAUNCH}
 *  gives each such list {@link SAMPLED_LAUNCH_ITEMS} sampled items. Each
 *  list stays pending: when it is ready, it freezes its shared context and
 *  opens its items as every list does. The launch decoded the input against
 *  its contract first, so the located error for an invalid list is an
 *  invariant. A launch always proposes at the current encoding. */
export function expandLaunchInput<Control extends GraphStructure>(
  control: Control,
  input: WorkflowInputValue | null | typeof SAMPLED_LAUNCH,
  encoding: WorkflowProposalEncoding,
): Control {
  return launchLists(control.graph.nodes).reduce((expanded, node) => {
    const list = input === SAMPLED_LAUNCH ? sampleItems(node, SAMPLED_LAUNCH_ITEMS) : input?.[node.source.field] ?? [];
    const items = manifestOf(list, node);
    if (Array.isArray(items)) {
      const { changes, ordinals } = expansionChanges(node, items, encoding);
      return applyGraphChanges(expanded, changes, itemProvenance(ordinals), node.id);
    }
    throw new Error(`Workflow invariant rejected launch input for phase "${node.outputId}" of workflow "${node.workflowDefinitionId}": ${String(items)}`);
  }, control);
}
