import { Effect, Result, Schema } from "effect";
import { isQualifiedSkillId } from "../infra/skill-id.js";
import { isBriefId } from "../infra/workflow-identifiers.js";
import { definitionAssets, describeAsset, isBundledAssetRef, resolveAssetRef, type AssetLocation, type DefinitionAssetReader } from "./definition-assets.js";
import { resolveSkillBody } from "./skill-references.js";
import { FORMER_STEP_SKILLS } from "./retired-bindings.js";
import { parseFieldRef } from "./field-ref.js";
import { compileInput, compileOutput, type CompiledInput, type CompiledOutput } from "./output-contract/compile.js";
import { decodeInputObject, decodeOutputObject, type Field, type OutputObject } from "./output-contract/grammar.js";
import { compileReassessmentOutput, compileRetiredReassessmentOutput, type ReassessmentPayload, type RetiredReassessmentPayload } from "./vm/reassessment-contract.js";
import { latestReducer } from "./reducers/registry.js";
import {
  agentRecords,
  DEFAULT_COUNTED_LIST_MAX,
  isRepeat,
  isStreamOver,
  isWhileRepeat,
  namedAgents,
  OutputRefSchema,
  outputSources,
  SkillIdSchema,
  streams,
  WORKFLOW_INPUT_SOURCE_ID,
  type AgentRecordKeys,
  type AgentRecordRef,
  type WorkflowDefinition,
} from "./workflow-schema.js";

/** The inline procedure of one agent record. */
const BriefSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.NonEmptyString),
  dependencies: Schema.Array(SkillIdSchema).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  subagents: Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  output: Schema.optionalKey(OutputRefSchema),
  body: Schema.String,
});

/** The effective procedure of a brief. `body` has every `{{ref:...}}`
 *  expanded, which is the text the agent reads. `subagents` names the
 *  personas the agent may dispatch. */
interface BriefProcedure {
  readonly name: string;
  readonly description?: string;
  readonly dependencies: readonly string[];
  readonly subagents: readonly string[];
  readonly body: string;
}

/** A brief's compiled output, and whether the VM owns it. The brief of a
 *  repeat's `reassess` phase declares no output; its contract is the VM's
 *  reassessment contract, typed so the VM reads its proposal without a cast.
 *  `retiredOutput` is the frozen contract that the reassess attempt of a
 *  `for` node of control from before phases runs with (remove after
 *  2027-04-30). */
export type BriefOutputRole =
  | { readonly reassesses: false; readonly output: CompiledOutput }
  | {
    readonly reassesses: true;
    readonly output: CompiledOutput<ReassessmentPayload>;
    readonly retiredOutput: CompiledOutput<RetiredReassessmentPayload>;
  };

/** A brief's output role, with the counted lists of its output that took
 *  {@link DEFAULT_COUNTED_LIST_MAX} at load because they declare no `max`.
 *  Only a workflow file that a chat launched by path has any. */
type LoadedOutput = BriefOutputRole & { readonly defaultedLists: readonly string[] };

/** One agent record's inline brief and compiled output. */
export type LoadedBrief = LoadedOutput & { readonly briefId: string; readonly procedure: BriefProcedure };

/** The loaded brief of every agent record of one workflow, keyed by
 *  definition id. */
export type LoadedBriefs = ReadonlyMap<string, LoadedBrief>;

const decodeBrief = Schema.decodeUnknownSync(BriefSchema, { onExcessProperty: "error", errors: "all" });

/** Where a workflow reads its files from: the workflow file's own location,
 *  or none for a definition that was never loaded from a file. */
type Origin = AssetLocation | undefined;

/** The workflow and the reader of its contract files. */
interface LoadContext {
  readonly workflow: WorkflowDefinition;
  readonly reader: DefinitionAssetReader;
}

/** The output with {@link DEFAULT_COUNTED_LIST_MAX} as the `max` of each
 *  list of `counted` that declares none, and the name of each such list. */
function withCountedListDefaults(output: OutputObject, counted: ReadonlySet<string>) {
  const fields = { ...output.fields };
  const defaulted: string[] = [];
  for (const name of counted) {
    const field = fields[name];
    if (field?.type !== "list" || field.max !== undefined) continue;
    fields[name] = { ...field, max: DEFAULT_COUNTED_LIST_MAX };
    defaulted.push(name);
  }
  return { output: defaulted.length === 0 ? output : { ...output, fields }, defaulted };
}

function at(origin: Origin, workflow: WorkflowDefinition): string {
  return origin ? describeAsset(origin) : `workflow "${workflow.id}"`;
}

/** Resolve one authored path. A `bundled:` path names Flywheel's own file
 *  from any origin, so a definition rebuilt from its record, which has no
 *  file, still reads its bundled files from the running build. */
function resolveRef(origin: Origin, ref: string, workflow: WorkflowDefinition): AssetLocation {
  if (!origin && !isBundledAssetRef(ref)) throw new Error(`${at(origin, workflow)} has no file location, so it cannot read ${JSON.stringify(ref)}`);
  return resolveAssetRef(origin, ref);
}

/** The contract kinds that one authored reference can name, with the
 *  decoder of each. An agent output and a workflow input share one
 *  grammar; an input declares only fields. */
const contractDecoders = {
  output: decodeOutputObject,
  input: decodeInputObject,
} as const;

/** Read and decode one contract reference. A path names a shared `.json`
 *  contract file, resolved relative to the file that holds the key. */
function loadContract(
  ref: typeof OutputRefSchema.Type | undefined,
  origin: Origin,
  { workflow, reader }: Pick<LoadContext, "workflow" | "reader">,
  kind: keyof typeof contractDecoders = "output",
): OutputObject {
  if (ref === undefined) return {};
  let source: unknown = ref;
  let where = at(origin, workflow);
  if (typeof ref === "string") {
    const location = resolveRef(origin, ref, workflow);
    where = describeAsset(location);
    if (!location.path.endsWith(".json")) throw new Error(`${where}: an ${kind} contract file must be a .json file`);
    try {
      source = JSON.parse(reader.read(location));
    } catch (error) {
      throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const decoded = contractDecoders[kind](source);
  if (Result.isFailure(decoded)) throw new Error(`${where}: invalid ${kind} contract:\n${decoded.failure.join("\n")}`);
  return decoded.success;
}

function expandReferences(body: string, where: string): string {
  try {
    return resolveSkillBody({ body });
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** The body of a converted saved file. The last build of the retired step
 *  grammar loaded a bound skill whose `{{ref:...}}` names a missing reference
 *  and failed only when the agent ran, so a missing reference keeps the body
 *  verbatim instead of refusing the file. Remove after 2027-04-30. */
function retiredBody(body: string): string {
  try {
    return resolveSkillBody({ body });
  } catch {
    return body;
  }
}

function briefId(id: string, where: string): string {
  if (!isBriefId(id)) throw new Error(`${where}: a brief id must contain dot-separated lowercase names with letters, digits, hyphens, or underscores: ${JSON.stringify(id)}`);
  return id;
}

/** The output role of one brief. The brief of a `reassess` phase gets the
 *  VM's reassessment contract for `reassessItem`, the item type of its
 *  repeat's `each` source, and must not declare an output of its own. Any
 *  other brief holds each list of `counted` that declares no `max` to the
 *  default. */
function outputRole(declared: typeof OutputRefSchema.Type | undefined, origin: Origin, context: LoadContext, reassessItem: Field | undefined, counted: ReadonlySet<string>): LoadedOutput {
  if (reassessItem === undefined) {
    const { output, defaulted } = withCountedListDefaults(loadContract(declared, origin, context), counted);
    return { reassesses: false, output: compileOutput(output), defaultedLists: defaulted };
  }
  if (declared !== undefined) throw new Error("the VM owns the output of a reassess phase; remove its output");
  return { reassesses: true, output: compileReassessmentOutput(reassessItem), retiredOutput: compileRetiredReassessmentOutput(reassessItem), defaultedLists: [] };
}

/** The inline briefs of a workflow, keyed by the name that runs them: each
 *  phase and each named agent that states `brief`. */
function inlineBriefs(workflow: WorkflowDefinition): ReadonlyMap<string, AgentRecordKeys & { readonly brief: string }> {
  const inline = new Map<string, AgentRecordKeys & { readonly brief: string }>();
  for (const entry of workflow.phases) {
    for (const phase of isRepeat(entry) ? entry.phases : [entry]) {
      if (phase.brief !== undefined && !inline.has(phase.phase)) inline.set(phase.phase, { ...phase, brief: phase.brief });
      for (const agent of namedAgents(phase)) {
        if (agent.brief !== undefined && !inline.has(agent.agent)) inline.set(agent.agent, { ...agent, brief: agent.brief });
      }
    }
  }
  return inline;
}

/** Load an inline brief, including reuse through an in-file `runs` name. */
function loadBrief(
  record: AgentRecordRef,
  origin: Origin,
  context: LoadContext,
  inline: ReturnType<typeof inlineBriefs>,
  reassessItem: Field | undefined,
  counted: ReadonlySet<string>,
): LoadedBrief {
  const { workflow } = context;
  const name = record.briefName;
  const retired = workflow.retiredStepGrammar;
  if (name.startsWith("skill:")) {
    const skill = name.slice("skill:".length);
    throw new Error(`runs "${name}"; a workflow no longer runs a skill as a brief; write the brief inline and add dependencies: [${skill}]`);
  }
  const definer = inline.get(name);
  if (definer !== undefined) {
    const retiredId = retired?.briefIds.get(name);
    if (retiredId === undefined && !isQualifiedSkillId(workflow.id)) {
      throw new Error(`${at(origin, workflow)}: workflow id cannot form a qualified brief id: ${JSON.stringify(workflow.id)}`);
    }
    const content = decodeBrief({
      name: definer.name ?? name,
      ...(definer.dependencies === undefined ? {} : { dependencies: definer.dependencies }),
      ...(definer.subagents === undefined ? {} : { subagents: definer.subagents }),
      body: definer.brief,
    });
    return {
      briefId: briefId(retiredId ?? `${workflow.id}.${name}`, `${at(origin, workflow)} brief "${name}"`),
      procedure: {
        name: record.keys.name ?? content.name,
        dependencies: content.dependencies,
        subagents: content.subagents,
        body: retiredId === undefined ? expandReferences(content.body, at(origin, workflow)) : retiredBody(content.body),
      },
      ...outputRole(definer.output, origin, context, reassessItem, counted),
    };
  }
  const shipped = name.includes(".") ? name : `${workflow.id}.${name}`;
  if (FORMER_STEP_SKILLS.has(shipped)) throw new Error(`runs brief "${shipped}", which Flywheel no longer ships; write the brief inline`);
  throw new Error(`runs brief "${name}", which this file does not hold; write the brief inline, or run a brief that another phase of this file states`);
}

/** The `each` source of each record of a `reassess` phase, keyed by
 *  definition id. */
function reassessSources(workflow: WorkflowDefinition): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const entry of workflow.phases) {
    if (!isRepeat(entry) || isWhileRepeat(entry.repeat) || entry.repeat.reassess === undefined) continue;
    sources.set(entry.repeat.reassess, entry.repeat.each);
  }
  return sources;
}

/** The item type of the list field an `each` reference names: of an agent's
 *  loaded output, or of the launch input. */
function sourceItem(source: string, briefs: ReadonlyMap<string, LoadedBrief>, input: CompiledInput | null): Field {
  const ref = parseFieldRef(source);
  const fields = ref.source === WORKFLOW_INPUT_SOURCE_ID ? input?.fields : briefs.get(ref.source)?.output.fields;
  const field = fields?.find(({ key }) => key === ref.field);
  if (field?.type !== "list" || field.of === undefined) {
    throw new Error(`its each source "${source}" does not name a declared list field, so the item shape is unknown`);
  }
  return field.of;
}

/** The list fields of each record's output whose `max` a worst-case count
 *  reads, keyed by definition id: each list that a phase runs over or a
 *  repeat runs each item of, and each list of a joined agent that its join
 *  counts (refer to
 *  `RegisteredReducer.countedLists`). A reference or a join that does not
 *  resolve counts nothing here, because compilation refuses it where it is
 *  located. */
function countedLists(workflow: WorkflowDefinition): ReadonlyMap<string, ReadonlySet<string>> {
  const counted = new Map<string, Set<string>>();
  const count = (definitionId: string, field: string): void => {
    counted.set(definitionId, (counted.get(definitionId) ?? new Set()).add(field));
  };
  const sources = outputSources(workflow);
  const countJoin = (reducerName: string, params: unknown, agents: readonly string[]): void => {
    const reducer = latestReducer(reducerName);
    let lists: readonly string[] = [];
    try {
      lists = reducer === undefined ? [] : reducer.countedLists(reducer.decodeParams(params));
    } catch {
      return;
    }
    for (const agent of agents) for (const field of lists) count(agent, field);
  };
  for (const stream of streams(workflow)) {
    const head = stream[0];
    const last = stream.at(-1);
    if (head?.over !== undefined && !isStreamOver(head.over)) {
      const dot = head.over.indexOf(".");
      const source = sources.get(head.over.slice(0, dot));
      if (dot > 0 && source?.kind === "agent" && source.definitionId !== undefined) count(source.definitionId, head.over.slice(dot + 1));
    }
    if (last !== undefined) countJoin(last.join?.reducer ?? "collect", last.join?.with, [last.phase]);
  }
  for (const entry of workflow.phases) {
    if (isRepeat(entry) && !isWhileRepeat(entry.repeat)) {
      const { source: name, field } = parseFieldRef(entry.repeat.each);
      const source = sources.get(name);
      if (source?.kind === "agent" && source.definitionId !== undefined) count(source.definitionId, field);
    }
    for (const phase of isRepeat(entry) ? entry.phases : [entry]) {
      if (phase.agents !== undefined && phase.join !== undefined) countJoin(phase.join.reducer, phase.join.with, namedAgents(phase).map(({ agent }) => agent));
    }
  }
  return counted;
}

/** The loaded brief of each agent record. */
export interface BriefLoad {
  readonly briefs: LoadedBriefs;
}

/** Load the brief of every agent record of one workflow. Throws an
 *  AggregateError with one error for each record that cannot load, each
 *  with a message that names the record and the file at fault, so an author
 *  fixes every record in one edit. A reassess record whose `each` source
 *  failed does not load, because its item shape is unknown. A workflow file
 *  that a chat launched by path holds each counted list that declares no
 *  `max` to {@link DEFAULT_COUNTED_LIST_MAX}, as every load of it does, so a
 *  run that rebuilds the file from its record holds the same contracts as
 *  its launch. A named workflow declares each `max`. */
export function loadBriefs(
  workflow: WorkflowDefinition,
  origin: Origin,
  reader: DefinitionAssetReader = definitionAssets,
  input: CompiledInput | null = null,
): BriefLoad {
  const context: LoadContext = { workflow, reader };
  const reassessing = reassessSources(workflow);
  const counted = workflow.provenance?.layer === "session" ? countedLists(workflow) : new Map<string, ReadonlySet<string>>();
  const inline = inlineBriefs(workflow);
  const briefs = new Map<string, LoadedBrief>();
  const failed = new Map<string, Error>();
  const load = (record: AgentRecordRef, reassessSource: string | undefined): void => {
    if (reassessSource !== undefined && failed.has(parseFieldRef(reassessSource).source)) return;
    try {
      const item = reassessSource === undefined ? undefined : sourceItem(reassessSource, briefs, input);
      const brief = loadBrief(record, origin, context, inline, item, counted.get(record.definitionId) ?? new Set());
      briefs.set(record.definitionId, brief);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.set(record.definitionId, new Error(`Workflow "${workflow.id}" agent "${record.definitionId}": ${message}`, { cause: error }));
    }
  };
  // A reassessment contract takes its item shape from its each source, so
  // every other record loads first.
  const records = [...agentRecords(workflow).values()];
  for (const record of records) if (!reassessing.has(record.definitionId)) load(record, undefined);
  for (const record of records) if (reassessing.has(record.definitionId)) load(record, reassessing.get(record.definitionId));
  if (failed.size > 0) throw new AggregateError([...failed.values()], [...failed.values()].map(({ message }) => message).join("\n"));
  return { briefs };
}

/** Load and compile the `input` contract of one workflow, or null when it
 *  declares none. A path resolves relative to the workflow file. Throws a
 *  message that names the workflow and the file at fault. */
export function loadWorkflowInputContract(
  workflow: WorkflowDefinition,
  origin: Origin,
  reader: DefinitionAssetReader = definitionAssets,
): CompiledInput | null {
  if (workflow.input === undefined) return null;
  try {
    return compileInput(loadContract(workflow.input, origin, { workflow, reader }, "input"));
  } catch (error) {
    throw new Error(`Workflow "${workflow.id}" input: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** The compiled `input` contract of a workflow, or null when it declares
 *  none. A bare definition that no loader published compiles here with no
 *  file location, so only an inline contract can resolve. */
export function workflowInputContract(workflow: WorkflowDefinition): CompiledInput | null {
  return workflow.inputContract !== undefined ? workflow.inputContract : loadWorkflowInputContract(workflow, undefined);
}

/** The loaded inline briefs of a workflow. */
export function workflowBriefs(workflow: WorkflowDefinition): LoadedBriefs {
  return workflow.briefs ?? loadBriefs(workflow, undefined, definitionAssets, workflowInputContract(workflow)).briefs;
}
