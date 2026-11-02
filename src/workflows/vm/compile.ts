import { Schema } from "effect";
import { ArtifactContractFrontmatterItemSchema } from "../artifact-contracts.js";
import type { ResolvedAgent } from "../agent-resolution.js";
import { parseFieldRef } from "../field-ref.js";
import { referenceIssues } from "../phase-references.js";
import {
  allPhases,
  isRepeat,
  isStreamOver,
  isWhileRepeat,
  ITEM_POSITION_KEY,
  MAX_ATTEMPTS_CEILING,
  namedAgentNodeId,
  namedAgents,
  outputSources,
  phaseById,
  phaseNodeId,
  phaseKind,
  repeatBodyNodeId,
  repeatLabel,
  streams,
  topNodeId,
  WORKFLOW_INPUT_SOURCE_ID,
  type PhaseLocation,
  type WorkflowDefinition,
  type WorkflowPhase,
  type WorkflowRepeat,
} from "../workflow-schema.js";
import { parseCommittedWorkflowControl, type CommittedWorkflowControl } from "./committed-control.js";
import { fieldIssues, resolveSources, type CompileLaunchInput, type EachRead, type JoinSource, type ResolvedSources } from "./compile-sources.js";
import { buildDefinitionIdentity, type DefinitionIdentityOptions } from "./definition-identity.js";
import { CURRENT_PROPOSAL_ENCODING } from "./events.js";
import { calculateFrontier } from "./frontier.js";
import {
  attemptIdOf,
  type AgentNode,
  type Attempt,
  type ListNode,
  type LogicalNode,
  type NodeCondition,
  type PhaseNode,
  type RepeatNode,
  type WorkflowGraph,
  type WorkflowOwnership,
} from "./graph-types.js";
import { expandLaunchInput, prospectiveLaunchInput, SAMPLED_LAUNCH, SAMPLED_LAUNCH_ITEMS } from "./list-expansion.js";
import { admitStructure, structuralFindings, worstCaseAttempts } from "./structural-admission.js";
import type { WorkflowVerificationFinding } from "./verify-types.js";

// Compile one phase grammar definition into control version 11 (ARCH-WORKFLOWS-011).
// Each top-level phase or repeat compiles to one node at its place, and runs
// after the element before it. A phase of one agent is an agent node; a
// phase of named agents is a phase node that owns one agent node for each
// agent; a stream, a phase over a list with the stream phases after it, is
// one list node at the place of its first phase; a repeat is a repeat node
// that owns round 1 of its phases, which run in order inside the round.

/** What every element compiler reads: the definition, its resolved agents,
 *  and its resolved sources, with the launch input of this compile. */
interface CompileContext {
  readonly workflow: WorkflowDefinition;
  readonly agents: ReadonlyMap<string, ResolvedAgent>;
  readonly sources: ResolvedSources;
  readonly launchInput: CompileLaunchInput;
  readonly nodes: LogicalNode[];
  readonly attempts: Attempt[];
}

/** The agent that one record names. Validation proved that every record
 *  resolves, so a missing one is an invariant. */
function requireAgent(context: CompileContext, definitionId: string): ResolvedAgent {
  const agent = context.agents.get(definitionId);
  if (!agent) throw new Error(`Workflow "${context.workflow.id}" compiled agent "${definitionId}", which did not resolve`);
  return agent;
}

function pendingAttempt(context: CompileContext, node: AgentNode): void {
  context.attempts.push({
    id: attemptIdOf(node.id, 1),
    logicalNodeId: node.id,
    workflowDefinitionId: context.workflow.id,
    definitionId: node.definitionId,
    sequence: 1,
    iteration: 1,
    resumeRevertCount: 0,
    provenance: { _tag: "authored" },
    ownership: node.ownership,
    state: { _tag: "pending" },
    parentAttemptId: null,
    conversationId: null,
    handoff: null,
    priorRetryFeedback: null,
    item: null,
  });
}

/** The `order` of the next node: its global preorder index, so a container
 *  comes before the nodes it owns. */
function nextOrder(context: CompileContext): number {
  return context.nodes.length;
}

/** Add one node, whose `order` is {@link nextOrder}, in preorder. */
function push<Node extends LogicalNode>(context: CompileContext, node: Node): Node {
  context.nodes.push(node);
  return node;
}

/** The node that one name of `if` names: the agent node of a phase of one
 *  agent or of a named agent, the phase node of a phase of named agents, or
 *  the list node of a stream's last phase. Inside a repeat this is round 1's
 *  node, which each later round's copy moves to its own round. */
function nameNodeId(workflow: WorkflowDefinition, name: string): string {
  const source = outputSources(workflow).get(name);
  if (source !== undefined) return source.nodeId;
  const phase = phaseById(workflow, name);
  if (phase === undefined) throw new Error(`Workflow "${workflow.id}" compiled a condition on "${name}", which names no phase`);
  return phaseNodeId(workflow.id, phase.location);
}

/** The condition of a phase's `if`: completed for a name, and a field that
 *  is not empty for `<name>.<field>`. */
function conditionOf(workflow: WorkflowDefinition, phase: WorkflowPhase): NodeCondition | null {
  if (phase.if === undefined) return null;
  if (!phase.if.includes(".")) return { _tag: "completed", nodeId: nameNodeId(workflow, phase.if) };
  const { source, field } = parseFieldRef(phase.if);
  return { _tag: "field", nodeId: nameNodeId(workflow, source), field };
}

function joinOf(join: JoinSource, write: WorkflowPhase["join"], fallback: string) {
  return {
    reducer: { id: join.reducer.id, version: join.reducer.version, params: join.params, contract: join.contract },
    write: Schema.decodeUnknownSync(ArtifactContractFrontmatterItemSchema)(write?.write ?? fallback),
  };
}

/** An automatic named join must not replace an authored artifact. Artifact
 *  ids accept any nonempty string, so each suffix can itself be authored. */
function defaultNamedJoinWriteId(context: CompileContext, phaseId: string): string {
  const used = new Set([...context.agents.values()].flatMap(({ writes }) => writes.map(({ id }) => id)));
  for (const { phase } of allPhases(context.workflow)) {
    const write = phase.join?.write;
    if (write !== undefined) used.add(typeof write === "string" ? write : write.id);
  }
  let id = phaseId;
  while (used.has(id)) id += ":join";
  return id;
}

/** Compile one phase at its place. A stream phase after the first adds no
 *  node, because the list node of its stream holds it. Returns the node that
 *  the next element runs after, or undefined for a stream phase. */
function compilePhase(context: CompileContext, phase: WorkflowPhase, id: string, ownership: WorkflowOwnership): LogicalNode | undefined {
  const { workflow } = context;
  const condition = conditionOf(workflow, phase);
  switch (phaseKind(phase)) {
    case "single": {
      const agent = requireAgent(context, phase.phase);
      const node = push<AgentNode>(context, {
        kind: "agent", id, order: nextOrder(context), workflowDefinitionId: workflow.id, ownership, state: { _tag: "pending" },
        definitionId: phase.phase, name: agent.name, retry: phase.retry ?? null, condition,
      });
      pendingAttempt(context, node);
      return node;
    }
    case "named": {
      const join = context.sources.joins.get(phase);
      const node = push<PhaseNode>(context, {
        kind: "phase", id, order: nextOrder(context), workflowDefinitionId: workflow.id, ownership, state: { _tag: "pending" },
        phaseId: phase.phase, name: phase.name ?? phase.phase, condition,
        join: join === undefined ? null : {
          ...joinOf(join, phase.join, phase.join === undefined ? defaultNamedJoinWriteId(context, phase.phase) : phase.phase),
          settlement: null,
        },
      });
      for (const [index, named] of namedAgents(phase).entries()) {
        const agent = requireAgent(context, named.agent);
        const child = push<AgentNode>(context, {
          kind: "agent", id: namedAgentNodeId(id, index), order: nextOrder(context), workflowDefinitionId: workflow.id,
          ownership: { _tag: "phase", workflowDefinitionId: workflow.id, phaseId: phase.phase, parentNodeId: id }, state: { _tag: "pending" },
          definitionId: named.agent, name: agent.name, retry: named.retry ?? phase.retry ?? null, condition: null,
        });
        pendingAttempt(context, child);
      }
      return node;
    }
    case "list": {
      if (phase.over !== undefined && isStreamOver(phase.over)) return undefined;
      const stream = streams(workflow).find((candidate) => candidate[0] === phase) ?? [phase];
      const last = stream.at(-1) ?? phase;
      const source = context.sources.streams.get(phase);
      if (!source) throw new Error(`Workflow "${workflow.id}" compiled phase "${phase.phase}", whose list did not resolve`);
      const [first, ...rest] = stream.map((member) => ({ definitionId: member.phase, name: requireAgent(context, member.phase).name, retry: member.retry ?? null }));
      if (!first) throw new Error(`Workflow invariant rejected an empty stream at phase "${phase.phase}"`);
      return push<ListNode>(context, {
        kind: "list", id, order: nextOrder(context), workflowDefinitionId: workflow.id, ownership, state: { _tag: "pending" },
        outputId: last.phase, name: last.name ?? last.phase,
        source: { nodeId: source.nodeId, field: source.field }, key: source.key, label: phase.label ?? null, width: source.width,
        ...(phase.votes === undefined ? {} : { votes: phase.votes }),
        phases: [first, ...rest],
        ...joinOf(source, last.join, last.phase),
        admittedContext: null, settlement: null, condition,
      });
    }
  }
}

/** The items of a repeat over the launch input, which control holds from
 *  launch because it does not keep the input: the list that this launch
 *  passes, a sample for a sampled launch, and none without input. A repeat
 *  over an agent's output reads its items when it opens. */
function launchItems(context: CompileContext, read: EachRead): readonly Attempt["item"][] | null {
  if (read.nodeId !== WORKFLOW_INPUT_SOURCE_ID) return null;
  const { launchInput } = context;
  if (launchInput === SAMPLED_LAUNCH) {
    return Array.from({ length: Math.min(SAMPLED_LAUNCH_ITEMS, read.width ?? SAMPLED_LAUNCH_ITEMS) }, (_, index) =>
      read.key === ITEM_POSITION_KEY ? `synthetic-${index + 1}` : { [read.key]: `synthetic-${index + 1}` });
  }
  const list = launchInput?.[read.field];
  return Array.isArray(list) ? list : [];
}

/** The loop of one repeat. A `while` repeat names its evaluator by round 1's
 *  node id; an `each` repeat names its source and its reassess phase. */
function loopOf(context: CompileContext, entry: WorkflowRepeat, location: Pick<PhaseLocation, "topIndex">): RepeatNode["loop"] {
  const { workflow } = context;
  const sources = outputSources(workflow);
  if (isWhileRepeat(entry.repeat)) {
    const { source, field } = parseFieldRef(entry.repeat.while);
    const evaluator = sources.get(source);
    if (!evaluator) throw new Error(`Workflow "${workflow.id}": ${repeatLabel(location.topIndex)} while names "${source}", which did not resolve`);
    return { _tag: "while", evaluator: evaluator.nodeId, field, max: entry.repeat.max, stuck: entry.repeat.stuck, priorSignal: null };
  }
  const read = context.sources.repeats.get(entry);
  if (!read) throw new Error(`Workflow "${workflow.id}": ${repeatLabel(location.topIndex)} each did not resolve`);
  const { reassess } = entry.repeat;
  const reassessPhase = reassess === undefined ? undefined : phaseById(workflow, reassess);
  return {
    _tag: "each",
    source: { nodeId: read.nodeId, field: read.field },
    width: read.width,
    reassess: reassessPhase === undefined ? null : phaseNodeId(workflow.id, reassessPhase.location),
    items: launchItems(context, read),
  };
}

/** Compile a repeat and round 1 of its phases, which the repeat owns and
 *  which run in order. A later round copies them when it starts. The repeat
 *  shows as the names of its phases in order, such as `Investigate → Fix`,
 *  so a person knows the loop by what it runs. */
function compileRepeat(context: CompileContext, entry: WorkflowRepeat, id: string, topIndex: number, dependencies: WorkflowGraph["dependencies"][number][]): LogicalNode {
  const { workflow } = context;
  const node = push<RepeatNode>(context, {
    kind: "repeat", id, order: nextOrder(context), workflowDefinitionId: workflow.id, ownership: { _tag: "workflow", workflowDefinitionId: workflow.id },
    state: { _tag: "pending" }, name: entry.phases.map((phase) => phase.name ?? phase.phase).join(" → "), loop: loopOf(context, entry, { topIndex }),
  });
  const ownership: WorkflowOwnership = { _tag: "round", workflowDefinitionId: workflow.id, parentNodeId: id, round: 1 };
  let previous: LogicalNode | undefined;
  for (const [index, phase] of entry.phases.entries()) {
    const compiled = compilePhase(context, phase, repeatBodyNodeId(id, index), ownership);
    if (compiled === undefined) continue;
    if (previous !== undefined) dependencies.push({ nodeId: compiled.id, dependsOn: previous.id });
    previous = compiled;
  }
  return node;
}

/** The limits that one compile writes into the control's guardrails. An
 *  undefined `maxAttempts` gives the control the worst case of what it
 *  launches (refer to `worstCaseAttempts`), and structural admission
 *  refuses a worst case past the ceiling. */
interface WorkflowGuardrailLimits {
  readonly maxAttempts: number | undefined;
  readonly maxMutationsPerAttempt: number;
  readonly maxInserts: number;
}

/** The limits of one launch: each declared guardrail, else its default.
 *  The attempt limit without a declaration is, for a workflow file that a
 *  chat launched by path, undefined, so the launch runs with the worst case
 *  of its compiled control; else `setting`. A launch passes the
 *  `workflow.max_attempts` setting, and a reader without a launch passes the
 *  ceiling. A run that a file started keeps its `session` provenance in its
 *  recorded definition, so a recompile at recovery takes the same rule. */
export function launchGuardrailLimits(workflow: WorkflowDefinition, setting: number): WorkflowGuardrailLimits {
  const declared = workflow.guardrails;
  return {
    maxAttempts: declared?.max_attempts ?? (workflow.provenance?.layer === "session" ? undefined : setting),
    maxMutationsPerAttempt: declared?.max_mutations_per_attempt ?? 3,
    maxInserts: declared?.max_inserts ?? 20,
  };
}

/** The limits of a compile whose caller names none: the defaults of the
 *  `workflow.max_attempts` setting and of the declared guardrails, the same
 *  for every layer, so two copies of one definition compile alike. */
const DEFAULT_GUARDRAIL_LIMITS: WorkflowGuardrailLimits = { maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 20 };

/** The guardrails that a reader without a launch applies to one definition:
 *  {@link launchGuardrailLimits} with the ceiling as its setting. An
 *  undeclared attempt limit of a named workflow is the launch setting
 *  `workflow.max_attempts`, which only a launch knows, so load-time validation
 *  and verification refuse only a workflow that no setting can admit, and
 *  give the same verdict. */
export function authoredGuardrailLimits(workflow: WorkflowDefinition): WorkflowGuardrailLimits {
  return launchGuardrailLimits(workflow, MAX_ATTEMPTS_CEILING);
}

interface CompiledWorkflowGraph {
  readonly graph: WorkflowGraph;
  readonly attempts: readonly Attempt[];
  readonly frontier: readonly string[];
  readonly guardrails: CommittedWorkflowControl["guardrails"];
}

/** Throw every issue together: one as itself, several as one error. */
function throwIssues(issues: readonly string[]): void {
  if (issues.length === 1) throw new Error(issues[0]);
  if (issues.length > 1) throw new AggregateError(issues.map((issue) => new Error(issue)), issues.join("\n"));
}

/** Compile the graph of one definition for one launch, without its
 *  identity. Each list over the launch input expands here, so structural
 *  admission counts its exact items. Throws a located error for a reference
 *  that names no earlier output, and for a list, join, or field that does
 *  not fit its contracts. */
function compileWorkflowGraph(
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
  guardrailLimits: WorkflowGuardrailLimits,
  launchInput: CompileLaunchInput,
): CompiledWorkflowGraph {
  throwIssues(referenceIssues(workflow));
  const sources = resolveSources(workflow, agents, launchInput);
  throwIssues(fieldIssues(workflow, agents, sources));
  const context: CompileContext = { workflow, agents, sources, launchInput, nodes: [], attempts: [] };
  const dependencies: WorkflowGraph["dependencies"][number][] = [];
  let previous: LogicalNode | undefined;
  for (const [index, entry] of workflow.phases.entries()) {
    const id = topNodeId(workflow.id, index);
    const compiled = isRepeat(entry)
      ? compileRepeat(context, entry, id, index, dependencies)
      : compilePhase(context, entry, id, { _tag: "workflow", workflowDefinitionId: workflow.id });
    if (compiled === undefined) continue;
    if (previous !== undefined) dependencies.push({ nodeId: compiled.id, dependsOn: previous.id });
    previous = compiled;
  }
  const graph: WorkflowGraph = { nodes: context.nodes, dependencies, joins: [] };
  const { attempts } = context;
  const { maxAttempts } = guardrailLimits;
  const initial = {
    graph,
    attempts,
    guardrails: {
      maxAttempts: maxAttempts ?? MAX_ATTEMPTS_CEILING,
      maxMutationsPerAttempt: guardrailLimits.maxMutationsPerAttempt,
      maxInserts: guardrailLimits.maxInserts,
      // The author's `max_parallel`. Without it, every ready attempt runs at
      // once, and a list's width and the attempt limit bound the run.
      ...(workflow.guardrails?.max_parallel === undefined ? {} : { maxParallel: workflow.guardrails.max_parallel }),
      insertsUsed: 0,
      attemptMutationsUsed: attempts.map(({ id: attemptId }) => ({ attemptId, used: 0 })),
    },
  };
  if (launchInput !== SAMPLED_LAUNCH) {
    const prospective = prospectiveLaunchInput(initial, launchInput, maxAttempts === undefined);
    admitStructure(workflow.id, judgedStructure(workflow.id, { ...prospective, frontier: [] }, launchInput)
      .filter(({ name }) => name === "attempt_limit_overrun"));
  }
  const launched = expandLaunchInput(initial, launchInput, CURRENT_PROPOSAL_ENCODING);
  // The worst case counts the expanded launch input, so it is the count of
  // this launch and not of a launch at the full max of each list. A control
  // holds an attempt limit of at least one, which an empty list over the
  // input alone does not reach.
  const guardrails = maxAttempts === undefined ? { ...launched.guardrails, maxAttempts: Math.max(1, worstCaseAttempts(launched)) } : launched.guardrails;
  const frontier = calculateFrontier(launched.graph, guardrails.maxParallel ?? null);
  return { ...launched, guardrails, graph: frontier.graph, frontier: frontier.readyNodeIds };
}

/** The structural findings of one definition at load time, with the
 *  guardrails of {@link authoredGuardrailLimits} and the sampled launch that
 *  verification also judges. A definition that cannot compile has located
 *  errors elsewhere, so this reads only one that compiles. */
export function authoredStructureFindings(
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
): readonly WorkflowVerificationFinding[] {
  return judgedStructure(workflow.id, compileWorkflowGraph(workflow, agents, authoredGuardrailLimits(workflow), SAMPLED_LAUNCH), SAMPLED_LAUNCH);
}

/** The structural findings of one compiled graph. A sampled launch gives
 *  each list over the launch input a sample of items, so its attempt count
 *  is the sample's and not a real launch's. The finding says so, because an
 *  author who declares the sampled count sees a full launch refused. */
function judgedStructure(workflowDefinitionId: string, compiled: CompiledWorkflowGraph, launchInput: CompileLaunchInput): readonly WorkflowVerificationFinding[] {
  const findings = structuralFindings({ ...compiled, definitionIdentity: { workflowDefinitionId } });
  const sampled = launchInput === SAMPLED_LAUNCH && compiled.graph.nodes.some((node) =>
    (node.kind === "list" && node.source.nodeId === WORKFLOW_INPUT_SOURCE_ID) || (node.kind === "repeat" && node.loop._tag === "each" && node.loop.source.nodeId === WORKFLOW_INPUT_SOURCE_ID));
  if (!sampled) return findings;
  const note = `This count gives each list of the launch input ${SAMPLED_LAUNCH_ITEMS} sample items; a launch counts its real items, up to the max of each list.`;
  return findings.map((finding) => finding.name === "attempt_limit_overrun" ? { ...finding, message: `${finding.message} ${note}` } : finding);
}

/** Compile one definition into deterministic initial control for one
 *  launch (refer to {@link CompileLaunchInput}). Structural admission
 *  judges the graph before the control is parsed, so a refused graph throws
 *  `WorkflowStructureRejectedError`. */
export function compileWorkflowControl(
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
  identityOptions: DefinitionIdentityOptions,
  guardrailLimits: WorkflowGuardrailLimits = DEFAULT_GUARDRAIL_LIMITS,
  launchInput: CompileLaunchInput = null,
): CommittedWorkflowControl {
  const compiled = compileWorkflowGraph(workflow, agents, guardrailLimits, launchInput);
  admitStructure(workflow.id, judgedStructure(workflow.id, compiled, launchInput));
  return parseCommittedWorkflowControl({
    definitionIdentity: buildDefinitionIdentity(workflow, agents, identityOptions),
    workflowName: workflow.name,
    graph: compiled.graph,
    attempts: compiled.attempts,
    frontier: compiled.frontier,
    guardrails: compiled.guardrails,
    status: "ready",
    followUp: null,
    aggregateSeq: 0,
  });
}
