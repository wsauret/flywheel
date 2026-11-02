import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { createProjectStateSessionManager, createProjectStateSessionsService, type ProjectStateSessionCommand } from "../../../../src/orchestration/app-service/project-state-sessions.js"
import { createSessionManager, ParentPublicationContendedError, type SessionManager, type SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { cleanupTmpRoot, makeDeps, makeTmpDir } from "../session/_session-manager-fixtures.js"

const roles = { worker: { model: "claude-sonnet-4.5", effort: "high" } }
const assignment = roles.worker
const catalog = { sessions: [], errors: [] }
const returnedNotice = { senderSessionId: "sender", notification: { key: "returned:c:msg:sender:ask-1", text: "<returned_messages session_id=\"c\" reason=\"deleted\">" } }

function fakeManager() {
  const calls: unknown[][] = []
  let subscriber: ((change: SessionMetadataChange) => void) | undefined
  const record = (name: string, ...args: unknown[]) => { calls.push([name, ...args]) }
  const manager: SessionManager = {
    allocateId: () => "manager-id",
    async publishWorkflow(input) { record("publishWorkflow", input); return "workflow-id" },
    async commitWorkflow(input) { record("commitWorkflow", input); return { kind: "stored", events: [] } },
    async adoptWorkflow(input) { record("adoptWorkflow", input); return true },
    async publishSubagent(input) { record("publishSubagent", input); return "subagent-id" },
    async createChat(input) { record("createChat", input); return "chat-id" },
    async forkChat(id) { record("forkChat", id); return "fork-id" },
    async createChatFromContext(id, messages) { record("createChatFromContext", id, messages); return "context-chat-id" },
    async listMetadata() { record("listMetadata"); return catalog },
    async listActive() { record("listActive"); return catalog },
    async listForIds(ids) { record("listForIds", ids); return catalog },
    async read(id) { record("read", id); return null },
    async updateLifecycleState(id, state) { record("updateLifecycleState", id, state) },
    async publishActivation(id, facts) { record("publishActivation", id, facts) },
    async updateLabel(id, labels, source) { record("updateLabel", id, labels, source); return true },
    async updateChatMetadata(id, patch) { record("updateChatMetadata", id, patch) },
    async captureRolesIfAbsent(id, value) { record("captureRolesIfAbsent", id, value); return true },
    async captureAuthProfileIfAbsent(id, profile) { record("captureAuthProfileIfAbsent", id, profile); return true },
    async selectAuthProfile(id, profile) { record("selectAuthProfile", id, profile); return true },
    async selectAuthProfileWithRoleSnapshot(id, profile, value) { record("selectAuthProfileWithRoleSnapshot", id, profile, value); return true },
    async replaceRoleSnapshot(id, value, overrides) { record("replaceRoleSnapshot", id, value, overrides); return true },
    async updateRoleAssignment(id, roleId, value) { record("updateRoleAssignment", id, roleId, value); return true },
    async removeRoleAssignment(id, roleId) { record("removeRoleAssignment", id, roleId); return true },
    async unlinkChild(parentId, childId) { record("unlinkChild", parentId, childId) },
    async admitDeletion(id) {
      record("admitDeletion", id)
      return { rootSessionId: id, targets: [{ kind: "root", rootSessionId: id, sessionId: id }] }
    },
    async finalizeDeletionTarget(target) {
      record("finalizeDeletionTarget", target)
      return [returnedNotice]
    },
    async recoverStaleSessions() { record("recoverStaleSessions"); return 2 },
    subscribe(listener) { subscriber = listener; return () => { subscriber = undefined } },
  }
  return { manager, calls, emit: (change: SessionMetadataChange) => subscriber?.(change) }
}

function connected(manager: SessionManager, work: Parameters<typeof createProjectStateSessionsService>[1] = {}) {
  const service = createProjectStateSessionsService(manager, work)
  let changeListener: ((change: unknown) => void) | undefined
  const client = createProjectStateSessionManager({
    request: (command) => service.request(structuredClone(command)),
    subscribe(listener) {
      changeListener = listener
      return service.subscribe((change) => changeListener?.(structuredClone(change)))
    },
  })
  return { service, client, close: () => {} }
}

afterEach(() => cleanupTmpRoot())

describe("project state session boundary", () => {
  test("rejects malformed commands before invoking the manager", async () => {
    const fake = fakeManager()
    const service = createProjectStateSessionsService(fake.manager)

    await expect(service.request({ kind: "session.admit-child-deletion", id: "s", extra: true })).rejects.toThrow()
    await expect(service.request({ kind: "session.update-lifecycle", id: "s", lifecycleState: "paused" })).rejects.toThrow()
    expect(fake.calls).toEqual([])
  })

  test("converts the project-state launchedFrom tool identity", async () => {
    const fake = fakeManager()
    const service = createProjectStateSessionsService(fake.manager)

    await service.request({
      kind: "session.publish-workflow",
      input: {
        id: "w",
        description: "work",
        workflowDefinitionId: "implementation",
        initialRoles: roles,
        facts: [],
        launchedFrom: { parentSessionId: "parent", conversationId: "conversation", toolUseId: "tool-use" },
      },
    })

    expect(fake.calls).toEqual([[
      "publishWorkflow",
      {
        id: "w",
        description: "work",
        workflowDefinitionId: "implementation",
        initialRoles: roles,
        facts: [],
        launchedFrom: { parentSessionId: "parent", conversationId: "conversation", toolUseId: "tool-use" },
      },
    ]])
  })

  test("carries a fork's history, assignment, and parent conversation through the state worker boundary", async () => {
    const fake = fakeManager()
    const { client } = connected(fake.manager)
    const forkHistory = [
      { kind: "user" as const, content: "Inspect the runtime" },
      { kind: "assistant" as const, content: [{ type: "text" as const, text: "Initial observation" }] },
    ]
    const append = {
      aggregateId: "session:child",
      type: "subagent.prompted",
      version: 1,
      timestamp: 1,
      actor: "flywheel",
      sessionId: "child",
      payload: {},
    }

    await client.publishSubagent({
      id: "child",
      conversationId: "child-conversation",
      description: "Inspect the runtime",
      launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "tool-use" },
      initialRoles: roles,
      runBinding: { ...append, type: "child_run.created" },
      promptFact: append,
      forkHistory,
      assignment: "Inspect the parser",
    })

    expect(fake.calls).toEqual([[
      "publishSubagent",
      expect.objectContaining({
        forkHistory,
        assignment: "Inspect the parser",
        launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "tool-use" },
      }),
    ]])
  })

  test("preserves launchedFrom tool identity across catalog responses", async () => {
    const fake = fakeManager()
    const launchedCatalogRow = {
      id: "w",
      kind: "workflow-agent" as const,
      workflowMembership: { kind: "attempt" as const, workflowId: "run", attemptId: "attempt" },
      lifecycleState: "inactive" as const,
      createdAt: "2026-09-17T00:00:00.000Z",
      lastUpdated: "2026-09-17T00:00:00.000Z",
      label: "work",
      executionCwd: "/work",
      command: "workflow-agent",
      conversationId: "agent-conversation",
      launchedFrom: { parentSessionId: "parent", toolUseId: "tool-use" },
    }
    fake.manager.listMetadata = async () => ({ sessions: [launchedCatalogRow], errors: [] })
    fake.manager.listActive = async () => ({ sessions: [launchedCatalogRow], errors: [] })
    fake.manager.listForIds = async () => ({ sessions: [launchedCatalogRow], errors: [] })
    const { client } = connected(fake.manager)

    expect((await client.listMetadata()).sessions[0]?.launchedFrom).toEqual({
      parentSessionId: "parent",
      toolUseId: "tool-use",
    })
    expect((await client.listActive()).sessions[0]?.launchedFrom).toEqual({
      parentSessionId: "parent",
      toolUseId: "tool-use",
    })
    expect((await client.listForIds(["w"])).sessions[0]?.launchedFrom).toEqual({
      parentSessionId: "parent",
      toolUseId: "tool-use",
    })
  })

  test("maps every asynchronous manager method with exact parameters and results", async () => {
    const fake = fakeManager()
    const { client } = connected(fake.manager, {
      async interruptOwed(sessionId) { fake.calls.push(["interruptOwed", sessionId]); return true },
    })
    const workflow = {
      id: "w", description: "work", summary: "Short work", workflowDefinitionId: "implementation", initialRoles: roles,
      facts: [],
      launchedFrom: { parentSessionId: "parent", conversationId: "conversation", toolUseId: "tool-use" },
      retainedOperation: { op: "swap" as const, kind: "workflow.launch", key: "accepted", expectedRaw: "{\"accepted\":true}", payload: null },
    }

    expect(await client.publishWorkflow(workflow)).toBe("workflow-id")
    const commit = { workflowId: "w", events: [] }
    expect(await client.commitWorkflow(commit)).toEqual({ kind: "stored", events: [] })
    const adoption = { workflowId: "w", launchedFrom: workflow.launchedFrom }
    expect(await client.adoptWorkflow(adoption)).toBe(true)
    expect(await client.createChat({ id: "c", initialState: "inactive", initialRoles: roles })).toBe("chat-id")
    expect(await client.forkChat("source")).toBe("fork-id")
    const capturedContext = [
      { kind: "system" as const, content: "captured instruction" },
      { kind: "user" as const, content: "side question" },
      { kind: "assistant" as const, content: "side answer" },
    ]
    expect(await client.createChatFromContext("source", capturedContext)).toBe("context-chat-id")
    expect(await client.listMetadata()).toEqual(catalog)
    expect(await client.listActive()).toEqual(catalog)
    expect(await client.listForIds(["a", "b"])).toEqual(catalog)
    expect(await client.read("c")).toBeNull()
    await client.updateLifecycleState("c", "active")
    const activationFacts = [{
      aggregateId: "session:c",
      type: "subagent.resumed",
      version: 1,
      timestamp: 1,
      actor: "flywheel",
      sessionId: "c",
      payload: { continuation: 1 },
      inFlight: [{ op: "clear" as const, kind: "session.planned_continuation" }],
    }]
    await client.publishActivation("c", activationFacts)
    expect(await client.updateLabel("c", { label: "Long", shortLabel: "Short" }, "user")).toBe(true)
    await client.updateChatMetadata("c", { providerConversationId: "provider" })
    expect(await client.captureRolesIfAbsent("c", roles)).toBe(true)
    expect(await client.captureAuthProfileIfAbsent("c", "profile-a")).toBe(true)
    expect(await client.selectAuthProfile("c", "profile-b")).toBe(true)
    expect(await client.selectAuthProfileWithRoleSnapshot("c", "profile-c", roles)).toBe(true)
    expect(await client.replaceRoleSnapshot("c", roles, {})).toBe(true)
    expect(await client.updateRoleAssignment("c", "worker", assignment)).toBe(true)
    expect(await client.removeRoleAssignment("c", "worker")).toBe(true)
    await client.unlinkChild("parent", "child")
    const deletion = await client.admitDeletion("c")
    const deletionTarget = deletion.targets[0]
    if (!deletionTarget) throw new Error("expected deletion root")
    // The notices the delete held reach the executor, which runs the senders.
    expect(await client.finalizeDeletionTarget(deletionTarget)).toEqual([returnedNotice])
    expect(await client.recoverStaleSessions()).toBe(2)
    expect(await client.interruptOwed("owed")).toBe(true)

    expect(fake.calls).toEqual([
      ["publishWorkflow", workflow],
      ["commitWorkflow", commit],
      ["adoptWorkflow", adoption],
      ["createChat", { id: "c", initialState: "inactive", initialRoles: roles }],
      ["forkChat", "source"], ["createChatFromContext", "source", capturedContext],
      ["listMetadata"], ["listActive"], ["listForIds", ["a", "b"]], ["read", "c"],
      ["updateLifecycleState", "c", "active"],
      ["publishActivation", "c", activationFacts],
      ["updateLabel", "c", { label: "Long", shortLabel: "Short" }, "user"],
      ["updateChatMetadata", "c", { providerConversationId: "provider" }],
      ["captureRolesIfAbsent", "c", roles], ["captureAuthProfileIfAbsent", "c", "profile-a"],
      ["selectAuthProfile", "c", "profile-b"], ["selectAuthProfileWithRoleSnapshot", "c", "profile-c", roles],
      ["replaceRoleSnapshot", "c", roles, {}], ["updateRoleAssignment", "c", "worker", assignment],
      ["removeRoleAssignment", "c", "worker"], ["unlinkChild", "parent", "child"], ["admitDeletion", "c"],
      ["finalizeDeletionTarget", { kind: "root", rootSessionId: "c", sessionId: "c" }],
      ["recoverStaleSessions"], ["interruptOwed", "owed"],
    ])
  })

  test("preserves historical reads and degraded catalog details", async () => {
    const fake = fakeManager()
    fake.manager.read = async () => ({
      kind: "chat", command: "chat", conversationId: "legacy", label: "Legacy", lastUpdated: "then", lifecycleState: "inactive",
    })
    fake.manager.listMetadata = async () => ({
      sessions: [{
        id: "broken", label: "Recovered", lifecycleState: "inactive", kind: "chat", command: "chat",
        lastUpdated: "then", executionCwd: "/project", degraded: true, unavailableFields: ["conversationId"],
      }],
      errors: [{ sessionId: "broken", scope: "metadata", reason: "bad historical fact" }],
    })
    const { client } = connected(fake.manager)

    expect((await client.read("legacy"))?.executionCwd).toBeUndefined()
    expect(await client.listMetadata()).toEqual(await fake.manager.listMetadata())
  })

  test("forwards changed and deleted notifications without a catalog cache", () => {
    const fake = fakeManager()
    const { client } = connected(fake.manager)
    const received: SessionMetadataChange[] = []
    const unsubscribe = client.subscribe((change) => received.push(change))

    fake.emit({ kind: "changed", sessionIds: ["a", "b"] })
    fake.emit({ kind: "deleted", sessionId: "a" })
    unsubscribe()
    fake.emit({ kind: "deleted", sessionId: "b" })

    expect(received).toEqual([
      { kind: "changed", sessionIds: ["a", "b"] },
      { kind: "deleted", sessionId: "a" },
    ])
  })

  test("uses the real manager for creation, profile selection, lifecycle policy, reads, deletion, and notifications", async () => {
    const root = makeTmpDir()
    const real = createSessionManager(makeDeps(root))
    const { client } = connected(real)
    const changes: SessionMetadataChange[] = []
    const unsubscribe = client.subscribe((change) => changes.push(change))

    const id = await client.createChat({ name: "Boundary", initialRoles: roles })
    expect(await client.selectAuthProfile("missing", "profile")).toBe(false)
    expect(await client.selectAuthProfileWithRoleSnapshot(id, "profile", roles, { authProfileId: undefined })).toBe(true)
    expect(await client.selectAuthProfileWithRoleSnapshot(id, "stale", {}, { authProfileId: undefined })).toBe(false)
    expect(await client.selectAuthProfileWithRoleSnapshot(id, "stale", {}, { authProfileId: "retired" })).toBe(false)
    await client.updateLifecycleState(id, "inactive")
    const session = await client.read(id)
    expect(session?.name).toBe("Boundary")
    expect(session?.authProfileId).toBe("profile")
    expect(session?.lifecycleState).toBe("inactive")
    expect(session?.roleAssignments).toEqual({ defaults: {}, overrides: roles })
    // The catalog row carries the profile choice so auth owners never read
    // every session across the Worker boundary to learn it.
    const row = (await client.listMetadata()).sessions.find((candidate) => candidate.id === id)
    expect(row?.authProfileId).toBe("profile")
    expect(row?.lifecycleState).toBe("inactive")
    expect((await client.listActive()).sessions).toEqual([])
    await expect(client.updateLifecycleState(id, "inactive")).resolves.toBeUndefined()
    const deletion = await client.admitDeletion(id)
    const target = deletion.targets[0]
    if (!target) throw new Error("expected deletion root")
    await client.finalizeDeletionTarget(target)
    expect(await client.read(id)).toBeNull()
    unsubscribe()
    expect(changes).toEqual([
      { kind: "changed", sessionIds: [id] },
      { kind: "changed", sessionIds: [id] },
      { kind: "changed", sessionIds: [id] },
      { kind: "deleted", sessionId: id },
    ])
  })

  test("serves the reads of one tick with one request, whatever the number of readers", async () => {
    for (const readers of [3, 30]) {
      const fake = fakeManager()
      const service = createProjectStateSessionsService(fake.manager)
      const sent: ProjectStateSessionCommand[] = []
      const client = createProjectStateSessionManager({
        request(command) { sent.push(command); return service.request(structuredClone(command)) },
        subscribe: () => () => {},
      })
      const ids = Array.from({ length: readers }, (_, index) => `s${index}`)
      await Promise.all(ids.flatMap((id) => [client.listForIds([id]), client.read(id), client.listActive()]))
      expect(sent).toHaveLength(1)
      expect(fake.calls.filter(([name]) => name === "listForIds")).toEqual(ids.map((id) => ["listForIds", [id]]))
      expect(fake.calls.filter(([name]) => name === "listActive")).toHaveLength(1)
    }
  })

  test("gives each catalog reader of a batch what its own read returns, even for sessions updated in the same millisecond", async () => {
    const real = createSessionManager(makeDeps(makeTmpDir()))
    const { client } = connected(real)
    setSystemTime(new Date("2026-10-25T00:00:00.000Z"))
    const [a, b, c] = [await real.createChat({ name: "a" }), await real.createChat({ name: "b" }), await real.createChat({ name: "c" })]
    setSystemTime()
    // The manager orders sessions of one timestamp by the order in which their
    // reads finish, so every session is read once before the comparison: then
    // that order is the order of the ids the manager receives.
    await real.listForIds([a, b, c])
    const requests = [[b, a, b, "missing"], [a, b], [c, a], [b, a, b, "missing"]]
    const alone = []
    for (const ids of requests) alone.push(await real.listForIds(ids))

    const batched = await Promise.all(requests.map((ids) => client.listForIds(ids)))

    expect(batched).toEqual(alone)
  })

  test("never lets a write overtake a read issued before it, and a read after a write sees it", async () => {
    const fake = fakeManager()
    let label = "before"
    fake.manager.read = async () => ({ kind: "chat", command: "chat", conversationId: "c", label, lastUpdated: "then", lifecycleState: "inactive" })
    fake.manager.updateLabel = async (_id, labels) => { label = labels.label ?? label; return true }
    const service = createProjectStateSessionsService(fake.manager)
    // The state Worker serves one request at a time, in the order they arrive.
    let served: Promise<unknown> = Promise.resolve()
    const client = createProjectStateSessionManager({
      request(command) {
        const result = served.then(() => service.request(structuredClone(command)))
        served = result
        return result
      },
      subscribe: () => () => {},
    })

    const [earlier, , later] = await Promise.all([client.read("c"), client.updateLabel("c", { label: "after" }, "user"), client.read("c")])

    expect(earlier?.label).toBe("before")
    expect(later?.label).toBe("after")
  })

  test("fails only the callers of the read that failed", async () => {
    const fake = fakeManager()
    fake.manager.listActive = async () => { throw new ParentPublicationContendedError("contended") }
    const { client } = connected(fake.manager)

    const [active, ids, session] = await Promise.allSettled([client.listActive(), client.listForIds(["a"]), client.read("a")])

    expect(active.status === "rejected" && active.reason).toBeInstanceOf(ParentPublicationContendedError)
    expect(ids).toEqual({ status: "fulfilled", value: catalog })
    expect(session).toEqual({ status: "fulfilled", value: null })
  })

  test("allocates local IDs without sending commands", () => {
    const commands: ProjectStateSessionCommand[] = []
    const client = createProjectStateSessionManager({
      async request(command) { commands.push(command); throw new Error("not used") },
      subscribe: () => () => {},
    })
    expect(client.allocateId()).toMatch(/^[0-9a-f]{12}$/)
    expect(commands).toEqual([])
  })
})
