import { Schema } from "effect";
import type { FieldMap } from "../output-contract/grammar.js";
import { compareCodeUnits, defineReducer, type JoinContracts } from "./reducer.js";
import { droppedValue, itemFieldIssue, itemKey, itemList, keptKey, keptValue, listEntries, listSelection, requireItemList, selectionOutput, syntheticSelectionReport, type ItemValue, type ListEntry } from "./list-selection.js";

// `top@1`: keep the `count` highest or lowest items by a declared number or
// enum. The output of each agent lists items in one list field. An enum
// ranks by its declaration order: the first declared value is the lowest.
// When the list declares a unique item key, ties break on the item key and
// then the key of the agent that reported it, and an item key names one
// item, so the same key from a second agent is dropped as a duplicate and
// never takes a second place. When the list declares none, each item is
// distinct, and ties break on the agent key and then list order. Either way
// the result does not depend on the order in which the agents settled.

const TopParamsSchema = Schema.Struct({
  items: Schema.NonEmptyString,
  by: Schema.NonEmptyString,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  order: Schema.Literals(["desc", "asc"]),
});
type TopParams = typeof TopParamsSchema.Type;

function checkTop(params: TopParams, contracts: JoinContracts): string | undefined {
  const list = itemList(params.items, contracts);
  if (typeof list === "string") return list;
  const issue = itemFieldIssue(list, params.by, ["number", "enum"], params.items);
  return issue === undefined ? undefined : `by "${params.by}" ${issue}`;
}

/** The rank of one item: a number ranks by its value, and an enum ranks by
 *  the position of its value in the declaration that the pinned output
 *  contract holds. Undefined when the item states no rank. */
function rankOf(item: ListEntry["item"], by: string, contract: FieldMap): number | undefined {
  const value = item[by];
  const values = contract["kept"]?.of?.fields?.[by]?.values;
  if (values !== undefined) {
    // The grammar lets an enum declare strings and numbers, so a number
    // value ranks by its declared position, not by its value.
    const position = typeof value === "string" || typeof value === "number" ? values.indexOf(value) : -1;
    return position < 0 ? undefined : position;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const topV1 = defineReducer({
  id: "top",
  version: 1,
  parameters: [
    { name: "items", optional: false, description: "A list field of each agent's output whose items the join ranks. With a unique item key, the join keeps each key once." },
    { name: "by", optional: false, description: "The required number or enum field of each item that ranks it. An enum ranks by its declaration order, first lowest." },
    { name: "count", optional: false, description: "The most items the join keeps." },
    { name: "order", optional: false, description: "desc keeps the highest ranks, asc keeps the lowest. Ties break on the item key, then the key of the agent that reported the item." },
  ],
  params: TopParamsSchema,
  check: checkTop,
  countedLists: (params) => [params.items],
  output: (params, contracts, width) => {
    const list = requireItemList(params.items, contracts);
    return selectionOutput(list, width, {
      description: `At most ${params.count} items by "${params.by}" (${params.order}),${list.unique === undefined ? "" : " each item key once,"} in rank order, each with the key of the agent that reported it.`,
      max: params.count,
      unique: list.unique,
    });
  },
  reduce: (params, { slots, contract }) => {
    const key = keptKey(contract);
    const { entries, failed } = listEntries(slots, params.items);
    const direction = params.order === "desc" ? -1 : 1;
    const ranked = entries.map((entry) => ({ entry, key: key === undefined ? null : itemKey(entry.item, key), rank: rankOf(entry.item, params.by, contract) }));
    const kept: ItemValue[] = [];
    const dropped: ItemValue[] = [];
    const ordered: { readonly entry: ListEntry; readonly key: string | null; readonly rank: number }[] = [];
    // An entry without a rank, or without the key that the list declares,
    // has no place in the order; it is dropped after the ranked entries,
    // with the field it lacks.
    const unplaced: ItemValue[] = [];
    for (const candidate of ranked) {
      if (key !== undefined && candidate.key === null) unplaced.push(droppedValue(null, candidate.entry, `has no "${key}"`));
      else if (candidate.rank === undefined) unplaced.push(droppedValue(candidate.key, candidate.entry, `has no "${params.by}"`));
      else ordered.push({ entry: candidate.entry, key: candidate.key, rank: candidate.rank });
    }
    // The entries are in agent-key order and then list order, and the sort
    // is stable, so a tie that no item key breaks keeps that order.
    const first = new Map<string, string>();
    for (const { entry, key: entryKey } of ordered.toSorted((left, right) => direction * (left.rank - right.rank)
      || compareCodeUnits(left.key ?? "", right.key ?? "")
      || compareCodeUnits(left.entry.branch, right.entry.branch))) {
      const winner = entryKey === null ? undefined : first.get(entryKey);
      if (winner !== undefined) dropped.push(droppedValue(entryKey, entry, `duplicate of ${winner}`));
      else {
        if (entryKey !== null) first.set(entryKey, entry.branch);
        if (kept.length < params.count) kept.push(keptValue(entry));
        else dropped.push(droppedValue(entryKey, entry, `below the top ${params.count}`));
      }
    }
    dropped.push(...unplaced);
    return { kept, dropped, failed };
  },
  selection: listSelection,
  syntheticReport: (params, contract, count) => syntheticSelectionReport(params.items, contract, count),
});
