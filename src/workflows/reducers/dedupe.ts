import { Schema } from "effect";
import { defineReducer, type JoinContracts, type ReducerInput } from "./reducer.js";
import { droppedValue, itemFieldIssue, itemKey, itemList, keptValue, listEntries, listSelection, requireItemList, selectionOutput, syntheticSelectionReport, type ItemValue } from "./list-selection.js";

// `dedupe@1`: keep the first item per key. The output of each agent lists
// items in one list field, and `by` names the item field whose value is the
// key. The first item in agent-key order and then list order wins, so the
// result does not depend on the order in which the agents settled.
//
// `dedupe@2` takes the same parameters and writes the same output, and it
// also drops each item whose key an earlier round of its loop kept or
// dropped. A finder that repeats an item that an earlier round saw, also one
// that a later phase refuted, cannot bring it back or keep the loop alive.
// Outside a loop it folds as `dedupe@1` does.

const DedupeParamsSchema = Schema.Struct({
  items: Schema.NonEmptyString,
  by: Schema.NonEmptyString,
});
type DedupeParams = typeof DedupeParamsSchema.Type;

const DEDUPE_PARAMETERS = [
  { name: "items", optional: false, description: "A list field of each agent's output whose items the join deduplicates." },
  { name: "by", optional: false, description: "The required string field of each item that is its key. The first item per key in the key order of the agents that reported them, then list order, is kept." },
];

/** The key of each kept entry must be a required string: it is the identity
 *  that `unique` declares, so a later phase can run over the kept list. */
function checkDedupe(params: DedupeParams, contracts: JoinContracts): string | undefined {
  const list = itemList(params.items, contracts);
  if (typeof list === "string") return list;
  const issue = itemFieldIssue(list, params.by, ["string"], params.items);
  return issue === undefined ? undefined : `by "${params.by}" ${issue}`;
}

function dedupeOutput(params: DedupeParams, contracts: JoinContracts, width: number, description: string) {
  const list = requireItemList(params.items, contracts);
  return selectionOutput(list, width, { description, max: width * list.max, unique: params.by });
}

/** Keep the first item per key, in agent-key order and then list order.
 *  An item whose key is in `seenIn` is dropped with the round that first
 *  saw it, and a repeat within the fold is dropped as a duplicate of the
 *  agent that kept it. */
function foldDedupe(params: DedupeParams, slots: ReducerInput["slots"], seenIn: ReadonlyMap<string, number>) {
  const { entries, failed } = listEntries(slots, params.items);
  const first = new Map<string, string>();
  const kept: ItemValue[] = [];
  const dropped: ItemValue[] = [];
  for (const entry of entries) {
    const key = itemKey(entry.item, params.by);
    const seen = key === null ? undefined : seenIn.get(key);
    const winner = key === null ? undefined : first.get(key);
    if (key === null) dropped.push(droppedValue(null, entry, `has no "${params.by}"`));
    else if (seen !== undefined) dropped.push(droppedValue(key, entry, `seen in round ${seen}`));
    else if (winner !== undefined) dropped.push(droppedValue(key, entry, `duplicate of ${winner}`));
    else {
      first.set(key, entry.branch);
      kept.push(keptValue(entry));
    }
  }
  return { kept, dropped, failed };
}

/** The round that first kept or dropped each key, read from the outputs of
 *  the earlier rounds through their selection. A null key names no item, so
 *  it never enters the set. */
function seenSet(earlierRounds: ReducerInput["earlierRounds"], contract: ReducerInput["contract"]): ReadonlyMap<string, number> {
  const seenIn = new Map<string, number>();
  for (const { round, output } of earlierRounds) {
    const selection = listSelection(output, contract);
    for (const { key } of [...selection.kept, ...selection.dropped]) {
      if (key !== null && !seenIn.has(key)) seenIn.set(key, round);
    }
  }
  return seenIn;
}

export const dedupeV1 = defineReducer({
  id: "dedupe",
  version: 1,
  parameters: DEDUPE_PARAMETERS,
  params: DedupeParamsSchema,
  check: checkDedupe,
  countedLists: (params) => [params.items],
  output: (params, contracts, width) => dedupeOutput(params, contracts, width, `The first item per "${params.by}", in the key order of the agents that reported them and then list order, each with the key of the agent that reported it.`),
  reduce: (params, { slots }) => foldDedupe(params, slots, new Map()),
  selection: listSelection,
  syntheticReport: (params, contract, count) => syntheticSelectionReport(params.items, contract, count),
});

export const dedupeV2 = defineReducer({
  id: "dedupe",
  version: 2,
  parameters: DEDUPE_PARAMETERS,
  params: DedupeParamsSchema,
  check: checkDedupe,
  countedLists: (params) => [params.items],
  output: (params, contracts, width) => dedupeOutput(params, contracts, width, `The first item per "${params.by}" that no earlier round of the repeat kept or dropped, in the key order of the agents that reported them and then list order, each with the key of the agent that reported it.`),
  reduce: (params, { slots, earlierRounds, contract }) => foldDedupe(params, slots, seenSet(earlierRounds, contract)),
  selection: listSelection,
  syntheticReport: (params, contract, count) => syntheticSelectionReport(params.items, contract, count),
});
