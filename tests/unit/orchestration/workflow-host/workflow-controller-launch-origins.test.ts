import { afterEach, describe, expect, it, mock } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile, resolveSessionDir } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { workflowLaunchTargets, WORKFLOW_LAUNCH_RETRY_INSTRUCTION } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { WORKFLOW_LAUNCH_OPERATION_KIND, type WorkflowLaunchOperation } from "../../../../src/orchestration/workflow-host/launch-operation-contract.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input-projection.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog.js"
import { publishTestWorkflow } from "../session/_session-manager-fixtures.js"
import { APPROVED_INTENT, cleanupProjectRoots, createDeps, fixtureSource, launchingController, makeWorkflowDeps, seedLaunchApproval, trackEventStore, until } from "./_workflow-controller-fixtures.js"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures.js"
import { createConversationCheckpointOwner } from "../../../../src/orchestration/session/conversation-checkpoint.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { loadAccumulatedContextFromEvents } from "../../../../src/workflows/context-bundle/context-projection.js"
import { renderWorkflowRequestSection } from "../../../../src/workflows/context-bundle/workflow-request.js"

const CHAT = "chat-1"
const CONVERSATION = "conv-1"
const CONFIRMATION = "toolu-approval"
const TOOL_CALL = "toolu-launch"

afterEach(cleanupProjectRoots)

async function askSetup(overrides: Parameters<typeof createDeps>[0] = {}) {
  let prepareCalls = 0
  const workflowHosts = createMockWorkflowHosts()
  const initialDeps = createDeps({ workflowHosts, ...overrides })
  const store = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(initialDeps.projectRoot)))
  const rawManager = createSessionManager({ projectRoot: initialDeps.projectRoot, executionCwd: initialDeps.projectRoot, store })
  const manager = {
    ...rawManager, publishWorkflow: mock(rawManager.publishWorkflow),
  }
  await manager.createChat({ id: CHAT, conversationId: CONVERSATION, name: "Chat" })
  const { authAdmission: _initialAdmission, ...base } = initialDeps
  const deps = createDeps({ ...base, manager, workflowMode: () => "ask", prepareWorkflowDeps: async () => { prepareCalls += 1; return makeWorkflowDeps() }, ...overrides })
  const auth = deps.authAdmission
  deps.authAdmission = { ...auth, admit: () => auth.admitDefaults(), admitWorkflow: () => auth.admitDefaults() }
  const source = fixtureSource(deps, CHAT)
  const target = await workflowLaunchTargets({ revision: () => deps.definitions.captureRevision(), sessionDir: resolveSessionDir(CHAT, deps.projectRoot), executionCwd: deps.projectRoot })(source)
  if ("error" in target) throw new Error(target.error)
  const controller = launchingController(deps)
  const launch = (input: { confirmationId?: string | null; conversationId?: string; toolUseId?: string; summary?: string; description?: string } = {}) => controller.startWorkflow({
    source, summary: input.summary ?? APPROVED_INTENT.summary, description: input.description ?? APPROVED_INTENT.description,
    origin: { kind: "model", chatSessionId: CHAT, conversationId: input.conversationId ?? CONVERSATION, toolUseId: input.toolUseId ?? TOOL_CALL, confirmation: input.confirmationId === null ? { kind: "absent" } : { kind: "supplied", confirmationId: input.confirmationId ?? CONFIRMATION }, authority: fullAuthority() },
  })
  const approve = (input: Partial<Parameters<typeof seedLaunchApproval>[0]> = {}) => seedLaunchApproval({ store, chatSessionId: CHAT, conversationId: CONVERSATION, confirmationId: CONFIRMATION, target, ...input })
  return { deps, manager, rawManager, workflowHosts, store, controller, launch, approve, source, target, prepareCalls: () => prepareCalls }
}

async function consumedBy(setup: Awaited<ReturnType<typeof askSetup>>) {
  const entry = (await loadAgentInputProjection(asAsyncEventReadSurface(setup.store), CHAT)).get(CONFIRMATION)
  return entry?.kind === "answered" ? entry.consumedBy : undefined
}

async function refused(setup: Awaited<ReturnType<typeof askSetup>>, result: Awaited<ReturnType<typeof setup.launch>>, reason: string, retry = true) {
  if (!("error" in result)) throw new Error("expected a refusal")
  expect(result.error).toContain(reason)
  expect(result.recovery).toBe(retry ? WORKFLOW_LAUNCH_RETRY_INSTRUCTION : undefined)
  expect(setup.prepareCalls()).toBe(0)
  expect(setup.manager.publishWorkflow).not.toHaveBeenCalled()
  expect(setup.workflowHosts._startCalls).toEqual([])
}

describe("model file launches under Workflows Ask", () => {
  it.each([true, false])("retains only approved checkpoint intent apart from the per-agent request (approved: %s)", async (approved) => {
    const setup = await askSetup()
    const checkpoint = createConversationCheckpointOwner(asAsyncEventReadSurface(setup.store), createSessionFactWriter({ sessionId: CHAT, writer: asAsyncEventWriter(setup.store) }), { kind: "session", sessionId: CHAT }, CONVERSATION)
    await checkpoint.replace("designIntent", { text: "Keep the user's exact intent.", approved })
    await checkpoint.decide({ date: "2026-10-21", words: "Do not share working notes.", replaces: null })
    await checkpoint.replace("workingNotes", "PRIVATE-PARENT-NOTES")
    setup.approve()
    const result = await setup.launch()
    if ("error" in result) throw new Error(result.error)
    // The launch snapshot is immutable even if the parent changes its checkpoint later.
    await checkpoint.replace("designIntent", { text: "Later parent intent.", approved: true })
    const events = setup.store.read({ aggregateId: `workflow:${result.workflowId}` })
    const requests = ["first", "reviewer"].map((attemptId) => loadAccumulatedContextFromEvents(events, { attemptId, scope: { _tag: "workflow" } }).request)
    expect(requests[0]).toEqual(requests[1])
    const request = requests[0]
    if (!request) throw new Error("Workflow request is missing")
    expect(request.original).toBe(APPROVED_INTENT.description)
    const rendered = renderWorkflowRequestSection(request)
    if (approved) {
      expect(request.inheritedIntent).toContain(`Source session: ${CHAT}\nSource conversation: ${CONVERSATION}`)
      expect(request.inheritedIntent).toMatch(/Checkpoint SHA-256: [0-9a-f]{64}/)
      expect(request.inheritedIntent).toContain("# Design intent (approved)\n\nKeep the user's exact intent.")
      expect(request.inheritedIntent).toContain("## 2026-10-21\n\nDo not share working notes.\n\nReplaces: None")
    } else {
      expect(request.inheritedIntent).toBeUndefined()
    }
    expect(rendered).not.toContain("# Inherited design intent")
    expect(rendered).not.toContain("Keep the user's exact intent.")
    expect(JSON.stringify(request)).not.toContain("PRIVATE-PARENT-NOTES")
    expect(JSON.stringify(request)).not.toContain("Later parent intent.")
    expect(rendered).not.toContain("PRIVATE-PARENT-NOTES")
    expect(rendered).not.toContain("Later parent intent.")
  })

  it("publishes a child under the trusted parent call and consumes approval exactly once", async () => {
    const setup = await askSetup()
    setup.approve()
    const result = await setup.launch()
    if ("error" in result) throw new Error(result.error)
    expect(setup.manager.publishWorkflow).toHaveBeenCalledTimes(1)
    expect(setup.manager.publishWorkflow).toHaveBeenCalledWith(expect.objectContaining({ launchedFrom: { parentSessionId: CHAT, conversationId: CONVERSATION, workflowDefinitionId: "repair", description: APPROVED_INTENT.description, toolUseId: TOOL_CALL } }))
    expect(setup.manager.publishWorkflow).not.toHaveBeenCalledWith(expect.objectContaining({ runtimeInvocation: expect.anything() }))
    expect(await consumedBy(setup)).toBe(TOOL_CALL)
    const second = await setup.launch({ toolUseId: "second" })
    expect(second).toMatchObject({ error: expect.stringContaining("was already used"), recovery: WORKFLOW_LAUNCH_RETRY_INSTRUCTION })
    expect(setup.manager.publishWorkflow).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: "absent confirmation", input: { confirmationId: null }, seed: false, reason: "carried no confirmation_id" },
    { name: "invented confirmation", input: { confirmationId: "invented" }, seed: false, reason: "No question invented exists" },
    { name: "ordinary question", input: {}, seed: true, bindsDecision: false, reason: "carries no workflow_launch decision" },
    { name: "another conversation", input: { conversationId: "other" }, seed: true, reason: "not the host-attested chat conversation", retry: false },
  ])("refuses $name before side effects", async ({ input, seed, bindsDecision, reason, retry }) => {
    const setup = await askSetup()
    if (seed) setup.approve({ bindsDecision })
    await refused(setup, await setup.launch(input), reason, retry)
  })

  it.each(["reject", "freeform", "approve-and-extra"] as const)("refuses the %s answer", async (answer) => {
    const setup = await askSetup()
    setup.approve({ answer })
    await refused(setup, await setup.launch(), answer === "freeform" ? "answer: yes go ahead" : "The user did not approve this launch")
  })

  it("refuses an approval of another workflow file", async () => {
    const setup = await askSetup()
    setup.approve({ target: { ...setup.target, source: { ...setup.target.source, path: "/scratch/other.workflow.yaml" } } })
    await refused(setup, await setup.launch(), "That confirmation approves the workflow file /scratch/other.workflow.yaml, not the workflow file")
  })

  it("refuses a recorded named approval without consuming it or authorizing a file", async () => {
    const setup = await askSetup()
    const question = "Launch the Debug workflow?"
    setup.store.appendBatch([
      { aggregateId: `session:${CHAT}`, sessionId: CHAT, timestamp: 1, type: "agent_input.requested", version: 3, actor: "agent", payload: { interactionId: CONFIRMATION, conversationId: CONVERSATION, toolUseId: CONFIRMATION, request: [{ question, header: "Workflow", choices: [{ kind: "option", choiceId: "approve", label: "Start" }, { kind: "option", choiceId: "inline", label: "Inline" }], multiSelect: false }], decision: { kind: "workflow_launch", source: { kind: "registered", definitionId: "debug" }, question, approve: { choiceId: "approve", label: "Start" }, reject: { choiceId: "inline", label: "Inline" } } } },
      { aggregateId: `session:${CHAT}`, sessionId: CHAT, timestamp: 2, type: "agent_input.answered", version: 3, actor: "user", payload: { interactionId: CONFIRMATION, answers: { [question]: { kind: "choice", selections: [{ choiceId: "approve" }], text: "Start" } } } },
    ])
    await refused(setup, await setup.launch(), `That confirmation approves the retired debug workflow, which Flywheel no longer launches, not the workflow file ${setup.source.path}.`)
    expect(await consumedBy(setup)).toBeUndefined()
  })

  it("binds approval to the file, not the summary or description", async () => {
    const setup = await askSetup()
    setup.approve()
    expect(await setup.launch({ summary: "Changed", description: "Changed request" })).not.toHaveProperty("error")
    expect(setup.manager.publishWorkflow).toHaveBeenCalledTimes(1)
  })

  it("grants one of two concurrent launches on one approval", async () => {
    const setup = await askSetup()
    setup.approve()
    const results = await Promise.all([setup.launch(), setup.launch({ toolUseId: "second" })])
    expect(results.filter((result) => !("error" in result))).toHaveLength(1)
    expect(results.filter((result) => "error" in result)).toHaveLength(1)
    expect(setup.manager.publishWorkflow).toHaveBeenCalledTimes(1)
  })

  it("keeps approval consumed after publication fails", async () => {
    const setup = await askSetup()
    setup.manager.publishWorkflow = mock(async () => { throw new Error("aggregate conflict") })
    setup.approve()
    expect(await setup.launch()).toEqual({ error: "Workflow publish error: aggregate conflict" })
    expect(await consumedBy(setup)).toBe(TOOL_CALL)
    expect(await setup.launch()).toMatchObject({ error: expect.stringContaining("was already used"), recovery: WORKFLOW_LAUNCH_RETRY_INSTRUCTION })
  })

  it("keeps approval reusable when provider preparation fails", async () => {
    let attempts = 0
    const setup = await askSetup({ prepareWorkflowDeps: async () => { if (++attempts === 1) throw new Error("provider unavailable"); return makeWorkflowDeps() } })
    setup.approve()
    expect(await setup.launch()).toEqual({ error: "Config error: provider unavailable" })
    expect(await consumedBy(setup)).toBeUndefined()
    expect(await setup.launch()).not.toHaveProperty("error")
    expect(await consumedBy(setup)).toBe(TOOL_CALL)
  })

  it("keeps a published child and reports a runner start failure once", async () => {
    const onRunnerError = mock(async () => {})
    const setup = await askSetup({ workflowMode: () => "on", onRunnerError, workflowHosts: {
      onChange: () => () => {}, get: () => undefined, allIds: () => [], isRunning: () => false,
      start: mock(async () => { throw new Error("runner start failed") }),
      abort: async () => false, remove: async () => {}, refreshDeps: async () => {}, disposeAll: async () => {},
    } })
    const result = await setup.launch({ confirmationId: null })
    if ("error" in result) throw new Error(result.error)
    await until(() => onRunnerError.mock.calls.length > 0, "the runner start failure")
    expect(setup.manager.publishWorkflow).toHaveBeenCalledTimes(1)
    expect(await setup.manager.read(result.workflowId)).toBeNull()
    expect(await workflowRunReader(setup.deps.projectionReader).read(result.workflowId)).toMatchObject({ workflowDefinitionId: "repair", launchedFrom: { parentSessionId: CHAT, toolUseId: TOOL_CALL } })
    expect(onRunnerError).toHaveBeenCalledTimes(1)
    expect(onRunnerError).toHaveBeenCalledWith(result.workflowId, "runner start failed")
  })

  it("launches without confirmation under On, but refuses a stale Ask confirmation", async () => {
    const setup = await askSetup({ workflowMode: () => "on" })
    setup.approve()
    expect(await setup.launch()).toEqual({ error: "Workflows does not require approval in this session, so confirmation_id is not accepted.", recovery: "Call workflow again without it." })
    expect(await consumedBy(setup)).toBeUndefined()
    expect(setup.prepareCalls()).toBe(0)
    expect(await setup.launch({ confirmationId: null })).not.toHaveProperty("error")
    expect(setup.manager.publishWorkflow).toHaveBeenCalledTimes(1)
  })
})

describe("retained named launch cells", () => {
  async function retained(published: boolean) {
    const setup = await askSetup()
    const operation: WorkflowLaunchOperation = { kind: WORKFLOW_LAUNCH_OPERATION_KIND, version: 1, operationId: "old-launch", parentSessionId: CHAT, parentConversationId: CONVERSATION, childSessionId: "old-child", toolUseId: "old-call", parentEntryId: "itb-settled-old-launch", acceptedAt: "2026-10-01T00:00:00.000Z", initiator: "person", launch: { workflowDefinitionId: "debug", description: "Fix it" } }
    if (published) await publishTestWorkflow(setup.rawManager, { id: operation.childSessionId, workflowDefinitionId: "debug", description: "Fix it", launchedFrom: { parentSessionId: CHAT, conversationId: CONVERSATION, toolUseId: operation.toolUseId } })
    await setup.deps.launchPort.acceptLaunch(CHAT, { kind: operation.kind, key: operation.operationId, payload: operation })
    return { ...setup, operation }
  }

  it("decodes a previous cell and refuses it under its original notice and retire swap", async () => {
    const setup = await retained(false)
    const [cell] = setup.store.readInFlight(CHAT, WORKFLOW_LAUNCH_OPERATION_KIND)
    expect(setup.deps.launchPort.failures).toEqual([])
    expect(setup.deps.launchPort.results).toEqual([{ kind: "refused", notice: { kind: "user", origin: "system", content: "The debug workflow could not start: Flywheel no longer launches a workflow by name. Ask the chat to write and launch a workflow file." }, noticeId: "itb-settled-old-launch", retire: { op: "swap", kind: WORKFLOW_LAUNCH_OPERATION_KIND, key: "old-launch", expectedRaw: cell!.raw, payload: null } }])
    expect(setup.prepareCalls()).toBe(0)
    expect(setup.manager.publishWorkflow).not.toHaveBeenCalled()
    expect(setup.workflowHosts._startCalls).toEqual([])
  })

  it("only retires a cell whose parent already published its child", async () => {
    const setup = await retained(true)
    expect(setup.deps.launchPort.results.map(({ kind }) => kind)).toEqual(["committed"])
    expect(setup.store.readInFlight(CHAT, WORKFLOW_LAUNCH_OPERATION_KIND)).toEqual([])
    expect(setup.manager.publishWorkflow).not.toHaveBeenCalled()
    expect(setup.workflowHosts._startCalls).toEqual([])
    expect(await workflowRunReader(setup.deps.projectionReader).read("old-child")).toMatchObject({ workflowDefinitionId: "debug" })
    await setup.controller.commitLaunch(setup.operation, { sessionId: CHAT, conversationId: CONVERSATION, kind: WORKFLOW_LAUNCH_OPERATION_KIND, key: "old-launch", raw: "already-settled" })
    expect(setup.workflowHosts._startCalls).toEqual([])
  })
})
