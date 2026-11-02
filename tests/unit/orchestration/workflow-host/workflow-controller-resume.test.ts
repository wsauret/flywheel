import { afterEach, describe, it, expect, mock, spyOn } from "bun:test"
import { workflowRunner } from "../app-service/_frontend-projection-fixtures.js"
import { FIXTURE_WORKFLOW_ID } from "../../../helpers/project-definitions.js"
import { Log } from "../../../../src/infra/log.js"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/publish"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { commitWorkflowEvent, createMockWorkflowHosts } from "./_workflow-host-fixtures"
import { convertWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions"
import { adoptWorkflowChildren } from "../../../../src/orchestration/modules/workflows/migrations/adopt-workflow-children"
import type { WorkflowView } from "../../../../src/workflows/view/types.js"
import { plainAgentTree } from "../../../helpers/workflow-view.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input-projection"
import {
  cleanupProjectRoots,
  trackProjectRoot,
  trackEventStore,
  createDeps,
  createMockManager,
  makeWorkflowDeps,
  seedWorkflowRequest,
  fixtureWorkflow,
} from "./_workflow-controller-fixtures"
import { historicalWorkflowSessionCreatedFacts } from "../../../fixtures/tolerant-reprojection-fixtures.js"
import { WorkflowPreflightError, type WorkflowHandBack } from "../../../../src/orchestration/workflow-host/runner-types.js"
import { workflowParentBinding } from "../../../helpers/workflow-parent.js"
import { Database } from "bun:sqlite"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"
import { workflowRunOwner, workflowRunReader } from "../../../../src/orchestration/module-catalog.js"
import type { WorkflowHosts } from "../../../../src/orchestration/workflow-host/host-collection.js"
import { createWorkflowDurationReader } from "../../../../src/orchestration/modules/workflows/duration.js"

afterEach(() => {
  cleanupProjectRoots()
})

/** One agent for each launch item and nothing after the list, so a failed
 *  item agent ends the run. */
const ITEMS_WORKFLOW = `id: items
name: Items
description: One agent for each item.
input:
  fields:
    items:
      type: list
      description: The items.
      unique: id
      of:
        type: object
        fields:
          id: { type: string, description: The item id. }
phases:
  - phase: item
    over: input.items
    label: id
    name: Item
    brief: Handle one item.
    output:
      summary: One sentence about the item.
`

describe("WorkflowController", () => {
  describe("resumeWorkflow", () => {
    it("prepares a resume from the saved run profile and records generated names on the aggregate", async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "controller-aggregate-resume-"))
      trackProjectRoot(projectRoot)
      const store = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      const reader = asAsyncEventReadSurface(store)
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const preparedProfiles: string[] = []
      const profile = {
        retirements: {}, id: "saved-profile", persistedId: "saved-profile", displayName: "Saved profile",
        source: "sticky" as const, directory: join(projectRoot, "auth"), availableProfiles: [{ id: "saved-profile", displayName: "Saved profile" }],
        projectBinding: undefined,
      }
      const runs = workflowRunReader(reader)
      const workflowAuth = createWorkflowAuthOwner({
        reader: runs, writer: workflowRunOwner().writer(reader, manager.commitWorkflow),
        profiles: { inspect: () => profile }, userDataRoot: projectRoot, onSelected: async () => {},
      })
      const authAdmission = createSessionAuthAdmission({
        manager, workflows: workflowAuth, authProfiles: { inspect: () => profile },
        materialize: async () => { throw new Error("No retirement is pending") },
        prepare: async (profileId) => { preparedProfiles.push(profileId); return makeWorkflowDeps() },
      })
      const start = mock(async (options: Parameters<WorkflowHosts["start"]>[0]) => {
        const queue = await loadQueueSnapshotFromReader(reader, options.sessionId)
        if (!queue) throw new Error("Missing published queue")
        await options.onPrepared?.(queue)
        return options.sessionId
      })
      const workflowHosts: WorkflowHosts = {
        start, get: () => undefined, allIds: () => [], isRunning: () => false,
        abort: async () => false, remove: async () => {}, onChange: () => () => {}, refreshDeps: async () => {}, disposeAll: async () => {},
      }
      const deps = createDeps({
        projectRoot, manager, workflowHosts, authAdmission,
      })
      const workflow = await fixtureWorkflow(deps)
      const execution = makeWorkflowDeps()
      const prepared = await prepareWorkflowLaunch({ workflow, description: "Saved workflow", deps: execution, projectRoot,
        authProfileId: profile.id, definitionRevision: execution.definitions.captureRevision() })
      await manager.publishWorkflow({ id: "saved-workflow", ...prepared, facts: prepared.workflowFacts, launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: workflow.id }) })
      const controller = createWorkflowController(deps)

      await expect(controller.resumeWorkflow("saved-workflow")).resolves.toEqual({ kind: "resumed", sessionId: "saved-workflow" })
      expect(start.mock.calls[0]?.[0].wake).toEqual(WHOLE_WORKFLOW)
      expect(preparedProfiles).toEqual(["saved-profile"])
      expect(await manager.read("saved-workflow")).toBeNull()
      expect((await runs.read("saved-workflow"))?.roleAssignments).toBeDefined()
      const named = Promise.withResolvers<void>()
      const unsubscribe = store.onStored(facts => {
        if (facts.some(fact => fact.type === "workflow.run.settings.updated")) named.resolve()
      })
      try {
        start.mock.calls[0]?.[0].onSessionName?.({ label: "Generated title", shortLabel: "Generated" })
        await named.promise
        expect(await runs.read("saved-workflow")).toMatchObject({ label: "Generated title", shortLabel: "Generated" })
      } finally { unsubscribe() }
      const address: WorkflowDeliveryAddress = { addressedTo: [{ _tag: "agent", nodeId: "agent", definitionId: "agent" }], label: "step agent" }
      await controller.resumeWorkflow("saved-workflow", address)
      expect(start.mock.calls[1]?.[0].wake).toEqual(address)
      await controller.resumeWorkflow("saved-workflow")
      expect(start.mock.calls[2]?.[0].wake).toEqual(WHOLE_WORKFLOW)
      await controller.resumeWorkflow("saved-workflow", WHOLE_WORKFLOW, { wake: "planned" })
      expect(start.mock.calls[3]?.[0].wake).toBe("planned")
    })

    it("hands back a named live agent while a sibling runs, and a capacity wake continues only the waiting agents of the live run", async () => {
      const manager = createMockManager()
      const workflowHosts = createMockWorkflowHosts()
      const handBack = mock(async (): Promise<WorkflowHandBack> => ({ kind: "continued" }))
      const continueCapacity = mock((ids: ReadonlySet<string>) => new Set([...ids].filter((id) => id === "waiting")))
      workflowHosts._runners.set("live", { ...workflowRunner("live"), handBack, continueCapacity })
      const deps = createDeps({ manager, workflowHosts })
      await seedWorkflowRequest(deps, "live", "Live workflow")
      const controller = createWorkflowController(deps)
      const address: WorkflowDeliveryAddress = { addressedTo: [{ _tag: "agent", nodeId: "agent", definitionId: "agent" }], label: "step agent" }
      expect(await controller.resumeWorkflow("live", address)).toEqual({ kind: "resumed", sessionId: "live" })
      expect(handBack).toHaveBeenCalledWith(address)
      expect(await controller.resumeWorkflow("live", WHOLE_WORKFLOW, { wake: "planned" })).toEqual({ kind: "already_running", sessionId: "live" })
      expect(handBack).toHaveBeenCalledTimes(1)
      // A capacity wake continues only the waiting agents inside the live run, and says which continued.
      expect(await controller.resumeWorkflow("live", WHOLE_WORKFLOW, { wake: { capacity: new Set(["waiting", "not-opened"]) } })).toEqual({ kind: "resumed", sessionId: "live", continued: new Set(["waiting"]) })
      expect(handBack).toHaveBeenCalledTimes(1)
      handBack.mockResolvedValueOnce({ kind: "not_parked" })
      expect(await controller.resumeWorkflow("live", address)).toEqual({ kind: "already_running", sessionId: "live" })
    })
    // The runner of an ended run can stay registered while its parent's
    // acknowledgement is pending. A Resume of the run that a failed item
    // agent ended still starts the failed agent again in a new run.
    it("starts a new run of a failed item agent while the ended run's runner is still registered", async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-controller-failed-item-"))
      trackProjectRoot(projectRoot)
      const eventReader = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      const reader = asAsyncEventReadSurface(eventReader)
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: eventReader })
      const wfDeps = makeWorkflowDeps()
      const workflow = await fixtureWorkflow({ projectRoot }, ITEMS_WORKFLOW)
      const prepared = await prepareWorkflowLaunch({
        authProfileId: wfDeps.activeProfileId ?? "default", workflow, description: "Two items",
        input: { items: [{ id: "alpha" }, { id: "bad" }] },
        deps: wfDeps, projectRoot, definitionRevision: wfDeps.definitions.captureRevision(),
      })
      const sessionId = await manager.publishWorkflow({
        id: manager.allocateId(), description: prepared.description, workflowDefinitionId: prepared.workflowDefinitionId,
        initialRoles: prepared.initialRoles, facts: prepared.workflowFacts,
        launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: prepared.workflowDefinitionId }),
      })
      const commits = { manager, projectionReader: reader }
      let control = await commitWorkflowEvent(commits, sessionId, workflow, { type: "START" })
      const [alpha, bad] = control.attempts
      if (!alpha || !bad) throw new Error("The fixture expands two items")
      for (const attempt of [alpha, bad]) control = await commitWorkflowEvent(commits, sessionId, workflow, { type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: `conversation-${attempt.id}` }, control)
      control = await commitWorkflowEvent(commits, sessionId, workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: alpha.id, conversationId: `conversation-${alpha.id}`, handoff: { summary: "Alpha is done." }, reassessment: null } }, control)
      control = await commitWorkflowEvent(commits, sessionId, workflow, { type: "ATTEMPT_FAILED", failure: { attemptId: bad.id, kind: "fatal", reason: "unauthorized", conversationId: `conversation-${bad.id}` } }, control)
      expect(control.status).toBe("failed")

      const workflowHosts = createMockWorkflowHosts()
      const handBack = mock(async (): Promise<WorkflowHandBack> => ({ kind: "not_parked" }))
      workflowHosts._runners.set(sessionId, { ...workflowRunner(sessionId), handBack })
      const remove = spyOn(workflowHosts, "remove")
      // A second Resume, such as the parent's beside the person's, reads the
      // same failed run but is admitted only after the first one started.
      const firstStarted = Promise.withResolvers<void>()
      let preparations = 0
      const controller = createWorkflowController(createDeps({ workflowHosts, manager, projectRoot, eventReader: reader, prepareWorkflowDeps: async () => {
        preparations += 1
        if (preparations > 1) await firstStarted.promise
        return wfDeps
      } }))

      const first = controller.resumeWorkflow(sessionId)
      const second = controller.resumeWorkflow(sessionId)
      expect(await first).toEqual({ kind: "resumed", sessionId })
      const successor = workflowHosts._runners.get(sessionId)
      firstStarted.resolve()
      expect(await second).toEqual({ kind: "already_running", sessionId })
      expect(handBack).not.toHaveBeenCalled()
      expect(remove).toHaveBeenCalledTimes(1)
      expect(workflowHosts._startCalls.map(({ startMode }) => startMode)).toEqual(["operator_resume"])
      expect(workflowHosts._runners.get(sessionId)).toBe(successor)
    })
    // A step of an earlier build could ask the person, and the workflow then
    // refused to resume while the question was open. Steps no longer ask
    // (PI-AGENT-024), so the resume withdraws the question and continues.
    it("resumes over a step question an earlier build left open and withdraws it", async () => {
      const manager = createMockManager()
      const workflowHosts = createMockWorkflowHosts()
      workflowHosts.start = mock(async (options) => {
        await options.onDefinitionAccepted?.()
        const attempts = [{ id: "step", definitionId: "work", briefId: "work", workflowDefinitionId: "asking", name: "Work", status: "pending", writes: [], resumeRevertCount: 0, lastConversationId: "step-conversation" }] as const
        await options.onPrepared?.({ cursor: 0, attempts, tree: plainAgentTree(attempts), status: "paused", mutationLog: [] } satisfies WorkflowView)
        return options.sessionId
      })
      const deps = createDeps({ manager, workflowHosts })
      await seedWorkflowRequest(deps, "asking-workflow", "Asking workflow")
      await deps.eventWriter.append({
        aggregateId: "session:asking-workflow", sessionId: "asking-workflow", type: "agent_input.requested", version: 3, actor: "agent", timestamp: 2,
        payload: {
          interactionId: "ask-1", conversationId: "step-conversation", toolUseId: "ask-1",
          request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
        },
      })

      await expect(createWorkflowController(deps).resumeWorkflow("asking-workflow")).resolves.toEqual({ kind: "resumed", sessionId: "asking-workflow" })
      const question = (await loadAgentInputProjection(deps.projectionReader, "asking-workflow")).get("ask-1")
      expect(question).toMatchObject({ kind: "withdrawn", reason: "child_question_retired" })
      expect(await manager.read("asking-workflow")).toBeNull()
      expect(workflowHosts.start).toHaveBeenCalledTimes(1)
    })
    it.each([
      { failure: { kind: "definition_drift" as const, workflowId: FIXTURE_WORKFLOW_ID, message: "Definition drift" }, result: "definition_drift" },
      { failure: { kind: "attempt_refused" as const, attemptId: "attempt-1", message: "Invocation budget exhausted (1/1)" }, result: "unavailable" },
    ])("does not prepare a refused resume: $result", async ({ failure, result: kind }) => {
      const manager = createMockManager()
      const workflowHosts = createMockWorkflowHosts()
      workflowHosts.start = mock(async () => {
        throw new WorkflowPreflightError(failure)
      })
      const deps = createDeps({ manager, workflowHosts })
      await seedWorkflowRequest(deps, "drifted-workflow", "Drifted workflow")
      const controller = createWorkflowController(deps)

      const log = spyOn(Log.create({ service: "workflow-controller" }), "info").mockImplementation(() => {})
      try {
        const result = await controller.resumeWorkflow("drifted-workflow")
        expect(result).toEqual({ kind, message: failure.message })
        expect(log).toHaveBeenCalledTimes(failure.kind === "attempt_refused" ? 1 : 0)
        if (failure.kind === "attempt_refused") expect(log).toHaveBeenCalledWith("workflow resume refused", {
          sessionId: "drifted-workflow", attemptId: "attempt-1", kind: "attempt_refused",
        })
      } finally {
        log.mockRestore()
      }
      expect(await manager.read("drifted-workflow")).toBeNull()
      expect(manager.updateLifecycleState).not.toHaveBeenCalled()
    })
    it.each([
      {
        damage: "a companion record",
        control: false,
        sql: "UPDATE event SET version = 99 WHERE type = 'queue.created'",
        result: {
          kind: "recovery_required",
          message: "This workflow's saved progress has a record that this version of Flywheel cannot read. Restart runs it again from its recorded request.",
        },
      },
      {
        damage: "a committed control record",
        control: true,
        sql: "UPDATE event SET version = 99 WHERE type = 'workflow.control.committed'",
        result: {
          kind: "malformed_state",
          message: "This workflow's saved progress has a record that this version of Flywheel cannot read. The workflow remains paused because its committed work cannot be proved, so Restart cannot run it again.",
        },
      },
    ])("offers a message route for malformed durable state only when recovery can prove it: $damage", async ({ control, sql, result }) => {
      const manager = createMockManager()
      const workflowHosts = createMockWorkflowHosts()
      workflowHosts.start = mock(async () => {
        throw new WorkflowPreflightError({ kind: "malformed_state", sessionId: "damaged-workflow", message: "Workflow session damaged-workflow has non-executable durable state: unknown_version" })
      })
      const deps = createDeps({ manager, workflowHosts })
      await seedWorkflowRequest(deps, "damaged-workflow", "Damaged task")
      if (control) await deps.eventWriter.append({
        aggregateId: "workflow:damaged-workflow", sessionId: "damaged-workflow", type: "workflow.control.committed", version: 1,
        timestamp: 2, actor: "flywheel", payload: {},
      })
      const db = new Database(resolveEventStoreDbFile(deps.projectRoot))
      try {
        db.run(sql)
      } finally {
        db.close()
      }

      expect(await createWorkflowController(deps).resumeWorkflow("damaged-workflow")).toEqual(result)
    })
    it("session_metadata unknown-older-version workflow-resume starts session.created@1 and @2 through project fallback", async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-controller-historical-"))
      trackProjectRoot(projectRoot)
      const eventReader = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      try {
        const wfDeps = makeWorkflowDeps()
        const prepared = await prepareWorkflowLaunch({
          authProfileId: wfDeps.activeProfileId ?? "default",
          workflow: await fixtureWorkflow({ projectRoot }),
          description: "Legacy workflow",
          deps: wfDeps,
          projectRoot,
          definitionRevision: wfDeps.definitions.captureRevision(),
        })
        eventReader.appendBatch(historicalWorkflowSessionCreatedFacts("legacy-workflow").map((fact) => ({
          ...fact, payload: { ...fact.payload, workflowDefinitionId: FIXTURE_WORKFLOW_ID },
        })))
        for (const version of [1, 2]) {
          const sessionId = `legacy-workflow-${version}`
          eventReader.appendBatch(prepared.workflowFacts.map((fact, index) => ({
            ...fact,
            aggregateId: `workflow:${sessionId}`,
            sessionId,
            timestamp: 10 + index,
          })))
        }
        adoptWorkflowChildren(resolveEventStoreDbFile(projectRoot), projectRoot)
        expect(convertWorkflowAgentSessions(resolveEventStoreDbFile(projectRoot)).converted).toBe(2)
        const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: eventReader })
        const workflowHosts = createMockWorkflowHosts()
        const controller = createWorkflowController(createDeps({ manager, workflowHosts, projectRoot, eventReader: asAsyncEventReadSurface(eventReader), prepareWorkflowDeps: async () => wfDeps }))

        for (const version of [1, 2]) {
          const sessionId = `legacy-workflow-${version}`
          await expect(controller.resumeWorkflow(sessionId)).resolves.toEqual({ kind: "resumed", sessionId })
          expect(workflowHosts._startCalls.at(-1)?.executionCwd).toBe(realpathSync(projectRoot))
        }
      } finally {
        eventReader.close()
        // Removal is the shared cleanup's: it closes the tracked stores first.
      }
    })
    it("resumes identity-only workflow metadata through the project fallback", async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-controller-identity-only-"))
      trackProjectRoot(projectRoot)
      const eventReader = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      try {
        const sessionId = "identity-only-workflow"
        const wfDeps = makeWorkflowDeps()
        const prepared = await prepareWorkflowLaunch({ workflow: await fixtureWorkflow({ projectRoot }), description: "Identity workflow", deps: wfDeps, authProfileId: wfDeps.activeProfileId ?? "default", projectRoot, definitionRevision: wfDeps.definitions.captureRevision() })
        eventReader.append({
          aggregateId: `session:${sessionId}`,
          sessionId,
          type: "session.created",
          version: 3,
          actor: "flywheel",
          timestamp: 1,
          payload: { kind: "workflow", command: "workflow", workflowDefinitionId: FIXTURE_WORKFLOW_ID, label: "Identity workflow", name: "Identity workflow", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "inactive" },
        })
        eventReader.appendBatch(prepared.workflowFacts.map((fact, index) => ({ ...fact, aggregateId: `workflow:${sessionId}`, sessionId, timestamp: 10 + index })))
        adoptWorkflowChildren(resolveEventStoreDbFile(projectRoot), projectRoot)
        expect(convertWorkflowAgentSessions(resolveEventStoreDbFile(projectRoot)).converted).toBe(1)
        const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: eventReader })
        const workflowHosts = createMockWorkflowHosts()
        const controller = createWorkflowController(createDeps({ manager, workflowHosts, projectRoot, eventReader: asAsyncEventReadSurface(eventReader), prepareWorkflowDeps: async () => wfDeps }))

        await expect(controller.resumeWorkflow(sessionId)).resolves.toEqual({ kind: "resumed", sessionId })
        expect(workflowHosts._startCalls[0]?.executionCwd).toBe(realpathSync(projectRoot))
      } finally {
        eventReader.close()
        // Removal is the shared cleanup's: it closes the tracked stores first.
      }
    })

    it("returns a not-found result when the session does not exist", async () => {
      const deps = createDeps()
      const controller = createWorkflowController(deps)

      const result = await controller.resumeWorkflow("missing-session")

      expect(result).toEqual({ kind: "not_found", message: "Workflow session missing-session was not found" })
    })

    it("workflow_control valid-current workflow-resume starts the registered durable workflow", async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-controller-resume-"))
      trackProjectRoot(projectRoot)
      const executionCwd = join(projectRoot, "packages", "nested")
      mkdirSync(executionCwd, { recursive: true })
      let eventReader: ReturnType<typeof createSqliteEventStore> | undefined
      try {
        eventReader = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
        const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: eventReader })
        const wfDeps = makeWorkflowDeps()
        const prepared = await prepareWorkflowLaunch({
          authProfileId: wfDeps.activeProfileId ?? "default",
          workflow: await fixtureWorkflow({ projectRoot }),
          description: "Resume Target",
          agents: { investigate: { model: "gpt-5.5", effort: "low" } },
          deps: wfDeps,
          projectRoot,
          definitionRevision: wfDeps.definitions.captureRevision(),
        })
        const sessionId = await manager.publishWorkflow({
          id: manager.allocateId(),
          description: prepared.description,
          workflowDefinitionId: prepared.workflowDefinitionId,
          initialRoles: prepared.initialRoles,
          facts: prepared.workflowFacts,
          executionCwd,
          launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: prepared.workflowDefinitionId }),
        })
        // The active time of the runs before this resume.
        eventReader.append({ aggregateId: `session:${sessionId}`, sessionId, type: "session.duration.recorded", version: 1, timestamp: Date.now(), actor: "flywheel", payload: { accumulatedActiveMs: 4_000 } })
        const reader = asAsyncEventReadSurface(eventReader)
        await workflowRunOwner().writer(reader, manager.commitWorkflow).update(sessionId, current => ({ ...current, historicalResidualAggregateId: `session:${sessionId}` }))

        const workflowHosts = createMockWorkflowHosts()
        const controller = createWorkflowController(createDeps({
          workflowHosts,
          manager,
          projectRoot,
          eventReader: asAsyncEventReadSurface(eventReader),
          prepareWorkflowDeps: async () => wfDeps,
        }))

        const result = await controller.resumeWorkflow(sessionId)

        expect(result).toEqual({ kind: "resumed", sessionId })
        expect(workflowHosts._startCalls).toHaveLength(1)
        expect(workflowHosts._startCalls[0]?.sessionId).toBe(sessionId)
        // The resumed clock continues from the recorded time, never from zero.
        expect((await createWorkflowDurationReader(reader)(sessionId, false)).durationMs).toBe(4_000)
        expect(workflowHosts._startCalls[0]?.description).toBe("Resume Target")
        expect(workflowHosts._startCalls[0]?.executionCwd).toBe(realpathSync(executionCwd))
        expect(workflowHosts._startCalls[0]?.projectRoot).toBe(projectRoot)
        expect(await manager.read(sessionId)).toBeNull()
        expect((await workflowRunReader(reader).read(sessionId))?.roleAssignments?.defaults["brief.repair.investigate.at.investigate"]).toEqual({ model: "gpt-5.5", effort: "low" })
      } finally {
        eventReader?.close()
        // Removal is the shared cleanup's: it closes the tracked stores first.
      }
    })

    it("refuses to resume a workflow whose recorded execution directory is gone, and starts nothing", async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-controller-resume-gone-"))
      trackProjectRoot(projectRoot)
      const executionCwd = join(projectRoot, "packages", "nested")
      mkdirSync(executionCwd, { recursive: true })
      let eventReader: ReturnType<typeof createSqliteEventStore> | undefined
      try {
        eventReader = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
        const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: eventReader })
        const wfDeps = makeWorkflowDeps()
        const prepared = await prepareWorkflowLaunch({
          authProfileId: wfDeps.activeProfileId ?? "default",
          workflow: await fixtureWorkflow({ projectRoot }),
          description: "Resume Target",
          deps: wfDeps,
          projectRoot,
          definitionRevision: wfDeps.definitions.captureRevision(),
        })
        const sessionId = await manager.publishWorkflow({
          id: manager.allocateId(),
          description: prepared.description,
          workflowDefinitionId: prepared.workflowDefinitionId,
          initialRoles: prepared.initialRoles,
          facts: prepared.workflowFacts,
          executionCwd,
          launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: prepared.workflowDefinitionId }),
        })
        rmSync(executionCwd, { recursive: true, force: true })

        const workflowHosts = createMockWorkflowHosts()
        const controller = createWorkflowController(createDeps({
          workflowHosts,
          manager,
          projectRoot,
          eventReader: asAsyncEventReadSurface(eventReader),
          prepareWorkflowDeps: async () => wfDeps,
        }))

        const before = eventReader.currentPosition()
        const result = await controller.resumeWorkflow(sessionId)

        expect(result).toEqual({ kind: "unavailable", message: `session execution directory does not exist: ${join(realpathSync(projectRoot), "packages", "nested")}. Restore the directory to continue.` })
        expect(workflowHosts._startCalls).toHaveLength(0)
        // Nothing is recorded, so the workflow stays paused where it was.
        expect(eventReader.currentPosition()).toBe(before)
      } finally {
        eventReader?.close()
        // Removal is the shared cleanup's: it closes the tracked stores first.
      }
    })

  })

  describe("resumeLaunch", () => {
    /** A launched workflow whose current step an interrupt by `by` cut, as
     *  its step conversation records it, with no runner live. */
    async function interruptedLaunch(by: "person" | "agent", mixed = false) {
      const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-controller-resume-launch-"))
      trackProjectRoot(projectRoot)
      const eventReader = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store: eventReader })
      const wfDeps = makeWorkflowDeps()
      const prepared = await prepareWorkflowLaunch({
        authProfileId: wfDeps.activeProfileId ?? "default",
        workflow: await fixtureWorkflow({ projectRoot }),
        description: "Interrupted launch",
        deps: wfDeps,
        projectRoot,
        definitionRevision: wfDeps.definitions.captureRevision(),
      })
      const sessionId = await manager.publishWorkflow({
        id: manager.allocateId(),
        description: prepared.description,
        workflowDefinitionId: prepared.workflowDefinitionId,
        initialRoles: prepared.initialRoles,
        facts: prepared.workflowFacts,
        launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: prepared.workflowDefinitionId }),
      })
      const initialQueue = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(eventReader), sessionId)
      if (!initialQueue) throw new Error("Published workflow requires an initial queue projection")
      const [first, second, ...rest] = initialQueue.attempts
      if (!first) throw new Error("The launch requires a workflow attempt")
      const step = { ...first, status: "running" as const, lastConversationId: "conv-interrupted-step" }
      const single = { ...initialQueue, attempts: [step, ...(second ? [second] : []), ...rest], tree: { ...initialQueue.tree, nodes: initialQueue.tree.nodes.map((node) => node.kind === "agent" ? { ...node, currentAttemptId: step.id } : node) } }
      const concurrent = () => {
        if (!second) throw new Error("Concurrent fixture requires a second attempt")
        const sibling = { ...second, status: "running" as const, lastConversationId: "conv-parent-step" }
        return { ...single, attempts: [step, sibling, ...rest], tree: { nodes: [
          { id: "parallel", kind: "phase", form: "parallel", phaseId: "parallel", label: "Parallel", parentId: null, disposition: "running" },
          { id: "person-agent", kind: "agent", definitionId: "person", label: "Person agent", parentId: "parallel", disposition: "running", attempts: 1, currentAttemptId: step.id },
          { id: "parent-agent", kind: "agent", definitionId: "parent", label: "Parent agent", parentId: "parallel", disposition: "running", attempts: 1, currentAttemptId: sibling.id },
        ] } } satisfies WorkflowView
      }
      const queue = { ...(mixed ? concurrent() : single), status: "paused" as const }
      eventReader.appendBatch(queueFactsForState(initialQueue, queue).map((fact) => ({
        aggregateId: `workflow:${sessionId}`, sessionId, timestamp: Date.now(), type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload,
      })))
      const tree = await createConversationTree({ conversationId: "conv-interrupted-step", sessionId, store: asAsyncEventReadSurface(eventReader), writer: asAsyncEventWriter(eventReader) })
      await tree.appendMessage({ kind: "user", content: "worker prompt" })
      const end = interruptedTurnEnd(by)
      await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "key"))
      tree.getStorage().dispose()
      if (mixed) {
        const sibling = await createConversationTree({ conversationId: "conv-parent-step", sessionId, store: asAsyncEventReadSurface(eventReader), writer: asAsyncEventWriter(eventReader) })
        await sibling.appendMessage({ kind: "user", content: "sibling prompt" })
        const parentEnd = interruptedTurnEnd("agent")
        await sibling.appendMessage({ kind: "user", content: interruptedTurnMessage(parentEnd.pausedBy, false), origin: "system" }, turnEndEntryId(parentEnd, "parent-key"))
        sibling.getStorage().dispose()
      }
      const workflowHosts = createMockWorkflowHosts()
      const starts = workflowHosts._startCalls
      const controller = createWorkflowController(createDeps({
        workflowHosts,
        manager,
        projectRoot,
        eventReader: asAsyncEventReadSurface(eventReader),
        prepareWorkflowDeps: async () => wfDeps,
      }))
      return { controller, sessionId, starts }
    }

    it("refuses the parent's resume of a step that a person interrupted, and resumes one that the parent interrupted", async () => {
      const person = await interruptedLaunch("person")
      expect(await person.controller.launchCut(person.sessionId)).toEqual({ kind: "interrupt", by: "person" })
      expect(await person.controller.resumeLaunch(person.sessionId)).toEqual({ ok: false, error: "A person interrupted this child, so only a person can continue it, with Resume or a message." })

      const agent = await interruptedLaunch("agent")
      expect(await agent.controller.launchCut(agent.sessionId)).toEqual({ kind: "interrupt", by: "agent" })
      expect(await agent.controller.resumeLaunch(agent.sessionId)).toEqual({ ok: true })
    })

    it("resumes only the parent's offline cut without authorizing a person's sibling park", async () => {
      const { controller, sessionId, starts } = await interruptedLaunch("person", true)
      const address: WorkflowDeliveryAddress = { addressedTo: [{ _tag: "agent", nodeId: "parent-agent", definitionId: "parent" }], label: "agent parent" }
      expect(await controller.launchCut(sessionId, address)).toEqual({ kind: "interrupt", by: "agent" })
      expect(await controller.resumeLaunch(sessionId)).toMatchObject({ ok: false })
      expect(starts).toHaveLength(0)
      expect(await controller.resumeLaunch(sessionId, address)).toEqual({ ok: true })
      expect(starts[0]?.wake).toEqual(address)
    })

    it("starts an offline addressed message with only its reached wake", async () => {
      const { controller, sessionId, starts } = await interruptedLaunch("person", true)
      expect(await controller.sendWorkflow(sessionId, "Continue this agent", ["parent"])).toMatchObject({ kind: "delivered" })
      expect(starts[0]?.wake).toEqual({ addressedTo: [{ _tag: "agent", nodeId: "parent-agent", definitionId: "parent" }], label: "agent parent" })
    })
  })
})
