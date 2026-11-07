import { afterEach, describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage.js"
import { commitWorkflowRecovery, type WorkflowRecoveryCommitInput } from "../../../../src/orchestration/workflow-host/recovery-commit.js"
import { prepareWorkflowAgents, prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/publish.js"
import { parseCommittedWorkflowControl, type CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { makeWorkflowDeps } from "../../orchestration/workflow-host/_workflow-controller-fixtures.js"
import { Database } from "bun:sqlite"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { createWorkflowViewStore } from "../../../../src/workflows/view/view-store.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { createWorkflowQueueProjection, queueFromProjection } from "../../../../src/workflows/view/view-projection.js"
import { createWorkflowContextProjection, contextFromProjection } from "../../../../src/workflows/context-bundle/context-projection.js"
import { buildContextAccumulatedFact, buildContextInputAddedFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js"
import { validateWorkflowBootstrap } from "../../../../src/workflows/vm/bootstrap-validation.js"
import { buildWorkflowControlInitializedFact, buildWorkflowControlRecoveredFact } from "../../../../src/workflows/vm/session-facts.js"
import { buildAttemptRecoveredFact } from "../../../../src/workflows/vm/fact-drafts.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { readWorkflowQueuedUserInputs } from "../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { INPUT_GROUP, inputBranch, inputMapWorkflow, items } from "./_map-fixtures.js"
import { controlBeforePhases } from "../../../helpers/control-before-phases.js"
import { EVERY_CAPABILITY } from "../../../helpers/attempt-brief.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("workflow recovery atomicity", () => {
  it("preserves pristine compiled control and holds no input or conversation", async () => {
    const fixture = await recoveryFixture("fallback-order")

    const result = await commitWorkflowRecovery(fixture.input())

    expect(result.kind).toBe("committed")
    if (result.kind !== "committed") throw new Error("Recovery did not commit")
    const facts = fixture.store.read().slice(1)
    expect(facts.map(({ type }) => type)).toEqual([
      "workflow.control.recovered",
      "context.input.seeded",
      "queue.created",
      "queue.tree.changed",
    ])
    const recovered = parseCommittedWorkflowControl(facts[0]!.payload.control)
    const replayed = replayWorkflowControl(fixture.store.read({ aggregateId: `workflow:${fixture.sessionId}` }))
    expect(replayed.aggregateSeq).toBe(5)
    expect(result).toEqual({ kind: "committed" })
    expect(recovered).toEqual({ ...fixture.fallback, aggregateSeq: 5 })
    expect(facts[0]!.payload.identities).toEqual({
      workflow: { source: "recovered", value: FIXTURE_WORKFLOW_ID }, step: null, attempt: null, conversation: null,
    })
    expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).toEqual([])
    fixture.close()
  })

  for (const failedType of ["context.input.seeded", "queue.created"]) it(`rolls back the root when ${failedType} fails`, async () => {
    const fixture = await recoveryFixture("rollback")
    const base = asAsyncEventWriter(fixture.store)
    const writer: AsyncEventWriter = {
      ...base,
      appendBatchGuarded: (events) => base.appendBatchGuarded(events.map((event) => event.type === failedType ? { ...event, expectedSeq: 99 } : event)),
    }

    await expect(commitWorkflowRecovery(fixture.input({ writer }))).resolves.toEqual({ kind: "conflict" })
    expect(fixture.store.read().map(({ type }) => type)).toEqual(["context.input.seeded"])
    expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).toEqual([])
    fixture.close()
    const reopened = createSqliteEventStore(resolveEventStoreDbFile(fixture.projectRoot))
    expect(reopened.read().map(({ type }) => type)).toEqual(["context.input.seeded"])
    expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(reopened), fixture.sessionId)).toEqual([])
    reopened.close()
  })

  it("guards the workflow aggregate before it publishes the root", async () => {
    const fixture = await recoveryFixture("guard-workflow")
    const base = asAsyncEventWriter(fixture.store)
    let competed = false
    const writer: AsyncEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        if (!competed) {
          competed = true
          const target = events[0]!
          await base.appendGuarded({ ...target, inFlight: undefined, type: "test.concurrent", payload: {}, expectedSeq: target.expectedSeq })
        }
        return base.appendBatchGuarded(events)
      },
    }

    await expect(commitWorkflowRecovery(fixture.input({ writer }))).resolves.toEqual({ kind: "conflict" })
    expect(fixture.store.read().map(({ type }) => type)).toEqual(["context.input.seeded", "test.concurrent"])
    expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).toEqual([])
    fixture.close()
  })

  it("rolls back the root when SQLite rejects the last companion", async () => {
    const fixture = await recoveryFixture("late-write-failure")
    const db = new Database(resolveEventStoreDbFile(fixture.projectRoot))
    db.run("CREATE TRIGGER reject_recovery_queue BEFORE INSERT ON event WHEN NEW.type = 'queue.created' BEGIN SELECT RAISE(ABORT, 'late companion rejected'); END")
    db.close()
    await expect(commitWorkflowRecovery(fixture.input())).rejects.toThrow("late companion rejected")
    expect(fixture.store.read().map(({ type }) => type)).toEqual(["context.input.seeded"])
    expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).toEqual([])
    fixture.close()
    const reopened = createSqliteEventStore(resolveEventStoreDbFile(fixture.projectRoot))
    expect(reopened.read().map(({ type }) => type)).toEqual(["context.input.seeded"])
    expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(reopened), fixture.sessionId)).toEqual([])
    reopened.close()
  })

  it("allows two concurrent recoveries to publish one root", async () => {
    const fixture = await recoveryFixture("concurrent")

    const results = await Promise.all([
      commitWorkflowRecovery(fixture.input()),
      commitWorkflowRecovery(fixture.input()),
    ])

    expect(results.filter(({ kind }) => kind === "committed")).toHaveLength(1)
    expect(fixture.store.read({ aggregateId: `workflow:${fixture.sessionId}` }).filter(({ type }) => type === "workflow.control.recovered")).toHaveLength(1)
    expect(fixture.store.read().filter(({ type }) => type.startsWith("chat."))).toEqual([])
    fixture.close()
  })

  for (const missing of ["root", "queue", "seed", "both", "all"] as const) {
    it(`repairs missing ${missing}, reopens SQLite, and acquires the real executor only after attempt start`, async () => {
      const fixture = await recoveryFixture(`production-${missing}`, false)
      const aggregateId = `workflow:${fixture.sessionId}`
      fixture.store.append({
        aggregateId, sessionId: fixture.sessionId, timestamp: 1,
        type: "workflow.run.registered", version: 1, actor: "flywheel",
        payload: {
          request: "original creation request",
          settings: { workflowDefinitionId: FIXTURE_WORKFLOW_ID, label: "original creation request", executionCwd: fixture.projectRoot, createdAt: new Date(1).toISOString(), lastUpdated: new Date(1).toISOString(), roleAssignments: { defaults: {}, overrides: {} } },
          launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" },
        },
      })
      fixture.store.append({
        aggregateId, sessionId: fixture.sessionId, timestamp: 2,
        type: "workflow.run.settings.updated", version: 1, actor: "flywheel",
        payload: {
          labelSource: "user",
          settings: { workflowDefinitionId: FIXTURE_WORKFLOW_ID, label: "renamed title", name: "renamed title", shortLabel: "renamed", userNamed: true, executionCwd: fixture.projectRoot, createdAt: new Date(1).toISOString(), lastUpdated: new Date(2).toISOString(), roleAssignments: { defaults: {}, overrides: {} } },
        },
      })
      const launch = fixture.prepared.workflowFacts.filter(({ type }) => type === "context.input.seeded" || type === "queue.created")
        .filter(({ type }) => !(missing === "seed" || missing === "both") || type !== "context.input.seeded")
        .filter(({ type }) => !(missing === "queue" || missing === "both") || type !== "queue.created")
        .filter(() => missing !== "all")
      const initial = buildWorkflowControlInitializedFact({ ...fixture.fallback, aggregateSeq: launch.length + 3 })
      fixture.store.appendBatch([...(missing === "root" || missing === "all" ? [] : [initial]), ...launch].map((fact) => ({ ...fact, aggregateId, sessionId: fixture.sessionId, timestamp: 10 })))
      const entry = {
        entryId: "prior-attempt", agentName: "Prior readable work", definitionId: "implement",
        workflowDefinitionId: "implement", recipientAttemptId: null,
        writes: [{ id: "retained", lifetime: "durable" as const, supersedes: [] }],
        timestamp: 123, handoff: { outcome: { state: "completed" }, summary: "readable inherited evidence", artifacts: { files_modified: ["src/example.ts"] } },
      }
      const priorEntries = [
        { ...entry, entryId: "older-attempt", timestamp: 121, writes: [{ id: "older", lifetime: "durable" as const, supersedes: [] }] },
        { ...entry, writes: [{ id: "retained", lifetime: "durable" as const, supersedes: ["older"] }] },
      ]
      if (missing !== "root" && missing !== "all") fixture.store.appendBatch(priorEntries.map((retainedEntry, index) => ({
        ...buildContextAccumulatedFact(retainedEntry), aggregateId, sessionId: fixture.sessionId, timestamp: 123 + index,
      })))
      const preflight = validateWorkflowBootstrap(fixture.store.readTolerant({ aggregateId }))
      expect(preflight.executable).toBe(false)
      if (missing !== "root" && missing !== "all" && preflight.kind === "recovery") expect(preflight.reasons).toContainEqual({ kind: "missing_companion", family: missing === "queue" ? "queue.created" : "context.input.seeded" })
      const recovered = await commitWorkflowRecovery(fixture.input())
      expect(recovered.kind).toBe("committed")
      if (recovered.kind !== "committed") throw new Error("Recovery must commit")
      const bootstrap = fixture.store.read({ aggregateId })
      const root = bootstrap.findLast(({ type }) => type === "workflow.control.recovered")!
      expect(root.payload.control).toMatchObject({ aggregateSeq: fixture.store.aggregateSeq(aggregateId) + 1 })
      if (missing !== "root" && missing !== "all") expect(bootstrap.filter(({ type }) => type === "context.accumulated").slice(-2)).toMatchObject(
        priorEntries.map((retainedEntry, index) => ({ timestamp: 123 + index, payload: { entry: retainedEntry } })),
      )
      expect(fixture.store.read().filter(({ type }) => type.startsWith("chat."))).toEqual([])
      fixture.close()

      const reopened = createSqliteEventStore(resolveEventStoreDbFile(fixture.projectRoot))
      const projectionReader = asAsyncEventReadSurface(reopened)
      const queueStore = createWorkflowViewStore({ sessionId: fixture.sessionId, reader: projectionReader })
      const contextStore = createWorkflowContextStore({ sessionId: fixture.sessionId, reader: projectionReader })
      const calls: Array<{ attemptId: string; prompt: string; conversationId: string }> = []
      const request = missing === "seed" || missing === "both" || missing === "all" ? "original creation request" : "recover atomically"
      const host = createWorkflowVmHost({
        servedConversations: async () => new Set(),
        requestAddenda: async () => [],
        startMode: "operator_resume", sessionId: fixture.sessionId, reader: projectionReader, writer: asAsyncEventWriter(reopened),
        workflow: workflowIn(fixture.revision, FIXTURE_WORKFLOW_ID), definitionRevision: fixture.revision,
        queueStore, contextStore, conversationId: (attempt) => `host-${attempt?.attemptId}`,
        attemptRunner: createAttemptExecutor({
          unavailableToolReason: (term) => `${term} is off`,
          earlierCheckpoint: async () => null,
          resolvedAgents: fixture.bindings, skills: fixture.revision.skills, context: contextStore,
          recordInvocation: async () => {},
          worker: async (step, brief, _signal, conversationId) => {
            const { userPrompt: prompt } = await brief(EVERY_CAPABILITY)
            expect(reopened.read({ aggregateId }).some((fact) => fact.type === "attempt.started" && fact.payload.attemptId === step.id)).toBe(true)
            calls.push({ attemptId: step.id, prompt, conversationId })
            return { output: "context_overflow", handoffContent: null, durationMs: 1 }
          },
        }),
        emit: () => {},
      })
      const before = reopened.countByAggregate(aggregateId)
      expect(await host.preflight()).toBeNull()
      expect(calls).toHaveLength(0)
      expect(reopened.countByAggregate(aggregateId)).toBe(before)
      const outcome = await host.run()
      expect(calls, JSON.stringify(outcome)).toHaveLength(1)
      expect(calls[0]).toMatchObject({ attemptId: fixture.firstReadyAttempt.id, conversationId: `host-${fixture.firstReadyAttempt.id}` })
      expect(calls[0]!.prompt).toContain(request)
      if (missing !== "root" && missing !== "all") expect(calls[0]!.prompt).toContain("readable inherited evidence")
      expect(calls[0]!.prompt).not.toContain("renamed title")
      expect(await readWorkflowQueuedUserInputs(projectionReader, fixture.sessionId)).toEqual([])
      expect(reopened.read().filter(({ type }) => type.startsWith("chat."))).toEqual([])
      await host.dispose()
      queueStore.dispose()
      contextStore.dispose()
      reopened.close()
    })
  }

  it("retains the original read token through preparation races and sparse sequences", async () => {
    const fixture = await recoveryFixture("preparation-race")
    const aggregateId = `workflow:${fixture.sessionId}`
    const original = fixture.input()
    let prepared = 0
    const input = fixture.input({ prepare: async (basis, launchInput) => {
      prepared += 1
      if (prepared === 1) fixture.store.append({ aggregateId, sessionId: fixture.sessionId, timestamp: 20, type: "test.concurrent", version: 1, actor: "flywheel", payload: {} })
      return original.prepare(basis, launchInput)
    } })
    expect(await commitWorkflowRecovery(input)).toEqual({ kind: "conflict" })
    expect(fixture.store.read({ aggregateId }).map(({ type }) => type)).toEqual(["context.input.seeded", "test.concurrent"])
    const db = new Database(resolveEventStoreDbFile(fixture.projectRoot))
    db.run("DELETE FROM event WHERE aggregate_id = ? AND type = 'test.concurrent'", [aggregateId])
    db.run("UPDATE event SET seq = 40 WHERE aggregate_id = ? AND type = 'context.input.seeded'", [aggregateId])
    db.run("UPDATE event_sequence SET seq = 40 WHERE aggregate_id = ?", [aggregateId])
    db.close()
    expect((await commitWorkflowRecovery(input)).kind).toBe("committed")
    expect(fixture.store.read({ aggregateId }).find(({ type }) => type === "workflow.control.recovered")?.seq).toBe(41)
    expect(prepared).toBe(2)
    fixture.close()
  })

  it("repairs the old contextless v1 batch, but fences artifacts at each complete root for held and cold reads", async () => {
    // Pre-phase control contains only agents, not the repeat container.
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "implement",
      name: "Legacy recovery",
      phases: [{ phase: "work", name: "Work", brief: "Do the work.", writes: [] }],
    })
    const fixture = await recoveryFixture("old-recovery", true, workflow.id, { workflow, input: undefined })
    const aggregateId = `workflow:${fixture.sessionId}`
    const tree = ConversationTreeStorage.prepareCreateWithEntries({
      conversationId: "old-conversation", sessionId: fixture.sessionId, createdAt: new Date(1).toISOString(),
      entries: [{ kind: "message", id: "old-entry", parentId: null, timestamp: new Date(1).toISOString(), message: { kind: "assistant", content: [{ type: "text", text: "prior readable result" }] } }],
    })
    fixture.store.appendBatch(tree)
    fixture.store.append({
      ...buildContextAccumulatedFact({
        entryId: "old-artifact", agentName: "Old artifact", definitionId: "implement", workflowDefinitionId: "implement",
        recipientAttemptId: null, timestamp: 12, writes: [{ id: "old-artifact", lifetime: "durable", supersedes: [] }],
        handoff: { outcome: { state: "completed" }, summary: "old artifact survives legacy bootstrap", artifacts: { files_modified: ["old.ts"] } },
      }), aggregateId, sessionId: fixture.sessionId, timestamp: 13,
    })
    const addendum = buildContextInputAddedFact({
      key: "msg:parent:tool-1", source: { kind: "parent", name: "Chat" }, text: "Use SQLite.",
      readBy: { attemptId: "old-artifact", agentName: "Old artifact", conversationId: "old-conversation" },
    })
    fixture.store.append({ ...addendum, aggregateId, sessionId: fixture.sessionId, timestamp: 14 })
    const attempt = { ...fixture.firstReadyAttempt, conversationId: "old-conversation" }
    const legacyStart = fixture.store.aggregateSeq(aggregateId) + 1
    const control = { ...fixture.fallback, attempts: [attempt], status: "paused" as const, frontier: [], aggregateSeq: legacyStart + 2 }
    const current = buildWorkflowControlRecoveredFact({
      supersededThroughSeq: legacyStart - 1, degradationReasons: [{ kind: "missing_root" }], runtimeIdentity: { version: "old", buildId: "old" },
      identities: { workflow: { source: "recovered", value: "implement" }, step: { source: "recovered", value: attempt.logicalNodeId }, attempt: { source: "recovered", value: attempt.id }, conversation: { source: "recovered", value: "old-conversation" } },
      control,
    })
    fixture.store.appendBatch([
      // The version 1 producer also wrote the inert issue and seal lists.
      { ...current, version: 1, payload: { ...current.payload, control: { ...controlBeforePhases(current.payload.control), issues: [], seals: [] } } },
      buildAttemptRecoveredFact(attempt.id, "old-conversation"),
    ].map((fact) => ({ ...fact, aggregateId, sessionId: fixture.sessionId, timestamp: 10 })))
    const conversationBefore = fixture.store.read({ aggregateId: "conversation:old-conversation" })
    expect((await commitWorkflowRecovery(fixture.input())).kind).toBe("committed")
    expect(fixture.store.read({ aggregateId: "conversation:old-conversation" })).toEqual(conversationBefore)
    const projectionReader = asAsyncEventReadSurface(fixture.store)
    const context = createWorkflowContextProjection(projectionReader, fixture.sessionId)
    const queue = createWorkflowQueueProjection(projectionReader, fixture.sessionId)
    expect(contextFromProjection(await context.replay()).request?.original).toBe("recover atomically")
    expect(contextFromProjection(await context.replay()).artifacts.map(({ id }) => id)).toEqual(["old-artifact"])
    expect(contextFromProjection(await context.replay()).request?.addenda).toEqual([addendum.payload])
    const bootstrap = fixture.store.read({ aggregateId })
    const bootstrapContext = bootstrap.slice(bootstrap.findLastIndex(({ type }) => type === "workflow.control.recovered") + 1).filter(({ type }) => type.startsWith("context.") || type.startsWith("step_context."))
    expect(bootstrapContext.map(({ type }) => type)).toEqual(["context.input.seeded", "context.accumulated", "step_context.input.added"])
    expect(bootstrapContext.at(-1)?.timestamp).toBe(14)
    expect(queueFromProjection(await queue.replay())?.attempts.find(({ id }) => id === attempt.id)?.lastConversationId).toBe("old-conversation")
    const before = fixture.store.read()
    expect(await commitWorkflowRecovery(fixture.input({ prepare: async () => { throw new Error("Intact bootstrap must not admit again") } }))).toEqual({ kind: "already_recovered" })
    expect(fixture.store.read()).toEqual(before)

    const newest = fixture.store.read({ aggregateId }).findLast(({ type }) => type === "workflow.control.recovered")!
    const nextSeq = fixture.store.aggregateSeq(aggregateId) + 1
    const finalControl = { ...parseCommittedWorkflowControl(newest.payload.control), aggregateSeq: nextSeq + 4 }
    const nextRoot = buildWorkflowControlRecoveredFact({
      supersededThroughSeq: nextSeq - 1, degradationReasons: [{ kind: "missing_companion", family: "context.input.seeded" }],
      runtimeIdentity: { version: "new", buildId: "new" }, control: finalControl,
      identities: { workflow: { source: "recovered", value: "implement" }, step: { source: "recovered", value: attempt.logicalNodeId }, attempt: { source: "recovered", value: attempt.id }, conversation: { source: "recovered", value: "old-conversation" } },
    })
    const seed = fixture.prepared.workflowFacts.find(({ type }) => type === "context.input.seeded")!
    const finalBatch = [nextRoot, buildAttemptRecoveredFact(attempt.id, "old-conversation"), { ...seed, payload: { workflowDefinitionId: "implement", userRequest: "current epoch task" } }, ...queueFactsForState(null, flattenWorkflowView(finalControl, fixture.bindings))]
    const stored = fixture.store.appendBatch(finalBatch.map((fact) => ({ ...fact, aggregateId, sessionId: fixture.sessionId, timestamp: 30 })))
    for (const fact of stored) { context.apply(fact); queue.apply(fact) }
    const db = new Database(resolveEventStoreDbFile(fixture.projectRoot))
    db.run("UPDATE event SET payload = 'not-json' WHERE aggregate_id = ? AND seq < ? AND type IN ('context.input.seeded', 'queue.created')", [aggregateId, nextSeq])
    db.close()
    expect(contextFromProjection(await context.replay()).request?.original).toBe("current epoch task")
    expect(contextFromProjection(await context.replay()).artifacts).toEqual([])
    expect(contextFromProjection(await context.replay()).request?.addenda).toEqual([])
    expect((await commitWorkflowRecovery(fixture.input())).kind).toBe("already_recovered")
    fixture.close()
    const cold = createSqliteEventStore(resolveEventStoreDbFile(fixture.projectRoot))
    const coldReader = asAsyncEventReadSurface(cold)
    expect(contextFromProjection(await createWorkflowContextProjection(coldReader, fixture.sessionId).replay()).request?.original).toBe("current epoch task")
    expect(contextFromProjection(await createWorkflowContextProjection(coldReader, fixture.sessionId).replay()).artifacts).toEqual([])
    expect(queueFromProjection(await createWorkflowQueueProjection(coldReader, fixture.sessionId).replay())?.attempts[0]?.lastConversationId).toBe("old-conversation")
    cold.close()
  })

  it("refuses continuation as a replacement task when both request sources are unreadable", async () => {
    const fixture = await recoveryFixture("no-request", false)
    const result = await commitWorkflowRecovery(fixture.input({ prepare: async () => { throw new Error("No admission without a request") } }))
    expect(result).toMatchObject({ kind: "unrecoverable", message: expect.stringContaining("original workflow request") })
    expect(fixture.store.read()).toEqual([])
    fixture.close()
  })

  for (const state of ["pending", "running", "completed", "follow_up"] as const) {
    it(`retains every canonical ${state} field without choosing or rewriting attempts`, async () => {
      const fixture = await recoveryFixture(`canonical-${state}`)
      const aggregateId = `workflow:${fixture.sessionId}`
      const source = fixture.firstReadyAttempt
      const settled = state === "completed" || state === "follow_up"
      const control: CommittedWorkflowControl = {
        ...fixture.fallback,
        graph: {
          ...fixture.fallback.graph,
          nodes: fixture.fallback.graph.nodes.map((node) => ({
            ...node, state: { _tag: settled ? "completed" : state === "running" && node.id === source.logicalNodeId ? "running" : "ready" },
          })),
        },
        attempts: [
          { ...source, state: { _tag: settled ? "completed" : state === "running" ? "running" : "pending" }, conversationId: state === "running" ? "known-running" : "terminal-or-pending", resumeRevertCount: 2 },
          { ...source, id: "retained-sibling-a", sequence: 2, state: { _tag: settled ? "completed" : "pending" }, parentAttemptId: source.id },
          { ...source, id: "retained-sibling-b", sequence: 3, state: { _tag: settled ? "completed" : "pending" }, parentAttemptId: source.id },
        ],
        frontier: settled ? [] : [source.logicalNodeId],
        guardrails: { ...fixture.fallback.guardrails, insertsUsed: 3, attemptMutationsUsed: [{ attemptId: source.id, used: 2 }] },
        status: state === "running" ? "executing" : state === "pending" ? "ready" : state,
        followUp: state === "follow_up" ? { conversationId: "known-follow-up", requestSequence: 4, identity: { kind: "identified", inputID: "pending-follow-up" }, pendingInput: { text: "pending follow-up instruction" } } : null,
        aggregateSeq: 3,
      }
      fixture.store.append({ ...buildWorkflowControlInitializedFact({ ...control, aggregateSeq: 2 }), aggregateId, sessionId: fixture.sessionId, timestamp: 20 })
      const before = fixture.store.read()
      const result = await commitWorkflowRecovery(fixture.input({ prepare: async (basis) => {
        expect(basis).toEqual(control)
        return { control: fixture.fallback, resolvedAgents: fixture.bindings }
      } }))
      expect(result).toEqual({ kind: "committed" })
      const added = fixture.store.read().slice(before.length)
      expect(added.map(({ type }) => type)).toEqual(["workflow.control.recovered", "context.input.seeded", "queue.created", "queue.tree.changed"])
      expect(replayWorkflowControl(fixture.store.read({ aggregateId }))).toEqual({ ...control, aggregateSeq: 6 })
      const { tree, ...queue } = flattenWorkflowView(control, fixture.bindings)
      expect(added[2]!.payload.rows).toEqual(queue)
      expect(added[3]!.payload.tree).toEqual(tree)
      expect(added[0]!.payload.identities).toEqual({
        workflow: { source: "recovered", value: control.definitionIdentity.workflowDefinitionId },
        step: state === "running" ? { source: "recovered", value: source.logicalNodeId } : null,
        attempt: state === "running" ? { source: "recovered", value: source.id } : null,
        conversation: state === "running" || state === "follow_up" ? { source: "recovered", value: state === "running" ? "known-running" : "known-follow-up" } : null,
      })
      fixture.close()
    })
  }

  for (const damage of ["prior-context", "unknown-fact", "semantic-suffix", "incomplete-suffix", "newer-root", "corrupt-root", "corrupt-seed", "corrupt-queue", "invalid-queue", "invalid-seed", "duplicate-seed", "duplicate-queue"] as const) {
    it(`refuses ${damage} without admission or appends`, async () => {
      const fixture = await recoveryFixture(`refuse-${damage}`)
      const aggregateId = `workflow:${fixture.sessionId}`
      const append = (fact: Pick<EventStoreAppend, "type" | "version" | "actor" | "payload">) =>
        fixture.store.append({ ...fact, aggregateId, sessionId: fixture.sessionId, timestamp: 20 })
      if (damage === "prior-context") append(buildContextAccumulatedFact({
        entryId: "already-ran", agentName: "Prior execution", definitionId: "implement", workflowDefinitionId: "implement",
        recipientAttemptId: null, writes: [], timestamp: 19, handoff: { summary: "completed before damage" },
      }))
      if (damage === "unknown-fact") append({ type: "future.execution", version: 1, actor: "flywheel", payload: {} })
      if (["semantic-suffix", "incomplete-suffix", "newer-root", "corrupt-root"].includes(damage)) {
        append(buildWorkflowControlInitializedFact({ ...fixture.fallback, aggregateSeq: 2 }))
        if (damage === "semantic-suffix") append({ type: "workflow.control.committed", version: 1, actor: "flywheel", payload: {} })
        if (damage === "incomplete-suffix") append({ type: "attempt.started", version: 1, actor: "flywheel", payload: { attemptId: fixture.firstReadyAttempt.id, conversationId: "interrupted" } })
        if (damage === "newer-root") append({ ...buildWorkflowControlInitializedFact({ ...fixture.fallback, aggregateSeq: 3 }), version: 999 })
      }
      if (damage === "duplicate-seed" || damage === "invalid-seed") {
        const seed = fixture.prepared.workflowFacts.find(({ type }) => type === "context.input.seeded")!
        append(damage === "invalid-seed" ? { ...seed, payload: { workflowDefinitionId: "implement", userRequest: 42 } } : seed)
      }
      if (damage === "duplicate-queue") {
        for (let index = 0; index < 2; index++) append(queueFactsForState(null, flattenWorkflowView(fixture.fallback, fixture.bindings))[0]!)
      }
      if (damage === "corrupt-queue" || damage === "invalid-queue") append({ type: "queue.created", version: 9, actor: "flywheel", payload: {} })
      if (damage === "corrupt-root" || damage === "corrupt-seed" || damage === "corrupt-queue") {
        const db = new Database(resolveEventStoreDbFile(fixture.projectRoot))
        db.run("UPDATE event SET payload = 'not-json' WHERE aggregate_id = ? AND type = ?", [aggregateId, damage === "corrupt-root" ? "workflow.control.initialized" : damage === "corrupt-seed" ? "context.input.seeded" : "queue.created"])
        db.close()
      }
      const before = fixture.store.readTolerant()
      expect(await commitWorkflowRecovery(fixture.input({ prepare: async () => { throw new Error("Unproved history must not compile") } }))).toMatchObject({ kind: "unrecoverable" })
      expect(fixture.store.readTolerant()).toEqual(before)
      expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).toEqual([])
      fixture.close()
    })
  }

  // Both retained launch shapes cross the same historical boundary.
  for (const launch of ["rows only", "rows and plan"] as const) {
    it(`recovers a missing-root launch whose queue holds ${launch}`, async () => {
      const fixture = await recoveryFixture(`plan-${launch.replaceAll(" ", "-")}`, true, FIXTURE_WORKFLOW_ID)
      const facts = queueFactsForState(null, flattenWorkflowView(fixture.fallback, fixture.bindings))
      expect(facts.map(({ type }) => type)).toEqual(["queue.created", "queue.tree.changed"])
      const launchFacts = [
        facts[0]!,
        ...(launch === "rows only" ? [] : [{ type: "queue.plan.changed", version: 2, actor: "flywheel", payload: { plan: { conditionalStepIds: [], steps: [] } } }] as const),
      ]
      fixture.store.appendBatch(launchFacts.map((fact) => ({ ...fact, aggregateId: `workflow:${fixture.sessionId}`, sessionId: fixture.sessionId, timestamp: 20 })))

      expect(await commitWorkflowRecovery(fixture.input())).toMatchObject({ kind: "committed" })
      expect(fixture.store.read().slice(-2).map(({ type }) => type)).toEqual(["queue.created", "queue.tree.changed"])
      fixture.close()
    })
  }

  it("compiles a missing-root launch again with the structured input that its seed recorded, and keeps the seed version", async () => {
    const input = { goal: "Ship.", items: items("a", "b") }
    const fixture = await recoveryFixture("launch-input", true, inputMapWorkflow.id, { workflow: inputMapWorkflow, input })
    expect(fixture.fallback.graph.joins).toEqual([{ kind: "collect_all", nodeId: INPUT_GROUP, requiredNodeIds: [inputBranch(1), inputBranch(2)] }])
    fixture.store.appendBatch(queueFactsForState(null, flattenWorkflowView(fixture.fallback, fixture.bindings)).map((fact) => ({ ...fact, aggregateId: `workflow:${fixture.sessionId}`, sessionId: fixture.sessionId, timestamp: 20 })))
    const received: unknown[] = []
    const original = fixture.input()

    const result = await commitWorkflowRecovery(fixture.input({ prepare: async (basis, launchInput) => {
      received.push(launchInput)
      return original.prepare(basis, launchInput)
    } }))

    expect(result).toMatchObject({ kind: "committed" })
    expect(received).toEqual([input])
    const recovered = fixture.store.read().filter(({ type }) => type === "workflow.control.recovered")
    expect(recovered).toHaveLength(1)
    expect(parseCommittedWorkflowControl(recovered[0]!.payload.control).graph).toEqual(fixture.fallback.graph)
    expect(fixture.store.read().filter(({ type }) => type === "context.input.seeded").map(({ version, payload }) => ({ version, input: payload.input }))).toEqual([{ version: 2, input }, { version: 2, input }])
    fixture.close()
  })

  for (const change of ["status", "description", "writes", "retry-count"] as const) {
    it(`rejects a missing-root queue with a changed ${change}, even when attempt identities match`, async () => {
      const fixture = await recoveryFixture(`queue-mismatch-${change}`)
      const queue = flattenWorkflowView(fixture.fallback, fixture.bindings)
      if (change === "status") queue.status = "completed"
      else queue.attempts = queue.attempts.map((step, index) => index === 0 ? {
        ...step,
        ...(change === "description" ? { description: "changed description" } : change === "writes" ? { writes: ["unproved-artifact"] } : { resumeRevertCount: 2 }),
      } : step)
      fixture.store.appendBatch(queueFactsForState(null, queue).map((fact) => ({ ...fact, aggregateId: `workflow:${fixture.sessionId}`, sessionId: fixture.sessionId, timestamp: 20 })))
      const before = fixture.store.read()
      expect(await commitWorkflowRecovery(fixture.input())).toMatchObject({ kind: "unrecoverable", message: expect.stringContaining("launch queue") })
      expect(fixture.store.read()).toEqual(before)
      expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).toEqual([])
      fixture.close()
    })
  }
})

/** A launch prepared and seeded but never published. `launch` adds a
 *  workflow to the captured revision and launches it with structured input. */
async function recoveryFixture(
  name: string,
  seedInput = true,
  workflowDefinitionId: string = FIXTURE_WORKFLOW_ID,
  launch?: { readonly workflow: WorkflowDefinition; readonly input: unknown },
) {
  const projectRoot = mkdtempSync(join(tmpdir(), `flywheel-vm-recovery-${name}-`))
  roots.push(projectRoot)
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  const writer = asAsyncEventWriter(store)
  const sessionId = `workflow-${name}`
  const deps = makeWorkflowDeps()
  const captured = deps.definitions.captureRevision()
  const definitionRevision = captured
  const prepared = await prepareWorkflowLaunch({
    workflow: launch?.workflow ?? workflowIn(definitionRevision, workflowDefinitionId),
    description: "recover atomically",
    deps,
    authProfileId: "default",
    projectRoot,
    definitionRevision,
    ...(launch === undefined ? {} : { input: launch.input }),
  })
  const initialized = prepared.workflowFacts.find(({ type }) => type === "workflow.control.initialized")
  if (initialized?.type !== "workflow.control.initialized" || initialized.version !== 12) throw new Error("Missing current initialized control")
  const fallback = initialized.payload.control
  const seed = prepared.workflowFacts.find(({ type }) => type === "context.input.seeded")!
  if (seedInput) await writer.append({ ...seed, aggregateId: `workflow:${sessionId}`, sessionId, timestamp: 10 })
  const revision = definitionRevision
  const { resolvedAgents: bindings } = prepareWorkflowAgents({ workflow: launch?.workflow ?? workflowIn(revision, workflowDefinitionId), deps, definitionRevision: revision }, fallback)
  return {
    projectRoot,
    sessionId,
    store,
    revision,
    bindings,
    fallback,
    prepared,
    /** The first attempt that the launch compiled ready. A workflow that
     *  opens a container first has none until its preparation runs. */
    get firstReadyAttempt() {
      const attempt = fallback.attempts.find(({ state, logicalNodeId }) => state._tag === "pending" && fallback.graph.nodes.some(({ id, state: nodeState }) => id === logicalNodeId && nodeState._tag === "ready"))
      if (!attempt) throw new Error("Fixture workflow has no ready pending attempt")
      return attempt
    },
    input: (overrides: Partial<WorkflowRecoveryCommitInput> = {}): WorkflowRecoveryCommitInput => ({
      sessionId,
      timestamp: new Date().toISOString(),
      reader: asAsyncEventReadSurface(store),
      writer,
      runtimeIdentity: async () => ({ version: "0.0.0", buildId: "test" }),
      prepare: async (basis, launchInput) => prepareWorkflowAgents({ workflow: launch?.workflow ?? workflowIn(definitionRevision, workflowDefinitionId), deps, definitionRevision }, basis, launchInput),
      ...overrides,
    }),
    close: () => store.close(),
  }
}
