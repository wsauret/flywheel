import { Schema } from "effect";
import { isRecord } from "../../infra/record.js";
import type { FieldMap, FieldType } from "../output-contract/grammar.js";
import { exampleObject } from "../output-contract/instructions.js";
import { byKey, fieldNoun, requiredFieldIssue, type JoinContracts, type JoinSelection, type ReducerInputSlot } from "./reducer.js";

// The shared shape of the reducers that select entries from one list field of
// the output of each agent of a phase (`dedupe@1`, `dedupe@2`, and `top@1`).
// Each flattens the lists of the completed agents in agent-key order and then
// list order, adds the key of the agent that reported each entry, and writes
// what it kept, what it dropped with the reason, and the agents that failed.
// `dedupe@2` also reads the selection of each earlier round of its repeat
// here, to drop what those rounds saw.

type JsonValue = typeof Schema.Json.Type;

/** The field that each entry gains: the item key of the agent that reported
 *  it. Join output stored the key `branch`, and agents read it. */
const BRANCH_FIELD = "branch";

/** The list field of each agent's output that a selecting join reads, as
 *  its contract declares it: the most items one agent reports, the fields of
 *  each item, and the item key that `unique` names, if any. */
export interface ItemList {
  readonly max: number;
  readonly fields: FieldMap;
  readonly unique: string | undefined;
}

/** The list field that `items` names in each agent's output, or why it
 *  cannot feed a selecting join. The list must hold objects, so that each
 *  entry can carry its agent's key, and must declare `max`, so that the join has a
 *  worst case: a workflow file that leaves `max` out gets the default at
 *  load, so only a named workflow meets this reason (refer to
 *  `RegisteredReducer.countedLists`). An item cannot declare the field that
 *  names the agent. */
export function itemList(items: string, contracts: JoinContracts): ItemList | string {
  const named = `items "${items}"`;
  const field = contracts.joined.fields.find(({ key }) => key === items);
  if (field === undefined) return `${named} is not a declared field of the ${contracts.joined.name}`;
  if (field.type !== "list") return `${named} must be a list, not ${fieldNoun(field.type)} of the ${contracts.joined.name}`;
  const fields = field.of?.type === "object" ? field.of.fields : undefined;
  if (fields === undefined) return `${named} must hold objects, so that each entry can name its agent`;
  if (field.max === undefined) return `${named} declares no max, so the join has no worst case`;
  if (Object.hasOwn(fields, BRANCH_FIELD)) return `${named} holds items that declare "${BRANCH_FIELD}", which the join adds to each entry to name its agent`;
  return { max: field.max, fields, unique: field.unique };
}

/** The list that a selecting reducer's `output` and `reduce` read. `check`
 *  accepted the parameters before either runs, so a list that does not fit
 *  is a broken invariant. */
export function requireItemList(items: string, contracts: JoinContracts): ItemList {
  const list = itemList(items, contracts);
  if (typeof list === "string") throw new Error(`Workflow invariant rejected a selecting join: ${list}`);
  return list;
}

/** Why `name` is not a required, non-nullable field of the items of the
 *  list whose type is one of `types`, or undefined when it is one. */
export function itemFieldIssue(list: ItemList, name: string, types: readonly FieldType[], items: string): string | undefined {
  return requiredFieldIssue(list.fields[name], types, `of the items of "${items}"`, "item");
}

/** One item of a list, or one entry of a selecting join's output. */
export type ItemValue = { readonly [key: string]: JsonValue };

/** One item of one agent's list, with the key of that agent. */
export interface ListEntry {
  readonly branch: string;
  readonly item: ItemValue;
}

/** The entries of every completed agent, and the agents that failed. */
export interface ListEntries {
  readonly entries: readonly ListEntry[];
  readonly failed: readonly string[];
}

const decodeItem = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

/** The entries of every completed agent, in agent-key order and then list
 *  order, and the keys of the agents that failed or did not settle, in key
 *  order. A completed agent whose output holds no list, which an optional
 *  field allows, reports no entries. */
export function listEntries(slots: readonly ReducerInputSlot[], items: string): ListEntries {
  const ordered = slots.toSorted(byKey);
  const entries: ListEntry[] = [];
  for (const slot of ordered) {
    const list: unknown = slot.disposition === "completed" ? slot.content?.[items] : undefined;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isRecord(item)) entries.push({ branch: slot.key, item: decodeItem(item) });
    }
  }
  return { entries, failed: ordered.filter(({ disposition }) => disposition === "failed").map(({ key }) => key) };
}

/** The value of a kept entry: the item, with the key of its agent. */
export function keptValue({ branch, item }: ListEntry) {
  return { ...item, [BRANCH_FIELD]: branch };
}

/** One dropped entry: the entry's key, or null when the item states none,
 *  the agent that reported it, and why the join dropped it. */
export function droppedValue(key: string | null, { branch }: ListEntry, reason: string) {
  return { key, [BRANCH_FIELD]: branch, reason };
}

/** The string that `field` of an item states, or null when it states none. */
export function itemKey(item: ListEntry["item"], field: string): string | null {
  const value = item[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The output contract of a selecting join: `kept` holds at most `keptMax`
 *  entries with the item fields and the agent key, unique on `unique` when
 *  the join keys its entries, so a later phase can run over it; `dropped`
 *  holds every other entry of the worst case with its reason; `failed`
 *  holds the keys of the failed agents. */
export function selectionOutput(list: ItemList, width: number, kept: { readonly description: string; readonly max: number; readonly unique: string | undefined }): FieldMap {
  const worst = width * list.max;
  return {
    kept: {
      type: "list",
      description: kept.description,
      max: Math.min(kept.max, worst),
      ...(kept.unique === undefined ? {} : { unique: kept.unique }),
      of: {
        type: "object",
        fields: { ...list.fields, [BRANCH_FIELD]: { type: "string", description: "The item key of the agent that reported this entry." } },
      },
    },
    dropped: {
      type: "list",
      description: "Every entry that the join did not keep, in fold order, each with the reason.",
      max: worst,
      of: {
        type: "object",
        fields: {
          key: { type: "string", nullable: true, description: "The key of the entry, or null when the item states none." },
          [BRANCH_FIELD]: { type: "string", description: "The item key of the agent that reported this entry." },
          reason: { type: "string", description: "Why the join dropped the entry." },
        },
      },
    },
    failed: {
      type: "list",
      description: "The keys of the agents that failed or did not settle, ordered by key. They reported no entries.",
      max: width,
      of: { type: "string" },
    },
  };
}

/** An agent report that lists `count` example items under `items`, with
 *  the item fields of the kept list of the pinned contract. When the list
 *  declares an item key, item n states the key `synthetic-n`, so the items
 *  are distinct and every agent that reports them reports the same keys. */
export function syntheticSelectionReport(items: string, contract: FieldMap, count: number) {
  const { [BRANCH_FIELD]: _branch, ...fields } = contract["kept"]?.of?.fields ?? {};
  const key = keptKey(contract);
  return { [items]: Array.from({ length: count }, (_, index) => ({ ...exampleObject(fields), ...(key === undefined ? {} : { [key]: `synthetic-${index + 1}` }) })) };
}

const SelectionOutputSchema = Schema.Struct({
  kept: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
  dropped: Schema.Array(Schema.Struct({ key: Schema.NullOr(Schema.String), branch: Schema.String, reason: Schema.String })),
  failed: Schema.Array(Schema.String),
});

const decodeSelectionOutput = Schema.decodeUnknownSync(SelectionOutputSchema, { onExcessProperty: "error" });

/** What a selecting join's output reports, as a later round of its repeat
 *  reads it: each kept item without the agent key that the join added, and the
 *  key and reason of each dropped entry that names a key. An entry without
 *  a key names no item that a finder could repeat. */
export function selectionReport(output: unknown) {
  const { kept, dropped } = decodeSelectionOutput(output);
  return {
    kept: kept.map(({ [BRANCH_FIELD]: _branch, ...item }) => item),
    dropped: dropped.flatMap(({ key, reason }) => key === null ? [] : [{ key, reason }]),
  };
}

/** The item field that keys a kept entry: the `unique` key that the pinned
 *  output contract declares on the kept list, or undefined when the items
 *  declare none, so that each entry is distinct. */
export function keptKey(contract: FieldMap): string | undefined {
  return contract["kept"]?.unique;
}

/** What a selecting join's output kept, by the key of each kept entry, or
 *  null when the items declare no key, and what it dropped with each
 *  reason. It reads the output and its pinned contract only. */
export function listSelection(output: unknown, contract: FieldMap): JoinSelection {
  const key = keptKey(contract);
  const { kept, dropped, failed } = decodeSelectionOutput(output);
  return {
    verb: "kept",
    kept: kept.map((entry) => {
      const branch = entry[BRANCH_FIELD];
      return { key: key === undefined ? null : itemKey(entry, key), ...(typeof branch === "string" ? { branch } : {}) };
    }),
    dropped: dropped.map(({ key: entryKey, branch, reason }) => ({ key: entryKey, branch, reason })),
    failed,
  };
}
