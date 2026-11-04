import { Effect, Schema } from "effect";
import { isQualifiedSkillId } from "../infra/skill-id.js";
import { EffortSchema } from "../infra/workflow-types.js";
import { isWorkflowLocalId } from "../infra/workflow-identifiers.js";
import { ArtifactContractFrontmatterItemSchema, ArtifactContractsFrontmatterSchema } from "./artifact-contracts.js";
import type { DefinitionProvenance } from "./definition-provenance.js";
import type { LoadedBriefs } from "./brief.js";
import type { RetiredReadSource } from "./retired-step-grammar/reads.js";
import type { RetiredStepGrammarView } from "./retired-step-grammar/view.js";
import type { CompiledInput } from "./output-contract/compile.js";

/** Whether an id is one segment of the qualified-id grammar: a lowercase
 *  slug of `[a-z0-9-]` with no dot. */
function isDotFreeSlug(id: string): boolean {
  return isQualifiedSkillId(id) && !id.includes(".");
}

/** Why an id cannot be one dot-free slug. */
export function dotFreeSlugIssue(id: string): string | undefined {
  return isDotFreeSlug(id) ? undefined : `${JSON.stringify(id)} is not a dot-free lowercase slug ([a-z0-9-])`;
}

/** A phase id or a named agent's id. A reference is `<name>.<field>`, so a
 *  name holds no dot. */
const LocalIdSchema = Schema.NonEmptyString.check(Schema.makeFilter((id) =>
  isWorkflowLocalId(id) || `a phase or agent name must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, or underscores: ${JSON.stringify(id)}`));

/** A qualified skill id (see infra/skill-id.ts). */
export const SkillIdSchema = Schema.NonEmptyString.check(Schema.makeFilter((id) =>
  isQualifiedSkillId(id)
  || `skill id must be a dot-delimited lowercase slug ([a-z0-9-]): ${JSON.stringify(id)}`));

/** An output contract as authored: a path to a shared `.json` contract file,
 *  or the contract object itself. The loader decodes the object with the
 *  closed field grammar (output-contract/grammar.ts), which names each bad key. */
export const OutputRefSchema = Schema.Union([Schema.NonEmptyString, Schema.Record(Schema.String, Schema.Unknown)]);

/** The outputs that one agent record reads: phase ids and named-agent ids.
 *  Only this agent receives them, each once and labeled with its id. */
const ReadsSchema = Schema.Array(LocalIdSchema).check(Schema.makeFilter((ids) => {
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  return repeated === undefined || `reads names ${JSON.stringify(repeated)} more than once`;
}));

/** How often a failed handoff of one agent tries again, and whether a retry
 *  stops when the failure repeats word for word. */
const RetrySchema = Schema.Struct({
  max: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  stuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
});

/** The keys of an agent record (docs/terminology.md "agent record"): which brief it runs,
 *  who runs it, and the policy the workflow imposes on it. `output`,
 *  `dependencies`, and `subagents` belong to an inline `brief`, because
 *  an in-file reused brief owns its own contract. `model` and
 *  `effort` belong only to a workflow file that a chat launches by path. */
export const AgentRecordFields = {
  name: Schema.optionalKey(Schema.NonEmptyString),
  runs: Schema.optionalKey(Schema.NonEmptyString),
  brief: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(EffortSchema),
  writes: Schema.optionalKey(ArtifactContractsFrontmatterSchema),
  reads: Schema.optionalKey(ReadsSchema),
  retry: Schema.optionalKey(RetrySchema),
  output: Schema.optionalKey(OutputRefSchema),
  dependencies: Schema.optionalKey(Schema.Array(SkillIdSchema)),
  subagents: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
} as const;

/** The record keys as one type, which a phase and a named agent share. */
export type AgentRecordKeys = Schema.Struct.Type<typeof AgentRecordFields>;

/** A named agent in its long form: its id and its own record keys. */
const NamedAgentSchema = Schema.Struct({
  agent: LocalIdSchema,
  ...AgentRecordFields,
});
export type NamedAgent = typeof NamedAgentSchema.Type;

/** The join of a phase with more than one agent: the registered reducer that
 *  folds the agents' outputs, its parameters, and the one artifact the join
 *  writes. `reducer` names a registered reducer id; compile pins its latest
 *  version. The reducer's own parameter schema decodes `with`. Without
 *  `write` the join writes one transient artifact named after the phase. */
const JoinSchema = Schema.Struct({
  reducer: Schema.NonEmptyString,
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  write: Schema.optionalKey(ArtifactContractFrontmatterItemSchema),
});

/** The reserved source id of the launch input. `over: input.<field>` runs
 *  one agent for each item of a list field of the workflow's `input`
 *  contract. No phase or agent can take this id. */
export const WORKFLOW_INPUT_SOURCE_ID = "input";

/** The reserved item key of a list that declares no `unique` key: each item
 *  takes its 1-based position in the frozen list, padded to the digits of the
 *  list length so that key order is list order. No declared field can take
 *  this name, because a field key matches `[a-z][a-z0-9_]*`. */
export const ITEM_POSITION_KEY = "#position";

/** The votes of each item of a phase with `votes`: at least 2, because one
 *  vote is a phase without votes, and at most 10, the bound of every other
 *  authored repetition. */
export const VotesSchema = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 10 }));

/** One phase of a workflow (docs/terminology.md "phase"). It holds one agent, the named
 *  agents of `agents`, or one agent for each item of the list that `over`
 *  names. The phase's own record keys declare its one agent, the agent of
 *  each item, or, beside `agents`, the defaults of its named agents, which
 *  an agent's own key replaces. */
const WorkflowPhaseSchema = Schema.Struct({
  phase: LocalIdSchema,
  if: Schema.optionalKey(Schema.NonEmptyString),
  over: Schema.optionalKey(Schema.NonEmptyString),
  label: Schema.optionalKey(Schema.NonEmptyString),
  votes: Schema.optionalKey(VotesSchema),
  join: Schema.optionalKey(JoinSchema),
  agents: Schema.optionalKey(Schema.Array(Schema.Union([LocalIdSchema, NamedAgentSchema])).check(Schema.makeFilter((agents) =>
    agents.length >= 2 || "agents names at least 2 agents; a phase of one agent needs no agents key"))),
  ...AgentRecordFields,
});
export type WorkflowPhase = typeof WorkflowPhaseSchema.Type;

/** The loop of a repeat: rounds while a field is not empty, or one round for
 *  each item of a list, one after another. */
const RepeatLoopSchema = Schema.Union([
  Schema.Struct({
    while: Schema.NonEmptyString,
    max: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    stuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  }),
  Schema.Struct({
    each: Schema.NonEmptyString,
    reassess: Schema.optionalKey(LocalIdSchema),
  }),
]);
export type RepeatLoop = typeof RepeatLoopSchema.Type;

/** A repeat (docs/terminology.md "repeat"): a block that runs its own phases in rounds.
 *  It is not a phase: it has no agent and no attempt. */
const WorkflowRepeatSchema = Schema.Struct({
  repeat: RepeatLoopSchema,
  phases: Schema.NonEmptyArray(WorkflowPhaseSchema),
});
export type WorkflowRepeat = typeof WorkflowRepeatSchema.Type;

export type PhaseOrRepeat = WorkflowPhase | WorkflowRepeat;

/** The element of each kind of a `phases` list. */
export interface PhaseOrRepeatByKind {
  readonly phase: WorkflowPhase;
  readonly repeat: WorkflowRepeat;
}
export type PhaseOrRepeatKind = keyof PhaseOrRepeatByKind;

/** The schema of each element kind. A list decodes each element through the
 *  union of both, whose failure states what each kind would need; a reader
 *  that knows an element's kind decodes it here to state only its problems. */
export const PHASE_OR_REPEAT_SCHEMAS = {
  phase: WorkflowPhaseSchema,
  repeat: WorkflowRepeatSchema,
} as const satisfies { readonly [K in PhaseOrRepeatKind]: Schema.Decoder<PhaseOrRepeatByKind[K]> };

const PhaseOrRepeatSchema = Schema.Union([WorkflowPhaseSchema, WorkflowRepeatSchema]);

/** The kind that one undecoded element names by its discriminating key. */
export function authoredPhaseOrRepeatKind(entry: unknown): PhaseOrRepeatKind | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  return (["repeat", "phase"] as const).find((kind) => kind in entry);
}

export function isRepeat(entry: PhaseOrRepeat): entry is WorkflowRepeat {
  return "repeat" in entry;
}

export function isWhileRepeat(loop: RepeatLoop): loop is Extract<RepeatLoop, { readonly while: string }> {
  return "while" in loop;
}

/** The greatest attempt count a declaration may request. A large list needs
 *  room, so the ceiling is well above the default of 50. */
export const MAX_ATTEMPTS_CEILING = 4096;

/** The `max` that a workflow file gives a list of an agent's output when a
 *  phase over it or a join counts the list and the list declares none. The
 *  agent is held to it, so the phase has a width, the join a worst case, and
 *  the run a bounded worst case. */
export const DEFAULT_COUNTED_LIST_MAX = 100;

/** Per-workflow guardrails that the launch compiles into committed control.
 *  Absent keys keep the launch defaults. Bounds are deliberate ceilings on
 *  what any declaration may request. */
const WorkflowGuardrailsSchema = Schema.Struct({
  /** The worst-case attempt count of one run. */
  max_attempts: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ATTEMPTS_CEILING }))),
  /** How many attempts may run at one time. Absent, every ready attempt
   *  that waits on no other runs at once. */
  max_parallel: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ATTEMPTS_CEILING }))),
  /** How many changes one reassess attempt may make. */
  max_mutations_per_attempt: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  /** How many items a run may add after launch. */
  max_inserts: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
});

export const WorkflowDefinitionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  guardrails: Schema.optionalKey(WorkflowGuardrailsSchema),
  /** The structured launch input that the workflow takes beside its text
   *  request: a path to a shared `.json` contract file, or the contract
   *  object itself. It uses the output field grammar and declares only
   *  `fields`. A launch passes `input` data, which must decode strictly
   *  against this contract before the workflow starts. Every agent receives
   *  the decoded input as part of the request, and `over: input.<field>`
   *  runs a phase over one of its list fields. */
  input: Schema.optionalKey(OutputRefSchema),
  /** The phases and repeats of the workflow, in run order. */
  phases: Schema.NonEmptyArray(PhaseOrRepeatSchema),
});

// Optional provenance and loaded content: WorkflowDefinition admits bare
// schema-decoded instances (the compiler and validators need no source file).
// The loader attaches both to every definition it publishes, so a published
// revision never reads the workflow file again.
export type WorkflowDefinition = typeof WorkflowDefinitionSchema.Type & {
  provenance?: DefinitionProvenance;
  /** The brief of each agent record, read once from the file when the
   *  loader published the workflow, keyed by record id. */
  briefs?: LoadedBriefs;
  /** The compiled `input` contract, read once with the briefs: null when
   *  the workflow declares none. */
  inputContract?: CompiledInput | null;
  /** The retired step-grammar record that a saved file stated before the loader
   *  converted it to phases. Brief loading and the identity proofs of a paused run
   *  read it. Remove after 2027-04-30. */
  retiredStepGrammar?: RetiredStepGrammarView;
};

/** Where one phase sits in the authored list. */
export interface PhaseLocation {
  /** The phase's index in its own list: the top-level list, or the
   *  phases of its repeat. */
  readonly index: number;
  /** The repeat that holds the phase, with the repeat's top-level index. */
  readonly repeat?: { readonly entry: WorkflowRepeat; readonly index: number };
  /** The top-level index of the phase, or of the repeat that holds it. */
  readonly topIndex: number;
  /** The phase as a message names it: `Phase "fix"`. */
  readonly label: string;
}

/** The label of one phase in a message. */
export function phaseLabel(id: string): string {
  return `Phase "${id}"`;
}

/** The label of one named agent in a message. */
export function agentLabel(id: string): string {
  return `Agent "${id}"`;
}

/** The label of one repeat in a message: its 1-based position in the
 *  top-level list. */
export function repeatLabel(topIndex: number): string {
  return `Repeat ${topIndex + 1}`;
}

/** Visit every phase in run order: the top-level phases, and the phases of
 *  each repeat where the repeat stands. Validation, resolution, identity,
 *  and compilation all walk phases here, so each one reads the same phases
 *  in the same order. */
export function walkPhases(
  phases: readonly PhaseOrRepeat[],
  visit: (phase: WorkflowPhase, location: PhaseLocation) => void,
): void {
  for (const [topIndex, entry] of phases.entries()) {
    if (isRepeat(entry)) {
      for (const [index, phase] of entry.phases.entries()) {
        visit(phase, { index, repeat: { entry, index: topIndex }, topIndex, label: phaseLabel(phase.phase) });
      }
    } else {
      visit(entry, { index: topIndex, topIndex, label: phaseLabel(entry.phase) });
    }
  }
}

/** The node id of the top-level element at `index`. */
export function topNodeId(workflowId: string, index: number): string {
  return `${workflowId}:node:${index + 1}`;
}

/** The id prefix of round `round` of a repeat node: the nodes of the round
 *  extend it, so a later round's nodes are round 1's ids with this prefix
 *  replaced. Control parses only this segment and `:attempt:`. */
function roundPrefix(repeatNodeId: string, round: number): string {
  return `${repeatNodeId}:round:${round}`;
}

/** The node id of the body phase at `index` in round 1 of a repeat. */
export function repeatBodyNodeId(repeatNodeId: string, index: number): string {
  return `${roundPrefix(repeatNodeId, 1)}:node:${index + 1}`;
}

/** The node id of a named agent of a phase node. */
export function namedAgentNodeId(phaseNode: string, index: number): string {
  return `${phaseNode}:node:${index + 1}`;
}

/** The node id that one phase compiles to: its own place in the top-level
 *  list, or its place in round 1 of its repeat. */
export function phaseNodeId(workflowId: string, location: Pick<PhaseLocation, "index" | "repeat" | "topIndex">): string {
  const top = topNodeId(workflowId, location.topIndex);
  return location.repeat === undefined ? top : repeatBodyNodeId(top, location.index);
}

/** What one phase holds: one agent, named agents, or one agent for each item
 *  of a list. A stream phase (`over: <phase>`) is a list phase whose items
 *  are the agents of the list phase before it. */
export type PhaseKind = "single" | "named" | "list";

export function phaseKind(phase: WorkflowPhase): PhaseKind {
  if (phase.agents !== undefined) return "named";
  return phase.over === undefined ? "single" : "list";
}

/** Whether `over` names a phase, which makes the phase a stream phase, and
 *  not a list field. */
export function isStreamOver(over: string): boolean {
  return !over.includes(".");
}

/** One agent record of a workflow file (docs/terminology.md "agent record"): a phase of
 *  one agent, a list phase, or a named agent. Its key is the phase id or the
 *  named agent's id. `keys` are its own record keys, a named agent's on top
 *  of its phase's defaults. `briefName` is the name its brief resolves by. */
export interface AgentRecordRef {
  readonly definitionId: string;
  readonly kind: PhaseKind;
  readonly phase: WorkflowPhase;
  readonly location: PhaseLocation;
  readonly keys: AgentRecordKeys;
  readonly briefName: string;
  /** The name the brief would resolve by without any `runs`. */
  readonly defaultBriefName: string;
}

/** The keys that a phase with `agents` gives each named agent as a default:
 *  every record key but the phase's display `name`. */
const NAMED_AGENT_DEFAULT_KEYS = ["runs", "brief", "output", "dependencies", "subagents", "persona", "model", "effort", "retry", "reads", "writes"] as const satisfies readonly (keyof AgentRecordKeys)[];

function isRecordKey(key: string): key is keyof AgentRecordKeys {
  return Object.hasOwn(AgentRecordFields, key);
}

/** The record keys of a phase or a named agent, without its other keys. */
function ownRecordKeys(source: AgentRecordKeys): AgentRecordKeys {
  const keys: { -readonly [K in keyof AgentRecordKeys]?: AgentRecordKeys[K] } = {};
  for (const [key, value] of Object.entries(source)) {
    if (isRecordKey(key) && value !== undefined) Object.assign(keys, { [key]: value });
  }
  return keys;
}

/** The named agents of a phase in their long form. */
export function namedAgents(phase: WorkflowPhase): readonly NamedAgent[] {
  return (phase.agents ?? []).map((agent) => typeof agent === "string" ? { agent } : agent);
}

interface NamedBriefName {
  readonly name: string;
  /** The name that the brief would resolve by without the agent's `runs`. */
  readonly fallback: string;
}

/** The brief name of one named agent: its own inline brief, else its own
 *  `runs`, else the phase's inline brief, which the phase id names, else the
 *  phase's `runs`, else its own id. */
function namedBriefName(phase: WorkflowPhase, agent: NamedAgent): NamedBriefName {
  if (agent.brief !== undefined) return { name: agent.agent, fallback: agent.agent };
  const fallback = phase.brief !== undefined ? phase.phase : phase.runs ?? agent.agent;
  return { name: agent.runs ?? fallback, fallback: phase.brief !== undefined || phase.runs !== undefined ? fallback : agent.agent };
}

const recordCache = new WeakMap<readonly PhaseOrRepeat[], ReadonlyMap<string, AgentRecordRef>>();

/** Every agent record of a workflow, keyed by its id, in run order. A name
 *  that more than one declaration takes keeps the first; validation refuses
 *  the file. */
export function agentRecords(workflow: Pick<WorkflowDefinition, "phases">): ReadonlyMap<string, AgentRecordRef> {
  const cached = recordCache.get(workflow.phases);
  if (cached) return cached;
  const records = new Map<string, AgentRecordRef>();
  walkPhases(workflow.phases, (phase, location) => {
    const kind = phaseKind(phase);
    if (kind !== "named") {
      if (!records.has(phase.phase)) {
        records.set(phase.phase, {
          definitionId: phase.phase,
          kind,
          phase,
          location,
          keys: ownRecordKeys(phase),
          briefName: phase.brief !== undefined ? phase.phase : phase.runs ?? phase.phase,
          defaultBriefName: phase.phase,
        });
      }
      return;
    }
    const defaults: Partial<AgentRecordKeys> = {};
    for (const key of NAMED_AGENT_DEFAULT_KEYS) {
      if (phase[key] !== undefined) Object.assign(defaults, { [key]: phase[key] });
    }
    for (const agent of namedAgents(phase)) {
      if (records.has(agent.agent)) continue;
      const { name, fallback } = namedBriefName(phase, agent);
      const own = ownRecordKeys(agent);
      // A phase's inline brief belongs to the phase id, so a named agent that
      // runs it takes its contract through the brief, not as its own keys.
      // An agent that names its own brief takes none of the phase's brief
      // keys, nor the keys of the skill that the phase runs.
      const inherited = { ...defaults };
      if (own.brief !== undefined || own.runs !== undefined) {
        delete inherited.brief;
        delete inherited.output;
        delete inherited.dependencies;
        delete inherited.subagents;
      }
      records.set(agent.agent, {
        definitionId: agent.agent,
        kind: "named",
        phase,
        location,
        keys: { ...inherited, ...own },
        briefName: name,
        defaultBriefName: fallback,
      });
    }
  });
  recordCache.set(workflow.phases, records);
  return records;
}

/** The phase that one phase id names, with its location. */
export function phaseById(workflow: Pick<WorkflowDefinition, "phases">, id: string): { readonly phase: WorkflowPhase; readonly location: PhaseLocation } | undefined {
  let found: { readonly phase: WorkflowPhase; readonly location: PhaseLocation } | undefined;
  walkPhases(workflow.phases, (phase, location) => {
    if (found === undefined && phase.phase === id) found = { phase, location };
  });
  return found;
}

/** Every phase in run order, with its location. */
export function allPhases(workflow: Pick<WorkflowDefinition, "phases">): readonly { readonly phase: WorkflowPhase; readonly location: PhaseLocation }[] {
  const phases: { readonly phase: WorkflowPhase; readonly location: PhaseLocation }[] = [];
  walkPhases(workflow.phases, (phase, location) => phases.push({ phase, location }));
  return phases;
}

/** The stream that a list phase belongs to: the list phase that heads it,
 *  and each stream phase that follows, in order. A phase that no stream
 *  holds is its own stream of one. */
export function streamOf(workflow: Pick<WorkflowDefinition, "phases">, phaseId: string): readonly WorkflowPhase[] {
  const lists = streams(workflow);
  return lists.find((stream) => stream.some(({ phase }) => phase === phaseId)) ?? [];
}

/** Every stream of a workflow: a list phase over a list field and the stream
 *  phases that follow it, each `over` the phase before. */
export function streams(workflow: Pick<WorkflowDefinition, "phases">): readonly (readonly WorkflowPhase[])[] {
  const result: WorkflowPhase[][] = [];
  const lists: readonly (readonly PhaseOrRepeat[])[] = [workflow.phases, ...workflow.phases.flatMap((entry) => isRepeat(entry) ? [entry.phases] : [])];
  for (const list of lists) {
    let current: WorkflowPhase[] | undefined;
    for (const entry of list) {
      if (isRepeat(entry)) {
        current = undefined;
        continue;
      }
      if (entry.over !== undefined && isStreamOver(entry.over) && current !== undefined && current.at(-1)?.phase === entry.over) {
        current.push(entry);
        continue;
      }
      current = entry.over !== undefined && !isStreamOver(entry.over) && entry.agents === undefined ? [entry] : undefined;
      if (current) result.push(current);
    }
  }
  return result;
}

/** A source that `over`, `if`, `reads`, `repeat.while`, and `repeat.each`
 *  can name: a phase of one agent, whose output is its handoff; a named
 *  agent, likewise; a list phase that ends its stream, whose output is its
 *  join output; or a phase of named agents. `repeat` is the
 *  repeat that holds the source, so a reader outside it reads every round. */
export interface OutputSource {
  readonly id: string;
  readonly kind: "agent" | "join";
  /** The phase that holds the source. */
  readonly phase: WorkflowPhase;
  readonly location: PhaseLocation;
  /** The node id of the source in round 1 of its repeat, or in its only
   *  place. A list's join output is its list node, at the place of the
   *  stream's head. */
  readonly nodeId: string;
  /** The definition id of an agent source. */
  readonly definitionId?: string;
}

/** Every named output of a workflow, keyed by its id. */
export function outputSources(workflow: Pick<WorkflowDefinition, "id" | "phases">): ReadonlyMap<string, OutputSource> {
  const sources = new Map<string, OutputSource>();
  // A stream compiles to one list node at the place of its head, and its
  // last phase names the list's join output.
  const headOfLast = new Map(streams(workflow).flatMap((stream) => {
    const head = stream[0];
    const last = stream.at(-1);
    return head === undefined || last === undefined ? [] : [[last.phase, head.phase] as const];
  }));
  const locations = new Map<string, PhaseLocation>();
  walkPhases(workflow.phases, (phase, location) => locations.set(phase.phase, location));
  walkPhases(workflow.phases, (phase, location) => {
    const nodeId = phaseNodeId(workflow.id, location);
    const kind = phaseKind(phase);
    if (kind === "single") {
      sources.set(phase.phase, { id: phase.phase, kind: "agent", phase, location, nodeId, definitionId: phase.phase });
    } else if (kind === "list") {
      const head = headOfLast.get(phase.phase);
      const headLocation = head === undefined ? undefined : locations.get(head);
      if (headLocation !== undefined) sources.set(phase.phase, { id: phase.phase, kind: "join", phase, location, nodeId: phaseNodeId(workflow.id, headLocation) });
    } else {
      sources.set(phase.phase, { id: phase.phase, kind: "join", phase, location, nodeId });
      for (const [index, agent] of namedAgents(phase).entries()) {
        sources.set(agent.agent, { id: agent.agent, kind: "agent", phase, location, nodeId: namedAgentNodeId(nodeId, index), definitionId: agent.agent });
      }
    }
  });
  return sources;
}

/** One output that an agent reads: the authored id, which labels it in the
 *  agent's context, and the node that holds it. A record converted from the
 *  retired step grammar also carries where that retired grammar found the output, which
 *  a run paused before phases holds (refer to `retired-step-grammar/reads.ts`;
 *  remove `retired` after 2027-04-30). */
export interface AgentRead {
  readonly id: string;
  readonly kind: "agent" | "join";
  readonly nodeId: string;
  readonly definitionId?: string;
  readonly retired?: RetiredReadSource;
}

/** The reads of one agent record that each name exactly one output, in
 *  authored order. Validation refuses any other id, so a definition that
 *  runs resolves every id. `retired` holds, for each authored id, where the
 *  retired step grammar found it, for a record converted from that retired grammar. */
export function agentReads(
  workflow: Pick<WorkflowDefinition, "id" | "phases">,
  reads: readonly string[] | undefined,
  retired: readonly (RetiredReadSource | undefined)[] = [],
): readonly AgentRead[] {
  if (reads === undefined) return [];
  const sources = outputSources(workflow);
  return reads.flatMap((id, index) => {
    const source = sources.get(id);
    const before = retired[index];
    return source === undefined ? [] : [{
      id,
      kind: source.kind,
      nodeId: source.nodeId,
      ...(source.definitionId === undefined ? {} : { definitionId: source.definitionId }),
      ...(before === undefined ? {} : { retired: before }),
    }];
  });
}
