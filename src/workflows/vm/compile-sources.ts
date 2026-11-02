import { latestReducer, VOTE_COUNTING_REDUCERS } from "../reducers/registry.js";
import type { JoinContracts, ReducerParams, RegisteredReducer } from "../reducers/reducer.js";
import type { ResolvedAgent } from "../agent-resolution.js";
import { workflowInputContract } from "../brief.js";
import { compiledFields, type CompiledField, type WorkflowInputValue } from "../output-contract/compile.js";
import type { Field, FieldMap } from "../output-contract/grammar.js";
import { parseFieldRef } from "../field-ref.js";
import {
  isRepeat,
  isStreamOver,
  isWhileRepeat,
  ITEM_POSITION_KEY,
  namedAgents,
  outputSources,
  repeatLabel,
  streams,
  walkPhases,
  WORKFLOW_INPUT_SOURCE_ID,
  type OutputSource,
  type PhaseLocation,
  type WorkflowDefinition,
  type WorkflowPhase,
  type WorkflowRepeat,
} from "../workflow-schema.js";
import { SAMPLED_LAUNCH, SAMPLED_LAUNCH_ITEMS } from "./list-expansion.js";

// The sources of a compiled workflow: the list that each phase over a list
// and each repeat over items reads, with the width and identity its field
// declares, and the reducer, parameters, and output contract of each join.
// Compile resolves every source once, so the list node, the repeat node, and
// each later reader agree.

/** The launch input that one compile reads: the decoded input of a launch,
 *  null for a launch without input, or {@link SAMPLED_LAUNCH} for load-time
 *  validation and verification, which have no launch. */
export type CompileLaunchInput = WorkflowInputValue | null | typeof SAMPLED_LAUNCH;

/** A join resolved at compile time: the latest version of the reducer, its
 *  decoded parameters, and the output contract that control pins. */
export interface JoinSource {
  readonly reducer: RegisteredReducer;
  readonly params: ReducerParams;
  readonly contract: FieldMap;
}

/** The list that a phase over a list reads: the node that produces it, its
 *  field, the identity and the width the field declares, and the field's
 *  item type. */
interface ListRead {
  readonly nodeId: string;
  readonly field: string;
  readonly key: string;
  readonly width: number;
  readonly item: Field | undefined;
}

/** The list that a repeat over items reads: the node that produces it, its
 *  field, its `unique` key or {@link ITEM_POSITION_KEY}, and its width,
 *  which is null when the list declares no `max`. A round runs one item at
 *  a time, so the repeat needs no width to run, and reassessment names an
 *  item by its `id`, so the list needs no `unique` key. */
export type EachRead = Omit<ListRead, "width" | "item"> & { readonly width: number | null };

/** A stream resolved at compile time: the list it reads and its join. */
interface StreamSource extends ListRead, JoinSource {}

/** Every source of one workflow, keyed by the authored element that reads
 *  it: the head phase of each stream, each phase of named agents, and each
 *  repeat over items. */
export interface ResolvedSources {
  readonly streams: ReadonlyMap<WorkflowPhase, StreamSource>;
  readonly joins: ReadonlyMap<WorkflowPhase, JoinSource>;
  readonly repeats: ReadonlyMap<WorkflowRepeat, EachRead>;
}

/** The width of a file launch's list of the launch input: the length of the
 *  list that this launch passes, or for a sampled launch the list's declared
 *  `max`, else {@link SAMPLED_LAUNCH_ITEMS}. A list phase has at least one
 *  item of width, so an absent or empty list gives one. */
function launchWidth(launchInput: CompileLaunchInput, field: string, max: number | undefined): number {
  if (launchInput === SAMPLED_LAUNCH) return max ?? SAMPLED_LAUNCH_ITEMS;
  const list = launchInput?.[field];
  return Math.max(1, Array.isArray(list) ? list.length : 0);
}

/** The output contract of a repeat's body phase as a reader outside the
 *  repeat reads it: each list as long as all rounds together. When the
 *  number of rounds is unknown, no list has a `max`. */
function roundsContract(fields: readonly CompiledField[], rounds: number | null): readonly CompiledField[] {
  return fields.map((field) => {
    if (field.type !== "list" || field.max === undefined) return field;
    if (rounds !== null) return { ...field, max: field.max * rounds };
    const { max: _max, ...unbounded } = field;
    return unbounded;
  });
}

/** The repeat that holds a phase, or undefined. */
function repeatOf(location: PhaseLocation): WorkflowRepeat | undefined {
  return location.repeat?.entry;
}

/** Resolve every source of one workflow (refer to {@link ResolvedSources}).
 *  `<source>.<field>` names exactly one phase of one agent, named agent, or
 *  join output, or the reserved launch input, and `<field>` is a list. The
 *  list's `max` is the width, and its `unique: <key>`, a required string
 *  field of object items, is each item's identity. A workflow file that a
 *  chat launched by path may leave out either one, so that an authored file
 *  can map any list: a list of the launch input is as wide as the list that this
 *  launch passes, a sampled launch uses its declared `max`, or
 *  {@link SAMPLED_LAUNCH_ITEMS} without one, and a list without `unique`
 *  names each item by its position (refer to {@link ITEM_POSITION_KEY}). A
 *  named workflow declares both, because load time is the only check
 *  its author sees. A join names a registered reducer whose parameters fit
 *  the contracts around it, and the reducer derives its output contract from
 *  them. Throws each independent source's located error together; a source
 *  that depends on a failed one adds no duplicate or consequential error.
 *  `rejected` names phases that semantic validation already refused. */
export function resolveSources(
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
  launchInput: CompileLaunchInput,
  rejected: ReadonlySet<WorkflowPhase> = new Set(),
): ResolvedSources {
  const file = workflow.provenance?.layer === "session";
  const sources = outputSources(workflow);
  const locations = new Map<WorkflowPhase, PhaseLocation>();
  walkPhases(workflow.phases, (phase, location) => locations.set(phase, location));
  const streamOf = new Map(streams(workflow).flatMap((stream) => {
    const last = stream.at(-1);
    return last === undefined ? [] : stream.map((phase) => [phase, stream] as const);
  }));
  const resolvedStreams = new Map<WorkflowPhase, StreamSource>();
  const resolvedJoins = new Map<WorkflowPhase, JoinSource>();
  const refused = Symbol("semantically refused phase");
  const failed = new Map<WorkflowPhase, unknown>([...rejected].map((phase) => [phase, refused]));
  const resolving = new Set<WorkflowPhase>();
  const where = (phase: WorkflowPhase): string => locations.get(phase)?.label ?? `Phase "${phase.phase}"`;

  /** The output fields of one named source as a reader at `reader` reads
   *  them. A body phase read from outside its repeat reads every round. */
  const outputFields = (source: OutputSource, reader: PhaseLocation | undefined): readonly CompiledField[] | undefined => {
    let fields: readonly CompiledField[] | undefined;
    if (source.kind === "agent") {
      fields = source.definitionId === undefined ? undefined : agents.get(source.definitionId)?.output.fields;
    } else {
      const join = source.phase.agents === undefined ? resolveStream(streamHead(source.phase)) : resolveJoin(source.phase);
      fields = compiledFields(join.contract);
    }
    const holder = repeatOf(source.location);
    if (fields === undefined || holder === undefined || (reader !== undefined && repeatOf(reader) === holder)) return fields;
    return roundsContract(fields, roundsOf(holder));
  };

  /** The most rounds of one repeat: its `max` for a repeat while, the width
   *  of its list for a repeat over items, which is null when that list
   *  declares no `max`. A list that a repeat cannot read reports its own
   *  refusal, so a reader of the repeat adds none. */
  const repeatRounds = new Map<WorkflowRepeat, number | null>();
  const roundsOf = (holder: WorkflowRepeat): number | null => {
    if (isWhileRepeat(holder.repeat)) return holder.repeat.max;
    const known = repeatRounds.get(holder);
    if (known !== undefined) return known;
    const topIndex = workflow.phases.indexOf(holder);
    let rounds: number | null;
    try {
      rounds = eachRead(holder.repeat.each, { index: topIndex, topIndex, label: repeatLabel(topIndex) }, (reason) => new Error(reason)).width;
    } catch {
      throw refused;
    }
    repeatRounds.set(holder, rounds);
    return rounds;
  };

  const streamHead = (phase: WorkflowPhase): WorkflowPhase => {
    const head = streamOf.get(phase)?.[0];
    if (head === undefined) throw new Error(`Workflow invariant rejected phase "${phase.phase}" outside a stream`);
    return head;
  };

  /** The list field that `ref` names, read by the element at `reader`, and
   *  its width: the launch width of a file's launch input, else the
   *  declared `max`. */
  const listField = (ref: string, reader: PhaseLocation, fail: (reason: string) => Error) => {
    const { source: sourceId, field } = parseFieldRef(ref);
    const isInput = sourceId === WORKFLOW_INPUT_SOURCE_ID;
    if (isInput && workflowInputContract(workflow) === null) throw fail(`reads the launch input through "${ref}", but the workflow declares no input contract`);
    const source = isInput ? undefined : sources.get(sourceId);
    if (!isInput && source === undefined) throw fail(`reads "${sourceId}", which names no phase of one agent, named agent, or join output`);
    const fields = isInput ? workflowInputContract(workflow)?.fields : source === undefined ? undefined : outputFields(source, reader);
    const list = fields?.find(({ key }) => key === field);
    if (list?.type !== "list") throw fail(`reads "${ref}", which is not a declared list field${isInput ? " of the input contract" : ""}`);
    const width = file && isInput ? launchWidth(launchInput, field, list.max) : list.max;
    return { nodeId: source?.nodeId ?? WORKFLOW_INPUT_SOURCE_ID, field, list, width };
  };

  /** The list that the phase over a list at `reader` reads. */
  const listRead = (ref: string, reader: PhaseLocation, fail: (reason: string) => Error): ListRead => {
    const { nodeId, field, list, width } = listField(ref, reader, fail);
    const holder = sources.get(parseFieldRef(ref).source)?.location;
    const repeat = holder === undefined ? undefined : repeatOf(holder);
    if (repeat !== undefined && repeatOf(reader) !== repeat && roundsOf(repeat) === null) {
      throw fail(`reads "${ref}" from outside a repeat over a list that declares no max, so the number of rounds and the width are unknown; declare max on the list that the repeat runs over`);
    }
    if (width === undefined) throw fail(`reads list "${ref}", which declares no max, so the width is unknown`);
    if (list.unique === undefined && !file) throw fail(`reads list "${ref}", which declares no unique key, so an item has no identity`);
    const key = list.unique ?? ITEM_POSITION_KEY;
    const keyField = list.of?.type === "object" ? list.of.fields?.[key] : undefined;
    if (list.unique !== undefined && (keyField?.type !== "string" || keyField.optional === true || keyField.nullable === true)) {
      throw fail(`reads list "${ref}", whose items must be objects with a required string "${key}"`);
    }
    return { nodeId, field, key, width, item: list.of };
  };

  /** The list that the repeat at `reader` runs one round for each item of.
   *  The repeat opens its rounds over a list that is there, so the list is
   *  neither optional nor nullable. */
  const eachRead = (ref: string, reader: PhaseLocation, fail: (reason: string) => Error): EachRead => {
    const { nodeId, field, list, width } = listField(ref, reader, fail);
    if (list.optional || list.nullable) throw fail(`reads "${ref}", which must be a required, non-nullable list; remove optional and nullable from the source field`);
    return { nodeId, field, key: list.unique ?? ITEM_POSITION_KEY, width: width ?? null };
  };

  /** The reducer of one join, decoded and checked against its contracts. */
  const joinSource = (phase: WorkflowPhase, contracts: JoinContracts, width: number, votes: number | undefined): JoinSource => {
    const reducerName = phase.join?.reducer ?? "collect";
    const reducer = latestReducer(reducerName);
    if (!reducer) throw new Error(`Workflow "${workflow.id}": ${where(phase)} join names unknown reducer "${reducerName}"`);
    if (votes !== undefined && !reducer.countsVotes) {
      throw new Error(`Workflow "${workflow.id}": ${where(phase)} casts ${votes} votes for each item, but reducer "${reducer.id}" counts no votes; join the phase with ${VOTE_COUNTING_REDUCERS.join(" or ")}, or remove votes`);
    }
    const misfit = (reason: string, cause?: unknown): Error =>
      new Error(`Workflow "${workflow.id}": ${where(phase)} join.with does not fit reducer "${reducer.id}@${reducer.version}": ${reason}`, cause === undefined ? undefined : { cause });
    let params: ReducerParams;
    try {
      params = reducer.decodeParams(phase.join?.with);
    } catch (error) {
      throw misfit(error instanceof Error ? error.message : String(error), error);
    }
    const issue = reducer.check(params, contracts);
    if (issue !== undefined) throw misfit(issue);
    return { reducer, params, contract: reducer.output(params, contracts, width) };
  };

  const resolveStreamSource = (head: WorkflowPhase): StreamSource => {
    const stream = streamOf.get(head) ?? [head];
    const last = stream.at(-1) ?? head;
    const location = locations.get(head);
    if (head.over === undefined || location === undefined) throw new Error(`Workflow invariant rejected stream "${head.phase}" without a list`);
    const fail = (reason: string): Error => new Error(`Workflow "${workflow.id}": ${where(head)} ${reason}`);
    // The message names `over`, so a file diagnostic locates it at that key.
    const list = listRead(head.over, location, (reason) => fail(`over ${reason}`));
    if (head.label !== undefined && list.item?.fields?.[head.label]?.type !== "string") {
      throw fail(`label "${head.label}" is not a string field of the items of "${head.over}"`);
    }
    const lastAgent = agents.get(last.phase);
    const source = sources.get(parseFieldRef(head.over).source);
    const sourceFields = source === undefined ? undefined : outputFields(source, location);
    const contracts: JoinContracts = {
      key: list.key,
      item: { name: `items of "${head.over}"`, fields: compiledFields(list.item?.fields ?? {}) },
      joined: { name: `output of the last phase "${last.phase}"`, fields: lastAgent?.output.fields ?? [] },
      source: sourceFields === undefined ? null : { name: `output of "${parseFieldRef(head.over).source}"`, fields: sourceFields },
      ...(head.votes === undefined ? {} : { votes: head.votes }),
    };
    return { ...list, ...joinSource(last, contracts, list.width, head.votes) };
  };

  const resolveStream = (head: WorkflowPhase): StreamSource => memo(head, resolvedStreams, () => resolveStreamSource(head));

  /** The join of a phase of named agents: one slot for each agent, keyed by
   *  its name. Its agents share one output contract for every field that
   *  the reducer reads, which validation proves, so the first agent's
   *  contract stands for them all. */
  const resolveJoin = (phase: WorkflowPhase): JoinSource => memo(phase, resolvedJoins, () => {
    const agentIds = namedAgents(phase).map(({ agent }) => agent);
    const joined = agentIds.map((id) => {
      const contracts: JoinContracts = {
        key: ITEM_POSITION_KEY,
        item: { name: `agents of phase "${phase.phase}"`, fields: [] },
        joined: { name: `output of agent "${id}"`, fields: agents.get(id)?.output.fields ?? [] },
        source: null,
      };
      return { id, join: joinSource(phase, contracts, agentIds.length, undefined) };
    });
    const [first, ...rest] = joined;
    if (first === undefined) throw new Error(`Workflow invariant rejected phase "${phase.phase}" without agents`);
    // The join folds every agent against one output contract, so the agents
    // must agree on each field that the reducer reads, which the contract
    // that it derives from each agent's output shows.
    const differs = rest.find(({ join }) => JSON.stringify(join.contract) !== JSON.stringify(first.join.contract));
    if (differs !== undefined) {
      throw new Error(`Workflow "${workflow.id}": ${where(phase)} join folds agents "${first.id}" and "${differs.id}", whose outputs differ in a field that reducer "${first.join.reducer.id}" reads; give the agents one output contract for those fields`);
    }
    return first.join;
  });

  function memo<T>(phase: WorkflowPhase, cache: Map<WorkflowPhase, T>, resolve: () => T): T {
    const known = cache.get(phase);
    if (known !== undefined) return known;
    if (failed.has(phase)) throw failed.get(phase);
    if (resolving.has(phase)) throw new Error(`Workflow "${workflow.id}": ${where(phase)} reads its own output`);
    resolving.add(phase);
    try {
      const value = resolve();
      cache.set(phase, value);
      return value;
    } catch (error) {
      failed.set(phase, error);
      throw error;
    } finally {
      resolving.delete(phase);
    }
  }

  const failures = new Set<unknown>();
  const attempt = (resolve: () => void): void => {
    try {
      resolve();
    } catch (error) {
      if (error !== refused) failures.add(error);
    }
  };
  for (const stream of streams(workflow)) {
    const head = stream[0];
    if (head !== undefined) attempt(() => resolveStream(head));
  }
  walkPhases(workflow.phases, (phase) => {
    if (phase.agents !== undefined) attempt(() => resolveJoin(phase));
  });
  const repeats = new Map<WorkflowRepeat, EachRead>();
  for (const [topIndex, entry] of workflow.phases.entries()) {
    if (!isRepeat(entry) || isWhileRepeat(entry.repeat)) continue;
    const { each } = entry.repeat;
    const location: PhaseLocation = { index: topIndex, topIndex, label: `Repeat ${topIndex + 1}` };
    attempt(() => repeats.set(entry, eachRead(each, location, (reason) => new Error(`Workflow "${workflow.id}": Repeat ${topIndex + 1} each ${reason}`))));
  }
  if (failures.size === 1) throw [...failures][0];
  if (failures.size > 1) throw new AggregateError(failures, [...failures].map((error) => error instanceof Error ? error.message : String(error)).join("\n"));
  return { streams: resolvedStreams, joins: resolvedJoins, repeats };
}

/** Field types whose value can be empty. The VM reads an `if` or `while`
 *  field as "not empty", and `false` and `0` are not empty, so a boolean or
 *  number condition would always hold. A nullable field of any type can be
 *  null, which is empty. */
const CONDITION_TYPES: ReadonlySet<CompiledField["type"]> = new Set(["string", "list", "path", "object", "variant"]);

/** Every field that an `if` or a `repeat.while` names, judged against the
 *  output contract of its source: the field is declared and can be empty. A
 *  `while` over a join reads a list field of the join output, and the join
 *  is `dedupe`, because only a join that drops what earlier rounds kept can
 *  stop a repeat whose agents find the same items again; such a repeat
 *  cannot also stop when stuck. Names that do not resolve are reported by
 *  `referenceIssues`, so they add nothing here. */
export function fieldIssues(workflow: WorkflowDefinition, agents: ReadonlyMap<string, ResolvedAgent>, resolved: ResolvedSources): readonly string[] {
  const sources = outputSources(workflow);
  const issues: string[] = [];
  const contractOf = (source: OutputSource): { readonly fields: readonly CompiledField[]; readonly reducer?: string } | undefined => {
    if (source.kind === "agent") {
      const fields = source.definitionId === undefined ? undefined : agents.get(source.definitionId)?.output.fields;
      return fields === undefined ? undefined : { fields };
    }
    const head = streams(workflow).find((stream) => stream.at(-1) === source.phase)?.[0];
    const join = head === undefined ? resolved.joins.get(source.phase) : resolved.streams.get(head);
    return join === undefined ? undefined : { fields: compiledFields(join.contract), reducer: join.reducer.id };
  };
  const judge = (where: string, key: string, ref: string, loop: { readonly stuck: boolean } | undefined): void => {
    const { source: name, field } = parseFieldRef(ref);
    const source = sources.get(name);
    const contract = source === undefined ? undefined : contractOf(source);
    if (contract === undefined) return;
    const fail = (reason: string): void => {
      issues.push(`Workflow "${workflow.id}": ${where} ${key} "${ref}" ${reason}`);
    };
    const declared = contract.fields.find((candidate) => candidate.key === field);
    if (declared === undefined) return fail(`names undeclared output field "${field}" of "${name}"`);
    if (loop !== undefined && contract.reducer !== undefined) {
      if (declared.type !== "list") return fail(`names "${field}", which is not a list field of the join output of "${name}"; name a list field such as kept`);
      if (contract.reducer !== "dedupe") return fail(`reads a join with reducer "${contract.reducer}", but a repeat over a join needs a dedupe join, so a repeated item cannot keep the repeat alive; join "${name}" with dedupe`);
      if (loop.stuck) return fail(`reads a join, whose dedupe already stops a repeat that finds nothing new; remove stuck`);
      return;
    }
    if (!declared.nullable && !CONDITION_TYPES.has(declared.type)) {
      fail(`names "${field}" of "${name}", a ${declared.type}, which is never empty; name a string, list, path, object, variant, or nullable field`);
    }
  };
  walkPhases(workflow.phases, (phase, location) => {
    if (phase.if?.includes(".") === true && !(phase.over !== undefined && isStreamOver(phase.over))) judge(location.label, "if", phase.if, undefined);
  });
  for (const [topIndex, entry] of workflow.phases.entries()) {
    if (isRepeat(entry) && isWhileRepeat(entry.repeat)) judge(repeatLabel(topIndex), "while", entry.repeat.while, entry.repeat);
  }
  return issues;
}
