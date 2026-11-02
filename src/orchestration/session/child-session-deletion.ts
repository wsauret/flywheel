import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import type { ParentNotificationDelivery } from "../module-seams.js"
import { settleInstalledSessionDeletion } from "./module-session-operations.js"
import { wakeAfterSettlement, type ReturnedNotice } from "./session-input-delivery.js"
import type { ReplayedSession } from "./schemas.js"
import { workflowRunOwner, workflowRunReader } from "../module-catalog.js"
import { workflowMembershipReader } from "./workflow-membership.js"
import { readWorkflowActivity } from "../../workflows/vm/control-status.js"

// Retained v1 cells keep their original key until the sessions migration consumes this decoder.
export const CHILD_SESSION_DELETION_IN_FLIGHT_KIND = "session.subagent_recursive_deletion"

interface ChildSessionDeletionEdge {
  readonly parentSessionId: string
  readonly childSessionId: string
}

interface HistoricalChildSessionDeletion {
  readonly version: 1
  readonly rootSessionId: string
  readonly edges: readonly ChildSessionDeletionEdge[]
}
export type RetainedChildSessionDeletion = HistoricalChildSessionDeletion | {
  readonly version: 2
  readonly rootSessionId: string
  readonly targets: readonly ChildSessionDeletionTarget[]
}

export type ChildSessionDeletionTarget =
  | {
    readonly kind: "workflow"
    readonly rootSessionId: string
    readonly workflowId: string
    readonly parentSessionId: string
  }
  | {
    readonly kind: "child"
    readonly rootSessionId: string
    readonly parentSessionId: string
    readonly sessionId: string
  }
  | {
    readonly kind: "root"
    readonly rootSessionId: string
    readonly sessionId: string
  }

export interface ChildSessionDeletionPlan {
  readonly rootSessionId: string
  readonly targets: readonly ChildSessionDeletionTarget[]
}

interface ChildSessionDeletionStatePorts {
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  read(sessionId: string): Promise<ReplayedSession | null>
  isKnown(sessionId: string): Promise<boolean>
  deleteOne(sessionId: string): Promise<readonly ReturnedNotice[]>
  deleteWorkflow(workflowId: string): Promise<readonly ReturnedNotice[]>
  unlink(parentSessionId: string, childSessionId: string): Promise<void>
}

interface ChildSessionDeletionSettlementPorts {
  readonly projectRoot: string
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  read(sessionId: string): Promise<ReplayedSession | null>
  abort?: (sessionId: string) => Promise<void>
  readonly deliverNotification?: ParentNotificationDelivery
}

interface ChildSessionDeletionExecutorPorts extends ChildSessionDeletionSettlementPorts {
  /** Deletes one target and resolves with the notices its delete held for
   *  the senders of the messages it never read. */
  finalizeDeletionTarget(target: ChildSessionDeletionTarget): Promise<readonly ReturnedNotice[]>
}

export interface ChildSessionDeletionState {
  admit(rootSessionId: string, inactiveBefore?: number): Promise<ChildSessionDeletionPlan>
  finalize(target: ChildSessionDeletionTarget): Promise<readonly ReturnedNotice[]>
  blocksLaunch(parentSessionId: string): Promise<boolean>
}

/** Converts one strict retained operation into its immutable leaf-first executor plan. */
export function childSessionDeletionPlan(operation: RetainedChildSessionDeletion): ChildSessionDeletionPlan {
  if (operation.version === 2) return { rootSessionId: operation.rootSessionId, targets: operation.targets }
  return {
    rootSessionId: operation.rootSessionId,
    targets: [
      ...operation.edges.map((edge): ChildSessionDeletionTarget => ({
        kind: "child",
        rootSessionId: operation.rootSessionId,
        parentSessionId: edge.parentSessionId,
        sessionId: edge.childSessionId,
      })),
      {
        kind: "root",
        rootSessionId: operation.rootSessionId,
        sessionId: operation.rootSessionId,
      },
    ],
  }
}

/** Strictly decodes the retained v1 cell. Migration and recovery use this same boundary. */
export function decodeRetainedChildSessionDeletion(
  value: { [key: string]: unknown },
  rootSessionId: string,
): RetainedChildSessionDeletion {
  if (value.version === 2 && value.rootSessionId === rootSessionId && Array.isArray(value.targets)) {
    const ids = new Set<string>()
    const targets = value.targets.map((entry): ChildSessionDeletionTarget => {
      if (typeof entry !== "object" || entry === null || !("kind" in entry) || !("rootSessionId" in entry)
        || entry.rootSessionId !== rootSessionId) throw new Error(`Session ${rootSessionId} has an unknown recursive deletion target`)
      if (entry.kind === "workflow" && "workflowId" in entry && typeof entry.workflowId === "string"
        && "parentSessionId" in entry && typeof entry.parentSessionId === "string") {
        const key = `workflow:${entry.workflowId}`
        if (ids.has(key)) throw new Error(`Duplicate deletion target ${key}`)
        ids.add(key)
        return { kind: "workflow", rootSessionId, workflowId: entry.workflowId, parentSessionId: entry.parentSessionId }
      }
      if ((entry.kind === "root" || entry.kind === "child") && "sessionId" in entry && typeof entry.sessionId === "string") {
        const key = `session:${entry.sessionId}`
        if (ids.has(key)) throw new Error(`Duplicate deletion target ${key}`)
        ids.add(key)
        if (entry.kind === "root") return { kind: "root", rootSessionId, sessionId: entry.sessionId }
        if ("parentSessionId" in entry && typeof entry.parentSessionId === "string") return {
          kind: "child", rootSessionId, sessionId: entry.sessionId, parentSessionId: entry.parentSessionId,
        }
      }
      throw new Error(`Session ${rootSessionId} has an unknown recursive deletion target`)
    })
    return { version: 2, rootSessionId, targets }
  }
  if (value.version !== 1) {
    throw new Error(`Session ${rootSessionId} has a recursive deletion operation of unknown version ${String(value.version)}`)
  }
  if (value.rootSessionId !== rootSessionId || !Array.isArray(value.edges)) {
    throw new Error(`Session ${rootSessionId} has an unknown recursive deletion operation`)
  }
  const childSessionIds = new Set<string>()
  const edges = value.edges.map((edge) => {
    if (
      typeof edge !== "object"
      || edge === null
      || !("parentSessionId" in edge)
      || typeof edge.parentSessionId !== "string"
      || edge.parentSessionId.length === 0
      || !("childSessionId" in edge)
      || typeof edge.childSessionId !== "string"
      || edge.childSessionId.length === 0
      || edge.childSessionId === rootSessionId
      || edge.childSessionId === edge.parentSessionId
      || childSessionIds.has(edge.childSessionId)
    ) throw new Error(`Session ${rootSessionId} has an unknown recursive deletion edge`)
    childSessionIds.add(edge.childSessionId)
    return {
      parentSessionId: edge.parentSessionId,
      childSessionId: edge.childSessionId,
    }
  })
  return { version: 1, rootSessionId, edges }
}

/** Owns durable admission, structural authorization, progress, and finalization. */
export function createChildSessionDeletionState(ports: ChildSessionDeletionStatePorts): ChildSessionDeletionState {
  async function retained(rootSessionId: string): Promise<RetainedChildSessionDeletion | null> {
    const rows = await ports.projectionReader.readInFlight(rootSessionId, CHILD_SESSION_DELETION_IN_FLIGHT_KIND)
    if (rows.length === 0) return null
    if (rows.length !== 1) throw new Error(`Session ${rootSessionId} has multiple recursive deletion operations`)
    const row = rows.at(0)
    if (!row) return null
    return decodeRetainedChildSessionDeletion(row.payload, rootSessionId)
  }

  async function preparePlan(rootSessionId: string, requireReadable: boolean): Promise<Extract<RetainedChildSessionDeletion, { version: 2 }> | null> {
    const targets: ChildSessionDeletionTarget[] = []
    const visited = new Set<string>()
    let unreadable = false
    const runs = workflowRunReader(ports.projectionReader)
    const visit = async (parentSessionId: string): Promise<void> => {
      if (visited.has(parentSessionId)) return
      visited.add(parentSessionId)
      const parent = await ports.read(parentSessionId)
      if (!parent) unreadable = true
      if (parent?.kind === "chat") for (const { workflowId } of await runs.listForParent(parentSessionId)) await visitWorkflow(workflowId)
      for (const childSessionId of parent?.childSessionIds ?? []) {
        const child = await ports.read(childSessionId)
        if (requireReadable && !child && await ports.isKnown(childSessionId)) unreadable = true
        if (!child || child.kind === "chat" || child.launchedFrom?.parentSessionId !== parentSessionId || visited.has(childSessionId)) continue
        await visit(childSessionId)
        targets.push({ kind: "child", rootSessionId, parentSessionId, sessionId: childSessionId })
      }
    }
    const visitWorkflow = async (workflowId: string): Promise<void> => {
      const run = await runs.read(workflowId)
      if (!run) return
      for (const member of await workflowMembershipReader(ports.projectionReader).list(workflowId)) {
        if (visited.has(member.sessionId)) continue
        await visit(member.sessionId)
        targets.push({ kind: "child", rootSessionId, sessionId: member.sessionId, parentSessionId: run.launchedFrom.parentSessionId })
      }
      targets.push({ kind: "workflow", rootSessionId, workflowId, parentSessionId: run.launchedFrom.parentSessionId })
    }
    if (await runs.read(rootSessionId)) await visitWorkflow(rootSessionId)
    else {
      await visit(rootSessionId)
      targets.push({ kind: "root", rootSessionId, sessionId: rootSessionId })
    }
    return requireReadable && unreadable ? null : { version: 2, rootSessionId, targets }
  }

  async function admit(rootSessionId: string, inactiveBefore?: number): Promise<ChildSessionDeletionPlan> {
    const refused = { rootSessionId, targets: [] }
    if (inactiveBefore !== undefined && (await ports.read(rootSessionId))?.kind !== "chat") return refused
    const existing = await retained(rootSessionId)
    if (existing) return inactiveBefore === undefined ? childSessionDeletionPlan(existing) : refused
    if (!await workflowRunReader(ports.projectionReader).read(rootSessionId)
      && !await ports.read(rootSessionId) && (await tombstoned(rootSessionId) || !await ports.isKnown(rootSessionId))) {
      return { rootSessionId, targets: [] }
    }
    const operation = await preparePlan(rootSessionId, inactiveBefore !== undefined)
    if (!operation) return refused
    if (inactiveBefore !== undefined) {
      const workflows = operation.targets.filter((target) => target.kind === "workflow").map((target) => target.workflowId)
      const states = await readWorkflowActivity(ports.projectionReader, workflows)
      // A ready workflow can own admitted work before its first member starts.
      if ([...states.values()].some((activity) => activity === undefined || activity.status === "ready" || activity.status === "executing" || activity.lastUpdated > inactiveBefore)) return refused
      for (const target of operation.targets) {
        if (target.kind !== "workflow") {
          const session = await ports.read(target.sessionId)
          if (!session || session.lifecycleState !== "inactive" || !(Date.parse(session.lastUpdated) <= inactiveBefore)) return refused
        }
      }
    }
    if (!ports.writer.putInFlight) throw new Error("Child session deletion requires durable in-flight storage")
    await ports.writer.putInFlight(rootSessionId, CHILD_SESSION_DELETION_IN_FLIGHT_KIND, rootSessionId, operation)
    return childSessionDeletionPlan(operation)
  }

  async function tombstoned(sessionId: string): Promise<boolean> {
    return (await ports.projectionReader.readSlice({
      aggregateId: `session:${sessionId}`,
      types: ["session.deleted"],
      order: "desc",
      limit: 1,
    })).facts.length > 0
  }

  async function edgeComplete(edge: ChildSessionDeletionEdge): Promise<boolean> {
    if (await ports.read(edge.childSessionId)) return false
    if (!await tombstoned(edge.childSessionId)) return false
    const parent = await ports.read(edge.parentSessionId)
    return parent === null || !(parent.childSessionIds ?? []).includes(edge.childSessionId)
  }

  async function finalize(target: ChildSessionDeletionTarget): Promise<readonly ReturnedNotice[]> {
    const operation = await retained(target.rootSessionId)
    if (!operation) {
      if (
        target.kind === "root"
        && target.sessionId === target.rootSessionId
        && !await ports.read(target.rootSessionId)
        && await tombstoned(target.rootSessionId)
      ) return []
      throw new Error(`Session ${target.rootSessionId} is missing its child deletion operation`)
    }
    const plan = childSessionDeletionPlan(operation)
    const targetIndex = plan.targets.findIndex((candidate) =>
      candidate.kind === target.kind
      && (candidate.kind === "workflow" ? target.kind === "workflow" && candidate.workflowId === target.workflowId
        : target.kind !== "workflow" && candidate.sessionId === target.sessionId)
      && (candidate.kind === "workflow" || candidate.kind === "root"
        || (target.kind === "child" && candidate.parentSessionId === target.parentSessionId)))
    const targetId = target.kind === "workflow" ? target.workflowId : target.sessionId
    if (targetIndex < 0) throw new Error(`Session ${targetId} is not an admitted deletion target of ${target.rootSessionId}`)
    if (target.kind === "child" && operation.version === 1) {
      const edgesByChild = new Map(operation.edges.map((edge) => [edge.childSessionId, edge]))
      const belongsToRoot = (childSessionId: string, visited = new Set<string>()): boolean => {
        if (visited.has(childSessionId)) return false
        visited.add(childSessionId)
        const edge = edgesByChild.get(childSessionId)
        if (!edge) return false
        return edge.parentSessionId === operation.rootSessionId
          || belongsToRoot(edge.parentSessionId, visited)
      }
      if (!belongsToRoot(target.sessionId)) {
        throw new Error(`Session ${target.sessionId} is not authorized by deletion root ${operation.rootSessionId}`)
      }
    }

    for (let index = 0; index < targetIndex; index += 1) {
      const preceding = plan.targets[index]
      const complete = preceding?.kind === "workflow"
        ? await workflowTombstoned(preceding.workflowId)
        : preceding?.kind === "child" && await edgeComplete({ parentSessionId: preceding.parentSessionId, childSessionId: preceding.sessionId })
      if (!complete) throw new Error(`Session ${targetId} is not the next deletion target`)
    }

    if (target.kind === "workflow") {
      const run = await workflowRunReader(ports.projectionReader).read(target.workflowId)
      if (!run && await workflowTombstoned(target.workflowId)) {
        if (target.workflowId === operation.rootSessionId) await ports.writer.dropInFlight?.(target.workflowId, CHILD_SESSION_DELETION_IN_FLIGHT_KIND, target.workflowId)
        return []
      }
      if (!run || run.launchedFrom.parentSessionId !== target.parentSessionId) throw new Error(`Workflow ${target.workflowId} no longer has its admitted launch binding`)
      const notices = await ports.deleteWorkflow(target.workflowId)
      if (target.workflowId === operation.rootSessionId) {
        if (!ports.writer.dropInFlight) throw new Error("Workflow deletion requires in-flight retirement")
        await ports.writer.dropInFlight(target.workflowId, CHILD_SESSION_DELETION_IN_FLIGHT_KIND, target.workflowId)
      }
      return notices
    }

    if (target.kind === "root") {
      if (target.sessionId !== operation.rootSessionId) {
        throw new Error(`Session ${target.sessionId} is not the admitted deletion root ${operation.rootSessionId}`)
      }
      return await ports.deleteOne(target.sessionId)
    }

    const edge = { parentSessionId: target.parentSessionId, childSessionId: target.sessionId }
    if (await edgeComplete(edge)) return []
    const child = await ports.read(target.sessionId)
    const parent = await ports.read(target.parentSessionId)
    if (!child && await tombstoned(target.sessionId)) {
      if (!(parent?.childSessionIds ?? []).includes(target.sessionId)) {
        throw new Error(`Session ${target.sessionId} no longer has its admitted live child binding`)
      }
      await ports.unlink(target.parentSessionId, target.sessionId)
      return []
    }
    if (
      !child || child.kind === "chat"
      || child.launchedFrom?.parentSessionId !== target.parentSessionId
      || !(parent?.childSessionIds ?? []).includes(target.sessionId)
    ) {
      throw new Error(`Session ${target.sessionId} no longer has its admitted live child binding`)
    }
    return await ports.deleteOne(target.sessionId)
  }

  async function workflowTombstoned(workflowId: string): Promise<boolean> {
    return workflowRunOwner().deleted(ports.projectionReader, workflowId)
  }

  /** Whether `sessionId` is `rootSessionId` or a child session linked below
   *  it. A chat ends the walk: a fork outlives its origin's deletion. */
  async function linkedBelow(sessionId: string, rootSessionId: string): Promise<boolean> {
    const visited = new Set<string>()
    let current: string | undefined = sessionId
    while (current !== undefined && !visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const session = await ports.read(current)
      if (!session || session.kind === "chat") return false
      current = session.launchedFrom?.parentSessionId
    }
    return false
  }

  /** A cell that does not read names only its root for certain, not the
   *  edges it admitted. So it holds every launch below its root, at any
   *  depth, the subtree a recursive deletion of that root would own, and
   *  none elsewhere. It never stops the project's other work; recovery
   *  reports it (ARCH-SUBSTRATE-013). */
  async function blocksLaunch(parentSessionId: string): Promise<boolean> {
    for (const owner of await ports.projectionReader.sessionsWithInFlight(CHILD_SESSION_DELETION_IN_FLIGHT_KIND)) {
      let operation: RetainedChildSessionDeletion | null
      try {
        operation = await retained(owner)
      } catch {
        if (await linkedBelow(parentSessionId, owner)) return true
        continue
      }
      if (operation && (
        operation.rootSessionId === parentSessionId
        || childSessionDeletionPlan(operation).targets.some((target) => target.kind === "workflow" ? target.workflowId === parentSessionId : target.sessionId === parentSessionId)
      )) return true
    }
    return false
  }

  return { admit, finalize, blocksLaunch }
}

/** Runs the kind owner's durable settlement that precedes state finalization. */
async function settleChildSessionDeletionTarget(
  ports: ChildSessionDeletionSettlementPorts,
  target: ChildSessionDeletionTarget,
): Promise<void> {
  if (target.kind === "workflow") {
    const run = await workflowRunReader(ports.projectionReader).read(target.workflowId)
    if (run) await workflowRunOwner().settleDeletion({ ...ports, workflowId: target.workflowId, run })
    return
  }
  const child = await ports.read(target.sessionId)
  if (!child || child.kind === "chat") return
  if (target.kind === "child") {
    const parent = await ports.read(target.parentSessionId)
    if (
      child.launchedFrom?.parentSessionId !== target.parentSessionId
      || !(parent?.childSessionIds ?? []).includes(target.sessionId)
    ) throw new Error(`Session ${target.sessionId} no longer has its admitted live child binding`)
  }
  await settleInstalledSessionDeletion({
    projectRoot: ports.projectRoot,
    sessionId: target.sessionId,
    session: child,
    reader: ports.reader,
    projectionReader: ports.projectionReader,
    writer: ports.writer,
    abort: ports.abort,
    deliverNotification: ports.deliverNotification,
  })
}

/** Settles and finalizes the admitted targets in their retained leaf-first order.
 *
 *  A child's settlement notifies its parent of how the child ended, and each
 *  delete returns the messages its target never read. The delete can run in
 *  the process that owns the project state, where no session runs, so this
 *  executor, which runs where the sessions run, hands each returned notice
 *  to its live sender. A session that this plan also deletes gets no
 *  delivery: the notification would wake its parked runner into a model
 *  request that its own deletion then aborts. The notification stays held
 *  with it, and its deletion removes it. */
export async function executeChildSessionDeletionPlan(
  ports: ChildSessionDeletionExecutorPorts,
  plan: ChildSessionDeletionPlan,
): Promise<void> {
  const deleted = new Set(plan.targets.flatMap((target) => target.kind === "workflow" ? [] : [target.sessionId]))
  const { deliverNotification } = ports
  const settlementPorts: ChildSessionDeletionSettlementPorts = deliverNotification
    ? { ...ports, deliverNotification: async (parentSessionId, notification) => !deleted.has(parentSessionId) && await deliverNotification(parentSessionId, notification) }
    : ports
  // A workflow must stop admitting and join its members before any member tombstone.
  for (const target of plan.targets) if (target.kind === "workflow") await settleChildSessionDeletionTarget(settlementPorts, target)
  for (const target of plan.targets) {
    if (target.kind !== "workflow") await settleChildSessionDeletionTarget(settlementPorts, target)
    const returned = await ports.finalizeDeletionTarget(target)
    await wakeAfterSettlement(ports.reader, target.kind === "workflow" ? target.workflowId : target.sessionId, returned.filter((notice) => !deleted.has(notice.senderSessionId)))
  }
}
