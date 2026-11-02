import { Log } from "../../infra/log.js"
import type { PausedBy } from "../../infra/output-blocks.js"
import type { ChildControlAnswer, ChildStopAnswer, ChildSessionPorts, ChildSessionTarget, WorkflowWorkTarget } from "../module-seams.js"
import type { ChildCut } from "./child-continuation.js"
import { installedChildSession } from "./module-session-operations.js"
import { observeSessionChanged, waitsReach } from "./reply-waits.js"
import { sessionDisplayName, type ReplayedSession } from "./schemas.js"
import { readRecipientState, type SessionInputDeliveryDeps } from "./session-input-delivery.js"
import type { RecipientState } from "./live-session-control.js"
import { listState, type SessionListState } from "./session-messaging.js"
import { resolveWorkflowDeliveryAddress } from "../workflow-host/workflow-addressing.js"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "./conversation/addressed-workflow-messages.js"
import type { BackgroundWorkTracking } from "../agent-runtime/background-work.js"
import { workflowRunOwner, workflowRunReader } from "../module-catalog.js"

const log = Log.create({ service: "child-session-control" })

/** How a child reads to its parent: as every session list reads it, or
 *  waiting on its parent's reply while it runs or rests. */
type ChildState = SessionListState | "waiting_on_parent"

/** One child of a parent, from the durable binding. `id` is the child's
 *  session id, its one address for every control and for messages. */
export interface ChildRow {
  readonly id: string
  readonly kind: "subagent" | "workflow"
  readonly name: string
  readonly state: ChildState
  /** The items or agents of the child that a message can name in
   *  `targets`, one line each. Empty for a child with none. */
  readonly addresses: readonly string[]
}

/** A child's row with who interrupted it, and its progress. */
export interface ChildStatus extends ChildRow {
  /** Who interrupted a child that waits on an interrupt. */
  readonly interruptedBy?: PausedBy
  /** An unexpected exit left the child waiting for a Resume. */
  readonly exited?: true
  /** Where the child is in its work, in its kind owner's words. */
  readonly progress: readonly string[]
}

/** The controls of the children that a parent agent started: the reads
 *  that `process list` and `process status` show, and the parent's
 *  Interrupt, Resume, and Stop. Each finds the child from the durable
 *  binding, never from runner memory, so it works after the parent's runner
 *  restarts. Every control admits only the caller's own child. */
export interface ChildSessionControl {
  /** Restores live child observers before a replacement parent can start work. */
  restoreTracking(parentSessionId: string, tasks: BackgroundWorkTracking): Promise<void>
  list(parentSessionId: string): Promise<readonly ChildRow[]>
  /** Undefined for a session that is not the caller's own child. */
  status(parentSessionId: string, childSessionId: string): Promise<ChildStatus | undefined>
  /** Whether `childSessionId` is the caller's own child. */
  isChild(parentSessionId: string, childSessionId: string): Promise<boolean>
  /** The one Interrupt, with the parent agent as its actor. The parent's
   *  own wait on that child ends before it returns: no wait parks on an
   *  interrupted child. Optional targets use workflow message keys; missing
   *  or empty targets control the whole child. Invalid targets refuse before control. */
  interrupt(parentSessionId: string, childSessionId: string, targets?: readonly string[]): Promise<ChildControlAnswer>
  /** The parent's Resume, which `parentMayContinue` admits. It also hands
   *  back a child that holds the parent's message behind an interrupt.
   *  Optional targets select only the named items or agents of the workflow. */
  resume(parentSessionId: string, childSessionId: string, targets?: readonly string[]): Promise<ChildControlAnswer>
  /** The parent's Stop reports the child's durable outcome, not assumed cancellation. */
  stop(parentSessionId: string, childSessionId: string): Promise<ChildStopAnswer>
}

export interface ChildSessionControlDeps extends Omit<ChildSessionPorts, "hosts"> {
  readonly manager: SessionInputDeliveryDeps["manager"]
  /** The composition's hosts, read at each control: the workflow host
   *  exists only after the runners that hold this control are composed. */
  readonly hosts: () => ChildSessionPorts["hosts"]
  /** The one Interrupt of a session (`RuntimeSupervisor.interruptSession`)
   *  with the parent agent as its actor. */
  readonly interrupt: (sessionId: string, address?: WorkflowDeliveryAddress) => Promise<boolean>
}

type ChildSession = Extract<ReplayedSession, { kind: "subagent" }>

function childState(state: RecipientState, waitsOnParent: boolean): ChildState | undefined {
  const listed = listState(state)
  return waitsOnParent && (listed === "running" || listed === "idle") ? "waiting_on_parent" : listed
}

export function createChildSessionControl(deps: ChildSessionControlDeps): ChildSessionControl {
  const { manager, interrupt, hosts, ...ports } = deps

  async function childOf(parentSessionId: string, childSessionId: string): Promise<ChildSession | undefined> {
    const session = await manager.read(childSessionId)
    if (session?.kind !== "subagent" || session.launchedFrom.parentSessionId !== parentSessionId) return undefined
    return session
  }

  async function row(parentSessionId: string, id: string, session: ChildSession): Promise<ChildRow | undefined> {
    const state = childState(await readRecipientState(ports, id, session), waitsReach(ports.projectionReader, id, parentSessionId))
    if (!state) return undefined
    const addresses = await owner(session).addresses?.(target(id, session)) ?? []
    return { id, kind: session.kind, name: sessionDisplayName({ id, session }), state, addresses }
  }

  function target(sessionId: string, session: ChildSession): ChildSessionTarget {
    return { ...ports, hosts: hosts(), sessionId, session }
  }

  function owner(session: ChildSession) {
    const found = installedChildSession(session.kind)
    if (!found) throw new Error(`No installed module owns ${session.kind} children`)
    return found
  }
  async function workflowOf(parentSessionId: string, workflowId: string): Promise<WorkflowWorkTarget | undefined> {
    const run = await workflowRunReader(ports.projectionReader).read(workflowId)
    return run?.launchedFrom.parentSessionId === parentSessionId ? { ...ports, hosts: hosts(), workflowId, run } : undefined
  }
  async function workflowRow(input: WorkflowWorkTarget): Promise<ChildRow> {
    return { id: input.workflowId, kind: "workflow", name: input.run.label,
      state: await workflowRunOwner().state(input), addresses: await workflowRunOwner().work.addresses?.(input) ?? [] }
  }

  const notChild = (childSessionId: string): Extract<ChildControlAnswer, { ok: false }> => ({ ok: false, error: `${childSessionId} is not a child that you started. Use process(action='list') to find your children.` })

  async function controlAddress(_sessionId: string, _session: ChildSession, targets: readonly string[] | undefined, _operation: "message" | "interrupt" = "message") {
    if (!targets?.length) return { ok: true as const, address: WHOLE_WORKFLOW }
    return { ok: false as const, refusal: "targets name items or agents of a workflow, and this child is not a workflow. Omit targets to control this child." }
  }

  return {
    async restoreTracking(parentSessionId, tasks) {
      const parent = await manager.read(parentSessionId)
      for (const id of parent?.childSessionIds ?? []) {
        const session = await childOf(parentSessionId, id)
        if (session) await owner(session).restoreTracking?.({ ...target(id, session), tasks })
      }
      for (const { workflowId } of await workflowRunReader(ports.projectionReader).listForParent(parentSessionId)) {
        const input = await workflowOf(parentSessionId, workflowId)
        if (input) await workflowRunOwner().work.restoreTracking?.({ ...input, tasks })
      }
    },
    async list(parentSessionId) {
      const parent = await manager.read(parentSessionId)
      const rows = await Promise.all((parent?.childSessionIds ?? []).map(async (id) => {
        const session = await childOf(parentSessionId, id)
        return session ? await row(parentSessionId, id, session) : undefined
      }))
      const workflows = await Promise.all((await workflowRunReader(ports.projectionReader).listForParent(parentSessionId))
        .map(({ workflowId }) => workflowOf(parentSessionId, workflowId).then((input) => input ? workflowRow(input) : undefined)))
      return [...rows, ...workflows].filter((entry) => entry !== undefined)
    },

    async status(parentSessionId, childSessionId) {
      const workflow = await workflowOf(parentSessionId, childSessionId)
      if (workflow) {
        const listed = await workflowRow(workflow)
        const cut = await workflowRunOwner().work.cut(workflow)
        return { ...listed, progress: await workflowRunOwner().work.progress(workflow),
          ...(cut?.kind === "interrupt" ? { interruptedBy: cut.by } : {}),
          ...(cut?.kind === "exit" ? { exited: true as const } : {}) }
      }
      const session = await childOf(parentSessionId, childSessionId)
      if (!session) return undefined
      const listed = await row(parentSessionId, childSessionId, session)
      if (!listed) return undefined
      const childTarget = target(childSessionId, session)
      const [cut, progress] = await Promise.all([
        listed.state === "interrupted" ? owner(session).cut(childTarget) : Promise.resolve<ChildCut | undefined>(undefined),
        owner(session).progress(childTarget),
      ])
      return {
        ...listed,
        ...(cut?.kind === "interrupt" ? { interruptedBy: cut.by } : {}),
        ...(cut?.kind === "exit" ? { exited: true as const } : {}),
        progress,
      }
    },

    async isChild(parentSessionId, childSessionId) {
      return await childOf(parentSessionId, childSessionId) !== undefined || await workflowOf(parentSessionId, childSessionId) !== undefined
    },

    async interrupt(parentSessionId, childSessionId, targets) {
      const workflow = await workflowOf(parentSessionId, childSessionId)
      if (workflow) {
        const resolved = targets?.length ? await resolveWorkflowDeliveryAddress(ports.projectionReader, workflow.workflowId, targets, "interrupt") : { ok: true as const, address: WHOLE_WORKFLOW }
        if (!resolved.ok) return { ok: false, error: resolved.refusal }
        return await interrupt(workflow.workflowId, resolved.address) ? { ok: true } : { ok: false, error: `${resolved.address.label} is not running, so there is nothing to interrupt.` }
      }
      const session = await childOf(parentSessionId, childSessionId)
      if (!session) return notChild(childSessionId)
      const resolved = await controlAddress(childSessionId, session, targets, "interrupt")
      if (!resolved.ok) return { ok: false, error: resolved.refusal }
      const interrupted = await interrupt(childSessionId, resolved.address)
      // The interrupt reports to the waits on the child, so the end rules
      // read it now and the parent does not wait on work that it cut.
      if (interrupted) await observeSessionChanged(ports.projectionReader, childSessionId)
      log.info("parent agent interrupt of its child", { parentSessionId, childSessionId, interrupted })
      return interrupted ? { ok: true } : { ok: false, error: targets?.length ? `${resolved.address.label} is not running, so there is nothing to interrupt.` : "This child is not running, so there is nothing to interrupt." }
    },

    async resume(parentSessionId, childSessionId, targets) {
      const workflow = await workflowOf(parentSessionId, childSessionId)
      if (workflow) {
        const resolved = targets?.length ? await resolveWorkflowDeliveryAddress(ports.projectionReader, workflow.workflowId, targets) : { ok: true as const, address: WHOLE_WORKFLOW }
        return resolved.ok ? workflowRunOwner().work.resume({ ...workflow, address: resolved.address }) : { ok: false, error: resolved.refusal }
      }
      const session = await childOf(parentSessionId, childSessionId)
      if (!session) return notChild(childSessionId)
      const resolved = await controlAddress(childSessionId, session, targets)
      if (!resolved.ok) return { ok: false, error: resolved.refusal }
      const answer = await owner(session).resume({ ...target(childSessionId, session), address: resolved.address })
      log.info("parent agent resume of its child", { parentSessionId, childSessionId, kind: session.kind, resumed: answer.ok })
      return !answer.ok && targets?.length ? { ok: false, error: `${resolved.address.label}: ${answer.error}` } : answer
    },

    async stop(parentSessionId, childSessionId) {
      const workflow = await workflowOf(parentSessionId, childSessionId)
      if (workflow) return workflowRunOwner().work.stop({ ...workflow, by: "agent" })
      const session = await childOf(parentSessionId, childSessionId)
      if (!session) return notChild(childSessionId)
      return owner(session).stop({ ...target(childSessionId, session), by: "agent" })
    },
  }
}
