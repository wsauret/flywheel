import { Schema } from "effect";
import type { WorkflowTreeCoverage } from "../../protocol/workflow-view-protocol-types.js";
import type { CompiledField } from "../output-contract/compile.js";
import type { FieldMap, FieldType } from "../output-contract/grammar.js";

/** The contract of a registered deterministic reducer, which folds the
 *  outcomes of a phase's agents at its join. A reducer calculates and never judges: it
 *  counts, thresholds, deduplicates by an explicit key, ranks by a declared
 *  numeric policy, or computes complements. It calls no model, reads no
 *  ambient state, and changes no control. The VM calls it inside strict
 *  replay, so a reducer is pure over its parameters and its input. */

/** The `handoff.written` fact that a slot refers to: its attempt id, in the
 *  stored key `stepId`, and the sha256 of its content. A reducer output carries this
 *  reference, never a copy of the handoff body. */
export interface HandoffReference {
  readonly stepId: string; // stored key of control v11 join slots
  readonly sha256: string;
}

type JsonValue = typeof Schema.Json.Type;

/** One manifest slot of a settled join, in manifest order, with the content
 *  that its references name. Every admitted item has one slot, so a missing
 *  or failed agent stays visible and never changes a denominator. The VM
 *  resolves the content and the item from committed control; `group.settled`
 *  records only the references. */
export interface ReducerInputSlot {
  readonly ordinal: number;
  readonly key: string;
  readonly branchNodeId: string;
  readonly disposition: "completed" | "failed";
  /** The handoff of the item's agent in the last phase of the stream, or
   *  null when that agent failed. */
  readonly handoff: HandoffReference | null;
  /** The recorded content of that handoff, which its sha256 pins. */
  readonly content: { readonly [key: string]: unknown } | null;
  /** The slot's item, as the frozen manifest admitted it. */
  readonly item: JsonValue;
  /** The vote of an agent of a phase with `votes`, and absent for any
   *  other phase, which runs one agent per item. */
  readonly vote?: ItemVote;
}

/** One agent of a phase with `votes`: its vote number, from 1 to the phase's
 *  vote count, and the key and display label of the item that it votes on.
 *  The agent's own key and label add the vote number to the item's, so two
 *  votes of one item never share a key. */
export interface ItemVote {
  readonly number: number;
  readonly itemKey: string;
  readonly itemLabel: string;
}

/** The output record of a list's source: the handoff of the source phase's
 *  agent, or the join output of the source phase. */
export interface SourceOutput {
  readonly [key: string]: unknown;
}

/** The settled join output of one earlier round of the repeat that owns the
 *  folding join. */
export interface EarlierRound {
  readonly round: number;
  readonly output: ReducerOutput;
}

/** Everything a reducer reads when its join folds. */
export interface ReducerInput {
  /** One slot per manifest item, in manifest order. */
  readonly slots: readonly ReducerInputSlot[];
  /** The item field that gives each agent its identity. */
  readonly key: string;
  /** The output that the list came from, or null when the list is in the
   *  launch input, which control does not keep. */
  readonly source: SourceOutput | null;
  /** The output contract that compilation pinned on the join. The fold
   *  validates its output against it, and a reducer that ranks by an enum
   *  reads the declaration order of that enum here, because the contracts
   *  around the join are not part of control. */
  readonly contract: FieldMap;
  /** The join outputs of the earlier rounds of the repeat that owns the join,
   *  round 1 first. Empty for a join outside a repeat and for round 1. The
   *  VM folds each one again from committed control, so no side store feeds
   *  it. Only a reducer that remembers earlier rounds, such as `dedupe@2`,
   *  reads it. */
  readonly earlierRounds: readonly EarlierRound[];
  /** The votes of each item of a phase with `votes`, whose slots each carry
   *  their vote. Absent for any other phase. */
  readonly votes?: number;
}

/** The JSON value a reducer writes. */
export interface ReducerOutput {
  readonly [key: string]: JsonValue;
}

const ReducerParamsSchema = Schema.Record(Schema.String, Schema.Json);
export type ReducerParams = typeof ReducerParamsSchema.Type;

/** One declared output contract that a reducer parameter can name: its
 *  fields as control validation reads them, and the words that name it in a
 *  load error. */
interface NamedContract {
  readonly name: string;
  readonly fields: readonly CompiledField[];
}

/** The contracts around one join, which the load-time check of a reducer's
 *  parameters reads. */
export interface JoinContracts {
  /** The item field that gives each agent's slot its identity. */
  readonly key: string;
  /** The fields of each item of the source list. */
  readonly item: NamedContract;
  /** The output contract of each output that the join folds: the last
   *  phase of a stream over a list, or one named agent of a phase. */
  readonly joined: NamedContract;
  /** The output contract of the list's source, or null when the list reads
   *  the launch input or the join folds named agents. */
  readonly source: NamedContract | null;
  /** The votes of each item of a list with `votes`, which runs that many
   *  agents for each item. Absent for any other list. */
  readonly votes?: number;
}

/** One entry of a join's selection: its key, or null for an item that
 *  states none, the agent that reported it when the entry comes from one
 *  agent, and why the join dropped or kept it when the reducer states a
 *  reason. */
export interface SelectionEntry {
  readonly key: string | null;
  readonly branch?: string;
  readonly reason?: string;
}

/** What a selecting reducer kept and dropped, read from its output alone.
 *  `verb` names the kept entries as the clients show them: `kept` for a
 *  filter or a ranking, `passed` for a vote. `failed` holds the keys of the
 *  agents that failed or did not settle. */
export interface JoinSelection {
  readonly verb: "kept" | "passed";
  readonly kept: readonly SelectionEntry[];
  readonly dropped: readonly SelectionEntry[];
  readonly failed: readonly string[];
}

/** One parameter of a reducer, as `flywheel workflow reducers` lists it. */
interface ReducerParameter {
  readonly name: string;
  readonly optional: boolean;
  readonly description: string;
}

export interface RegisteredReducer {
  readonly id: string;
  readonly version: number;
  readonly parameters: readonly ReducerParameter[];
  /** Whether the reducer counts the votes of a phase with `votes`. Only such
   *  a reducer can join that phase, because the phase runs several agents
   *  for each item, and only a vote count gives those agents one result. */
  readonly countsVotes: boolean;
  /** Decodes the `with` record of a join. Excess keys are errors. */
  readonly decodeParams: (params: unknown) => ReducerParams;
  /** Why decoded parameters do not fit the contracts around the join, or
   *  undefined when they fit. Compilation calls it when a definition loads. */
  readonly check: (params: ReducerParams, contracts: JoinContracts) => string | undefined;
  /** Why the source output cannot feed this join, or undefined when it can.
   *  Expansion of a list from a phase's output calls it with the manifest
   *  keys, and a reason refuses the expansion. */
  readonly admit: (params: ReducerParams, source: SourceOutput | null, keys: readonly string[], key: string) => string | undefined;
  /** The output contract of the join: a function of the parameters, the
   *  contracts around the join, and the width of the group, so a kept list
   *  carries the item fields that it copies. Compilation calls it once, after
   *  `check` accepted the parameters, and pins the result on the group node.
   *  A later phase can run over a list field of it. */
  readonly output: (params: ReducerParams, contracts: JoinContracts, width: number) => FieldMap;
  readonly reduce: (params: ReducerParams, input: ReducerInput) => ReducerOutput;
  /** The item fields that `reduce` reads from each item as strings, such
   *  as the field a quorum groups its votes by. Load-time validation proved
   *  that the items declare each one, and the verifier's sampled items state
   *  each one, so exploration folds a sample as a run folds real items. */
  readonly itemFields: (params: ReducerParams) => readonly string[];
  /** The list fields of each agent's output whose `max` the join's
   *  output contract counts, such as the items that a selecting join keeps.
   *  A workflow file that declares no `max` on one of them gets the default
   *  at load (refer to `DEFAULT_COUNTED_LIST_MAX`), so the join has a worst
   *  case. */
  readonly countedLists: (params: ReducerParams) => readonly string[];
  /** The list fields of the source output that `admit` reads, such as the
   *  exclusions of a coverage join. A source handoff delivered after its
   *  correction ran out salvages them, so admission can read them. */
  readonly admittedLists: (params: ReducerParams) => readonly string[];
  /** The coverage that a coverage reducer's output states: the status, the
   *  required numerator and denominator, and the required unsurveyed keys.
   *  It reads only the output, so it cannot disagree with it. A reducer
   *  that reports no coverage has none. The tree and inspection read it. */
  readonly coverage?: (output: ReducerOutput) => WorkflowTreeCoverage;
  /** What a selecting reducer's output kept and dropped, with the reason for
   *  each dropped entry. It reads the output and the output contract that
   *  the group pinned, which names the key of a kept entry, so it cannot
   *  disagree with the output. The tree reads its counts, and inspection
   *  prints its entries. */
  readonly selection?: (output: ReducerOutput, contract: FieldMap) => JoinSelection;
  /** The fields that the verifier's synthetic agents of the join report in
   *  a positive handoff of `count` sampled items (1 or 2), from the join's
   *  pinned output contract: the same entries from every agent, so the fold
   *  keeps `count` entries and a phase that reads the join's output explores
   *  it non-empty and, where the count matters, with two. In a repeat, the
   *  first round keeps them and the next round of `dedupe@2` is dry. A
   *  reducer whose output does not depend on the count ignores it. A reducer
   *  without it sees the synthetic handoffs alone. */
  readonly syntheticReport?: (params: ReducerParams, contract: FieldMap, count: number) => { readonly [field: string]: unknown };
}

/** The definition of one reducer over its own typed parameters. */
interface ReducerDefinition<Params extends ReducerParams> {
  readonly id: string;
  readonly version: number;
  readonly parameters: readonly ReducerParameter[];
  readonly countsVotes?: boolean;
  readonly params: Schema.Decoder<Params>;
  readonly check?: (params: Params, contracts: JoinContracts) => string | undefined;
  readonly admit?: (params: Params, source: SourceOutput | null, keys: readonly string[], key: string) => string | undefined;
  readonly output: (params: Params, contracts: JoinContracts, width: number) => FieldMap;
  readonly reduce: (params: Params, input: ReducerInput) => ReducerOutput;
  readonly itemFields?: (params: Params) => readonly string[];
  readonly countedLists?: (params: Params) => readonly string[];
  readonly admittedLists?: (params: Params) => readonly string[];
  readonly coverage?: (output: ReducerOutput) => WorkflowTreeCoverage;
  readonly selection?: (output: ReducerOutput, contract: FieldMap) => JoinSelection;
  readonly syntheticReport?: (params: Params, contract: FieldMap, count: number) => { readonly [field: string]: unknown };
}

/** Register one reducer. Each call decodes the stored parameters with the
 *  reducer's own schema, so a reducer reads typed parameters and a stored
 *  run that names it reads the same values. */
export function defineReducer<Params extends ReducerParams>(definition: ReducerDefinition<Params>): RegisteredReducer {
  const decode = Schema.decodeUnknownSync(definition.params, { onExcessProperty: "error" });
  return {
    id: definition.id,
    version: definition.version,
    parameters: definition.parameters,
    countsVotes: definition.countsVotes ?? false,
    decodeParams: (params) => decode(params ?? {}),
    check: (params, contracts) => definition.check?.(decode(params), contracts),
    admit: (params, source, keys, key) => definition.admit?.(decode(params), source, keys, key),
    output: (params, contracts, width) => definition.output(decode(params), contracts, width),
    reduce: (params, input) => definition.reduce(decode(params), input),
    itemFields: (params) => definition.itemFields?.(decode(params)) ?? [],
    countedLists: (params) => definition.countedLists?.(decode(params)) ?? [],
    admittedLists: (params) => definition.admittedLists?.(decode(params)) ?? [],
    ...(definition.coverage === undefined ? {} : { coverage: definition.coverage }),
    ...(definition.selection === undefined ? {} : { selection: definition.selection }),
    ...(definition.syntheticReport === undefined ? {} : { syntheticReport: (params: ReducerParams, contract: FieldMap, count: number) => definition.syntheticReport?.(decode(params), contract, count) ?? {} }),
  };
}

/** A phrase with its indefinite article, as a load error states it. */
function withArticle(phrase: string): string {
  return `${/^[aeiou]/.test(phrase) ? "an" : "a"} ${phrase}`;
}

/** A field type as a load error names it, such as "an enum field". */
export function fieldNoun(type: FieldType): string {
  return withArticle(`${type} field`);
}

/** Why `field` is not a required, non-nullable field whose type is one of
 *  `types`, or undefined when it is one. `where` names the contract that
 *  declares the field, and `each` names what must state it. Every reducer
 *  check words this reason here, so the reasons agree. */
export function requiredFieldIssue(
  field: { readonly type: FieldType; readonly optional?: boolean; readonly nullable?: boolean } | undefined,
  types: readonly FieldType[],
  where: string,
  each: string,
): string | undefined {
  if (field === undefined) return `is not a declared field ${where}`;
  if (!types.includes(field.type)) return `must be ${withArticle(`${types.join(" or ")} field`)}, not ${fieldNoun(field.type)} ${where}`;
  if (field.optional === true || field.nullable === true) return `must be a required and not nullable field ${where}, so every ${each} states it`;
  return undefined;
}

/** Order two strings by their code units. Stable item identity orders this
 *  way: a locale-aware comparison could differ between machines, so it is
 *  not used. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function byKey(left: { readonly key: string }, right: { readonly key: string }): number {
  return compareCodeUnits(left.key, right.key);
}

/** The reference that a reducer output writes for a handoff, in the field
 *  names that every post-join reader expands. */
export function handoffValue(handoff: HandoffReference | null): { readonly step_id: string; readonly sha256: string } | null {
  return handoff === null ? null : { step_id: handoff.stepId, sha256: handoff.sha256 }; // stored keys of control v11 join output
}

/** The output contract of one handoff reference. */
export const HANDOFF_REFERENCE_FIELD = {
  type: "object",
  nullable: true,
  description: "The handoff of the branch's last stage, or null when the branch failed.", // stored text: control v6 groups convert to this pinned contract
  fields: {
    step_id: { type: "string", description: "The attempt that wrote the handoff." },
    sha256: { type: "string", description: "The sha256 of the handoff content." },
  },
} as const;
