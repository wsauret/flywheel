import { Schema } from "effect";
import { isRecord } from "../../infra/record.js";
import type { CompiledField } from "../output-contract/compile.js";
import type { FieldMap } from "../output-contract/grammar.js";
import type { WorkflowTreeCoverage } from "../../protocol/workflow-view-protocol-types.js";
import { ITEM_POSITION_KEY } from "../workflow-schema.js";
import { byKey, compareCodeUnits, defineReducer, fieldNoun, HANDOFF_REFERENCE_FIELD, handoffValue, type JoinContracts, type ReducerInput, type ReducerInputSlot, type ReducerOutput, type SourceOutput } from "./reducer.js";

// `coverage@1`: the breadth-coverage contract of a survey. Each item of the
// list is a target with a priority, the agent of each item reports whether
// it surveyed its target, and the source phase can list the targets that the
// scope excluded. The reducer counts which targets the survey reached. It
// never judges a report: the agent that wrote the report decided its outcome.

const PRIORITIES = ["required", "supporting"] as const;
const OUTCOMES = ["surveyed", "inaccessible", "excluded"] as const;
type Priority = (typeof PRIORITIES)[number];
type Outcome = (typeof OUTCOMES)[number];

const FieldNameSchema = Schema.NonEmptyString;

const CoverageParamsSchema = Schema.Struct({
  priority: FieldNameSchema,
  outcome: FieldNameSchema,
  exclusions: Schema.optionalKey(FieldNameSchema),
});
type CoverageParams = typeof CoverageParamsSchema.Type;

/** One priority tier: the exact numerator and denominator, and the surveyed
 *  and unsurveyed complements as item keys. */
const TierSchema = Schema.Struct({
  numerator: Schema.Int,
  denominator: Schema.Int,
  surveyed: Schema.Array(Schema.String),
  unsurveyed: Schema.Array(Schema.String),
});
type Tier = typeof TierSchema.Type;

/** The output of `coverage@1`, as a reader decodes it from a settled join. */
export const CoverageOutputSchema = Schema.Struct({
  status: Schema.Literals(["full", "partial", "empty"]),
  required: TierSchema,
  supporting: TierSchema,
  inaccessible: Schema.Array(Schema.String),
  excluded: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.String),
  items: Schema.Array(Schema.Struct({
    key: Schema.String,
    priority: Schema.Literals(PRIORITIES),
    disposition: Schema.Literals(["completed", "failed"]),
    outcome: Schema.NullOr(Schema.Literals(OUTCOMES)),
    handoff: Schema.NullOr(Schema.Struct({ step_id: Schema.String, sha256: Schema.String })),
  })),
});
type CoverageOutput = typeof CoverageOutputSchema.Type;

function declared(fields: readonly CompiledField[], key: string): CompiledField | undefined {
  return fields.find((field) => field.key === key);
}

/** Why `field` is not a required enum whose values come from `allowed`, or
 *  undefined when it is one. `needs` names a value it must declare. */
function enumIssue(field: CompiledField | undefined, allowed: readonly string[], needs?: string): string | undefined {
  if (field === undefined) return "is not a declared field";
  if (field.type !== "enum" || field.values === undefined) return `must be an enum of ${allowed.join(" | ")}, not ${fieldNoun(field.type)}`;
  if (field.optional || field.nullable) return "must be a required and not nullable field";
  const foreign = field.values.filter((value) => typeof value !== "string" || !allowed.includes(value));
  if (foreign.length > 0) return `declares ${foreign.map((value) => JSON.stringify(value)).join(", ")}, which is not one of ${allowed.join(" | ")}`;
  if (needs !== undefined && !field.values.includes(needs)) return `must declare "${needs}"`;
  return undefined;
}

/** Why the exclusions field is not a list of item keys, or undefined when it
 *  is one: a list of strings, or of objects that carry the item key as a
 *  required string. */
function exclusionsIssue(field: CompiledField | undefined, key: string): string | undefined {
  if (field === undefined) return "is not a declared field";
  if (field.type !== "list") return `must be a list, not ${fieldNoun(field.type)}`;
  const item = field.of;
  if (item?.nullable) return "must hold non-null items; remove nullable from the list item contract";
  if (item?.type === "string") return undefined;
  const keyField = item?.type === "object" ? item.fields?.[key] : undefined;
  if (keyField?.type === "string" && keyField.optional !== true && keyField.nullable !== true) return undefined;
  return `must hold strings, or objects with a required string "${key}" that names each excluded target`;
}

function checkCoverage(params: CoverageParams, contracts: JoinContracts): string | undefined {
  const priority = enumIssue(declared(contracts.item.fields, params.priority), PRIORITIES, "required");
  if (priority !== undefined) return `priority "${params.priority}" ${priority} of the ${contracts.item.name}`;
  const outcome = enumIssue(declared(contracts.joined.fields, params.outcome), OUTCOMES, "surveyed");
  if (outcome !== undefined) return `outcome "${params.outcome}" ${outcome} of the ${contracts.joined.name}`;
  if (params.exclusions === undefined) return undefined;
  if (contracts.source === null) return `exclusions "${params.exclusions}" needs a source phase; the launch input holds no exclusions list`;
  if (contracts.key === ITEM_POSITION_KEY) return `exclusions "${params.exclusions}" names targets by their unique key, and the source list declares none; declare unique on the source list`;
  const exclusions = exclusionsIssue(declared(contracts.source.fields, params.exclusions), contracts.key);
  return exclusions === undefined ? undefined : `exclusions "${params.exclusions}" ${exclusions} of the ${contracts.source.name}`;
}

/** The keys of the source's exclusions list, in list order, or why the list
 *  holds no keys. An absent list, which an optional field allows, holds
 *  none. */
function exclusionKeys(params: CoverageParams, source: SourceOutput | null, key: string): readonly string[] | string {
  if (params.exclusions === undefined) return [];
  const list = source?.[params.exclusions];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return `exclusions "${params.exclusions}" is not a list`;
  const keys: string[] = [];
  for (const [index, entry] of list.entries()) {
    const value: unknown = isRecord(entry) ? entry[key] : entry;
    if (typeof value !== "string" || value.length === 0) return `exclusion ${index + 1} has no string "${key}"`;
    keys.push(value);
  }
  return keys;
}

/** Refuse an exclusions list that repeats a key or names a target, because
 *  a target is either surveyed or excluded, and a silent deduplication would
 *  hide which one the inventory meant. */
function admitCoverage(params: CoverageParams, source: SourceOutput | null, targets: readonly string[], key: string): string | undefined {
  const excluded = exclusionKeys(params, source, key);
  if (typeof excluded === "string") return excluded;
  const seen = new Set<string>();
  const targetKeys = new Set(targets);
  for (const excludedKey of excluded) {
    if (seen.has(excludedKey)) return `exclusions repeat the key "${excludedKey}"`;
    if (targetKeys.has(excludedKey)) return `exclusion "${excludedKey}" is also a target`;
    seen.add(excludedKey);
  }
  return undefined;
}

function itemPriority(slot: ReducerInputSlot, params: CoverageParams): Priority {
  const value = isRecord(slot.item) ? slot.item[params.priority] : undefined;
  // A value that the contract does not name counts as required, so an
  // unreadable priority can never shrink the required denominator.
  return value === "supporting" ? "supporting" : "required";
}

function slotOutcome(slot: ReducerInputSlot, params: CoverageParams): Outcome | null {
  if (slot.disposition !== "completed") return null;
  const value = slot.content?.[params.outcome];
  return OUTCOMES.find((outcome) => outcome === value) ?? null;
}

function tier(slots: readonly { readonly key: string; readonly surveyed: boolean }[]): Tier {
  const surveyed = slots.filter((slot) => slot.surveyed).map(({ key }) => key);
  const unsurveyed = slots.filter((slot) => !slot.surveyed).map(({ key }) => key);
  return { numerator: surveyed.length, denominator: slots.length, surveyed, unsurveyed };
}

/** The status of a fold. A survey is full only when it holds a required
 *  target and reached every one. A survey of supporting targets alone
 *  reached no required target, so it is partial and never reads as full. */
function surveyStatus(items: readonly unknown[], required: Tier): CoverageOutput["status"] {
  if (items.length === 0) return "empty";
  return required.denominator > 0 && required.unsurveyed.length === 0 ? "full" : "partial";
}

/** Fold the survey. A target counts as surveyed only when its agent
 *  completed and its report states `surveyed`. An agent that failed, or
 *  whose report states no readable outcome, never surveyed its target: it
 *  stays in the denominator and the unsurveyed complement, and `failed`
 *  names it. An agent that reports `inaccessible` or `excluded` is
 *  unsurveyed too, and its list names it. The source's exclusions receive
 *  no agent and do not count in a denominator. */
function reduceCoverage(params: CoverageParams, slots: readonly ReducerInputSlot[], excludedBySource: readonly string[]): CoverageOutput {
  const items = slots.toSorted(byKey).map((slot) => ({
    key: slot.key,
    priority: itemPriority(slot, params),
    disposition: slot.disposition,
    outcome: slotOutcome(slot, params),
    handoff: handoffValue(slot.handoff),
  }));
  const ofPriority = (priority: Priority) => tier(items.filter((item) => item.priority === priority).map(({ key, outcome }) => ({ key, surveyed: outcome === "surveyed" })));
  const required = ofPriority("required");
  const supporting = ofPriority("supporting");
  const status = surveyStatus(items, required);
  const keysWith = (outcome: Outcome) => items.filter((item) => item.outcome === outcome).map(({ key }) => key);
  return {
    status,
    required,
    supporting,
    inaccessible: keysWith("inaccessible"),
    excluded: [...keysWith("excluded"), ...excludedBySource].toSorted(compareCodeUnits),
    failed: items.filter((item) => item.outcome === null).map(({ key }) => key),
    items,
  };
}

const decodeCoverageOutput = Schema.decodeUnknownSync(CoverageOutputSchema);

/** The coverage that one output states: its status, the required numerator
 *  and denominator, and the required unsurveyed keys. */
function coverageOf(output: ReducerOutput): WorkflowTreeCoverage {
  const { status, required } = decodeCoverageOutput(output);
  return { status, required: { surveyed: required.numerator, total: required.denominator }, unsurveyed: required.unsurveyed };
}

function foldCoverage(params: CoverageParams, { slots, source, key }: ReducerInput): CoverageOutput {
  const excluded = exclusionKeys(params, source, key);
  // Expansion admitted the same list, so a list that holds no keys here
  // means control changed under a settled expansion.
  if (typeof excluded === "string") throw new Error(`Workflow invariant rejected coverage exclusions: ${excluded}`);
  return reduceCoverage(params, slots, excluded);
}

const keyList = (description: string, max?: number) => ({
  type: "list",
  description,
  ...(max === undefined ? {} : { max }),
  of: { type: "string" },
}) as const;

const tierField = (width: number, priority: Priority) => ({
  type: "object",
  description: `The ${priority} targets: the exact numerator and denominator, and the keys that the survey did and did not reach, ordered by key.`,
  fields: {
    numerator: { type: "number", description: `How many ${priority} targets the survey reached.` },
    denominator: { type: "number", description: `How many ${priority} targets the manifest holds.` },
    surveyed: keyList(`The keys of the ${priority} targets that the survey reached.`, width),
    unsurveyed: keyList(`The keys of the ${priority} targets that the survey did not reach.`, width),
  },
}) as const;

/** The output contract of `coverage@1` for a join of `width` items. It
 *  reads no other contract, so a stored group from before the contract was
 *  pinned on the group node converts to the same contract. Its descriptions
 *  are that stored text, so they keep the retired branch words. */
export function coverageOutput(width: number): FieldMap {
  return {
    status: { type: "enum", values: ["full", "partial", "empty"], description: "full when the manifest holds a required target and the survey reached every one, empty when the manifest held no targets, and partial otherwise." },
    required: tierField(width, "required"),
    supporting: tierField(width, "supporting"),
    inaccessible: keyList("The keys of the targets whose report states inaccessible, ordered by key.", width),
    excluded: keyList("The keys of the targets that the source excluded or whose report states excluded, ordered by key."),
    failed: keyList("The keys of the targets whose branch failed or reported no outcome, ordered by key.", width),
    items: {
      type: "list",
      max: width,
      unique: "key",
      description: "One item per branch, ordered by key, with a reference to its report.",
      of: {
        type: "object",
        fields: {
          key: { type: "string", description: "The branch identity: the item's unique key." },
          priority: { type: "enum", values: [...PRIORITIES], description: "The target's priority." },
          disposition: { type: "enum", values: ["completed", "failed"], description: "How the branch ended." },
          outcome: { type: "enum", values: [...OUTCOMES], nullable: true, description: "What the report states, or null when the branch failed or stated no outcome." },
          handoff: HANDOFF_REFERENCE_FIELD,
        },
      },
    },
  };
}

export const coverageV1 = defineReducer({
  id: "coverage",
  version: 1,
  parameters: [
    { name: "priority", optional: false, description: "The item field whose values are required | supporting." },
    { name: "outcome", optional: false, description: "The field of each agent's output that reports surveyed | inaccessible | excluded." },
    { name: "exclusions", optional: true, description: "A list field of the source output that names the targets the scope excluded." },
  ],
  params: CoverageParamsSchema,
  check: checkCoverage,
  admit: admitCoverage,
  output: (_params, _contracts, width) => coverageOutput(width),
  reduce: foldCoverage,
  coverage: coverageOf,
});
