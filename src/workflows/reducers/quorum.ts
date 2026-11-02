import { Schema } from "effect";
import { isRecord } from "../../infra/record.js";
import type { Field, FieldMap } from "../output-contract/grammar.js";
import { byKey, compareCodeUnits, defineReducer, requiredFieldIssue, type JoinContracts, type JoinSelection, type ReducerInput, type ReducerInputSlot, type ReducerOutput } from "./reducer.js";

// `quorum@1`: count the votes of the agents of a phase. The output of each
// agent states a vote of valid, refuted, or abstain. A verdict passes only
// when it has at least `min_valid` valid votes and at most `max_refuted`
// refuted votes. An agent that failed, did not settle, or stated no vote
// abstains, and `min_valid` is at least one, so a pass where every agent
// abstained never passes. Without `group_by` the join has one verdict; with
// it, each value of that item field has its own verdict. Over a phase with
// `votes`, each item has its own verdict over the agents that vote on it,
// and the verdict names the item by its key and label.

const VOTES = ["valid", "refuted", "abstain"] as const;
type Vote = (typeof VOTES)[number];

const QuorumParamsSchema = Schema.Struct({
  vote: Schema.NonEmptyString,
  min_valid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  max_refuted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  group_by: Schema.optionalKey(Schema.NonEmptyString),
});
type QuorumParams = typeof QuorumParamsSchema.Type;

const VerdictSchema = Schema.Struct({
  group: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  valid: Schema.Int,
  refuted: Schema.Int,
  abstain: Schema.Int,
  reason: Schema.String,
});
type Verdict = typeof VerdictSchema.Type;

const QuorumOutputSchema = Schema.Struct({
  passed: Schema.Array(VerdictSchema),
  rejected: Schema.Array(VerdictSchema),
  failed: Schema.Array(Schema.String),
});

function checkQuorum(params: QuorumParams, contracts: JoinContracts): string | undefined {
  const vote = contracts.joined.fields.find(({ key }) => key === params.vote);
  const voteIssue = requiredFieldIssue(vote, ["enum"], `of the ${contracts.joined.name}`, "agent");
  if (voteIssue !== undefined) return `vote "${params.vote}" ${voteIssue}`;
  const values = vote?.values ?? [];
  if (values.length !== VOTES.length || !VOTES.every((value) => values.includes(value))) {
    return `vote "${params.vote}" must declare exactly ${VOTES.join(" | ")}, not ${values.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  if (contracts.votes !== undefined) {
    if (params.group_by !== undefined) {
      return `group_by "${params.group_by}" cannot join a phase with votes, which gives each item one verdict over its ${contracts.votes} votes; remove group_by`;
    }
    if (params.min_valid > contracts.votes) {
      return `min_valid ${params.min_valid} is more than the ${contracts.votes} votes of each item, so no verdict could pass; lower min_valid or raise votes`;
    }
    return undefined;
  }
  if (params.group_by === undefined) return undefined;
  const groupIssue = requiredFieldIssue(contracts.item.fields.find(({ key }) => key === params.group_by), ["string"], `of the ${contracts.item.name}`, "item");
  if (groupIssue !== undefined) return `group_by "${params.group_by}" ${groupIssue}`;
  // The key is unique across the items, so each group holds one item and
  // one vote. A floor above one vote can then never pass, and every verdict
  // would be rejected without a sign of why.
  if (params.group_by === contracts.key && params.min_valid > 1) {
    return `group_by "${params.group_by}" is the key of each item, so each group holds one vote and can never reach min_valid ${params.min_valid}; remove group_by and set votes on the phase, so each item gets its own verdict over its votes`;
  }
  return undefined;
}

function verdictField(params: QuorumParams, contracts: JoinContracts, width: number, description: string): Field {
  const counts = {
    valid: { type: "number", description: "How many agents voted valid." },
    refuted: { type: "number", description: "How many agents voted refuted." },
    abstain: { type: "number", description: "How many agents abstained, failed, or did not settle." },
    reason: { type: "string", description: "The counts against the thresholds that decided the verdict." },
  } as const;
  if (contracts.votes !== undefined) {
    return {
      type: "list",
      description: `${description} One verdict per item over its ${contracts.votes} votes, ordered by the item key.`,
      max: width,
      unique: "key",
      of: {
        type: "object",
        fields: {
          key: { type: "string", description: "The key of the item that the verdict counts: its unique key, or its position in the list." },
          label: { type: "string", description: "The display label of that item." },
          ...counts,
        },
      },
    };
  }
  if (params.group_by === undefined) return { type: "list", description, max: 1, of: { type: "object", fields: counts } };
  return {
    type: "list",
    description: `${description} One verdict per value of "${params.group_by}", ordered by that value.`,
    max: width,
    unique: "group",
    of: { type: "object", fields: { group: { type: "string", description: `The value of "${params.group_by}" that the verdict counts.` }, ...counts } },
  };
}

function quorumOutput(params: QuorumParams, contracts: JoinContracts, width: number): FieldMap {
  return {
    passed: verdictField(params, contracts, width, "The verdicts that reached the quorum."),
    rejected: verdictField(params, contracts, width, "The verdicts that did not reach the quorum."),
    failed: { type: "list", description: "The keys of the agents that failed or did not settle, ordered by key. Each abstained.", max: width * (contracts.votes ?? 1), of: { type: "string" } },
  };
}

/** The vote of one agent: what its report states, or abstain when the
 *  agent failed, did not settle, or stated no vote. */
function voteOf(slot: ReducerInputSlot, field: string): Vote {
  if (slot.disposition !== "completed") return "abstain";
  const value = slot.content?.[field];
  return VOTES.find((vote) => vote === value) ?? "abstain";
}

/** The group of one agent: the value of `group_by` in its item. Load-time
 *  validation required a string, and the source contract decoded the item,
 *  so another value is a broken invariant. */
function groupOf(slot: ReducerInputSlot, groupBy: string): string {
  const value = isRecord(slot.item) ? slot.item[groupBy] : undefined;
  if (typeof value !== "string") throw new Error(`Workflow invariant rejected quorum group_by "${groupBy}" of agent "${slot.key}"`);
  return value;
}

/** One verdict and whether it reached the quorum. */
interface Decision {
  readonly passed: boolean;
  readonly value: Verdict;
}

/** What one verdict counts: every vote, one value of `group_by`, or one
 *  item of a phase with votes. */
type Subject = Pick<Verdict, "group" | "key" | "label">;

/** The vote of one agent of a phase with votes. Expansion gave every agent
 *  of such a phase its vote, so an agent without one is a broken invariant. */
function itemVoteOf(slot: ReducerInputSlot): NonNullable<ReducerInputSlot["vote"]> {
  if (slot.vote === undefined) throw new Error(`Workflow invariant rejected quorum agent "${slot.key}" without a vote`);
  return slot.vote;
}

/** The slots that each verdict counts, in verdict order. */
function subjects(params: QuorumParams, votes: number | undefined, ordered: readonly ReducerInputSlot[]): readonly (readonly [Subject, readonly ReducerInputSlot[]])[] {
  if (votes !== undefined) {
    return [...Map.groupBy(ordered, (slot) => itemVoteOf(slot).itemKey)]
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .flatMap(([key, [first, ...rest]]) => first === undefined ? [] : [[{ key, label: itemVoteOf(first).itemLabel }, [first, ...rest]] as const]);
  }
  const { group_by: groupBy } = params;
  if (groupBy === undefined) return [[{}, ordered]];
  return [...Map.groupBy(ordered, (slot) => groupOf(slot, groupBy))]
    .toSorted(([left], [right]) => compareCodeUnits(left, right))
    .map(([group, members]) => [{ group }, members] as const);
}

function verdict(params: QuorumParams, subject: Subject, votes: readonly Vote[]): Decision {
  const count = (vote: Vote) => votes.filter((candidate) => candidate === vote).length;
  const valid = count("valid");
  const refuted = count("refuted");
  const passed = valid >= params.min_valid && refuted <= params.max_refuted;
  const reasons = passed
    ? [`${valid} valid, at least ${params.min_valid}`, `${refuted} refuted, at most ${params.max_refuted}`]
    : [
      ...(valid < params.min_valid ? [`${valid} valid, fewer than ${params.min_valid}`] : []),
      ...(refuted > params.max_refuted ? [`${refuted} refuted, more than ${params.max_refuted}`] : []),
    ];
  return { passed, value: { ...subject, valid, refuted, abstain: count("abstain"), reason: reasons.join("; ") } };
}

function foldQuorum(params: QuorumParams, { slots, votes }: Pick<ReducerInput, "slots" | "votes">): ReducerOutput {
  const ordered = slots.toSorted(byKey);
  const verdicts = subjects(params, votes, ordered).map(([subject, members]) => verdict(params, subject, members.map((slot) => voteOf(slot, params.vote))));
  return {
    passed: verdicts.filter(({ passed }) => passed).map(({ value }) => value),
    rejected: verdicts.filter(({ passed }) => !passed).map(({ value }) => value),
    failed: ordered.filter(({ disposition }) => disposition === "failed").map(({ key }) => key),
  };
}

const decodeQuorumOutput = Schema.decodeUnknownSync(QuorumOutputSchema, { onExcessProperty: "error" });

/** The verdicts that passed and the ones that did not, each with its counts
 *  as its reason. A verdict without a group or an item counts every vote. */
function quorumSelection(output: ReducerOutput): JoinSelection {
  const { passed, rejected, failed } = decodeQuorumOutput(output);
  const entry = ({ group, key, reason }: Verdict) => ({ key: group ?? key ?? "all votes", reason });
  return { verb: "passed", kept: passed.map(entry), dropped: rejected.map(entry), failed };
}

export const quorumV1 = defineReducer({
  id: "quorum",
  version: 1,
  countsVotes: true,
  parameters: [
    { name: "vote", optional: false, description: "The enum field of each agent's output whose values are exactly valid | refuted | abstain. A failed or unsettled agent abstains." },
    { name: "min_valid", optional: false, description: "The fewest valid votes that pass a verdict; at least 1, so an all-abstain vote never passes." },
    { name: "max_refuted", optional: false, description: "The most refuted votes that a passing verdict allows." },
    { name: "group_by", optional: true, description: "A required string field of each item. Each of its values gets its own verdict. A phase with votes takes none, because each item gets its own verdict." },
  ],
  params: QuorumParamsSchema,
  check: checkQuorum,
  output: quorumOutput,
  reduce: foldQuorum,
  itemFields: (params) => params.group_by === undefined ? [] : [params.group_by],
  selection: quorumSelection,
  syntheticReport: (params) => ({ [params.vote]: "valid" }),
});
