import { Schema } from "effect";
import type { FieldMap } from "../output-contract/grammar.js";
import { byKey, defineReducer, HANDOFF_REFERENCE_FIELD, handoffValue } from "./reducer.js";

/** The output contract of `collect@1` for a join of `width` items. It
 *  reads no other contract, so a stored group from before the contract was
 *  pinned on the group node converts to the same contract. Its descriptions
 *  are that stored text, so they keep the retired branch words. */
export function collectOutput(width: number): FieldMap {
  return {
    total: { type: "number", description: "How many branches the frozen manifest admitted." },
    completed: { type: "number", description: "How many branches completed every stage." }, // stored text: control v6 groups convert to this pinned contract
    failed: { type: "number", description: "How many branches failed a stage." }, // stored text: control v6 groups convert to this pinned contract
    items: {
      type: "list",
      max: width,
      unique: "key",
      description: "One item per branch, ordered by key.",
      of: {
        type: "object",
        fields: {
          key: { type: "string", description: "The branch identity: the item's unique key." },
          disposition: { type: "enum", values: ["completed", "failed"], description: "How the branch ended." },
          handoff: HANDOFF_REFERENCE_FIELD,
        },
      },
    },
  };
}

/** `collect@1`: every slot, its disposition, and a reference to its handoff,
 *  ordered by item key, with the totals. */
export const collectV1 = defineReducer({
  id: "collect",
  version: 1,
  parameters: [],
  // It takes no parameters. An empty struct schema would accept any keys, so
  // a record of `Never` refuses each one.
  params: Schema.Record(Schema.String, Schema.Never),
  output: (_params, _contracts, width) => collectOutput(width),
  reduce: (_params, { slots }) => ({
    total: slots.length,
    completed: slots.filter(({ disposition }) => disposition === "completed").length,
    failed: slots.filter(({ disposition }) => disposition === "failed").length,
    items: slots.toSorted(byKey).map(({ key, disposition, handoff }) => ({ key, disposition, handoff: handoffValue(handoff) })),
  }),
});
