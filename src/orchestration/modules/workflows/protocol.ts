import { isDeepStrictEqual } from "node:util"
import { workflowsProtocol, type WorkflowDetail } from "../../../protocol/modules/workflows.js"
import type { RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
import { createWorkflowViewProtocolReader, createWorkflowViewProtocolProjection } from "./view-protocol.js"
import { readWorkflowLiveView, createWorkflowLiveProtocolProjection } from "./live-protocol.js"
import type { ModuleBackgroundReaders, ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import { asAsyncEventReadSurface, type EventReader } from "../../../infra/event-store-types.js"
import { readSessionMetadata } from "../../session/session-metadata-store.js"
import { executeChildSessionDeletionPlan } from "../../session/child-session-deletion.js"
import { attachedRunnerDelivery } from "../../app-service/session-background-notifications.js"
import { recordBackgroundFailure } from "../../../infra/operation-log.js"
import { Log } from "../../../infra/log.js"
import { WHOLE_WORKFLOW } from "../../session/conversation/addressed-workflow-messages.js"
import { EARLIER_AGENT_SESSION_REFUSAL, resolveWorkflowDeliveryAddress } from "../../workflow-host/workflow-addressing.js"
import { errorMessage } from "../../../infra/error-message.js"
import { composeWorkflowDetail, createWorkflowDetailPartsReader, createWorkflowDetailReader, WORKFLOW_DETAIL_INPUTS, type WorkflowDetailInput, type WorkflowDetailParts } from "./detail.js"
import { createStartedAgentStates } from "../../workflow-host/started-agent-states.js"
import { advanceWorkflowMemberTotals } from "../../workflow-host/member-totals.js"
import { BUDGET_FACT_TYPES } from "../../session/budget-projection.js"
import { composeModuleServices, moduleServiceHandle } from "../../../infra/module-service.js"
import type { ModuleWorkflowRuns } from "../../module-seams.js"

type WorkflowProtocolInputs = Parameters<ModuleWorkflowRuns["protocolServices"]>[0]
const workflowProtocolService = moduleServiceHandle<{
  readonly projectRoot: string
  readonly controller: WorkflowProtocolInputs["controller"]
  readonly auth: WorkflowProtocolInputs["auth"]
  readonly authStatus: WorkflowProtocolInputs["authStatus"]
  readonly isRunning: (workflowId: string) => boolean
  readonly onHostChanged: (listener: () => void) => () => void
  readonly onAuthChanged: (listener: () => void) => () => void
  readonly interrupt: (workflowId: string, address: import("../../session/conversation/addressed-workflow-messages.js").WorkflowDeliveryAddress) => Promise<boolean>
  readonly stop: (workflowId: string) => Promise<void>
  readonly abort: (workflowId: string) => Promise<boolean>
  readonly deletion: Pick<import("../../session/manager.js").SessionManager, "admitDeletion" | "finalizeDeletionTarget">
}>("workflows")

/** The installed workflow owner binds controls once; unrelated protocol modules receive only the neutral service registry. */
export const workflowProtocolServices: ModuleWorkflowRuns["protocolServices"] = (input) => {
  const control = {
    isRunning: input.hosts.isRunning, onHostChanged: input.hosts.onChange,
    projectRoot: input.projectRoot, controller: input.controller, auth: input.auth, authStatus: input.authStatus,
    onAuthChanged(listener: () => void) {
      const observe = (event: import("../../../protocol/app-service-types.js").FrontendEvent) => {
        if (event.type === "patch" && event.patch.payload.kind === "auth.changed") listener()
      }
      input.bus.addListener(observe)
      return () => input.bus.removeListener(observe)
    },
    interrupt: (id: string, address: import("../../session/conversation/addressed-workflow-messages.js").WorkflowDeliveryAddress) => input.supervisor.interruptSession(id, "person", address),
    stop: (id: string) => input.controller.stopLaunch(id, "person"),
    abort: input.hosts.abort,
    deletion: input.deletion,
  }
  const own = composeModuleServices([["workflows", control]])
  return { get: (handle) => handle.moduleId === workflowProtocolService.moduleId ? own.get(handle) : input.modules.get(handle) }
}

const workflowDetailCursor = (workflowId: string) => ({ scope: "workflow" as const, domain: "workflow_detail" as const, workflowId })

export function createWorkflowsProtocol(services: Pick<ModuleProtocolServices, "projectionReader" | "eventStore" | "eventWriter" | "manager" | "modules" | "onStored" | "snapshotPosition" | "publish"> & {
  readonly sessionStore: Pick<ModuleProtocolServices["sessionStore"], "get" | "onChange" | "remove">
}): ModuleProtocolRuntime<typeof workflowsProtocol> {
  const port = services.modules.get(workflowProtocolService)
  if (!port) throw new Error("Workflow protocol controls are not composed")
  // The agent owner subscribes before the detail and the live view, so a
  // commit marks its started set before either reads it again.
  const agents = createStartedAgentStates({ reader: services.projectionReader, onStored: services.onStored })
  const viewProjection = createWorkflowViewProtocolProjection({ reader: services.projectionReader, onStored: services.onStored, publish: services.publish })
  const liveProjection = createWorkflowLiveProtocolProjection({ reader: services.projectionReader, onStored: services.onStored, sessionStore: services.sessionStore, agents, publish: services.publish })
  const read = createWorkflowDetailPartsReader({
    reader: services.projectionReader, manager: services.manager, projectRoot: port.projectRoot,
    auth: async (id) => port.authStatus.view(await port.auth.snapshot(id)), isRunning: port.isRunning, turnEnds: agents.turnEnds,
  })
  /** Each held detail, with the parts it composes from. Parts are null
   *  while the next read must read every part: no workflow had the id, or
   *  the last read failed. */
  const held = new Map<string, { readonly parts: WorkflowDetailParts | null; readonly view: WorkflowDetail | null }>()
  const heldByParent = new Map<string, Set<string>>()
  const retain = (id: string, parts: WorkflowDetailParts | null) => {
    const view = parts && composeWorkflowDetail(id, parts)
    const previous = held.get(id)?.view
    const previousParent = previous?.launchedFrom.parentSessionId
    const parent = view?.launchedFrom.parentSessionId
    if (previousParent !== parent) {
      const ids = previousParent === undefined ? undefined : heldByParent.get(previousParent)
      ids?.delete(id)
      if (ids?.size === 0 && previousParent !== undefined) heldByParent.delete(previousParent)
      if (parent !== undefined) {
        let next = heldByParent.get(parent)
        if (!next) heldByParent.set(parent, next = new Set())
        next.add(id)
      }
    }
    held.set(id, { parts, view })
    return { view, moved: !isDeepStrictEqual(view, previous) }
  }
  /** The inputs of each held detail that a change moved since its last read. */
  const dirty = new Map<string, Set<WorkflowDetailInput>>()
  const log = Log.create({ service: "workflow-protocol" })
  let pending: Promise<void> | undefined
  let disposed = false
  const publish = (workflowId: string, view: WorkflowDetail | null): RuntimeUiPatchInput => ({ cursor: workflowDetailCursor(workflowId), payload: { kind: "workflow_detail.changed", view } })
  const changed = (ids: Iterable<string>, inputs: Iterable<WorkflowDetailInput>) => {
    for (const id of ids) {
      let stale = dirty.get(id)
      if (!stale) dirty.set(id, stale = new Set())
      for (const input of inputs) stale.add(input)
    }
    pending ??= Promise.resolve().then(async () => {
      try {
        while (dirty.size > 0) {
          if (disposed) return
          const batch = [...dirty]
          dirty.clear()
          for (const [id, stale] of batch) {
            const previous = held.get(id)
            const parts = previous?.parts
            let next: WorkflowDetailParts | null
            try {
              next = await read(id, parts ? { parts, stale } : undefined)
            } catch (error) {
              // The marks of a failed read are gone, so the next change for
              // this id reads every part instead of only its own input.
              if (previous) held.set(id, { parts: null, view: previous.view })
              recordBackgroundFailure(log, "read workflow detail", { workflowId: id, inputs: [...stale].join(",") }, error)
              continue
            }
            const { view, moved } = retain(id, next)
            if (moved) services.publish(publish(id, view))
          }
        }
      } finally {
        pending = undefined
      }
    }).catch((error: unknown) => recordBackgroundFailure(log, "publish workflow details", { workflows: held.size }, error))
  }
  const offFacts = services.onStored((facts) => {
    const ids = new Set<string>()
    const calls = new Set<string>()
    let budgetChanged = false
    for (const fact of facts) {
      if (BUDGET_FACT_TYPES.some(type => type === fact.type)) { budgetChanged = true; continue }
      if (fact.aggregateId.startsWith("workflow:")) {
        const id = fact.aggregateId.slice("workflow:".length)
        if (held.has(id)) ids.add(id)
      }
      if (fact.type === "tool.result.recorded") for (const id of heldByParent.get(fact.sessionId) ?? []) calls.add(id)
    }
    if (ids.size > 0) changed(ids, WORKFLOW_DETAIL_INPUTS)
    if (calls.size > 0) changed(calls, ["record"])
    // A usage batch moves only the totals of the workflows whose members it
    // counts, so it reads neither the agents nor the control of any detail.
    // It also moves the duration of a workflow that no host here runs, whose
    // open interval ends at its members' newest evidence.
    if (budgetChanged) void advanceWorkflowMemberTotals(services.projectionReader)
      .then(moved => changed(moved.filter(id => held.has(id)), ["usage", "duration"]))
      .catch((error: unknown) => recordBackgroundFailure(log, "invalidate workflow usage", { workflows: held.size }, error))
  })
  const offAgents = agents.onChange((moved) => changed([...moved].filter(id => held.has(id)), ["agents"]))
  const offAuth = port.onAuthChanged(() => changed(held.keys(), ["auth"]))
  // A host that starts or stops moves only whether the clock runs.
  const offHosts = port.onHostChanged(() => changed(held.keys(), ["duration"]))
  const ok = { ok: true as const }
  const sent = (result: Awaited<ReturnType<typeof port.controller.sendWorkflow>>) =>
    result.kind === "delivered" || result.kind === "retained"
      ? { ...ok, ...(result.confirmedSubmissionIds ? { confirmedSubmissionIds: result.confirmedSubmissionIds } : {}) }
      : { ok: false as const, error: "message" in result ? result.message : "The workflow did not accept this message." }
  return {
    serve: {
      async workflowDetail(query) {
        const snapshotPosition = services.snapshotPosition({ kind: "cursor", cursor: workflowDetailCursor(query.workflowId) })
        const { view } = retain(query.workflowId, await read(query.workflowId))
        return { snapshotPosition, view }
      },
      async workflowViewSnapshot(query) {
        const snapshotPosition = services.snapshotPosition({ kind: "cursor", cursor: { scope: "workflow", domain: "workflow_view", workflowId: query.workflowId } })
        return { snapshotPosition, view: await viewProjection.snapshot(query.workflowId) }
      },
      async workflowLiveSnapshot(query) {
        const snapshotPosition = services.snapshotPosition({ kind: "cursor", cursor: { scope: "workflow", domain: "workflow_live", workflowId: query.workflowId } })
        return { snapshotPosition, view: await liveProjection.snapshot(query.workflowId) }
      },
    },
    mutate: {
      async "workflow.send"(command) {
        return sent(await port.controller.sendWorkflow(command.workflowId, command.input, command.targets))
      },
      async "workflow.interrupt"(command) {
        const address = command.targets?.length ? await resolveWorkflowDeliveryAddress(services.projectionReader, command.workflowId, command.targets, "interrupt") : { ok: true as const, address: WHOLE_WORKFLOW }
        if (!address.ok) return { kind: "interrupt", interrupted: false, reason: address.refusal }
        return { kind: "interrupt", interrupted: await port.interrupt(command.workflowId, address.address) }
      },
      async "workflow.resume"(command) {
        const address = command.targets?.length ? await resolveWorkflowDeliveryAddress(services.projectionReader, command.workflowId, command.targets) : { ok: true as const, address: WHOLE_WORKFLOW }
        if (!address.ok) return { ok: false, error: address.refusal }
        const result = await port.controller.resumeWorkflow(command.workflowId, address.address)
        return result.kind === "resumed" || result.kind === "already_running" ? ok : { ok: false, error: result.message }
      },
      async "workflow.restart"(command) {
        const result = await port.controller.restartWorkflow(command.workflowId)
        return result.kind === "restarted" ? ok : { ok: false, error: result.message }
      },
      async "workflow.stop"(command) { await port.stop(command.workflowId); return ok },
      async "workflow.delete"(command) {
        const plan = await port.deletion.admitDeletion(command.workflowId)
        await executeChildSessionDeletionPlan({
          projectRoot: port.projectRoot, reader: services.eventStore, projectionReader: services.projectionReader,
          writer: services.eventWriter, read: services.manager.read, finalizeDeletionTarget: port.deletion.finalizeDeletionTarget,
          deliverNotification: attachedRunnerDelivery(services.sessionStore),
          abort: async (id) => { if (!await port.abort(id)) await services.sessionStore.remove(id) },
        }, plan)
        return ok
      },
      async "workflow.profile.select"(command) {
        try {
          return await port.auth.select(command.workflowId, command.profileId) ? ok : { ok: false, error: "Workflow not found." }
        } catch (error) { return { ok: false, error: errorMessage(error) } }
      },
    },
    // A person's message in an agent view addresses that agent's item or
    // named agent through the workflow (PI-AGENT-027), so the item's agent
    // in a later phase reads it too. The workflow resolves the address from
    // the session's attempt, never from a key that an earlier list shares.
    send: {
      kind: "workflow-agent",
      async send(sessionId, input) {
        const session = await services.manager.read(sessionId)
        const membership = session?.kind === "workflow-agent" ? session.workflowMembership : undefined
        if (membership?.kind !== "attempt") return { ok: false, error: EARLIER_AGENT_SESSION_REFUSAL }
        return sent(await port.controller.sendWorkflow(membership.workflowId, input, { attemptId: membership.attemptId }))
      },
    },
    dispose() { disposed = true; offFacts(); offAgents(); offAuth(); offHosts(); held.clear(); heldByParent.clear(); viewProjection.dispose(); liveProjection.dispose(); agents.dispose() },
  }
}

/** The same readers serve a stopped executor through the existing background Worker. */
export function workflowBackgroundReaders(reader: EventReader, context: { readonly projectRoot: string }): ModuleBackgroundReaders<typeof workflowsProtocol> {
  const projectionReader = asAsyncEventReadSurface(reader)
  const detail = createWorkflowDetailReader({ reader: projectionReader, manager: { read: (id) => readSessionMetadata(projectionReader, id) }, projectRoot: context.projectRoot })
  const view = createWorkflowViewProtocolReader(projectionReader)
  return {
    workflow_detail: async (workflowId) => ({ view: await detail(workflowId) }),
    workflow_view: async (workflowId) => ({ view: await view(workflowId) }),
    workflow_live: async (workflowId) => ({ view: await readWorkflowLiveView(projectionReader, workflowId) }),
  }
}

