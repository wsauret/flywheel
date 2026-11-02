import { describe, expect, test } from "bun:test"

import { authDir } from "../../../../src/infra/paths.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { authScopesForProfile, resolveAuthProfileScope, resolveSessionAuthProfile } from "../../../../src/orchestration/app-service/auth-profile-scope.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { workflowRunReader, workflowRunWriter } from "../../../../src/orchestration/module-catalog.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { makeDepsWithStore, publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const temp = temporaryDirectories()

const userDataRoot = "/account/.flywheel"
const defaults: AuthProfileResolution = {
  id: "a",
  persistedId: "a",
  displayName: "Profile A",
  directory: authDir(userDataRoot, "a"),
  source: "sticky",
  projectBinding: undefined,
  retirements: {},
  availableProfiles: [{ id: "a", displayName: "Profile A" }, { id: "b", displayName: "Profile B" }],
}

function row(id: string, authProfileId?: string, lifecycleState: DurableSessionCatalogRow["lifecycleState"] = "active"): DurableSessionCatalogRow {
  return { id, label: id, lifecycleState, kind: "chat", command: "chat", lastUpdated: "now", executionCwd: "/project", ...(authProfileId ? { authProfileId } : {}) }
}

describe("auth profile scope", () => {
  test("a zero-member workflow selects and retires its profile through its aggregate without a session row", async () => {
    const { deps, store } = makeDepsWithStore(temp("workflow-auth-"))
    const manager = createSessionManager(deps)
    const runs = workflowRunReader(deps.projectionReader)
    let profiles = defaults
    const selected: string[] = []
    try {
      const workflowId = await publishTestWorkflow(manager, { authProfileId: "a", initialRoles: { "workflow-agent": { model: "saved", effort: "low" } } })
      const owner = createWorkflowAuthOwner({
        reader: runs, writer: workflowRunWriter(deps.projectionReader, manager.commitWorkflow),
        profiles: { inspect: () => profiles }, userDataRoot,
        onSelected: async (id) => { selected.push(id) },
      })
      expect(await owner.select(workflowId, "b")).toBe(true)
      expect(await owner.snapshot(workflowId)).toMatchObject({ id: "b", persistedId: "b" })
      expect(await owner.list()).toMatchObject([{ workflowId, profile: { id: "b" } }])
      profiles = { ...defaults, retirements: { b: "a" } }
      expect(await owner.snapshot(workflowId)).toMatchObject({ id: "a", persistedId: "a" })
      expect(await runs.read(workflowId)).toMatchObject({ authProfileId: "a", roleAssignments: { defaults: { "workflow-agent": { model: "saved", effort: "low" } }, overrides: {} } })
      expect(await manager.read(workflowId)).toBeNull()
      expect(store.read({ aggregateId: `session:${workflowId}` })).toEqual([])
      expect(selected).toEqual([workflowId])
    } finally { store.close() }
  })

  // An agent of a workflow runs on its workflow's profile. A profile that an
  // earlier build wrote on the agent's own metadata is not its selection.
  test("an agent of a workflow reads its workflow's current profile in every session scope", async () => {
    const { deps, store } = makeDepsWithStore(temp("workflow-agent-auth-"))
    const manager = createSessionManager(deps)
    const runs = workflowRunReader(deps.projectionReader)
    try {
      const workflowId = await publishTestWorkflow(manager, { authProfileId: "a" })
      const agent = await startTestWorkflowMember(manager, store, workflowId)
      expect((await manager.read(agent))?.authProfileId).toBeUndefined()
      expect(await manager.selectAuthProfileWithRoleSnapshot(agent, "a", {})).toBe(true)
      const owner = createWorkflowAuthOwner({
        reader: runs, writer: workflowRunWriter(deps.projectionReader, manager.commitWorkflow),
        profiles: { inspect: () => defaults }, userDataRoot, onSelected: async () => {},
      })
      expect(await owner.select(workflowId, "b")).toBe(true)
      const profileB = resolveSessionAuthProfile({ authProfileId: "b" }, defaults, userDataRoot)
      expect(await resolveAuthProfileScope({ kind: "session", sessionId: agent }, defaults, manager, runs, userDataRoot)).toMatchObject({ id: "b", persistedId: "b" })
      expect(await authScopesForProfile(profileB, defaults, manager, runs, userDataRoot, new Set([agent]))).toContainEqual({ kind: "session", sessionId: agent })
      expect(await authScopesForProfile(defaults, defaults, manager, runs, userDataRoot, new Set([agent]))).not.toContainEqual({ kind: "session", sessionId: agent })
      const [catalogRow] = (await manager.listForIds([agent])).sessions
      expect(catalogRow?.id).toBe(agent)
      expect(catalogRow?.authProfileId).toBeUndefined()
    } finally { store.close() }
  })

  test("a session's persisted profile wins over the default unless the environment selected one", () => {
    const persisted = resolveSessionAuthProfile({ authProfileId: "b" }, defaults, userDataRoot)
    expect(persisted).toMatchObject({ id: "b", persistedId: "b", displayName: "Profile B", directory: authDir(userDataRoot, "b") })
    expect(resolveSessionAuthProfile({}, defaults, userDataRoot)).toMatchObject({ id: "a", persistedId: "a" })
    expect(resolveSessionAuthProfile({ authProfileId: "b" }, { ...defaults, source: "environment" }, userDataRoot)).toMatchObject({ id: "a", persistedId: "b" })
    const retired = { ...defaults, retirements: { old: "b" } }
    expect(resolveSessionAuthProfile({ authProfileId: "old" }, retired, userDataRoot)).toMatchObject({ id: "b", persistedId: "b", displayName: "Profile B", directory: authDir(userDataRoot, "b") })
    expect(resolveSessionAuthProfile({ authProfileId: "unknown" }, retired, userDataRoot).id).toBe("unknown")
  })

  test("lists active and observed scopes without reading unobserved history", async () => {
    const listings: string[] = []
    const rows = [row("s1"), row("s2", "b"), row("s3", "a"), row("s4", undefined, "inactive"), row("s5", "b", "inactive")]
    const manager = {
      async listActive() {
        listings.push("active")
        return { sessions: rows.filter((candidate) => candidate.lifecycleState === "active"), errors: [] }
      },
      async listForIds(ids: readonly string[]) {
        listings.push(`ids:${ids.join(",")}`)
        return { sessions: rows.filter((candidate) => ids.includes(candidate.id)), errors: [] }
      },
    }
    const profileB = resolveSessionAuthProfile({ authProfileId: "b" }, defaults, userDataRoot)

    const runs = { read: async () => null }
    expect(await authScopesForProfile(defaults, defaults, manager, runs, userDataRoot)).toEqual([
      { kind: "defaults" },
      { kind: "session", sessionId: "s1" },
      { kind: "session", sessionId: "s3" },
    ])
    expect(await authScopesForProfile(profileB, defaults, manager, runs, userDataRoot, new Set(["s2", "s5", "missing"]))).toEqual([
      { kind: "session", sessionId: "s2" },
      { kind: "session", sessionId: "s5" },
    ])
    expect(listings).toEqual(["active", "active", "ids:s2,s5,missing"])
  })
})
