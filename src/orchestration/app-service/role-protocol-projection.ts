import { rolesCursor, type RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { SessionManager } from "../session/manager.js"
import type { RoleAssignmentSnapshot } from "../session/schemas.js"
import { Log } from "../../infra/log.js"
import { createBackgroundLane } from "../../infra/ordered-lane.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { agentPersonas, installedPersonaRole } from "../workflow-host/frontend-attempts.js"
import { createRoleAssignmentReader } from "./role-assignment-projection.js"
import { workflowRunOwner, workflowRunReader } from "../module-catalog.js"
import type { RuntimeOwnership } from "./runtime-ownership.js"
import type { ProviderConnectionCapture } from "../agent-runtime/factory.js"
import { installedChildSessionHistory } from "../session/module-session-operations.js"
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"

const log = Log.create({ service: "role-protocol-projection" })

export interface RoleProtocolProjection {
  snapshot(sessionId: string): Promise<RoleAssignmentView | null>
  dispose(): Promise<void>
}

export function createRoleProtocolProjection(deps: {
  readonly manager: Pick<SessionManager, "subscribe">
  readonly readRoles: (sessionId: string) => Promise<RoleAssignmentView | null>
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch
  readonly subscribeRefresh?: (refresh: (sessionId?: string) => void) => () => Promise<void>
}): RoleProtocolProjection {
  let disposed = false
  const lane = createBackgroundLane(log, "role-protocol")
  const known = new Set<string>()
  const snapshot = (sessionId: string) => { known.add(sessionId); return deps.readRoles(sessionId) }
  const push = async (sessionId: string) => {
    if (disposed) return
    const roles = await deps.readRoles(sessionId)
    if (disposed) return
    deps.publish({ cursor: rolesCursor(sessionId), payload: roles ? { kind: "roles.updated", roles } : { kind: "roles.removed" } })
  }
  // Refresh requests coalesce into one pending set that one lane task drains,
  // so a burst of policy publications pushes each held reading once. A
  // profile-wide change covers every held reading; a local edit reaches only
  // its session, independent of the workflow's member count.
  let refreshAll = false
  const refreshing = new Set<string>()
  let drainQueued = false
  const unsubscribeRefresh = deps.subscribeRefresh?.((sessionId) => {
    if (sessionId === undefined) refreshAll = true
    else refreshing.add(sessionId)
    if (drainQueued) return
    drainQueued = true
    lane.runInBackground("serving policy push", async () => {
      drainQueued = false
      const ids = refreshAll ? [...known] : [...refreshing].filter((id) => known.has(id))
      refreshAll = false
      refreshing.clear()
      for (const id of ids) await push(id)
    })
  })
  const unsubscribe = deps.manager.subscribe((change) => {
    lane.runInBackground("roles push", async () => {
      if (disposed) return
      if (change.kind === "deleted") {
        known.delete(change.sessionId)
        deps.publish({ cursor: rolesCursor(change.sessionId), payload: { kind: "roles.removed" } })
        return
      }
      // Only a session some client read holds a reading to patch. Resolving
      // another would admit its provider connection for nobody.
      for (const sessionId of change.sessionIds) {
        if (known.has(sessionId)) await push(sessionId)
      }
    })
  })
  return { snapshot, dispose: async () => { disposed = true; unsubscribe(); await unsubscribeRefresh?.(); await lane.settled() } }
}

/** Owns the role projection in the runtime scope. Workflow roles resolve the
 * session's provider connection through `capture`, lazily on each read. */
export function composeRoleProtocolProjection(scope: RuntimeOwnership, deps: {
  readonly manager: Pick<SessionManager, "subscribe" | "read">
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch
  readonly reader: AsyncEventStateReadSurface
  readonly userDataRoot: string
  readonly capture: (sessionId: string) => Promise<ProviderConnectionCapture>
  readonly definitions: Pick<ProjectDefinitionRegistry, "personas">
  readonly bus: Pick<RuntimeUiBus, "addListener" | "removeListener">
  readonly onStored: (listener: (facts: readonly StoredFact[]) => void) => () => void
  /** Runs `onChange` after each publication that changed the profiles setting. */
  readonly onProfilesChanged: (onChange: () => void) => () => Promise<void>
}): RoleProtocolProjection {
  const runs = workflowRunReader(deps.reader)
  const records = new Map<string, ReturnType<typeof loadRecords>>()
  const loadRecords = async (workflowId: string) => {
    const lineage = await runs.readDefinitionLineage(workflowId)
    return {
      definitions: lineage.definitions,
      personas: agentPersonas(lineage, installedPersonaRole(deps.definitions.personas())),
    }
  }
  const runRecords = (workflowId: string) => {
    let held = records.get(workflowId)
    if (!held) {
      held = loadRecords(workflowId)
      records.set(workflowId, held)
    }
    return held
  }
  // Attempt identities and child persona types do not change across requests.
  // Resolve them once, not once per member on each card update.
  const attempts = new Map<string, Promise<{ readonly briefId: string; readonly definitionId: string } | undefined>>()
  const agentTypes = new Map<string, Promise<string | undefined>>()
  const attempt = (workflowId: string, attemptId: string) => {
    const key = JSON.stringify([workflowId, attemptId])
    let held = attempts.get(key)
    if (!held) {
      held = runs.readAttempt(workflowId, attemptId).then(async (row) => {
        if (row === null) return undefined
        const loaded = (await runRecords(workflowId)).definitions[`agent:${row.definitionId}`]
        return loaded?.kind === "agent" ? { briefId: loaded.definition.briefId, definitionId: row.definitionId } : undefined
      })
      attempts.set(key, held)
    }
    return held
  }
  // Only a settings fact changes a run's policy, and it drops the held
  // policy below, so each change reads it once for all of the run's members.
  const policies = new Map<string, Promise<RoleAssignmentSnapshot>>()
  const policy = (workflowId: string) => {
    let held = policies.get(workflowId)
    if (!held) {
      held = runs.read(workflowId).then((run) => {
        if (!run) throw new Error(`Workflow not found: ${workflowId}`)
        return run.roleAssignments
      })
      policies.set(workflowId, held)
    }
    return held
  }
  const members = new Map<string, Set<string>>()
  const readRoles = createRoleAssignmentReader({
    inheritedRoles: policy,
    readSession: async (sessionId) => {
      const session = await deps.manager.read(sessionId)
      if (session?.kind === "workflow-agent") {
        const id = session.workflowMembership.workflowId
        const sessions = members.get(id) ?? new Set<string>()
        sessions.add(sessionId)
        members.set(id, sessions)
      }
      return session
    },
    userDataRoot: deps.userDataRoot,
    personas: async (workflowId) => (await runRecords(workflowId)).personas,
    workflowSeat: async (membership) => membership.kind === "historical-follow-up"
      ? undefined : (await attempt(membership.workflowId, membership.attemptId)) ?? undefined,
    childRole: async (sessionId) => {
      let held = agentTypes.get(sessionId)
      if (!held) {
        held = installedChildSessionHistory().readAgentType(deps.reader, sessionId)
        agentTypes.set(sessionId, held)
      }
      const type = await held
      const agent = type === undefined ? undefined : deps.definitions.personas().get(type)
      if (!agent) return undefined
      const session = await deps.manager.read(sessionId)
      const parent = session?.kind === "subagent" ? await deps.manager.read(session.launchedFrom.parentSessionId) : null
      const membership = parent?.kind === "workflow-agent" ? parent.workflowMembership : undefined
      const record = membership === undefined || membership.kind === "historical-follow-up"
        ? undefined : await attempt(membership.workflowId, membership.attemptId)
      return {
        roleId: agent.kind === "general" ? "chat" : agent.role,
        ...(record === undefined || record === null ? {} : { briefScope: { briefId: record.briefId } }),
      }
    },
    capture: deps.capture,
  })
  return scope.own("role-projection", createRoleProtocolProjection({
    manager: deps.manager, publish: deps.publish, readRoles,
    subscribeRefresh: (refresh) => {
      const listener: Parameters<RuntimeUiBus["addListener"]>[0] = (event) => {
        if (event.type !== "patch") return
        const cursor = event.patch.cursor
        if (cursor.domain === "auth") refresh(cursor.scope === "session" ? cursor.sessionId : undefined)
      }
      deps.bus.addListener(listener)
      // A profile role edit changes what every runner resolves on its next
      // request, without an auth publication or a stored fact.
      const unsubscribeProfiles = deps.onProfilesChanged(() => refresh())
      const unsubscribe = deps.onStored((facts) => {
        for (const workflowId of workflowRunOwner().roleChanges(facts)) {
          policies.delete(workflowId)
          for (const sessionId of members.get(workflowId) ?? []) refresh(sessionId)
        }
      })
      return async () => { deps.bus.removeListener(listener); unsubscribe(); await unsubscribeProfiles() }
    },
  }), (owned) => owned.dispose())
}
