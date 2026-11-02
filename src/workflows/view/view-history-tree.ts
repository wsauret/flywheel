import { parseProjectionFact } from "../../infra/event-projection.js"
import { CorruptEventRowError, type StoredFact } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import type { WorkflowTree, WorkflowTreeAgent, WorkflowTreeDisposition, WorkflowTreeLoop, WorkflowTreeNode, WorkflowTreePhase } from "../../protocol/workflow-view-protocol-types.js"
import { attemptNodeIdOf, type LogicalNode } from "../vm/graph-types.js"
import { normalizeLogicalNodeV3 } from "../vm/historical-normalization.js"
import { recoverWorkflowControl, workflowRecoveryBasis } from "../vm/recovery.js"
import { committedWorkflowEvent, groupExpandedChanges, parseWorkflowSessionFact, workflowRootControl } from "../vm/session-facts.js"
import { whileOutcome } from "../vm/loop-signal.js"
import { workflowTree } from "../vm/view-tree.js"
import { selectNewestWorkflowRoot } from "../workflow-root.js"
import type { WorkflowPlanSchema, WorkflowTreeV1Schema, WorkflowTreeV3Schema } from "./schemas.js"
import type { AttemptRow, WorkflowView } from "./types.js"

type RawQueue = Omit<WorkflowView, "tree">
type HistoricalTree = typeof WorkflowTreeV1Schema.Type
type HistoricalPlan = typeof WorkflowPlanSchema.Type
type TreeV3 = typeof WorkflowTreeV3Schema.Type
type TreeNodeV3 = TreeV3["nodes"][number]

/** Read-only tree adaptation for views that recorded no tree, or a tree
 * before version 4. It rebuilds the tree from control; only when control is
 * not readable does it keep the retained tree, in the current shape.
 * Retained evidence describes display only; it never becomes executable
 * control. Remove after 2027-04-30. */
export function historicalWorkflowTree(queue: RawQueue, stored: HistoricalTree | undefined, plan: HistoricalPlan | undefined, events: readonly (StoredFact | CorruptEventRowError)[]): WorkflowTree {
  const names = new Map(queue.attempts.map((row) => [row.definitionId, row.name]))
  for (const entry of plan?.steps ?? []) names.set(entry.definitionId, entry.name)
  const recovery = recoverWorkflowControl(events)
  const control = recovery.executable ? recovery.control : workflowRecoveryBasis(events)
  if (control) return workflowTree(control, (id) => names.get(id) ?? id)
  return treeFromV3(retainedTree(queue, stored, plan, events))
}

/** A tree in the spellings before version 4 as phases, agents, and
 *  repeats: a step outside a map is a phase of one agent, the executions of
 *  a chain are phases of their own, a concurrent phase of steps is a
 *  parallel phase, a map is one list phase for each of its stages, whose
 *  agents take their item from their branch, and rounds are a repeat. */
function treeFromV3(tree: TreeV3): WorkflowTree {
  const children = Map.groupBy(tree.nodes, ({ parentId }) => parentId)
  const childrenOf = (id: string | null): readonly TreeNodeV3[] => children.get(id) ?? []
  const stepsUnder = (node: TreeNodeV3): readonly (TreeNodeV3 & { readonly kind: "step" })[] =>
    node.kind === "step" ? [node] : childrenOf(node.id).flatMap(stepsUnder)
  const agentOf = (leaf: TreeNodeV3 & { readonly kind: "step" }, parentId: string): WorkflowTreeAgent => ({
    id: leaf.id, kind: "agent", definitionId: leaf.stepId, label: leaf.label, parentId, disposition: leaf.disposition, attempts: leaf.attempts,
    ...(leaf.reason === undefined ? {} : { reason: leaf.reason }),
    ...(leaf.currentAttemptId === undefined ? {} : { currentAttemptId: leaf.currentAttemptId }),
    ...(leaf.evidence === undefined ? {} : { evidence: leaf.evidence }),
    ...(leaf.waitsOn === undefined ? {} : { waitsOn: leaf.waitsOn }),
  })
  const common = (node: TreeNodeV3, parentId: string | null) => ({
    label: node.label, parentId, disposition: node.disposition,
    ...(node.reason === undefined ? {} : { reason: node.reason }),
    ...(node.round === undefined ? {} : { round: node.round }),
  })
  const visit = (node: TreeNodeV3, parentId: string | null): WorkflowTreeNode[] => {
    switch (node.kind) {
      case "step": {
        const id = `${node.id}:phase`
        return [{ id, kind: "phase", form: "single", phaseId: node.stepId, ...common(node, parentId) }, agentOf(node, id)]
      }
      case "rounds":
        return [{ id: node.id, kind: "repeat", label: node.label, parentId, disposition: node.disposition, ...(node.reason === undefined ? {} : { reason: node.reason }), loop: node.loop },
          ...childrenOf(node.id).flatMap((child) => visit(child, node.id))]
      case "phase": {
        const members = childrenOf(node.id)
        if (node.concurrent !== true || !members.every(({ kind }) => kind === "step")) return members.flatMap((child) => visit(child, parentId))
        return [{ id: node.id, kind: "phase", form: "parallel", phaseId: node.label, ...common(node, parentId), ...(node.join === undefined ? {} : { join: node.join }) },
          ...members.flatMap((member) => member.kind === "step" ? [agentOf(member, node.id)] : [])]
      }
      case "group": {
        const stages = node.stageIds ?? node.stages ?? [node.label]
        const branches = childrenOf(node.id).filter(({ kind }) => kind === "branch").toSorted((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
        const expanded = node.join !== undefined
        return stages.flatMap((stage, place): WorkflowTreeNode[] => {
          const id = `${node.id}:phase:${place + 1}`
          const agents = branches.flatMap((branch): WorkflowTreeAgent[] => {
            const leaf = stepsUnder(branch)[place]
            const key = branch.key ?? branch.label
            return leaf === undefined ? [] : [{ ...agentOf(leaf, id), item: { nodeId: branch.id, key, label: branch.label, ordinal: branch.ordinal ?? 0, text: branch.item ?? key } }]
          })
          const last = place === stages.length - 1
          const disposition: WorkflowTreeDisposition = !expanded || (last && (node.disposition === "completed" || node.disposition === "failed")) || node.disposition === "skipped" ? node.disposition
            : agents.length > 0 && agents.every(({ disposition: one }) => one === "completed" || one === "failed" || one === "skipped") ? "completed"
              : agents.some(({ disposition: one }) => one !== "pending" && one !== "conditional") ? "running" : "pending"
          const phase: WorkflowTreePhase = {
            id, kind: "phase", form: "list", phaseId: stage, ...common(node, parentId), label: node.stages?.[place] ?? stage, disposition,
            list: { id: node.id, expanded },
            ...(last && node.join !== undefined ? { join: node.join } : {}),
          }
          return [phase, ...agents]
        })
      }
      case "chain":
        return childrenOf(node.id).flatMap((child) => visit(child, parentId))
      case "branch":
        return []
    }
  }
  const nodes = childrenOf(null).flatMap((node) => visit(node, null))
  const current = tree.currentLeafId === undefined ? undefined : nodes.find(({ id, kind }) => kind === "agent" && id === tree.currentLeafId)
  return { nodes, ...(current === undefined ? {} : { currentAgentNodeId: current.id }) }
}

interface RetainedIdentity {
  readonly nodes: Map<string, LogicalNode>
  readonly owners: Map<string, string>
  readonly retries: Map<string, string>
  readonly replacementReasons: Map<string, string>
  readonly handoffs: Map<string, { readonly [key: string]: unknown }>
}

function missingIdentity(event: StoredFact, detail: string): never {
  throw new InvariantViolation({ kind: "missing-producer-event", eventType: event.type, eventPosition: event.position, aggregateId: event.aggregateId, detail })
}

function retainedOwner(owners: ReadonlyMap<string, string>, attemptId: string): string | null {
  // Reassessment ids encode the author, not the target that owns the work.
  return owners.get(attemptId) ?? (attemptId.includes(":reassessment:") ? null : attemptNodeIdOf(attemptId))
}

function retainedIdentity(events: readonly (StoredFact | CorruptEventRowError)[]): RetainedIdentity {
  const nodes = new Map<string, LogicalNode>()
  const owners = new Map<string, string>()
  const retries = new Map<string, string>()
  const replacementReasons = new Map<string, string>()
  const handoffs = new Map<string, { readonly [key: string]: unknown }>()
  const root = selectNewestWorkflowRoot(events)
  const suffix = root === null ? events : events.slice(root.index)
  for (const event of suffix) {
    // oxlint-disable-next-line eslint/no-throw-literal -- boundary: retain the durable-row Error identity
    if (event instanceof CorruptEventRowError) throw event
    if (event.type !== "workflow.control.initialized" && event.type !== "workflow.control.recovered"
      && event.type !== "group.expanded" && event.type !== "workflow.reassessed" && event.type !== "attempt.retry_inserted" && event.type !== "workflow.control.committed") continue
    const fact = parseProjectionFact(event, parseWorkflowSessionFact)
    switch (fact.type) {
      case "workflow.control.initialized":
      case "workflow.control.recovered": {
        const initial = workflowRootControl(fact)
        for (const node of initial.graph.nodes) nodes.set(node.id, node)
        for (const attempt of initial.attempts) {
          owners.set(attempt.id, attempt.logicalNodeId)
          if (attempt.handoff !== null) handoffs.set(attempt.id, attempt.handoff)
          if (attempt.provenance._tag === "retry") {
            if (attempt.parentAttemptId === null) missingIdentity(event, `Retry ${attempt.id} has no parent`)
            retries.set(attempt.id, attempt.parentAttemptId)
          }
        }
        break
      }
      case "workflow.control.committed": {
        const committed = committedWorkflowEvent(fact)
        if (committed.type === "ATTEMPT_SUCCEEDED") handoffs.set(committed.outcome.attemptId, committed.outcome.handoff)
        break
      }
      case "group.expanded":
        for (const change of groupExpandedChanges(fact)) {
          if (change.kind === "add_node") nodes.set(change.node.id, change.node)
        }
        break
      case "workflow.reassessed":
        for (const change of fact.payload.changes) {
          if (change.kind === "add_node") nodes.set(change.node.id, normalizeLogicalNodeV3(change.node))
          if (change.kind === "replace" || change.kind === "insert_after") {
            const owner = retainedOwner(owners, change.targetAttemptId)
            if (owner === null) missingIdentity(event, `Replacement ${change.attemptId} has no target owner`)
            owners.set(change.attemptId, owner)
            if (change.kind === "replace") replacementReasons.set(change.targetAttemptId, change.reason)
          }
        }
        break
      case "attempt.retry_inserted": {
        const owner = retainedOwner(owners, fact.payload.attemptId)
        if (owner === null) missingIdentity(event, `Retry ${fact.payload.retryAttemptId} has no parent owner`)
        owners.set(fact.payload.retryAttemptId, owner)
        retries.set(fact.payload.retryAttemptId, fact.payload.attemptId)
        break
      }
    }
  }
  return { nodes, owners, retries, handoffs, replacementReasons }
}

function rowDisposition(row: AttemptRow, owner: { readonly disposition: WorkflowTreeDisposition } | undefined, conditional: ReadonlySet<string>, open: boolean): WorkflowTreeDisposition {
  if (row.status === "blocked" || row.status === "skipped") return "skipped"
  if (row.status !== "pending") return row.status
  if (!open || owner?.disposition === "skipped" || owner?.disposition === "failed" || owner?.disposition === "completed") return "skipped"
  return conditional.has(row.id) ? "conditional" : "pending"
}

/** The tree kind that one node of control projects to. */
function treeKind(node: LogicalNode | undefined): TreeNodeV3["kind"] {
  switch (node?.kind) {
    case "phase": return "phase"
    case "list": return "group"
    case "item": return "branch"
    case "repeat": return "rounds"
    default: return "step"
  }
}

function retainedKind(node: LogicalNode | undefined, old: HistoricalTree["nodes"][number] | undefined, executions: readonly AttemptRow[][], planned: readonly unknown[]): TreeNodeV3["kind"] {
  if (node?.kind === "while") return "rounds"
  if (node?.kind === "for" || (node?.kind === "agent" && node.followUpV10 != null)
    || executions.length > 1 || (planned.length > 0 && node?.kind !== "list" && old?.kind !== "group")) return "chain"
  if (old) return old.kind
  return treeKind(node)
}

function retainedDisposition(node: LogicalNode | undefined, old: HistoricalTree["nodes"][number] | undefined, executions: readonly AttemptRow[][]): WorkflowTreeDisposition {
  if (old) return old.disposition
  if (node?.state._tag === "blocked" || node?.state._tag === "cancelled" || node?.state._tag === "superseded") return "skipped"
  if (executions.some((rows) => rows.at(-1)?.status === "running")) return "running"
  if (executions.some((rows) => rows.at(-1)?.status === "failed")) return "failed"
  return executions.length > 0 && executions.every((rows) => rows.at(-1)?.status === "completed") ? "completed" : "pending"
}

function retainedLoop(id: string, node: LogicalNode | undefined, old: HistoricalTree["nodes"][number] | undefined, oldNodes: ReadonlyMap<string, HistoricalTree["nodes"][number]>, executions: readonly AttemptRow[][], handoffs: RetainedIdentity["handoffs"]): WorkflowTreeLoop {
  if (old?.loop) return old.loop
  const lastRound = [...oldNodes.values()].filter((child) => child.parentId === id && child.kind === "group").at(-1)?.round
  const evaluations = node?.kind === "while" ? executions.filter((rows) => rows.at(-1)?.definitionId === node.evaluator.step) : []
  const latest = evaluations.findLastIndex((rows) => rows.at(-1)?.status === "completed")
  const evaluator = evaluations[latest]?.at(-1)
  const handoff = evaluator === undefined ? undefined : handoffs.get(evaluator.id)
  const outcome = node?.kind === "while" && handoff !== undefined
    ? whileOutcome(node, handoff, latest + 1, handoffs.get(evaluations[latest - 1]?.at(-1)?.id ?? "") ?? null)
    : lastRound?.outcome === "dry" || lastRound?.outcome === "bound" ? lastRound.outcome : undefined
  const maxIterations = node?.kind === "while" ? node.maxIterations : node?.kind === "repeat" && node.loop._tag === "while" ? node.loop.max : undefined
  if (node === undefined || maxIterations === undefined) throw new Error(`Historical loop ${id} has no retained iteration bound`)
  return {
    iteration: Math.max(1, node.kind === "while" ? Math.ceil(executions.length / node.body.length) : lastRound?.number ?? 1),
    maxIterations,
    ...(outcome === undefined ? {} : { outcome }),
  }
}

function retainedFields(id: string, node: LogicalNode | undefined, old: HistoricalTree["nodes"][number] | undefined, executions: readonly AttemptRow[][]) {
  const parentId = old?.parentId ?? (node?.ownership._tag === "workflow" || node === undefined ? null : node.ownership.parentNodeId)
  const label = old?.label ?? (node !== undefined && "name" in node ? node.name : executions[0]?.[0]?.name ?? id)
  const { kind: _kind, stepId: _stepId, loop: _loop, currentAttemptId: _attemptId, joinsInto: _joinsInto, ...retained } = old ?? {}
  return {
    ...(node?.kind === "list" ? { stages: node.phases.map((phase) => phase.name), mapId: node.outputId, stageIds: node.phases.map((phase) => phase.definitionId) } : {}),
    ...(node?.kind === "item" ? { key: node.key, ordinal: node.ordinal, item: typeof node.item === "string" ? node.item : JSON.stringify(node.item) } : {}),
    ...(node?.ownership._tag === "round" ? { round: { number: node.ownership.round } } : {}),
    ...(node && "reason" in node.state ? { reason: node.state.reason } : {}),
    ...retained, id, label, parentId, disposition: retainedDisposition(node, old, executions), attempts: 0,
  }
}

function retainedTree(queue: RawQueue, stored: HistoricalTree | undefined, plan: HistoricalPlan | undefined, events: readonly (StoredFact | CorruptEventRowError)[]): TreeV3 {
  const { nodes: logical, owners, retries, handoffs, replacementReasons } = retainedIdentity(events)
  const oldNodes = new Map(stored?.nodes.map((node) => [node.id, node]))
  const open = queue.status === "idle" || queue.status === "running" || queue.status === "paused"
  const conditional = new Set(plan?.conditionalStepIds)
  const byRow = new Map<string, AttemptRow[]>()
  const byOwner = new Map<string, AttemptRow[][]>()
  for (const row of queue.attempts) {
    const parent = retries.get(row.id)
    const lineage = parent === undefined ? [] : byRow.get(parent)
    if (lineage === undefined) {
      const event = events.find((entry): entry is StoredFact => !(entry instanceof CorruptEventRowError) && entry.type === "attempt.retry_inserted" && entry.payload.retryAttemptId === row.id)
      if (event) missingIdentity(event, `Retry ${row.id} has no retained parent ${parent}`)
      throw new Error(`Historical retry ${row.id} has no retained parent ${parent}`)
    }
    if (parent === undefined) {
      const owner = retainedOwner(owners, row.id) ?? row.id
      if (owner === row.id && row.id.includes(":reassessment:")) {
        const event = events.findLast((entry): entry is StoredFact => !(entry instanceof CorruptEventRowError) && (entry.type === "queue.created" || entry.type === "queue.mutated"))
        if (event) missingIdentity(event, `Reassessment ${row.id} has no retained target owner`)
      }
      owners.set(row.id, owner)
      const children = byOwner.get(owner) ?? []
      children.push(lineage)
      byOwner.set(owner, children)
    } else {
      const owner = owners.get(parent)
      if (owner !== undefined) owners.set(row.id, owner)
    }
    lineage.push(row)
    byRow.set(row.id, lineage)
  }
  const plannedByOwner = new Map<string, HistoricalPlan["steps"][number][]>()
  const ownerByPlanned = new Map<string, string>()
  for (const entry of plan?.steps ?? []) {
    // Map placeholders use the group's id rather than their preceding row.
    const group = [...logical.values()].find((node) => node.kind === "list" && entry.id.startsWith(`${node.id}:planned:`))
    const owner = group?.id ?? ownerByPlanned.get(entry.after) ?? owners.get(entry.after) ?? attemptNodeIdOf(entry.after) ?? entry.after
    ownerByPlanned.set(entry.id, owner)
    const entries = plannedByOwner.get(owner) ?? []
    entries.push(entry)
    plannedByOwner.set(owner, entries)
  }
  const result: TreeNodeV3[] = []
  const emitted = new Set<string>()
  const emit = (id: string): void => {
    if (emitted.has(id)) return
    emitted.add(id)
    const old = oldNodes.get(id)
    const node = logical.get(id)
    const executions = byOwner.get(id) ?? []
    const planned = plannedByOwner.get(id) ?? []
    const kind = retainedKind(node, old, executions, planned)
    const isExecutionContainer = kind === "chain" || (kind === "rounds" && node?.kind === "while")
    const common = retainedFields(id, node, old, executions)
    const { parentId, disposition } = common
    const appendExecution = (rows: AttemptRow[]): void => {
      // SAFETY: retained retry grouping creates each lineage with its first row.
      const first = rows[0]!
      // SAFETY: retained retry grouping never emits an empty lineage.
      const current = rows.find((row) => row.status === "running") ?? rows.at(-1)!
      const reason = replacementReasons.get(current.id) ?? common.reason
      const leaf: TreeNodeV3 = {
        id: isExecutionContainer ? first.id : id, kind: "step", stepId: current.definitionId, label: current.name,
        parentId: isExecutionContainer ? id : parentId,
        disposition: rowDisposition(current, common, conditional, open), attempts: rows.length, currentAttemptId: current.id,
        ...(reason === undefined ? {} : { reason }),
        ...(old?.currentAttemptId === current.id && old.evidence !== undefined ? { evidence: old.evidence } : {}),
        ...(node?.kind === "while" ? { round: { number: Math.floor(executions.indexOf(rows) / node.body.length) + 1 } } : {}),
      }
      result.push(leaf)
      for (const entry of planned.filter((candidate) => byRow.get(candidate.after) === rows)) appendPlanned(entry)
    }
    const appendPlanned = (entry: HistoricalPlan["steps"][number]): void => {
      const unreachable = !open || disposition === "completed" || disposition === "failed" || disposition === "skipped"
      result.push({ id: entry.id, kind: "step", stepId: entry.definitionId, label: entry.name, parentId: id,
        disposition: unreachable ? "skipped" : entry.status === "pending" ? "pending" : entry.status,
        attempts: 0, ...(common.reason === undefined ? {} : { reason: common.reason }) })
      for (const next of planned.filter((candidate) => candidate.after === entry.id)) appendPlanned(next)
    }
    if (kind === "step") {
      const [execution] = executions
      if (execution) appendExecution(execution)
      else if (node?.kind === "agent" || old?.stepId !== undefined) result.push({ ...common, kind: "step", stepId: old?.stepId ?? (node?.kind === "agent" ? node.definitionId : id) })
      else {
        const event = events.findLast((entry): entry is StoredFact => !(entry instanceof CorruptEventRowError) && entry.type === "queue.tree.changed")
        if (event) missingIdentity(event, `Step ${id} has no retained authored identity`)
      }
    } else {
      if (kind === "rounds") {
        result.push({ ...common, kind, loop: retainedLoop(id, node, old, oldNodes, executions, handoffs) })
      } else result.push({ ...common, kind })
      for (const rows of executions) appendExecution(rows)
      if (kind !== "group") for (const entry of planned.filter((candidate) => !byRow.has(candidate.after) && !ownerByPlanned.has(candidate.after))) appendPlanned(entry)
      for (const child of stored?.nodes.filter((candidate) => candidate.parentId === id) ?? []) emit(child.id)
      for (const child of logical.values()) if (child.ownership._tag !== "workflow" && child.ownership.parentNodeId === id) emit(child.id)
    }
  }
  for (const node of stored?.nodes ?? []) if (node.parentId === null) emit(node.id)
  for (const node of logical.values()) if (node.ownership._tag === "workflow") emit(node.id)
  for (const owner of byOwner.keys()) emit(owner)
  const current = result.find((node) => node.kind === "step" && node.disposition === "running")
    ?? result.find((node) => node.kind === "step" && node.currentAttemptId !== undefined && node.disposition === "pending")
  return { nodes: result, ...(current === undefined ? {} : { currentLeafId: current.id }) }
}
