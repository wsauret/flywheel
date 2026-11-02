/** The step grammar of workflow files before the phase grammar: `steps`
 *  records joined by a `flow` of step, map, while, for, and phase entries.
 *  Frozen: nothing reads it to run a workflow. The converter
 *  (`convert.ts`) reads a saved file in this form, the definition records
 *  of runs launched before the phase grammar decode through it, and the
 *  identity proofs of a paused run rebuild the identity that such a run
 *  recorded from it. Remove after 2027-04-30. */
import { Effect, Schema } from "effect";
import { CanonicalToolScopingSchema, EffortSchema, ToolScopingSchema } from "../../infra/workflow-types.js";
import { isWorkflowLocalId } from "../../infra/workflow-identifiers.js";
import { ArtifactContractFrontmatterItemSchema, ArtifactContractsFrontmatterSchema } from "../artifact-contracts.js";
import type { DefinitionProvenance } from "../definition-provenance.js";
import type { RetiredBinding } from "../retired-bindings.js";
import { OutputRefSchema, SkillIdSchema, VotesSchema } from "../workflow-schema.js";

/** A loop reference is `<step>.<field>`, so local names cannot contain dots. */
const StepIdSchema = Schema.NonEmptyString.check(Schema.makeFilter((id) =>
  isWorkflowLocalId(id) || `step id must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, or underscores: ${JSON.stringify(id)}`));

const PackageRelativePathSchema = Schema.NonEmptyString.check(Schema.makeFilter((path) =>
  (!path.startsWith("/") && !path.includes("\\") && !path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  || `must be a normalized package-relative path: ${JSON.stringify(path)}`));

/** The content keys. Beside `instructions` they are the step's only source of
 *  content. Beside `file` each one replaces the md frontmatter value of the
 *  same key as a whole; keys are never merged. */
const StepContentKeys = {
  /** Display name. Required with `instructions` and `external`. */
  name: Schema.optionalKey(Schema.NonEmptyString),
  dependencies: Schema.optionalKey(Schema.Array(SkillIdSchema)),
  /** Persona names the step body may dispatch. */
  agents: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  output: Schema.optionalKey(OutputRefSchema),
} as const;

const ArtifactRedirectSchema = Schema.Struct({
  fromPath: PackageRelativePathSchema,
  toDir: PackageRelativePathSchema,
});

/** A step that runs a foreign skill package from `~/.agents/skills`. The
 *  package owns the procedure; the workflow owns the name and the contract. */
const ExternalStepSchema = Schema.Struct({
  skill: SkillIdSchema,
  arguments: Schema.optionalKey(Schema.Array(Schema.String)),
  artifactRedirect: Schema.optionalKey(ArtifactRedirectSchema),
  allowedChildSkills: Schema.Array(SkillIdSchema).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed([])),
  ),
}).check(Schema.makeFilter((external) => {
  const uniqueChildren = new Set(external.allowedChildSkills);
  if (uniqueChildren.size !== external.allowedChildSkills.length) return "allowedChildSkills must not contain duplicate ids";
  return !uniqueChildren.has(external.skill) || "allowedChildSkills must not contain the root skill id";
}));

/** The canonical external record: the same Type, with the default applied. */
const CanonicalExternalStepSchema = Schema.Struct({
  skill: SkillIdSchema,
  arguments: Schema.optionalKey(Schema.Array(Schema.String)),
  artifactRedirect: Schema.optionalKey(ArtifactRedirectSchema),
  allowedChildSkills: Schema.Array(SkillIdSchema),
});

/** Where a step's instructions come from. Exactly one is set. */
const StepSourceKeys = {
  /** A step md file: relative to the workflow file, or `bundled:<path>` in the
   *  core workflow folder. */
  file: Schema.optionalKey(Schema.NonEmptyString),
  /** Inline instruction text. It may be empty, as the body of a step file
   *  may be. */
  instructions: Schema.optionalKey(Schema.String),
} as const;

/** The outputs that one step reads: the local id of each step entry, whose
 *  output is its handoff, and of each map entry, whose output is its join
 *  output. Each named entry must complete before every position of the
 *  step starts. Only this step receives the named outputs, each once and
 *  labeled with its id; no other step and no lane does. */
const StepReadsSchema = Schema.Array(StepIdSchema).check(Schema.makeFilter((ids) => {
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  return repeated === undefined || `reads names ${JSON.stringify(repeated)} more than once`;
}));

/** The retired prompt profile of a step. Every step now gets the same tools
 *  and system prompt (ARCH-CONTEXT-018), and the loader drops `kind` and
 *  `toolScoping` from a workflow file, so no current definition holds them.
 *  The keys stay here only so that the definition facts of builds before
 *  2026-10-13 decode. Remove them after 2027-04-13. */
const StepKindSchema = Schema.Literal("check");

/** The policy keys: what only a workflow can mean at this position. An absent
 *  `writes` resolves to one transient artifact named after the step id, so a
 *  step that declares no output still hands its summary to the next step. An
 *  absent or empty `reads` reads nothing beyond the default context. The record
 *  keeps the authored value, which is what policy identity hashes. */
const StepPolicyKeys = {
  writes: Schema.optionalKey(ArtifactContractsFrontmatterSchema),
  reads: Schema.optionalKey(StepReadsSchema),
  toolScoping: Schema.optionalKey(ToolScopingSchema),
  kind: Schema.optionalKey(StepKindSchema),
} as const;

/** The model choice of the author of a workflow file for one step. Only a
 *  file of the `session` layer, which a chat launches by path, can set them;
 *  load refuses them in a registered workflow (refer to
 *  `validateStepModelKeys`). Each key is optional and stands alone, and a
 *  key that is set always wins: a step without `model` runs on the model of
 *  its step default, and a step without `effort` on that default's effort.
 *  `model` is a model id or a tier name (`cheap`, `mid`, `powerful`), as a
 *  role assignment takes it. The launch resolves both keys against what the
 *  account can serve and binds the result in the run's role snapshot, so
 *  the keys are not step policy identity: a paused run keeps the pair that
 *  its launch bound. */
const StepModelKeys = {
  model: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(EffortSchema),
} as const;

/** The step record keys that the joining rules read. */
interface StepRecordKeys {
  readonly file?: string;
  readonly instructions?: string;
  readonly external?: unknown;
  readonly name?: string;
  readonly dependencies?: readonly string[];
  readonly agents?: readonly string[];
}

/** The rules that join the step record keys. The output rules need the
 *  flow, because a step in a `reassess` slot takes the VM's contract, so the
 *  content loader enforces them (step-content.ts). */
function stepRecordIssue(step: StepRecordKeys): string | undefined {
  const sources = [step.file, step.instructions, step.external].filter((source) => source !== undefined).length;
  if (sources !== 1) return "a step needs exactly one of file, instructions, or external";
  if (step.instructions !== undefined && step.name === undefined) return "a step with instructions needs a name";
  if (step.external !== undefined) {
    if (step.name === undefined) return "an external step needs a name";
    if (step.dependencies !== undefined || step.agents !== undefined) return "an external step takes its dependencies and agents from its package";
  }
  return undefined;
}

/** One workflow step: where its content comes from, the content keys the
 *  workflow sets, and the execution policy the workflow imposes. */
const WorkflowStepSchema = Schema.Struct({
  ...StepSourceKeys,
  external: Schema.optionalKey(ExternalStepSchema),
  ...StepContentKeys,
  ...StepPolicyKeys,
  ...StepModelKeys,
}).check(Schema.makeFilter((step) => stepRecordIssue(step) ?? true));

export type WorkflowStep = typeof WorkflowStepSchema.Type;

/** Internal round-trip shape of a step record: identical Type, but toolScoping
 *  carries every field because the decode-time ergonomic defaults of
 *  ToolScopingSchema belong to the authoring boundary only. */
export const CanonicalWorkflowStepSchema = Schema.Struct({
  ...StepSourceKeys,
  external: Schema.optionalKey(CanonicalExternalStepSchema),
  ...StepContentKeys,
  writes: StepPolicyKeys.writes,
  reads: StepPolicyKeys.reads,
  toolScoping: Schema.optionalKey(CanonicalToolScopingSchema),
  kind: StepPolicyKeys.kind,
  ...StepModelKeys,
});

interface WorkflowThenRef {
  readonly step: string;
  readonly when?: string;
  readonly then?: WorkflowThenRef;
}

const WorkflowThenRefSchema: Schema.Codec<WorkflowThenRef> = Schema.suspend((): Schema.Codec<WorkflowThenRef> =>
  Schema.Struct({
    step: StepIdSchema,
    when: Schema.optionalKey(Schema.String),
    then: Schema.optionalKey(WorkflowThenRefSchema),
  })
);

/** The keys every executable flow entry can take. `id` names the entry in its
 *  own flow list; a step entry without one takes its step id. `after` names the
 *  sibling entries the entry runs after: absent, it runs after the entry before
 *  it; `[]`, it waits only for its container. Both keys enter the canonical
 *  flow, and so the graph identity, only when an author writes them. */
const FlowEntryOrderKeys = {
  id: Schema.optionalKey(StepIdSchema),
  after: Schema.optionalKey(Schema.Array(StepIdSchema)),
} as const;

// A graph position. `step` names the step record that runs here.
const WorkflowStepRefSchema = Schema.Struct({
  step: StepIdSchema,
  ...FlowEntryOrderKeys,
  then: Schema.optionalKey(WorkflowThenRefSchema),
  retry: Schema.optionalKey(Schema.Struct({
    maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    detectStuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  })),
});

// What a loop node's `do` names: one step id, or a chain of step ids that run
// in order. A chain names each step once.
const WorkflowLoopDoSchema = Schema.Union([
  StepIdSchema,
  Schema.NonEmptyArray(StepIdSchema).check(Schema.makeFilter((chain) => {
    const repeated = chain.find((stepId, index) => chain.indexOf(stepId) !== index);
    return repeated === undefined || `a do chain names each step once, but names ${JSON.stringify(repeated)} more than once`;
  })),
]);

/** The join of a `map` entry: the registered reducer that folds the branch
 *  outcomes, its parameters, and the one artifact the join writes. `reducer`
 *  names a registered reducer id, such as `collect`; compile pins its latest
 *  version. The reducer's own parameter schema decodes `with`. `write` has
 *  the shape of one item of a step's `writes`; without it the join writes one
 *  transient artifact named after the map id. */
const MapJoinSchema = Schema.Struct({
  reducer: Schema.NonEmptyString,
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  write: Schema.optionalKey(ArtifactContractFrontmatterItemSchema),
});

/** A `map` entry: a fan-out over a frozen list. `map: <id>.<field>` names the
 *  source list: `<id>` is a step entry or another map entry that runs before
 *  this one on every path, or the reserved id `input`, and `<field>` is a
 *  `list` field of that step's output contract, of that map's reducer output
 *  contract, or of the workflow's `input` contract. The list must declare
 *  `max`, which is the branch width, and `unique: <key>`, which is the branch
 *  identity. Compile emits one group node. When a step or map source
 *  completes, the VM adds one branch node per item. The launch input is known
 *  at launch, so the launch adds the branches of a map over it at once. Each
 *  branch runs the `do` chain as its own stages. A stage handoff failure
 *  after its `retry` fails only that branch. The `join` folds every branch disposition once all are
 *  terminal, and the group then completes. `label` names an item field that
 *  gives each branch its display name; without it the key is the name.
 *  `votes: N` runs N lanes for each item instead of one, each with its vote
 *  number, and its join must count the votes (refer to `countsVotes`). */
const WorkflowMapEntrySchema = Schema.Struct({
  map: Schema.NonEmptyString,
  id: StepIdSchema,
  name: Schema.optionalKey(Schema.NonEmptyString),
  label: Schema.optionalKey(Schema.NonEmptyString),
  votes: Schema.optionalKey(VotesSchema),
  do: WorkflowLoopDoSchema,
  retry: WorkflowStepRefSchema.fields.retry,
  join: MapJoinSchema,
  after: FlowEntryOrderKeys.after,
});

export type WorkflowMapEntry = typeof WorkflowMapEntrySchema.Type;

/** Whether a `while` entry's `do` holds one map instead of step ids. */
function isMapBody(body: string | readonly string[] | WorkflowMapEntry): body is WorkflowMapEntry {
  // An array has a `map` method, so the key test alone would accept a chain.
  return typeof body === "object" && !Array.isArray(body) && "map" in body;
}

/** A `do` chain states the whole body, so a separate follow-up slot would give
 *  the body two authored orders. */
function loopDoIssue(node: { readonly do: string | readonly string[] | WorkflowMapEntry; readonly then?: string; readonly reassess?: string }): string | undefined {
  if (typeof node.do === "string" || isMapBody(node.do)) return undefined;
  if (node.then !== undefined) return "a do chain names every body step, so the node takes no then";
  if (node.reassess !== undefined) return "a do chain names every body step, so the node takes no reassess";
  return undefined;
}

/** A loop over a map runs the map once in each round and stops on the round
 *  that keeps nothing new, so a key that serves a loop over steps has no
 *  meaning on it. Each refusal names what to do instead. */
function whileMapIssue(node: { readonly do: string | readonly string[] | WorkflowMapEntry; readonly then?: string; readonly detectStuck: boolean; readonly id?: string }): string | undefined {
  if (!isMapBody(node.do)) return undefined;
  if (node.then !== undefined) return "a loop over a map runs only its map, so it takes no then; put the step after the loop in the flow";
  if (node.detectStuck) return "a loop over a map stops on the first round that keeps nothing new, so it takes no detectStuck";
  if (node.id !== undefined) return "a loop over a map takes its id from its map, so remove id from the while entry";
  if (node.do.after !== undefined) return "the map of a loop runs once in each round, so it takes no after; put after on the while entry";
  return undefined;
}

// A `while` loop node: repeat the body while the evaluator's gating field is
// non-empty. The leading `while` key is `<step>.<field>`: the evaluator, a
// body step, plus its gating field. `do` names the body: one step with an
// optional `then` step, or a chain. `maxIterations` is the REQUIRED cap
// (1..10, like retry) on evaluator runs. A final evaluation with a live signal
// still runs the body steps that trail the evaluator before the loop stops,
// so the last evaluation is never wasted. `do` can instead hold one map, and
// then `while` is `<map id>.<field>`: a list field of the map's join output.
// Each round runs the map again over the same items, and the loop continues
// while a round keeps at least one item in that field, up to
// `maxIterations` rounds.
const WorkflowWhileNodeSchema = Schema.Struct({
  while: Schema.NonEmptyString,
  do: Schema.Union([WorkflowLoopDoSchema, WorkflowMapEntrySchema]),
  then: Schema.optionalKey(StepIdSchema),
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  detectStuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  ...FlowEntryOrderKeys,
}).check(Schema.makeFilter((node) => loopDoIssue(node) ?? whileMapIssue(node) ?? true));

// A `for` loop node: iterate the body over an UPSTREAM step's array. The
// leading `for` key is `<step>.<field>` (the producing step plus its list
// field). `do` names the per-item body: one step, or a chain. After a single
// `do` step one optional follow-up runs: `then` names an ordinary step, and
// `reassess` names the step that reassesses the remaining items. A step in a
// `reassess` slot declares no output: the VM owns its contract
// (vm/reassessment-contract.ts), and its proposal can drop, replace, or
// insert items. No `maxIterations`: a for-loop is bounded by the array
// length, with the per-session insert guardrail as the backstop when
// reassessment grows the array.
const WorkflowForNodeSchema = Schema.Struct({
  for: Schema.NonEmptyString,
  do: WorkflowLoopDoSchema,
  then: Schema.optionalKey(StepIdSchema),
  reassess: Schema.optionalKey(StepIdSchema),
  ...FlowEntryOrderKeys,
}).check(Schema.makeFilter((node) =>
  loopDoIssue(node)
  ?? (node.then === undefined || node.reassess === undefined || "a for node takes then or reassess, not both")));

// A loop node is a `while` node XOR a `for` node. Both share the qualified
// `<step>.<field>` reference parser; they differ in the evaluator's topology
// (a `while` ref points at a body step, a `for` ref at an upstream one).
const WorkflowLoopNodeSchema = Schema.Union([WorkflowWhileNodeSchema, WorkflowForNodeSchema]);

export type WorkflowStepRef = typeof WorkflowStepRefSchema.Type;
export type WorkflowWhileNode = typeof WorkflowWhileNodeSchema.Type;
export type WorkflowLoopNode = typeof WorkflowLoopNodeSchema.Type;

/** The declared structural limits of one phase. Each key is optional: the
 *  compiler derives the usage of every phase, and admission enforces a
 *  limit only when the author declares it. `depth` counts the nested
 *  containers on the deepest path from the phase to a leaf, the phase
 *  included. `nodes` counts the logical nodes below the phase. */
const PhaseLimitsSchema = Schema.Struct({
  nodes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  depth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
}).check(Schema.makeFilter((limits) =>
  limits.nodes !== undefined || limits.depth !== undefined || "limits names nodes, depth, or both"));

/** A phase: a deterministic container with no model attempt. Its value is its
 *  id in the enclosing flow, and its `flow` holds the work it owns. `name` is
 *  a display name only, so it does not enter the definition identity. The
 *  phase starts when its own `after` entries complete, and it completes when
 *  every entry of its flow completes. */
interface WorkflowPhaseEntry {
  readonly phase: string;
  readonly name?: string;
  readonly limits?: typeof PhaseLimitsSchema.Type;
  readonly flow: readonly [WorkflowFlowEntry, ...WorkflowFlowEntry[]];
  readonly after?: readonly string[];
}

interface WorkflowPhaseEntryEncoded {
  readonly phase: string;
  readonly name?: string;
  readonly limits?: typeof PhaseLimitsSchema.Encoded;
  readonly flow: readonly [WorkflowFlowEntryEncoded, ...WorkflowFlowEntryEncoded[]];
  readonly after?: readonly string[];
}

/** One entry of a `flow` list. Each kind has one discriminating key:
 *  `step`, `while`, `for`, `phase`, or `map`. */
export type WorkflowFlowEntry = WorkflowStepRef | WorkflowLoopNode | WorkflowPhaseEntry | WorkflowMapEntry;
type WorkflowFlowEntryEncoded =
  | typeof WorkflowStepRefSchema.Encoded
  | typeof WorkflowLoopNodeSchema.Encoded
  | WorkflowPhaseEntryEncoded
  | typeof WorkflowMapEntrySchema.Encoded;

const WorkflowPhaseEntrySchema: Schema.Codec<WorkflowPhaseEntry, WorkflowPhaseEntryEncoded> = Schema.suspend(
  (): Schema.Codec<WorkflowPhaseEntry, WorkflowPhaseEntryEncoded> => Schema.Struct({
    phase: StepIdSchema,
    name: Schema.optionalKey(Schema.NonEmptyString),
    limits: Schema.optionalKey(PhaseLimitsSchema),
    flow: Schema.NonEmptyArray(WorkflowFlowEntrySchema),
    after: FlowEntryOrderKeys.after,
  }),
);

const WorkflowFlowEntrySchema: Schema.Codec<WorkflowFlowEntry, WorkflowFlowEntryEncoded> = Schema.Union([
  WorkflowStepRefSchema,
  WorkflowLoopNodeSchema,
  WorkflowPhaseEntrySchema,
  WorkflowMapEntrySchema,
]);

export function isWhileNode(node: WorkflowLoopNode): node is WorkflowWhileNode {
  return "while" in node;
}

/** The map in the body of a `while` entry, or undefined for any other
 *  entry. */
export function whileMap(entry: WorkflowFlowEntry): WorkflowMapEntry | undefined {
  return "while" in entry && isMapBody(entry.do) ? entry.do : undefined;
}

/** The id that names an entry in its own flow list: a phase's value, an
 *  authored `id`, or a step entry's step id. A loop over a map takes the id
 *  of its map. Any other loop entry without an `id` has none, so no `after`
 *  can name it. A map entry always has one. */
export function flowEntryLocalId(entry: WorkflowFlowEntry): string | undefined {
  if ("phase" in entry) return entry.phase;
  if ("step" in entry) return entry.id ?? entry.step;
  return whileMap(entry)?.id ?? entry.id;
}

/** The stage steps of a map entry, in run order: its `do` step or chain. */
export function mapStages(entry: WorkflowMapEntry): readonly [string, ...string[]] {
  return typeof entry.do === "string" ? [entry.do] : entry.do;
}

/** Where one entry sits in the authored tree. */
interface FlowLocation {
  /** The phase ids from the top-level flow down to the flow that holds the entry. */
  readonly phases: readonly string[];
  /** The entry's index in its own flow list. */
  readonly index: number;
  /** The index of each entry from the top-level flow down to this entry,
   *  this entry's own index last. */
  readonly path: readonly number[];
  /** The flow list that holds the entry. */
  readonly siblings: readonly WorkflowFlowEntry[];
  /** The entry as a message names it: `Step 2` in the top-level flow, and
   *  `Phase "build/review" step 2` in a nested flow. */
  readonly label: string;
}

/** The label of a flow list, for a message about the list itself. */
export function flowListLabel(phases: readonly string[]): string {
  return phases.length === 0 ? "the top-level flow" : `phase "${phases.join("/")}"`;
}

/** The label of one entry, as {@link FlowLocation.label} states it. */
export function flowEntryLabel(phases: readonly string[], index: number): string {
  return phases.length === 0 ? `Step ${index}` : `Phase "${phases.join("/")}" step ${index}`;
}

/** Visit every entry of an authored flow tree in preorder: an entry, then
 *  the entries of its phase flow. Validation, step resolution, step content,
 *  identity, and compilation all walk the tree here, so each one reads the
 *  same entries in the same order. */
export function walkFlow(
  flow: readonly WorkflowFlowEntry[],
  visit: (entry: WorkflowFlowEntry, location: FlowLocation) => void,
): void {
  const walk = (siblings: readonly WorkflowFlowEntry[], phases: readonly string[], above: readonly number[]): void => {
    for (const [index, entry] of siblings.entries()) {
      const path = [...above, index];
      visit(entry, { phases, index, path, siblings, label: flowEntryLabel(phases, index) });
      if ("phase" in entry) walk(entry.flow, [...phases, entry.phase], path);
    }
  };
  walk(flow, [], []);
}

/** One flow list of an authored tree and the phase path that holds it. */
interface FlowList {
  readonly entries: readonly WorkflowFlowEntry[];
  readonly phases: readonly string[];
}

/** Every flow list of an authored tree in preorder: the top-level flow first. */
export function flowLists(flow: readonly WorkflowFlowEntry[]): readonly FlowList[] {
  const lists: FlowList[] = [{ entries: flow, phases: [] }];
  walkFlow(flow, (entry, { phases }) => {
    if ("phase" in entry) lists.push({ entries: entry.flow, phases: [...phases, entry.phase] });
  });
  return lists;
}

/** One step of a loop body. `slot` names the key that the author wrote the
 *  step under: a message points at it, and the step in a `reassess` slot
 *  reassesses a `for` node's remaining items. */
export interface LoopBodyStep {
  readonly step: string;
  readonly slot: "do" | "then" | "reassess";
}

/** The body of a loop node, in run order. This is the one normalization of
 *  both authored forms: a `do` chain is the body, and a single `do` step is
 *  followed by its `then` or `reassess` step when the node names one. Every
 *  reader of a loop body reads it here, so both forms mean the same body and
 *  compile to the same control. The body of a loop over a map is the map's
 *  stage chain, which each branch of each round runs. */
export function loopBody(node: WorkflowLoopNode): readonly [LoopBodyStep, ...LoopBodyStep[]] {
  if (isMapBody(node.do)) {
    const [first, ...rest] = mapStages(node.do);
    return [{ step: first, slot: "do" }, ...rest.map((step) => ({ step, slot: "do" as const }))];
  }
  if (typeof node.do !== "string") {
    const [first, ...rest] = node.do;
    return [{ step: first, slot: "do" }, ...rest.map((step) => ({ step, slot: "do" as const }))];
  }
  const head: LoopBodyStep = { step: node.do, slot: "do" };
  if (!isWhileNode(node) && node.reassess !== undefined) return [head, { step: node.reassess, slot: "reassess" }];
  return node.then === undefined ? [head] : [head, { step: node.then, slot: "then" }];
}

// Per-workflow overrides of the queue-mutation guardrails the launch path
// compiles into the committed workflow control. Declaration data, not code: a
// long-horizon workflow raises its caps here instead of the launch path
// special-casing workflow ids. Absent keys keep the launch path's defaults.
// Bounds are deliberate ceilings on what any declaration may request.
/** The ceiling of a queue length in the step grammar. */
const RETIRED_QUEUE_LENGTH_CEILING = 4096;

const WorkflowGuardrailsSchema = Schema.Struct({
  max_queue_length: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: RETIRED_QUEUE_LENGTH_CEILING }))),
  // How many step attempts may run at one time. Absent, every ready attempt
  // that waits on no other runs at once; a map's declared `max` and the
  // queue length already bound the width and the total.
  max_parallel: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: RETIRED_QUEUE_LENGTH_CEILING }))),
  max_mutations_per_attempt: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  max_session_inserts: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
});

const WORKFLOW_CONFIRMATION_TEMPLATES = ["spec-and-implement", "debug", "qa"] as const;

export const StepGrammarWorkflowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  use_when: Schema.optionalKey(Schema.String),
  confirmation_template: Schema.Literals(WORKFLOW_CONFIRMATION_TEMPLATES).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed("spec-and-implement" as const)),
  ),
  // When false, the slash dispatcher launches without prompting the user for a per-invocation
  // description. Defaults to true.
  requires_description: Schema.optionalKey(Schema.Boolean),
  // When false, the workflow is hidden from user-facing rosters (slash
  // catalog and workflow picker). Mirrors the skill frontmatter key of the
  // same name. Defaults to true.
  "user-invocable": Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true))),
  // When true, the workflow is hidden from the model-invocable roster (the
  // workflow tool); it stays launchable by slash command and palette. Mirrors
  // the skill frontmatter key of the same name.
  "disable-model-invocation": Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  guardrails: Schema.optionalKey(WorkflowGuardrailsSchema),
  /** The structured launch input that the workflow takes beside its text
   *  request: a path to a shared `.json` contract file, or the contract
   *  object itself. It uses the step output field grammar and declares only
   *  `fields` (output-contract/grammar.ts). A launch passes `input` data, and the
   *  data must decode strictly against this contract before the workflow
   *  starts. A workflow without this key takes no input. Every step receives
   *  the decoded input as part of the request, and `map: input.<field>` fans
   *  out over one of its list fields. Only an agent launch passes input, so
   *  a workflow whose contract requires a field is not offered to a person,
   *  and it must not set `disable-model-invocation`. */
  input: Schema.optionalKey(OutputRefSchema),
  /** Every step this workflow's flow may reference, keyed by step id. */
  steps: Schema.Record(StepIdSchema, WorkflowStepSchema),
  /** The graph: which steps run, in what order, under which control. A
   *  `phase` entry nests a flow of its own. */
  flow: Schema.NonEmptyArray(WorkflowFlowEntrySchema),
});

/** One decoded step-grammar definition. `provenance` names where the file
 *  came from, and `retiredBindings` keeps the bindings that a saved file in
 *  the older bindings form stated before the loader converted it to steps,
 *  keyed by step id. */
export type StepGrammarWorkflow = typeof StepGrammarWorkflowSchema.Type & {
  readonly provenance?: DefinitionProvenance;
  readonly retiredBindings?: ReadonlyMap<string, RetiredBinding>;
};
