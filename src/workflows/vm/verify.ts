import type { ResolvedAgent } from "../agent-resolution.js";
import { WORKFLOW_INPUT_SOURCE_ID, type WorkflowDefinition } from "../workflow-schema.js";
import { authoredGuardrailLimits, compileWorkflowControl } from "./compile.js";
import type { WorkflowTransitionResult } from "./commands.js";
import { parseCommittedWorkflowControl, type CommittedWorkflowControl } from "./committed-control.js";
import { identityDefinitionIds, type DefinitionIdentityOptions } from "./definition-identity.js";
import type { WorkflowMachineContext } from "./control-types.js";
import type { DecodedWorkflowEvent } from "./events.js";
import { inRound, listAgentCount, roundOfNodeId, type FollowUpV10, type LogicalNode, type RepeatNode } from "./graph-types.js";
import { SAMPLED_LAUNCH, SAMPLED_LAUNCH_ITEMS, sampleItems } from "./list-expansion.js";
import { requireReducer } from "../reducers/registry.js";
import { structuralFindings, WorkflowStructureRejectedError } from "./structural-admission.js";
import { initializeWorkflow, transitionDecodedWorkflow } from "./transition.js";
import {
  parseWorkflowVerificationReport,
  type ProofFinding,
  type WorkflowVerificationFinding,
  type WorkflowVerificationReport,
  type VerificationUncertaintyKind,
  type WorkflowVerificationUncertainty,
} from "./verify-types.js";

const EXPLORATION_LIMIT = 20_000;

function errorText(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

function witnessed(name: string, target: string | null, message: string, witness: readonly string[]): WorkflowVerificationFinding {
  return { name, target, message, witness, noPathReason: null };
}

/** A proof finding: what the verifier proved, with the path that shows it.
 *  A launch never warns about one (refer to `launchVerificationWarnings`). */
function proved(name: ProofFinding["name"], target: string | null, message: string, witness: readonly string[]): ProofFinding {
  return { name, target, message, witness, noPathReason: null };
}

function unwitnessed(name: string, target: string | null, message: string, reason: string): WorkflowVerificationFinding {
  return { name, target, message, witness: null, noPathReason: reason };
}

function uncertainty(name: VerificationUncertaintyKind, target: string | null, detail: string): WorkflowVerificationUncertainty {
  return { name, target, detail };
}

function followUps(root: FollowUpV10 | null): readonly FollowUpV10[] {
  const result: FollowUpV10[] = [];
  let current = root;
  while (current) {
    result.push(current);
    current = current.then;
  }
  return result;
}

/** The structural defects of one control: everything structural admission
 *  finds, the `impossible_join` of a join that no group can fold among them,
 *  plus the defects that read node states, which admission never reads
 *  because a running graph changes them. */
function structuralDefects(control: CommittedWorkflowControl): WorkflowVerificationFinding[] {
  const findings: WorkflowVerificationFinding[] = [...structuralFindings(control)];
  const graph = control.graph;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const definitions = new Set(identityDefinitionIds(control.definitionIdentity));

  for (const edge of graph.dependencies) {
    if (byId.get(edge.dependsOn)?.state._tag === "cancelled") {
      findings.push(witnessed("cancelled_dependency", edge.nodeId, `Node "${edge.nodeId}" depends on cancelled node "${edge.dependsOn}".`, []));
    }
  }

  const workflowId = control.definitionIdentity.workflowDefinitionId;
  for (const node of graph.nodes) {
    if (node.workflowDefinitionId !== workflowId || node.ownership.workflowDefinitionId !== workflowId) {
      findings.push(witnessed("invalid_parent_ownership", node.id, `Node "${node.id}" does not belong to workflow "${workflowId}".`, []));
    }
    const references = node.kind === "agent" ? followUps(node.followUpV10 ?? null) : [];
    for (const reference of references) {
      if (!definitions.has(reference.step)) { // stored key of control v10
        findings.push(witnessed("invalid_then_target", reference.step, `Follow-up target "${reference.step}" is not in the compiled definition identity.`, [])); // stored key of control v10
      }
    }
  }
  return findings;
}

interface SyntheticHandoff {
  [field: string]: unknown;
}

/** The positive report of an agent whose output a join folds, when a later
 *  phase reads that join's output: the entries that the join's reducer
 *  gives every agent of a phase with a join, or the last phase of every
 *  item of a list, so the fold keeps them and the reader explores a
 *  non-empty output. Only a list or repeat over the join's items reads how
 *  many it kept, so only then does the report sample `items` entries, and a
 *  later quorum over them can need two; any other reader gets one. So a
 *  `while` repeat whose join no list reads keeps the entry in round 1 and
 *  is dry in round 2. Empty for any
 *  other agent: a join that no phase reads gives exploration nothing to
 *  decide, and its positive reports would only multiply the states. */
function joinReport(control: CommittedWorkflowControl, node: LogicalNode, definitionId: string, items: 1 | 2): SyntheticHandoff {
  const byId = new Map(control.graph.nodes.map((candidate) => [candidate.id, candidate]));
  const owner = ownerOf(byId, node);
  const list = owner?.kind === "item" ? ownerOf(byId, owner) : undefined;
  const join = owner?.kind === "phase" && owner.join !== null ? { node: owner, reducer: owner.join.reducer }
    : list?.kind === "list" && list.phases.at(-1)?.definitionId === definitionId ? { node: list, reducer: list.reducer }
      : undefined;
  if (join === undefined || !outputRead(control, join.node)) return {};
  const count = runsOver(control, join.node) ? items : 1;
  return { ...requireReducer(join.reducer.id, join.reducer.version).syntheticReport?.(join.reducer.params, join.reducer.contract, count) };
}

/** Whether a list or an `each` repeat runs over the items of `node`. */
function runsOver(control: CommittedWorkflowControl, node: LogicalNode): boolean {
  return control.graph.nodes.some((candidate) =>
    (candidate.kind === "list" && candidate.source.nodeId === node.id)
    || (candidate.kind === "repeat" && candidate.loop._tag === "each" && candidate.loop.source.nodeId === node.id));
}

/** Whether a phase reads the output of `node`: an `if` on its field, a list
 *  or repeat over its items, or the `while` of a repeat that it evaluates. */
function outputRead(control: CommittedWorkflowControl, node: LogicalNode): boolean {
  return runsOver(control, node) || control.graph.nodes.some((candidate) =>
    ((candidate.kind === "agent" || candidate.kind === "phase" || candidate.kind === "list") && candidate.condition?._tag === "field" && candidate.condition.nodeId === node.id)
    || (candidate.kind === "repeat" && evaluates(candidate, node)));
}

/** Whether `node` is the evaluator of round `round` of a `while` repeat. */
function evaluates(repeat: RepeatNode, node: LogicalNode): boolean {
  const place = roundOfNodeId(node.id);
  return repeat.loop._tag === "while" && place?.repeatNodeId === repeat.id && inRound(repeat.loop.evaluator, repeat.id, place.round) === node.id;
}

/** A synthetic handoff for one attempt. `items` is how many items each list
 *  that the attempt sources, and each join that folds it, holds: 0 for the
 *  empty handoff, 1 for the positive one, and 2 for the pair that
 *  exploration also tries when it differs from the positive one. */
function syntheticHandoff(
  control: CommittedWorkflowControl,
  node: LogicalNode,
  definitionId: string,
  items: 0 | 1 | 2,
): SyntheticHandoff {
  const positive = items > 0;
  const handoff: SyntheticHandoff = {};
  const agent = node.kind === "agent" && node.definitionId === definitionId;
  for (const candidate of control.graph.nodes) {
    if (candidate.kind === "while" && candidate.evaluator.step === definitionId) { // stored key of control v10
      handoff[candidate.evaluator.field] = positive ? `continue-${candidate.iteration}` : "";
    }
    if (candidate.kind === "for" && candidate.source.step === definitionId) { // stored key of control v10
      handoff[candidate.source.field] = positive ? [{ synthetic: true }] : [];
    }
    if (!agent) continue;
    if (candidate.kind === "repeat" && candidate.loop._tag === "while" && evaluates(candidate, node)) {
      handoff[candidate.loop.field] = positive ? `continue-${roundOfNodeId(node.id)?.round ?? 1}` : "";
    }
    if (candidate.kind === "repeat" && candidate.loop._tag === "each" && candidate.loop.source.nodeId === node.id) {
      handoff[candidate.loop.source.field] = Array.from({ length: items }, (_, index) => ({ id: `synthetic-${index + 1}` }));
    }
    if (candidate.kind === "list" && candidate.source.nodeId === node.id) {
      handoff[candidate.source.field] = sampleItems(candidate, items);
    }
    if ((candidate.kind === "agent" || candidate.kind === "phase" || candidate.kind === "list") && candidate.condition?._tag === "field" && candidate.condition.nodeId === node.id) {
      handoff[candidate.condition.field] = positive ? "present" : "";
    }
  }
  if (node.kind === "agent") {
    for (const reference of followUps(node.followUpV10 ?? null)) {
      if (reference.when) handoff[reference.when] = positive ? "present" : "";
    }
  }
  return items === 0 ? handoff : { ...handoff, ...joinReport(control, node, definitionId, items) };
}

/** Which outcomes exploration tries for `node`'s attempts: every outcome,
 *  each success or a fatal failure without the retry path, or only each
 *  success. */
type OutcomeScope = (control: CommittedWorkflowControl, node: LogicalNode) => "every" | "settle" | "success";

const EVERY_OUTCOME: OutcomeScope = () => "every";

const FINISHED_NODE_STATES: ReadonlySet<LogicalNode["state"]["_tag"]> = new Set(["completed", "failed", "blocked", "cancelled", "superseded", "skipped"]);

/** A failed item stops only itself, and every item runs the same phases, so
 *  the items of one list differ only in how many fail. The last unfinished
 *  item tries every outcome, which covers the retry path. The item before it
 *  also succeeds or fails, which covers a list whose items all fail and one
 *  whose items mix. Earlier items only succeed, so the exploration grows
 *  with the item count instead of with every combination of failures. Read
 *  the current graph because exploration expands lists as it proceeds. */
const lastItemsOutcomes: OutcomeScope = (control, node) => {
  const byId = new Map(control.graph.nodes.map((candidate) => [candidate.id, candidate]));
  for (let owner = ownerOf(byId, node); owner !== undefined; owner = ownerOf(byId, owner)) {
    if (owner.kind !== "item" || owner.ownership._tag === "workflow") continue;
    const { ordinal, ownership: { parentNodeId } } = owner;
    const later = control.graph.nodes.filter((candidate) =>
      candidate.kind === "item"
      && candidate.ownership._tag !== "workflow"
      && candidate.ownership.parentNodeId === parentNodeId
      && candidate.ordinal > ordinal
      && !FINISHED_NODE_STATES.has(candidate.state._tag)).length;
    return later === 0 ? "every" : later === 1 ? "settle" : "success";
  }
  return "every";
};

/** Narrow `scope` to success for each attempt of a repeat's round that the
 *  exploration adds after `start`. A later round runs the phases of the
 *  rounds before it, so the rounds that exist at the start already show
 *  every outcome that their agents can reach, and a failed agent there
 *  already shows that a round with a failure is not dry. The exploration
 *  then grows with the rounds, not with every order of outcomes in every
 *  round. */
function addedRoundsSucceed(start: CommittedWorkflowControl, scope: OutcomeScope): OutcomeScope {
  const existing = new Set(start.graph.nodes.flatMap((node) => node.ownership._tag === "round" ? [node.id] : []));
  return (current, node) => {
    const byId = new Map(current.graph.nodes.map((candidate) => [candidate.id, candidate]));
    for (let owner: LogicalNode | undefined = node; owner !== undefined; owner = ownerOf(byId, owner)) {
      if (owner.ownership._tag === "round" && !existing.has(owner.id)) return "success";
    }
    return scope(current, node);
  };
}

function syntheticEvents(result: WorkflowTransitionResult, scope: OutcomeScope = EVERY_OUTCOME): readonly DecodedWorkflowEvent[] {
  const context = result.state.context;
  if (result.command.kind === "commit") {
    const pending = context.pending;
    if (!pending) throw new Error("Workflow verifier received a commit command without a pending proposal");
    return [{ type: "COMMIT_SUCCEEDED", proposalId: pending.proposalId, aggregateSeq: pending.proposedCommitted.aggregateSeq }];
  }
  const preparation: DecodedWorkflowEvent[] = result.command.kind === "prepare_attempt" ? [{
    type: "ATTEMPT_STARTED",
    attemptId: result.command.attempt.attemptId,
    conversationId: `verification:${result.command.attempt.attemptId}`,
  }] : [];
  if (result.state.lifecycle === "ready") {
    return [...preparation, { type: "START" }, { type: "ABORT", reason: "synthetic terminal" }];
  }
  if (result.state.lifecycle === "paused") return [{ type: "ABORT", reason: "synthetic terminal" }];
  if (result.state.lifecycle !== "executing") return preparation;
  const attempt = context.committed.attempts.find(({ state }) => state._tag === "running");
  if (!attempt) return [...preparation, { type: "ADVANCE" }, { type: "ABORT", reason: "synthetic terminal" }];
  const node = context.committed.graph.nodes.find(({ id }) => id === attempt.logicalNodeId);
  if (!node) return [{ type: "ABORT", reason: "synthetic terminal" }];
  const conversationId = attempt.conversationId ?? `verification:${attempt.id}`;
  const success = (handoff: SyntheticHandoff): DecodedWorkflowEvent => ({
    type: "ATTEMPT_SUCCEEDED",
    outcome: { attemptId: attempt.id, conversationId, handoff, reassessment: null },
  });
  const empty = syntheticHandoff(context.committed, node, attempt.definitionId, 0);
  const positive = syntheticHandoff(context.committed, node, attempt.definitionId, 1);
  const pair = syntheticHandoff(context.committed, node, attempt.definitionId, 2);
  const successEvents = Object.keys(positive).length === 0
    ? [success(empty)]
    : [success(empty), success(positive), ...(JSON.stringify(pair) === JSON.stringify(positive) ? [] : [success(pair)])];
  const outcomes = scope(context.committed, node);
  if (outcomes === "success") return [...preparation, ...successEvents];
  const retry: DecodedWorkflowEvent = {
    type: "ATTEMPT_FAILED",
    failure: { attemptId: attempt.id, kind: "handoff", reason: `synthetic retry ${attempt.iteration}`, conversationId },
  };
  return [
    ...preparation,
    ...successEvents,
    ...(outcomes === "every" ? [retry] : []),
    {
      type: "ATTEMPT_FAILED",
      failure: { attemptId: attempt.id, kind: "fatal", reason: "synthetic failure", conversationId },
    },
    { type: "ABORT", reason: "synthetic terminal" },
  ];
}

function controlKey(control: CommittedWorkflowControl) {
  return {
    graph: control.graph,
    attempts: control.attempts,
    frontier: control.frontier,
    guardrails: control.guardrails,
    status: control.status,
  };
}

function serializeTransition(result: WorkflowTransitionResult): string {
  const context = result.state.context;
  return JSON.stringify({
    lifecycle: result.state.lifecycle,
    committed: controlKey(context.committed),
    pending: context.pending && {
      proposed: controlKey(context.pending.proposedCommitted),
      nextLifecycle: context.pending.nextLifecycle,
    },
    command: result.command.kind === "commit" ? { kind: "commit" } : result.command,
  });
}

type WorkflowStatePath = WorkflowTransitionResult & { readonly witness: readonly string[] };

function eventPath(path: WorkflowStatePath): string[] {
  return [...path.witness];
}

interface Exploration {
  readonly paths: readonly WorkflowStatePath[];
  readonly contexts: readonly WorkflowMachineContext[];
}

/** Drive the production machine from `control` through every synthetic
 *  event that `scope` admits. The initial transition decodes the control
 *  strictly; each later state is the machine's own output, so exploration
 *  drives it with the decoded transition, as the production host does. */
function explore(control: CommittedWorkflowControl, scope: OutcomeScope = EVERY_OUTCOME): Exploration {
  const initial = initializeWorkflow(control);
  const paths: WorkflowStatePath[] = [{ ...initial, witness: ["INITIALIZE"] }];
  const visited = new Set([serializeTransition(initial)]);
  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    if (!path) continue;
    for (const event of syntheticEvents(path, scope)) {
      const result = transitionDecodedWorkflow(path.state, event);
      const key = serializeTransition(result);
      if (visited.has(key)) continue;
      if (paths.length >= EXPLORATION_LIMIT) throw new Error("Traversal limit exceeded");
      visited.add(key);
      paths.push({ ...result, witness: [...path.witness, event.type] });
    }
  }
  return {
    paths,
    contexts: paths.map(({ state }) => state.context),
  };
}

interface UnparsedControl {
  readonly graph?: { readonly nodes?: readonly { readonly id?: string; readonly ownership?: object }[] };
}

function missingOwnershipFinding(value: UnparsedControl): WorkflowVerificationFinding | undefined {
  const nodes = value.graph?.nodes;
  if (!Array.isArray(nodes)) return undefined;
  for (const node of nodes) {
    if (!node || "ownership" in node) continue;
    return unwitnessed(
      "missing_ownership",
      typeof node.id === "string" && node.id.length > 0 ? node.id : "unknown-node",
      "A logical node has no ownership record.",
      "Strict control decoding failed before machine initialization.",
    );
  }
  return undefined;
}

/** `reassessSlot` states whether a reassessment, whose model-authored
 *  proposal changes the remaining work, can run: a repeat with a `reassess`
 *  phase, or a `for` node of control from before phases whose follow-up
 *  position can be a `reassess` slot. An authored workflow knows it from its
 *  resolved agents. Control from before phases kept one body shape for
 *  `then`, `reassess`, and a sequence of two records, so control alone can
 *  only say that the second record of a body of two might be one. */
function verificationUncertainties(control: CommittedWorkflowControl, reassessSlot: boolean): WorkflowVerificationUncertainty[] {
  const result = [
    uncertainty("runtime_handoff_values", null, "Synthetic handoffs cover empty and positive values, not every runtime value."),
    ...(reassessSlot
      ? [uncertainty("model_reassessment_content", null, "Model-authored reassessment proposals are not enumerable before runtime.")]
      : []),
  ];
  const byId = new Map(control.graph.nodes.map((node) => [node.id, node]));
  for (const node of control.graph.nodes) {
    if (node.kind === "for" || (node.kind === "repeat" && node.loop._tag === "each")) {
      result.push(uncertainty("runtime_for_array_size", node.id, "The verifier samples empty and one-item lists; the runtime list length is dynamic."));
    }
    if (node.kind === "repeat" && node.loop._tag === "while") {
      result.push(uncertainty("runtime_round_count", node.id, `The verifier reaches a dry round with synthetic items, and explores only the success of the agents of each round that it adds. The runtime round count is dynamic, up to ${node.loop.max}. Structural admission counts ${node.loop.max}.`));
    }
    if (node.kind === "list") {
      const admitted = `structural admission covers the width of ${node.width}${node.votes === undefined ? "" : `, with ${node.votes} votes on each item`}`;
      const source = node.source.nodeId === WORKFLOW_INPUT_SOURCE_ID ? "input" : byId.get(node.source.nodeId)?.kind === "agent" ? "agent" : "join";
      result.push(uncertainty("runtime_map_width", node.id, {
        input: `The verifier samples a launch input of ${Math.min(SAMPLED_LAUNCH_ITEMS, node.width)} items; a launch admits the exact item count of its input, up to the list's max when the list declares one.`,
        agent: `The verifier samples 0, 1, and 2 items; ${admitted}.`,
        join: `The verifier samples the items that the join of its source folds from synthetic reports of 0, 1, and 2 items; ${admitted}.`,
      }[source]));
      if (listAgentCount(node) > 1) {
        result.push(uncertainty("sampled_branch_outcomes", node.id, "The verifier explores every outcome of the last unfinished item of this list, success or failure of the item before it, and only success for the other items; every item runs the same phases."));
      }
    }
  }
  return result;
}

/** Whether a control can run a reassessment (refer to
 *  `verificationUncertainties`). */
function controlReassesses(control: CommittedWorkflowControl): boolean {
  return control.graph.nodes.some((node) => (node.kind === "for" && node.body.length === 2) || (node.kind === "repeat" && node.loop._tag === "each" && node.loop.reassess !== null));
}

function verifyControl(control: CommittedWorkflowControl, reassessSlot: boolean): WorkflowVerificationReport {
  const defects = structuralDefects(control);
  const findings: ProofFinding[] = [];
  let exploration: Exploration | undefined;
  try {
    exploration = explore(control, addedRoundsSucceed(control, lastItemsOutcomes));
  } catch (error) {
    const message = errorText(error instanceof Error ? error : String(error));
    if (message === "Traversal limit exceeded") {
      return parseWorkflowVerificationReport({
        result: defects.length > 0 ? "invalid" : "partially_proved",
        findings: [...defects, proved("exploration_limit", null, `Production-machine exploration reached its ${EXPLORATION_LIMIT}-state bound.`, [])],
        uncertainties: [uncertainty("bounded_graph_exploration", null, `States beyond the ${EXPLORATION_LIMIT}-state exploration bound were not proved.`), ...verificationUncertainties(control, reassessSlot).filter(({ name }) => name === "sampled_branch_outcomes")],
      });
    }
    return parseWorkflowVerificationReport({
      result: "invalid",
      findings: [...defects, witnessed("machine_oracle_error", null, `Production-machine exploration failed: ${message}`, [])],
      uncertainties: [],
    });
  }

  const reached = new Map<string, string[]>();
  const retries = new Map<string, string[]>();
  for (const path of exploration.paths) {
    const context = path.state.context;
    const controls = context.pending ? [context.committed, context.pending.proposedCommitted] : [context.committed];
    for (const candidate of controls) {
      for (const node of candidate.graph.nodes) {
        if ((node.state._tag === "running" || node.state._tag === "completed") && !reached.has(node.id)) {
          reached.set(node.id, eventPath(path));
        }
      }
      for (const attempt of candidate.attempts) {
        if (attempt.provenance._tag === "retry" && !retries.has(attempt.logicalNodeId)) {
          retries.set(attempt.logicalNodeId, eventPath(path));
        }
      }
    }
  }
  for (const node of control.graph.nodes) {
    if (["pending", "ready", "running"].includes(node.state._tag) && !reached.has(node.id)) {
      defects.push(witnessed("unreachable_work", node.id, `Logical node "${node.id}" cannot reach execution through the production machine.`, []));
    }
  }

  for (const status of ["completed", "failed"] as const) {
    const terminal = exploration.paths.find((path) => {
      const context = path.state.context;
      return context.committed.status === status;
    });
    if (terminal) findings.push(proved("terminal_reachable", status, `The production machine reaches ${status}.`, eventPath(terminal)));
  }
  for (const [nodeId, witness] of retries) {
    findings.push(proved("retry_reachable", nodeId, `The production machine reaches a bounded retry for "${nodeId}".`, witness));
  }

  for (const node of control.graph.nodes) {
    const bound = node.kind === "while" ? node.maxIterations : node.kind === "repeat" && node.loop._tag === "while" ? node.loop.max : undefined;
    if (bound !== undefined && (node.kind === "while" || node.kind === "repeat")) {
      const round = roundCounter(node);
      const name = node.kind === "while" ? `While node "${node.id}"` : `Repeat node "${node.id}"`;
      const reaches = (context: WorkflowMachineContext, past: (count: number) => boolean): boolean => {
        const controls = context.pending ? [context.committed, context.pending.proposedCommitted] : [context.committed];
        return controls.some((candidate) => past(round(candidate)));
      };
      const boundPath = exploration.paths.find((path) => reaches(path.state.context, (count) => count === bound));
      if (boundPath) {
        findings.push(proved("while_bound", node.id, `${name} reaches and stops at its authored bound ${bound}.`, eventPath(boundPath)));
      }
      const exceeded = exploration.contexts.some((context) => reaches(context, (count) => count > bound));
      if (exceeded) defects.push(witnessed("while_bound_exceeded", node.id, `${name} exceeded its authored bound.`, []));
    }
    if (node.kind === "for" || (node.kind === "repeat" && node.loop._tag === "each")) {
      const name = node.kind === "for" ? `For node "${node.id}"` : `Repeat node "${node.id}"`;
      findings.push(proved("array_bounded_for", node.id, `${name} expands only from its runtime source list.`, reached.get(node.id) ?? []));
    }
  }

  const uncertainties = verificationUncertainties(control, reassessSlot);
  return parseWorkflowVerificationReport({
    result: defects.length > 0 ? "invalid" : uncertainties.length > 0 ? "partially_proved" : "proved",
    findings: [...defects, ...findings],
    uncertainties,
  });
}

/** How far one loop got in a control: the iteration of a `while` node of
 *  control from before phases, or the latest round of a repeat. */
function roundCounter(loop: Extract<LogicalNode, { kind: "while" | "repeat" }>): (control: CommittedWorkflowControl) => number {
  return (control) => loop.kind === "while"
    ? control.graph.nodes.reduce((count, item) => item.kind === "while" && item.id === loop.id ? Math.max(count, item.iteration) : count, 0)
    : control.graph.nodes.reduce((count, item) => item.ownership._tag === "round" && item.ownership.parentNodeId === loop.id ? Math.max(count, item.ownership.round) : count, 0);
}

/** Verify compiled runtime control with structural checks and production-machine graph exploration. */
export function verifyInstantiatedWorkflow(value: UnparsedControl): WorkflowVerificationReport {
  let control: CommittedWorkflowControl;
  try {
    control = parseCommittedWorkflowControl(value);
  } catch (error) {
    const finding = missingOwnershipFinding(value) ?? unwitnessed(
      "schema_invalid",
      "control",
      `Concrete workflow control failed strict decode: ${errorText(error instanceof Error ? error : String(error))}`,
      "Strict control decoding failed before machine initialization.",
    );
    return parseWorkflowVerificationReport({ result: "invalid", findings: [finding], uncertainties: [] });
  }
  return verifyControl(control, controlReassesses(control));
}

/** Verify the control that a session's stored facts replay to, from the
 *  state the session is in now. Exploration starts at that state, so work
 *  that already settled is not explored again, and each expanded group
 *  explores every outcome of only its last unfinished item. */
export function verifyRecoveredWorkflow(control: CommittedWorkflowControl): WorkflowVerificationReport {
  return verifyControl(control, controlReassesses(control));
}

function ownerOf(byId: ReadonlyMap<string, LogicalNode>, node: LogicalNode): LogicalNode | undefined {
  return node.ownership._tag === "workflow" ? undefined : byId.get(node.ownership.parentNodeId);
}

/** Compile and verify an authored workflow without executing workers or
 *  effects. A workflow with a phase over the launch input compiles with the
 *  sampled launch that load-time validation also judges. */
export function verifyAuthoredWorkflow(
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
  identityOptions: DefinitionIdentityOptions,
): WorkflowVerificationReport {
  let control: CommittedWorkflowControl;
  try {
    control = compileWorkflowControl(workflow, agents, identityOptions, authoredGuardrailLimits(workflow), SAMPLED_LAUNCH);
  } catch (error) {
    if (error instanceof WorkflowStructureRejectedError) {
      return parseWorkflowVerificationReport({
        result: "invalid",
        findings: error.findings.map(({ name, target, message }) => witnessed(name, target, message, [])),
        uncertainties: [],
      });
    }
    return parseWorkflowVerificationReport({
      result: "invalid",
      findings: [unwitnessed(
        "compile_error",
        workflow.id || "unknown-workflow",
        `Authored workflow compilation failed: ${errorText(error instanceof Error ? error : String(error))}`,
        "Compilation failed before machine initialization.",
      )],
      uncertainties: [],
    });
  }
  return verifyControl(control, [...agents.values()].some((agent) => agent.reassesses));
}
