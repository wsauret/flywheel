import { assertNever } from "../../infra/assert-never.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import type { HandoffIssue } from "../output-contract/facts.js";
import type { ReassessmentChange, ReassessmentProposal } from "./events.js";
import { repeatRun, roundOfNodeId, type Attempt, type RepeatNode } from "./graph-types.js";
import { initialAttempts, insertNode, replaceNode, withNodeState } from "./graph-changes.js";
import { allRequiredJoinEdges, normalizeLogicalNodeV3 } from "./historical-normalization.js";
import { admitStructureChange, queuedAttempts } from "./structural-admission.js";
import type { ReassessmentPayload, RetiredReassessmentPayload } from "./reassessment-contract.js";

interface ReassessmentResult {
  readonly control: CommittedWorkflowControl;
  readonly acceptedChanges: readonly ReassessmentChange[];
}

/** Settle a logical node once none of its attempts can still run. A blocked
 *  attempt keeps the node blocked until a lineage-linked corrective attempt
 *  completes, so a workflow can never report completion over stopped work. */
export function settleNode(control: CommittedWorkflowControl, nodeId: string): CommittedWorkflowControl {
  const attempts = control.attempts.filter((attempt) => attempt.logicalNodeId === nodeId);
  if (attempts.length === 0 || attempts.some(({ state }) => state._tag === "pending" || state._tag === "running")) {
    return control;
  }
  const blocked = attempts.find((attempt) => attempt.state._tag === "blocked" && !isCorrected(control, attempt));
  const failed = attempts.find((attempt) => attempt.state._tag === "failed" && !isCorrected(control, attempt));
  return replaceNode(control, nodeId, (node) => withNodeState(
    node,
    blocked?.state._tag === "blocked"
      ? { _tag: "blocked", reason: blocked.state.reason, causedBy: [blocked.id] }
      : failed?.state._tag === "failed"
        ? failed.state
        : { _tag: "completed" },
  ));
}

/** The node of a failed attempt fails with it. The attempts of a node run in
 *  order, as a retry, and in control from before phases a `then` follow-up,
 *  a loop body, and the items of a `for` loop, run one after another, so
 *  the node's attempts that have not run are
 *  skipped, and the output of an earlier attempt of the node is never read
 *  as the node's result. */
export function failNode(control: CommittedWorkflowControl, failed: Attempt, reason: string): CommittedWorkflowControl {
  const skipped: CommittedWorkflowControl = {
    ...control,
    attempts: control.attempts.map((attempt) => attempt.logicalNodeId === failed.logicalNodeId && attempt.state._tag === "pending"
      ? { ...attempt, state: { _tag: "skipped", reason: `Attempt "${failed.id}" of its node failed` } }
      : attempt),
  };
  return replaceNode(skipped, failed.logicalNodeId, (node) => withNodeState(node, { _tag: "failed", reason }));
}

/** A blocked attempt is corrected only by a completed attempt that reassessment
 *  created from it; its authored reassessment child never settles it. */
function isCorrected(control: CommittedWorkflowControl, blocked: Attempt): boolean {
  return control.attempts.some((attempt) =>
    attempt.parentAttemptId === blocked.id
    && (blocked.state._tag === "blocked" ? attempt.provenance._tag === "reassessment"
      : attempt.provenance._tag === "retry" || attempt.provenance._tag === "continuation")
    && (attempt.state._tag === "completed" || isCorrected(control, attempt))
  );
}

function eligibleNodeTarget(control: CommittedWorkflowControl, nodeId: string): boolean {
  const node = control.graph.nodes.find(({ id }) => id === nodeId);
  if (!node || (node.state._tag !== "pending" && node.state._tag !== "ready")) return false;
  return !control.attempts.some((attempt) =>
    attempt.logicalNodeId === nodeId
    && (attempt.state._tag === "running" || attempt.state._tag === "completed")
  );
}

function acceptedChanges(
  control: CommittedWorkflowControl,
  changes: readonly ReassessmentChange[],
  ownerAttempt: Attempt,
): readonly ReassessmentChange[] {
  return changes.filter((change) => {
    switch (change.kind) {
      case "drop_item":
      case "replace_item": return remainingItemIds(control, change.repeatNodeId).includes(change.itemId);
      case "insert_item": return remainingItemIds(control, change.repeatNodeId).includes(change.afterItemId) || currentItemId(control, change.repeatNodeId) === change.afterItemId;
      // A blocked source stays immutable: `replace` corrects it with new work
      // rather than settling it, and `skip` cannot dispose of it at all.
      case "skip": return control.attempts.some(({ id, state }) =>
        id === change.targetAttemptId && state._tag === "pending"
      );
      case "replace": return control.attempts.some(({ id, state }) =>
        id === change.targetAttemptId && (state._tag === "pending" || state._tag === "blocked")
      );
      case "insert_after": return control.attempts.some(({ id, state }) =>
        id === change.targetAttemptId
        && (
          (state._tag === "pending" && change.afterAttemptId === id)
          || (
            id === ownerAttempt.parentAttemptId
            && (state._tag === "completed" || state._tag === "blocked")
            && change.afterAttemptId === ownerAttempt.id
          )
        )
      );
      case "cancel_node":
      case "supersede_node": return eligibleNodeTarget(control, change.nodeId);
      case "add_node":
      case "add_dependency":
      case "add_join": return true;
      default: return assertNever(change);
    }
  });
}

function attemptsCreated(change: ReassessmentChange): number {
  switch (change.kind) {
    case "add_node": return change.node.kind === "step" ? 1 : change.node.kind === "while" ? change.node.body.length : 0;
    case "drop_item":
    case "replace_item":
    case "insert_item": return 0;
    case "replace":
    case "insert_after": return 1;
    case "skip":
    case "add_dependency":
    case "add_join":
    case "cancel_node":
    case "supersede_node": return 0;
  }
}

function mutationCount(change: ReassessmentChange): number {
  return change.kind === "replace" || change.kind === "replace_item" ? 2 : 1;
}

/** The items that a change adds after launch: an inserted attempt of
 *  control from before phases, or an inserted item of a repeat (D13). */
function insertsOf(change: ReassessmentChange): number {
  return change.kind === "insert_item" ? 1 : attemptsCreated(change);
}

function assertBudget(
  control: CommittedWorkflowControl,
  ownerAttempt: Attempt,
  proposalId: string,
  changes: readonly ReassessmentChange[],
): void {
  const attempts = changes.reduce((total, change) => total + attemptsCreated(change), 0);
  const inserts = changes.reduce((total, change) => total + insertsOf(change), 0);
  const mutations = changes.reduce((total, change) => total + mutationCount(change), 0);
  const accounting = control.guardrails;
  if (queuedAttempts(control) + attempts > accounting.maxAttempts) {
    throw new Error(`Workflow control "reassess:${proposalId}" rejected insert_after: max attempts (${accounting.maxAttempts})`);
  }
  if (accounting.insertsUsed + inserts > accounting.maxInserts) {
    throw new Error(`Workflow control "reassess:${proposalId}" rejected insert_after: max inserts (${accounting.maxInserts})`);
  }
  const used = accounting.attemptMutationsUsed.find(({ attemptId }) => attemptId === ownerAttempt.id)?.used;
  if (used === undefined) throw new Error(`Workflow invariant rejected missing guardrail accounting for attempt "${ownerAttempt.id}"`);
  if (used + mutations > accounting.maxMutationsPerAttempt) {
    throw new Error(`Workflow control "reassess:${proposalId}" rejected mutation: attempt "${ownerAttempt.id}" exceeds mutation cap (${accounting.maxMutationsPerAttempt})`);
  }
}

function skipAttempt(control: CommittedWorkflowControl, attemptId: string, reason: string): CommittedWorkflowControl {
  return {
    ...control,
    attempts: control.attempts.map((attempt) =>
      attempt.id === attemptId && attempt.state._tag === "pending"
        ? { ...attempt, state: { _tag: "skipped", reason } }
        : attempt
    ),
  };
}

function skipNodeAttempts(control: CommittedWorkflowControl, nodeId: string, reason: string): CommittedWorkflowControl {
  return {
    ...control,
    attempts: control.attempts.map((attempt) =>
      attempt.logicalNodeId === nodeId && attempt.state._tag === "pending"
        ? { ...attempt, state: { _tag: "skipped", reason } }
        : attempt
    ),
  };
}

function reassessmentAttempt(
  control: CommittedWorkflowControl,
  change: Extract<ReassessmentChange, { kind: "replace" | "insert_after" }>,
): Attempt {
  const target = control.attempts.find(({ id }) => id === change.targetAttemptId);
  if (!target) throw new Error(`Workflow invariant rejected missing reassessment target "${change.targetAttemptId}"`);
  const sequence = control.attempts.reduce(
    (maximum, attempt) => attempt.logicalNodeId === target.logicalNodeId ? Math.max(maximum, attempt.sequence) : maximum,
    0,
  ) + 1;
  return {
    ...target,
    id: change.attemptId,
    sequence,
    iteration: 1,
    resumeRevertCount: 0,
    provenance: { _tag: "reassessment" },
    state: { _tag: "pending" },
    // Corrective work keeps the lineage of the blocked source it replaces or
    // follows, so settling can tell a correction from an ordinary follow-up.
    parentAttemptId: target.state._tag === "blocked" ? target.id : null,
    conversationId: null,
    handoff: null,
    priorRetryFeedback: null,
    item: change.forItem,
  };
}

function insertAttemptAfter(
  control: CommittedWorkflowControl,
  targetAttemptId: string,
  attempt: Attempt,
): CommittedWorkflowControl {
  if (control.attempts.some(({ id }) => id === attempt.id)) {
    throw new Error(`Workflow invariant rejected duplicate reassessment attempt "${attempt.id}"`);
  }
  const index = control.attempts.findIndex(({ id }) => id === targetAttemptId);
  if (index < 0) throw new Error(`Workflow invariant rejected missing reassessment target "${targetAttemptId}"`);
  return {
    ...control,
    attempts: [
      ...control.attempts.slice(0, index + 1),
      attempt,
      ...control.attempts.slice(index + 1),
    ],
    guardrails: {
      ...control.guardrails,
      attemptMutationsUsed: [...control.guardrails.attemptMutationsUsed, { attemptId: attempt.id, used: 0 }],
    },
  };
}



function charge(
  control: CommittedWorkflowControl,
  ownerAttempt: Attempt,
  changes: readonly ReassessmentChange[],
): CommittedWorkflowControl {
  const inserts = changes.reduce((total, change) => total + insertsOf(change), 0);
  const mutations = changes.reduce((total, change) => total + mutationCount(change), 0);
  return {
    ...control,
    guardrails: {
      ...control.guardrails,
      insertsUsed: control.guardrails.insertsUsed + inserts,
      attemptMutationsUsed: control.guardrails.attemptMutationsUsed.map((entry) =>
        entry.attemptId === ownerAttempt.id ? { ...entry, used: entry.used + mutations } : entry
      ),
    },
  };
}

/** The node or attempt that one change acts on, when it names one. */
interface ChangeTarget {
  readonly nodeId?: string;
  readonly attemptId?: string;
}

function changeTarget(change: ReassessmentChange): ChangeTarget {
  switch (change.kind) {
    case "skip":
    case "replace":
    case "insert_after": return { attemptId: change.targetAttemptId };
    case "cancel_node":
    case "supersede_node": return { nodeId: change.nodeId };
    case "add_dependency": return { nodeId: change.dependency.nodeId };
    case "add_join": return { nodeId: change.join.nodeId };
    case "add_node":
    case "drop_item":
    case "replace_item":
    case "insert_item": return {};
  }
}

/** List expansion alone shapes a list: its items and agents come from the
 *  frozen manifest, and its join folds every slot. A repeat alone adds its
 *  rounds. So a graph change of a reassessment refuses a target that is a
 *  list, an item, or a repeat, or that one owns. */
function refuseMapTargets(control: CommittedWorkflowControl, proposal: ReassessmentProposal, changes: readonly ReassessmentChange[]): void {
  for (const change of changes) {
    const { nodeId, attemptId } = changeTarget(change);
    const node = nodeId === undefined ? undefined : control.graph.nodes.find(({ id }) => id === nodeId);
    const attempt = attemptId === undefined ? undefined : control.attempts.find(({ id }) => id === attemptId);
    const owner = node?.ownership ?? attempt?.ownership;
    if (node?.kind === "list" || node?.kind === "item" || node?.kind === "repeat" || owner?._tag === "list" || owner?._tag === "item" || owner?._tag === "round") {
      throw new Error(`Reassessment "${proposal.proposalId}" rejected ${change.kind}: target "${nodeId ?? attemptId}" belongs to a list or a repeat, which only expansion and rounds change`);
    }
  }
}

/** Apply one accepted reassessment group without selecting frontier work or committing effects. */
export function applyReassessment(
  control: CommittedWorkflowControl,
  proposal: ReassessmentProposal,
  ownerAttempt: Attempt,
): ReassessmentResult {
  const accepted = acceptedChanges(control, proposal.changes, ownerAttempt);
  if (accepted.length === 0) return { control, acceptedChanges: accepted };
  refuseMapTargets(control, proposal, accepted);
  assertBudget(control, ownerAttempt, proposal.proposalId, accepted);
  let proposed = control;
  const insertionAnchors = new Map<string, string>();
  for (const change of accepted) {
    switch (change.kind) {
      case "skip": {
        const target = proposed.attempts.find(({ id }) => id === change.targetAttemptId);
        if (!target) throw new Error(`Workflow invariant rejected missing reassessment target "${change.targetAttemptId}"`);
        proposed = settleNode(skipAttempt(proposed, target.id, change.reason), target.logicalNodeId);
        break;
      }
      case "cancel_node":
        proposed = replaceNode(proposed, change.nodeId, (node) => withNodeState(node, {
          _tag: "cancelled",
          reason: change.reason,
          causedBy: [proposal.ownerNodeId],
        }));
        proposed = skipNodeAttempts(proposed, change.nodeId, change.reason);
        break;
      case "supersede_node":
        proposed = replaceNode(proposed, change.nodeId, (node) => withNodeState(node, {
          _tag: "superseded",
          reason: change.reason,
          replacementNodeId: change.replacementNodeId,
        }));
        proposed = skipNodeAttempts(proposed, change.nodeId, change.reason);
        break;
      case "replace": {
        const target = proposed.attempts.find(({ id }) => id === change.targetAttemptId);
        if (!target) throw new Error(`Workflow invariant rejected missing reassessment target "${change.targetAttemptId}"`);
        const replacement = reassessmentAttempt(proposed, change);
        proposed = skipAttempt(proposed, target.id, change.reason);
        proposed = insertAttemptAfter(proposed, target.id, replacement);
        break;
      }
      case "insert_after": {
        const inserted = reassessmentAttempt(proposed, change);
        const anchor = insertionAnchors.get(change.afterAttemptId) ?? change.afterAttemptId;
        proposed = insertAttemptAfter(proposed, anchor, inserted);
        insertionAnchors.set(change.afterAttemptId, inserted.id);
        break;
      }
      case "add_node": {
        const node = normalizeLogicalNodeV3(change.node);
        proposed = insertNode(proposed, node, initialAttempts(node, change.forItem, { _tag: "reassessment" }));
        break;
      }
      case "drop_item":
      case "replace_item":
      case "insert_item":
        proposed = withItemChange(proposed, change);
        break;
      case "add_dependency":
        proposed = { ...proposed, graph: { ...proposed.graph, dependencies: [...proposed.graph.dependencies, change.dependency] } };
        break;
      case "add_join":
        // The frozen all-required join states dependency edges in the
        // current graph; the current join folds a list only.
        proposed = { ...proposed, graph: { ...proposed.graph, dependencies: allRequiredJoinEdges(proposed.graph.dependencies, [change.join]) } };
        break;
    }
  }
  // The proposal passes the same structural admission as compiled control,
  // judged by the findings it adds. An inserted attempt copies the ownership
  // of the attempt it follows or replaces, so it takes its anchor's owner.
  admitStructureChange(control, proposed);
  return { control: charge(proposed, ownerAttempt, accepted), acceptedChanges: accepted };
}

/** The reassess attempt that wrote the payload. */
interface ReassessmentOwner {
  readonly attemptId: string;
  readonly logicalNodeId: string;
}

/** The committed control a reassessment payload is judged against. */
export type ReassessmentControl = Pick<CommittedWorkflowControl, "attempts" | "graph">;

/** The id of an item: its `id` field. Validation proves that every `each`
 *  source of a `reassess` phase declares it. */
function itemIdOf(item: Attempt["item"]): string | undefined {
  if (item === null || typeof item !== "object" || Array.isArray(item) || !("id" in item)) return undefined;
  return typeof item.id === "string" ? item.id : undefined;
}

function phaseId(attempt: Pick<Attempt, "item">) {
  return itemIdOf(attempt.item);
}

type ControlAttempt = ReassessmentControl["attempts"][number];

/** The reassessment's own attempt and the settled phase it follows. */
interface ReassessmentSource {
  readonly ownerAttempt: ControlAttempt | undefined;
  readonly sourcePhase: ControlAttempt | undefined;
}

function reassessmentSource(owner: ReassessmentOwner, control: ReassessmentControl): ReassessmentSource {
  const ownerAttempt = control.attempts.find(({ id }) => id === owner.attemptId);
  const parentAttemptId = ownerAttempt?.parentAttemptId ?? null;
  const sourcePhase = parentAttemptId === null ? undefined : control.attempts.find(({ id }) => id === parentAttemptId);
  return { ownerAttempt, sourcePhase };
}

/** Where one change acts in committed control. */
interface ChangeRoute {
  readonly target: ControlAttempt;
  /** The change inserts after the settled phase this reassessment follows,
   *  so the insertion anchors after the reassessment's own attempt. */
  readonly anchorsAfterSource: boolean;
}

/** The committed attempt one change acts on, or undefined when no eligible
 *  phase work carries its `phase_id`. A drop acts on a queued phase. A
 *  replace acts on the blocked source phase it corrects, else on a queued
 *  phase. An insert acts on a queued phase, else on the settled source
 *  phase. Throws when two queued attempts carry the id, which the live-id
 *  rule makes impossible for committed control. */
function changeRoute(change: RetiredReassessmentPayload["changes"][number], source: ReassessmentSource, control: ReassessmentControl): ChangeRoute | undefined {
  const pendingTargets = control.attempts.filter((attempt) =>
    attempt.state._tag === "pending" && phaseId(attempt) === change.phase_id
  );
  if (pendingTargets.length > 1) {
    throw new Error(
      `Workflow invariant rejected ambiguous reassessment target "${change.phase_id}": ${pendingTargets.length} pending phase attempts carry that id`,
    );
  }
  const { ownerAttempt, sourcePhase } = source;
  const settledSource = ownerAttempt
    && (sourcePhase?.state._tag === "completed" || sourcePhase?.state._tag === "blocked")
    && phaseId(sourcePhase) === change.phase_id
      ? sourcePhase
      : undefined;
  const insertAnchor = change.action === "insert" ? settledSource : undefined;
  const blockedSource = change.action === "replace" && settledSource?.state._tag === "blocked"
    ? settledSource
    : undefined;
  // A blocked source outranks any pending attempt that carries the same phase
  // id: the correction this reassessment owes belongs to the attempt that
  // blocked, so lineage never points at unrelated queued work.
  const target = blockedSource ?? pendingTargets[0] ?? insertAnchor;
  return target ? { target, anchorsAfterSource: insertAnchor !== undefined } : undefined;
}

/** Committed-control invariants a reassessment payload must satisfy before it
 *  can become a proposal. They are proven from committed control, never from
 *  the payload's prose: every change names eligible phase work, a blocked
 *  parent phase must be corrected by this reassessment, and every proposed
 *  phase id must name at most one unit of live work so routing can never
 *  resolve to an attempt the author did not mean. Only a corrective chain that
 *  a build before blocked retirement committed has a blocked parent; remove
 *  that check with the replay arms after 2027-04-03. */
function retiredReassessmentIssues(
  payload: RetiredReassessmentPayload,
  owner: ReassessmentOwner,
  control: ReassessmentControl,
): HandoffIssue[] {
  const issues: HandoffIssue[] = [];
  const source = reassessmentSource(owner, control);
  for (const [index, change] of payload.changes.entries()) {
    if (changeRoute(change, source, control)) continue;
    issues.push({
      path: `changes.${index}.phase_id`,
      message: `Phase id "${change.phase_id}" names no phase work this change can act on`,
      hint: "Name a queued phase. An insert can also name the phase this reassessment follows, and a replace can name that phase when it is blocked.",
    });
  }
  const blockedPhase = source.sourcePhase?.state._tag === "blocked" ? phaseId(source.sourcePhase) : undefined;
  // Only a blocked phase has a correction the control model can express; a
  // blocked attempt without phase work has no `replace`/`insert` target, so it
  // settles through the blocked node instead of through this reassessment.
  if (typeof blockedPhase === "string") {
    const corrects = payload.changes.some((change) =>
      change.action !== "drop" && change.phase_id === blockedPhase
    );
    if (!corrects) {
      issues.push({
        path: "changes",
        message: `Phase "${blockedPhase}" is blocked, so this reassessment must correct it`,
        hint: `Add a change whose action is "replace" or "insert" and whose phase_id is "${blockedPhase}".`,
      });
    }
  }
  const livePhaseIds = new Set(
    control.attempts
      .filter(({ state }) => state._tag === "pending" || state._tag === "running")
      .map((attempt) => phaseId(attempt)),
  );
  const proposedPhaseIds = new Set<string>();
  for (const [index, change] of payload.changes.entries()) {
    if (change.action === "drop") continue;
    const proposedId = change.phase.id;
    if (proposedPhaseIds.has(proposedId)) {
      issues.push({
        path: `changes.${index}.phase.id`,
        message: `Phase id "${proposedId}" is proposed twice by this reassessment`,
        hint: "Give every proposed phase its own id.",
      });
    }
    proposedPhaseIds.add(proposedId);
    // A replace that keeps its target's id renames nothing, so that target is
    // the one live unit allowed to carry the proposed id. A replace that
    // corrects the blocked phase targets that settled attempt instead, so live
    // phase work carrying the same id stays a second unit and must be renamed.
    const keepsTargetId = change.action === "replace"
      && change.phase_id === proposedId
      && change.phase_id !== blockedPhase;
    if (!keepsTargetId && livePhaseIds.has(proposedId)) {
      issues.push({
        path: `changes.${index}.phase.id`,
        message: `Phase id "${proposedId}" already names live phase work`,
        hint: "Give the new phase an id no queued or running phase uses.",
      });
    }
  }
  return issues;
}

/** Map a decoded reassessment payload into a proposal over read-only
 *  committed control. An empty `changes` list confirms the remaining phases,
 *  so it proposes nothing. Call it only for a payload that
 *  {@link reassessmentIssues} accepted. */
function retiredReassessmentProposal(
  payload: RetiredReassessmentPayload,
  owner: ReassessmentOwner,
  control: ReassessmentControl,
): ReassessmentProposal | null {
  const source = reassessmentSource(owner, control);
  const changes: ReassessmentChange[] = [];
  for (const [index, change] of payload.changes.entries()) {
    const route = changeRoute(change, source, control);
    if (!route) throw new Error(`Reassessment target "${change.phase_id}" is not eligible phase work`);
    const { target } = route;
    if (change.action === "drop") {
      changes.push({ kind: "skip", targetAttemptId: target.id, reason: `Reassess dropped phase "${change.phase_id}"` });
      continue;
    }
    const attemptId = `${owner.attemptId}:reassessment:${index + 1}`;
    changes.push(change.action === "replace"
      ? {
          kind: "replace",
          targetAttemptId: target.id,
          attemptId,
          forItem: change.phase,
          reason: `Reassess replaced phase "${change.phase_id}"`,
        }
      : {
          kind: "insert_after",
          targetAttemptId: target.id,
          afterAttemptId: route.anchorsAfterSource && source.ownerAttempt ? source.ownerAttempt.id : target.id,
          attemptId,
          forItem: change.phase,
          reason: `Reassess inserted a phase after "${change.phase_id}"`,
        });
  }
  const first = changes[0];
  if (!first) return null;
  return {
    proposalId: `${owner.attemptId}:reassessment`,
    ownerNodeId: owner.logicalNodeId,
    reason: payload.summary,
    changes: [first, ...changes.slice(1)],
  };
}

/** The repeat over items that one node id names. */
type EachLoop = Extract<RepeatNode["loop"], { readonly _tag: "each" }>;

/** The loop of the repeat over items that one node id names. */
function requireEachLoop(control: Pick<CommittedWorkflowControl, "graph">, repeatNodeId: string): EachLoop {
  const node = control.graph.nodes.find(({ id }) => id === repeatNodeId);
  if (node?.kind !== "repeat" || node.loop._tag !== "each") throw new Error(`Workflow invariant rejected missing repeat over items "${repeatNodeId}"`);
  return node.loop;
}

/** The round of a repeat that runs now: the latest round of its current run. */
function currentRound(control: Pick<CommittedWorkflowControl, "graph">, repeatNodeId: string): number {
  const run = repeatRun(control.graph, repeatNodeId);
  return control.graph.nodes.reduce((latest, node) =>
    node.ownership._tag === "round" && node.ownership.parentNodeId === repeatNodeId && (roundOfNodeId(node.id)?.run ?? 1) === run ? Math.max(latest, node.ownership.round) : latest, 0);
}

/** The ids of the items of a repeat that no round has run yet. */
function remainingItemIds(control: Pick<CommittedWorkflowControl, "graph">, repeatNodeId: string): readonly (string | undefined)[] {
  return (requireEachLoop(control, repeatNodeId).items ?? []).slice(currentRound(control, repeatNodeId)).map(itemIdOf);
}

/** The id of the item that the current round of a repeat runs. */
function currentItemId(control: Pick<CommittedWorkflowControl, "graph">, repeatNodeId: string): string | undefined {
  return itemIdOf(requireEachLoop(control, repeatNodeId).items?.[currentRound(control, repeatNodeId) - 1] ?? null);
}

/** The repeat with one item change applied to its remaining items. Completed
 *  items are immutable, so a change acts only after the current round.
 *  Validation judged each change against the items that the changes before
 *  it leave, so every change finds its item. */
function withItemChange(control: CommittedWorkflowControl, change: Extract<ReassessmentChange, { kind: "drop_item" | "replace_item" | "insert_item" }>): CommittedWorkflowControl {
  const items = [...requireEachLoop(control, change.repeatNodeId).items ?? []];
  const round = currentRound(control, change.repeatNodeId);
  const at = (id: string): number => {
    const index = items.findIndex((item, position) => position >= round - 1 && itemIdOf(item) === id);
    if (index < 0) throw new Error(`Workflow invariant rejected item change of "${change.repeatNodeId}" that names no remaining item "${id}"`);
    return index;
  };
  switch (change.kind) {
    case "drop_item": items.splice(at(change.itemId), 1); break;
    case "replace_item": items.splice(at(change.itemId), 1, change.item); break;
    case "insert_item": items.splice(at(change.afterItemId) + 1, 0, change.item); break;
  }
  return replaceNode(control, change.repeatNodeId, (node) => node.kind === "repeat" && node.loop._tag === "each" ? { ...node, loop: { ...node.loop, items } } : node);
}

/** The repeat over items whose `reassess` agent an attempt runs, or
 *  undefined for any other attempt. */
function reassessedRepeat(owner: ReassessmentOwner, control: ReassessmentControl): RepeatNode | undefined {
  const place = roundOfNodeId(owner.logicalNodeId);
  const repeat = place === null ? undefined : control.graph.nodes.find(({ id }) => id === place.repeatNodeId);
  return repeat?.kind === "repeat" && repeat.loop._tag === "each" ? repeat : undefined;
}

/** Whether a reassess attempt runs on a `for` node of control from before
 *  phases, which reads the frozen contract that named each item a phase.
 *  Remove after 2027-04-30. */
export function reassessesRetiredFor(owner: Pick<ReassessmentOwner, "logicalNodeId">, control: Pick<ReassessmentControl, "graph">): boolean {
  return control.graph.nodes.find(({ id }) => id === owner.logicalNodeId)?.kind === "for";
}

/** Committed-control invariants that an item reassessment must satisfy
 *  before it can become a proposal: every change names an item that remains
 *  after the changes before it, or for an insert the item that the round
 *  just ran, and every proposed item id is new. The changes apply in order,
 *  so each one is judged against the items that the earlier ones leave. */
function itemReassessmentIssues(payload: ReassessmentPayload, repeat: RepeatNode, control: ReassessmentControl): HandoffIssue[] {
  const issues: HandoffIssue[] = [];
  const original = new Set(remainingItemIds(control, repeat.id));
  const remaining = new Set(original);
  const current = currentItemId(control, repeat.id);
  for (const [index, change] of payload.changes.entries()) {
    if (remaining.has(change.item_id) || (change.action === "insert" && change.item_id === current)) {
      if (change.action !== "insert") remaining.delete(change.item_id);
      if (change.action !== "drop") remaining.add(change.item.id);
      continue;
    }
    issues.push(original.has(change.item_id) ? {
      path: `changes.${index}.item_id`,
      message: `Item id "${change.item_id}" names an item that an earlier change of this reassessment dropped or replaced`,
      hint: "Name each item that a change acts on once, and anchor an insert on an item that stays.",
    } : {
      path: `changes.${index}.item_id`,
      message: `Item id "${change.item_id}" names no item this change can act on`,
      hint: "Name a remaining item. An insert can also name the item that this round ran.",
    });
  }
  const known = new Set((requireEachLoop(control, repeat.id).items ?? []).map(itemIdOf));
  const proposed = new Set<unknown>();
  for (const [index, change] of payload.changes.entries()) {
    if (change.action === "drop") continue;
    const id = change.item.id;
    if (proposed.has(id)) {
      issues.push({ path: `changes.${index}.item.id`, message: `Item id "${id}" is proposed twice by this reassessment`, hint: "Give every proposed item its own id." });
    }
    proposed.add(id);
    const keepsTargetId = change.action === "replace" && change.item_id === id;
    if (!keepsTargetId && known.has(id)) {
      issues.push({ path: `changes.${index}.item.id`, message: `Item id "${id}" already names an item`, hint: "Give the new item an id that no item uses." });
    }
  }
  return issues;
}

function itemReassessmentProposal(payload: ReassessmentPayload, owner: ReassessmentOwner, repeat: RepeatNode): ReassessmentProposal | null {
  const changes = payload.changes.map((change): ReassessmentChange => {
    if (change.action === "drop") return { kind: "drop_item", repeatNodeId: repeat.id, itemId: change.item_id, reason: `Reassess dropped item "${change.item_id}"` };
    if (change.action === "replace") return { kind: "replace_item", repeatNodeId: repeat.id, itemId: change.item_id, item: change.item, reason: `Reassess replaced item "${change.item_id}"` };
    return { kind: "insert_item", repeatNodeId: repeat.id, afterItemId: change.item_id, item: change.item, reason: `Reassess inserted an item after "${change.item_id}"` };
  });
  const first = changes[0];
  if (!first) return null;
  return { proposalId: `${owner.attemptId}:reassessment`, ownerNodeId: owner.logicalNodeId, reason: payload.summary, changes: [first, ...changes.slice(1)] };
}

/** The handoff of a reassess attempt, decoded with its contract: the item
 *  contract of a repeat, or the frozen phase contract of a `for` node of
 *  control from before phases. */
export type ReassessmentHandoff =
  | { readonly retired: false; readonly payload: ReassessmentPayload }
  | { readonly retired: true; readonly payload: RetiredReassessmentPayload };

/** Why a reassess attempt's handoff cannot become a proposal, as handoff
 *  issues; empty when it can. */
export function reassessmentIssues(handoff: ReassessmentHandoff, owner: ReassessmentOwner, control: ReassessmentControl): HandoffIssue[] {
  if (handoff.retired) return retiredReassessmentIssues(handoff.payload, owner, control);
  const repeat = reassessedRepeat(owner, control);
  if (repeat === undefined) throw new Error(`Workflow invariant rejected reassess attempt "${owner.attemptId}" outside a repeat over items`);
  return itemReassessmentIssues(handoff.payload, repeat, control);
}

/** Map a decoded reassessment handoff into a proposal over read-only
 *  committed control. An empty `changes` list confirms the remaining items,
 *  so it proposes nothing. Call it only for a handoff that
 *  {@link reassessmentIssues} accepted. */
export function reassessmentProposal(handoff: ReassessmentHandoff, owner: ReassessmentOwner, control: ReassessmentControl): ReassessmentProposal | null {
  if (handoff.retired) return retiredReassessmentProposal(handoff.payload, owner, control);
  const repeat = reassessedRepeat(owner, control);
  if (repeat === undefined) throw new Error(`Workflow invariant rejected reassess attempt "${owner.attemptId}" outside a repeat over items`);
  return itemReassessmentProposal(handoff.payload, owner, repeat);
}
