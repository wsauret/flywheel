import { describe, expect, spyOn, test } from "bun:test"
import { Schema } from "effect"
import { FIXTURE_EXECUTION_CWD, temporaryDirectories } from "../../../helpers/directories.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore, type FactQuery, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { publishWorkerAttempt } from "../workflow-host/_workflow-host-fixtures.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createWorkflowDetailReader } from "../../../../src/orchestration/modules/workflows/detail.js"
import { runtimeQueryResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { buildDefinitionDriftRejectedFact } from "../../../../src/workflows/definition-provenance-fact-writers.js"
import { workflowControlInitializedEvent, workflowLaunchEvents } from "../../workflows/vm/_workflow-control-fixtures.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createWorkflowDurationReader } from "../../../../src/orchestration/modules/workflows/duration.js"
import { workflowRunWriter } from "../../../../src/orchestration/module-catalog.js"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { readWorkflowRecovery } from "../../../../src/workflows/vm/recovery-fold.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { canonicalScenarios } from "../../workflows/vm/golden/_canonical-scenarios.js"
import { runCanonicalScenario } from "../../workflows/vm/golden/_golden-harness.js"
import * as transition from "../../../../src/workflows/vm/transition.js"
import { buildWorkflowControlRecoveredFact } from "../../../../src/workflows/vm/session-facts.js"
import { Database } from "bun:sqlite"
import { readEpisodeEvidenceEnd } from "../../../../src/orchestration/session-store/duration.js"
import { readWorkflowMemberEvidence } from "../../../../src/orchestration/workflow-host/member-totals.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"

const tmp = temporaryDirectories()
function register(store: EventStore) {
  store.append({
    aggregateId: "workflow:child-flow", sessionId: "child-flow", timestamp: 0, actor: "flywheel",
    type: "workflow.run.registered", version: 1,
    payload: { settings: {
      workflowDefinitionId: "fixture-workflow", label: "Child workflow",
      createdAt: "2026-10-17T00:00:00.000Z", lastUpdated: "2026-10-17T00:00:00.000Z",
      executionCwd: FIXTURE_EXECUTION_CWD, roleAssignments: { defaults: {}, overrides: {} },
    }, request: "Do the work", launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" } },
  })
  const input = { description: "Do the work" }
  const evidence = contentEvidence(JSON.stringify(input))
  store.append({
    aggregateId: "session:parent", sessionId: "parent", type: "tool.input.completed", version: 1, actor: "agent", timestamp: 1,
    payload: { toolUseId: "launch", toolName: "workflow", input, inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request" },
  })
}
function detailReader(store: EventStore, wholeReads?: FactQuery[]) {
  const reader = asAsyncEventReadSurface(store)
  return createWorkflowDetailReader({
    projectRoot: FIXTURE_EXECUTION_CWD, manager: { read: async () => null },
    reader: wholeReads ? { ...reader, readSlice: (query, tolerant) => {
      if (query.aggregateId === "workflow:child-flow" && query.types === undefined) wholeReads.push(query)
      return reader.readSlice(query, tolerant)
    } } : reader,
  })
}
function state(store: EventStore, status: "idle" | "running" | "paused" | "completed" | "failed", version = 10) {
  store.append({ aggregateId: "workflow:child-flow", type: "queue.created", version, timestamp: 0, actor: "flywheel", sessionId: "child-flow", payload: { rows: { attempts: [], cursor: 0, status, mutationLog: [] } } })
}

describe("workflow aggregate detail controls", () => {
  test("counts old session duration once and bounds a crash-cut interval by member evidence, not recovery downtime", async () => {
    const root = tmp("workflow-duration-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    const clock = spyOn(Date, "now").mockReturnValue(0)
    try {
      const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
      const workflowId = await publishTestWorkflow(manager, { id: "duration" })
      const reader = asAsyncEventReadSurface(store)
      store.append({ aggregateId: "session:old-workflow", sessionId: "old-workflow", type: "session.duration.recorded", version: 1, actor: "flywheel", timestamp: 0, payload: { accumulatedActiveMs: 500 } })
      clock.mockReturnValue(1000)
      const memberId = await startTestWorkflowMember(manager, store, workflowId)
      await workflowRunWriter(reader, manager.commitWorkflow).update(workflowId, (run) => ({ ...run, historicalResidualAggregateId: "session:old-workflow" }))
      store.append({ aggregateId: `session:${memberId}`, sessionId: memberId, type: "model.requested", version: 1, actor: "agent", timestamp: 2000, payload: {} })
      const read = createWorkflowDurationReader(reader)
      expect(await read(workflowId, true)).toEqual({ durationMs: 500, streamingStartedAt: 1000, activeIntervals: [] })
      expect(await read(workflowId, false)).toEqual({ durationMs: 1500, streamingStartedAt: null, activeIntervals: [{ start: 1000, end: 2000 }] })
      const control = replayWorkflowControl(store.read({ aggregateId: `workflow:${workflowId}` }))
      const recovered = buildWorkflowControlRecoveredFact({
        supersededThroughSeq: store.aggregateSeq(`workflow:${workflowId}`),
        degradationReasons: [{ kind: "invalid_suffix", seq: store.aggregateSeq(`workflow:${workflowId}`) }],
        runtimeIdentity: { version: "test", buildId: "test" },
        identities: { workflow: { source: "recovered", value: workflowId }, step: null, attempt: null, conversation: null },
        control: { ...control, status: "paused", aggregateSeq: store.aggregateSeq(`workflow:${workflowId}`) + 1 },
      })
      store.append({ aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp: 100_000, ...recovered })
      expect(await read(workflowId, false)).toEqual({ durationMs: 1500, streamingStartedAt: null, activeIntervals: [{ start: 1000, end: 2000 }] })
    } finally { clock.mockRestore(); store.close() }
  })
  test("keeps the converted era's intervals for its phases while the run's time counts the old session's time", async () => {
    const scenario = canonicalScenarios.find(({ id }) => id === "linear-three-phase-completion")
    if (!scenario) throw new Error("The scenario is missing")
    const { events: history } = await runCanonicalScenario(scenario)
    // A second between facts, so each interval of the old era has a length.
    const rows: StoredFact[] = history.map((fact, index) => ({ ...fact, timestamp: (index + 1) * 1000 }))
    const reader = asAsyncEventReadSurface(inMemoryEventReader(rows))
    const before = await createWorkflowDurationReader(reader)(scenario.id, false)
    expect(before.activeIntervals.length).toBeGreaterThan(0)
    // The conversion registers the run after its control history and names
    // the old session, whose recorded time the run's time counts.
    const last = rows.at(-1)!
    rows.push(
      { id: "registered", aggregateId: `workflow:${scenario.id}`, sessionId: scenario.id, type: "workflow.run.registered", version: 1, actor: "flywheel", timestamp: last.timestamp + 3_600_000, seq: last.seq + 1, position: last.position + 1, payload: {
        settings: { workflowDefinitionId: "fixture-workflow", label: "Converted", createdAt: "2026-10-17T00:00:00.000Z", lastUpdated: "2026-10-17T00:00:00.000Z", roleAssignments: { defaults: {}, overrides: {} }, historicalResidualAggregateId: "session:old-run" },
        request: "Do the work", launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" },
      } },
      { id: "old-duration", aggregateId: "session:old-run", sessionId: "old-run", type: "session.duration.recorded", version: 1, actor: "flywheel", timestamp: last.timestamp, seq: 0, position: last.position + 2, payload: { accumulatedActiveMs: 7_000 } },
    )
    expect(await createWorkflowDurationReader(reader)(scenario.id, false)).toEqual({ durationMs: 7_000, streamingStartedAt: null, activeIntervals: before.activeIntervals })
  })
  test("closes the run's interval at each whole-run cut, and reads its closed intervals again only when one closes", async () => {
    /** The run's time after `cuts` interrupts that each held the run for an
     *  hour, and the state requests and interval identity of a read that
     *  follows a read with nothing moved. */
    const timed = async (cuts: number) => {
      const root = tmp("workflow-duration-cuts-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(root))
      const clock = spyOn(Date, "now").mockReturnValue(1000)
      try {
        const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
        const workflowId = await publishTestWorkflow(manager, { id: "cuts" })
        await startTestWorkflowMember(manager, store, workflowId)
        const cut = (timestamp: number, recorded: { readonly by: "person"; readonly timestamp: number } | null) =>
          store.append({ aggregateId: `workflow:${workflowId}`, sessionId: workflowId, type: "workflow.run.cut.updated", version: 1, actor: "flywheel", timestamp, payload: { cut: recorded } })
        let opened = 1000
        for (let index = 0; index < cuts; index++) {
          cut(opened + 1000, { by: "person", timestamp: opened + 1000 })
          opened += 1000 + 3_600_000
          cut(opened, null)
        }
        const counter = countStateRequests(asAsyncEventReadSurface(store))
        const read = createWorkflowDurationReader(counter.reader)
        const first = await read(workflowId, true)
        counter.take()
        const second = await read(workflowId, true)
        return { first, requests: counter.take().length, same: second.activeIntervals === first.activeIntervals, opened }
      } finally { clock.mockRestore(); store.close() }
    }
    const few = await timed(2)
    const many = await timed(20)
    // Each interrupt adds its second of work and none of its hour.
    expect(few.first).toMatchObject({ durationMs: 2000, streamingStartedAt: few.opened })
    expect(many.first).toMatchObject({ durationMs: 20_000, streamingStartedAt: many.opened })
    expect(many.first.activeIntervals).toHaveLength(20)
    expect(many.first.activeIntervals[1]).toEqual({ start: 1000 + 1000 + 3_600_000, end: 1000 + 1000 + 3_600_000 + 1000 })
    expect({ requests: many.requests, same: many.same }).toEqual({ requests: few.requests, same: true })
  })
  test("measures an open interval to the newest member evidence while the workflow head stays", async () => {
    const root = tmp("workflow-duration-evidence-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    const clock = spyOn(Date, "now").mockReturnValue(1000)
    try {
      const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
      const workflowId = await publishTestWorkflow(manager, { id: "evidence" })
      const memberId = await startTestWorkflowMember(manager, store, workflowId)
      const reader = asAsyncEventReadSurface(store)
      const requested = (timestamp: number) => store.append({ aggregateId: `session:${memberId}`, sessionId: memberId, type: "model.requested", version: 1, actor: "agent", timestamp, payload: {} })
      requested(2000)
      const read = createWorkflowDurationReader(reader)
      expect((await read(workflowId, false)).durationMs).toBe(1000)
      expect((await read(workflowId, true)).streamingStartedAt).toBe(1000)
      // The only agent asks the person a question and then resumes: its
      // request commits nothing to the workflow.
      const head = store.aggregateSeq(`workflow:${workflowId}`)
      requested(6000)
      const measured = await read(workflowId, false)
      expect(store.aggregateSeq(`workflow:${workflowId}`)).toBe(head)
      expect(measured).toEqual(await createWorkflowDurationReader(reader)(workflowId, false))
      expect(measured.durationMs).toBe(5000)
    } finally { clock.mockRestore(); store.close() }
  })
  test.each([
    ["cold", "corrupt"], ["warm", "corrupt"],
    ["cold", "timestamp"], ["warm", "timestamp"],
  ] as const)("%s duration matches fresh member evidence with %s ordering", async (temperature, scenario) => {
    const root = tmp("workflow-duration-latest-")
    const dbFile = resolveEventStoreDbFile(root)
    const store = createSqliteEventStore(dbFile)
    const clock = spyOn(Date, "now").mockReturnValue(1000)
    try {
      const reader = asAsyncEventReadSurface(store)
      const workflowId = "latest"
      await publishWorkerAttempt({ projectRoot: root, reader, writer: asAsyncEventWriter(store), workflowId, attemptId: "first", conversationId: "first-conversation", siblings: [{ attemptId: "second", conversationId: "second-conversation" }] })
      const members = await workflowMembershipReader(reader).list(workflowId)
      const first = members[0]!.sessionId
      const second = members[1]!.sessionId
      const requested = (sessionId: string, timestamp: number) => store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "model.requested", version: 1, actor: "agent", timestamp, payload: {} })
      requested(first, scenario === "corrupt" ? 2000 : 5000)
      const read = createWorkflowDurationReader(reader)
      const startedAt = (await read(workflowId, true)).streamingStartedAt!
      if (temperature === "warm") await read(workflowId, false)
      if (scenario === "corrupt") {
        requested(first, 3000)
        const db = new Database(dbFile)
        try { db.run("update event set payload = ? where session_id = ? and timestamp = ?", ["{", first, 3000]) } finally { db.close() }
      } else {
        requested(second, 4000)
      }
      const expected = await readEpisodeEvidenceEnd(reader, { sessionIds: [first, second], afterPosition: 0 })
      expect(expected).toBe(scenario === "corrupt" ? undefined : 5000)
      expect((await readWorkflowMemberEvidence(reader, workflowId))?.timestamp).toBe(expected)
      expect((await read(workflowId, false)).durationMs).toBe(Math.max(0, (expected ?? startedAt) - startedAt))
      if (scenario === "timestamp") {
        requested(first, 3000)
        const decreased = await readEpisodeEvidenceEnd(reader, { sessionIds: [first, second], afterPosition: 0 })
        expect(decreased).toBe(4000)
        expect((await read(workflowId, false)).durationMs).toBe(decreased! - startedAt)
        expect((await readWorkflowMemberEvidence(reader, workflowId))?.timestamp).toBe(decreased)
      }
    } finally { clock.mockRestore(); store.close() }
  })
  test("measures an open interval across workflow commits with member evidence reads independent of the member count", async () => {
    const evidenceReads = async (memberCount: number) => {
      const root = tmp("workflow-duration-members-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(root))
      try {
        const base = asAsyncEventReadSurface(store)
        const bindings = Array.from({ length: memberCount }, (_, index) => ({ attemptId: `a${index}`, conversationId: `conv-${index}` }))
        const workflowId = "members"
        const { manager } = await publishWorkerAttempt({ projectRoot: root, reader: base, writer: asAsyncEventWriter(store), workflowId, ...bindings[0]!, siblings: bindings.slice(1) })
        let reads = 0
        const evidence = (query: FactQuery) => { if (query.types?.includes("model.requested")) reads += 1 }
        const reader: typeof base = {
          ...base,
          readSlice: (query, tolerant) => { evidence(query); return base.readSlice(query, tolerant) },
          readPage: (query, upper, after, tolerant, content) => { evidence(query); return base.readPage(query, upper, after, tolerant, content) },
        }
        const read = createWorkflowDurationReader(reader)
        await read(workflowId, false)
        reads = 0
        for (const label of ["one", "two", "three"]) {
          await workflowRunWriter(base, manager.commitWorkflow).update(workflowId, (run) => ({ ...run, label }))
          await read(workflowId, false)
        }
        return reads
      } finally { store.close() }
    }
    expect(await evidenceReads(12)).toBe(await evidenceReads(3))
  })
  test("reads and transitions the workflow only through the shared recovery owner while the aggregate grows", async () => {
    const root = tmp("workflow-duration-growth-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    const transitions = spyOn(transition, "transitionDecodedWorkflow")
    try {
      const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
      const workflowId = await publishTestWorkflow(manager, { id: "growth" })
      const base = asAsyncEventReadSurface(store)
      let folded = 0
      const reader: typeof base = { ...base, readSlice: async (query, tolerant) => {
        const slice = await base.readSlice(query, tolerant)
        if (query.aggregateId === `workflow:${workflowId}` && query.types === undefined) folded += slice.facts.length
        return slice
      } }
      const read = createWorkflowDurationReader(reader)
      // Detail reads recovery and then duration on each change; duration
      // adds no read and no transition to what recovery already paid.
      const durationCost = async () => {
        await readWorkflowRecovery(reader, workflowId)
        const before = { folded, transitions: transitions.mock.calls.length }
        const measured = await read(workflowId, true)
        expect({ folded, transitions: transitions.mock.calls.length }).toEqual(before)
        return measured
      }
      await durationCost()
      await startTestWorkflowMember(manager, store, workflowId)
      expect((await durationCost()).streamingStartedAt).not.toBeNull()
      for (const label of ["one", "two", "three"]) {
        await workflowRunWriter(base, manager.commitWorkflow).update(workflowId, (run) => ({ ...run, label }))
        await durationCost()
      }
    } finally { transitions.mockRestore(); store.close() }
  })
  test("runs each commit's control transition once when recovery and duration consume successive commits", async () => {
    const scenario = canonicalScenarios.find(({ id }) => id === "linear-three-phase-completion")
    if (!scenario) throw new Error("The scenario is missing")
    const { events: history, batchEnds } = await runCanonicalScenario(scenario)
    const rows: StoredFact[] = []
    const reader = asAsyncEventReadSurface(inMemoryEventReader(rows))
    const read = createWorkflowDurationReader(reader)
    const firstProposal = history.findIndex(({ type }) => type === "workflow.control.committed")
    const [seedEnd = 0, ...laterEnds] = batchEnds.filter((end) => end > firstProposal)
    rows.push(...history.slice(0, seedEnd))
    await readWorkflowRecovery(reader, scenario.id)
    await read(scenario.id, false)
    const transitions = spyOn(transition, "transitionDecodedWorkflow")
    try {
      let commits = 0
      for (const end of laterEnds) {
        commits += history.slice(rows.length, end).filter(({ type }) => type === "workflow.control.committed").length
        rows.push(...history.slice(rows.length, end))
        await readWorkflowRecovery(reader, scenario.id)
        await read(scenario.id, false)
      }
      expect(commits).toBeGreaterThan(1)
      expect(transitions.mock.calls.length).toBe(commits)
    } finally { transitions.mockRestore() }
  })
  test.each(["idle", "running", "paused", "completed", "failed"] as const)("steering follows unfinished %s work without a session row", async (status) => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("workflow-detail-")))
    try {
      store.append(workflowControlInitializedEvent("child-flow", 0))
      state(store, status)
      register(store)
      const before = store.read({ aggregateId: "workflow:child-flow" })
      const detail = await detailReader(store)("child-flow")
      expect(detail).toMatchObject({ workflowId: "child-flow", title: "Child workflow", launchedFrom: { parentSessionId: "parent", toolUseId: "launch" } })
      expect(detail?.admittedActions.includes("workflow.send")).toBe(status !== "completed" && status !== "failed")
      expect(store.read({ aggregateId: "session:child-flow" })).toEqual([])
      expect(store.read({ aggregateId: "workflow:child-flow" })).toEqual(before)
    } finally { store.close() }
  })

  test("repeated held detail reads read the workflow again only when it grows", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("workflow-held-detail-")))
    const reads: FactQuery[] = []
    try {
      for (const event of workflowLaunchEvents("child-flow", 0)) store.append(event)
      register(store)
      const read = detailReader(store, reads)
      const first = await read("child-flow")
      const seeded = reads.length
      expect(seeded).toBeGreaterThan(0)
      expect((await read("child-flow"))?.admittedActions).toEqual(first?.admittedActions)
      expect(reads).toHaveLength(seeded)
      state(store, "completed")
      const finished = await read("child-flow")
      expect(finished?.admittedActions).not.toContain("workflow.send")
    } finally { store.close() }
  })

  test("a held detail read after one more workflow fact reads only that fact, however long the history", async () => {
    const factsReadAfterGrowth = async (updates: number) => {
      const root = tmp("workflow-detail-growth-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(root))
      try {
        const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
        const workflowId = await publishTestWorkflow(manager, { id: "growth" })
        await startTestWorkflowMember(manager, store, workflowId)
        const reader = asAsyncEventReadSurface(store)
        const runs = workflowRunWriter(reader, manager.commitWorkflow)
        for (let index = 0; index < updates; index++) await runs.update(workflowId, (run) => ({ ...run, label: `label ${index}` }))
        let read = 0
        const aggregateId = `workflow:${workflowId}`
        const detail = createWorkflowDetailReader({
          projectRoot: root, manager: { read: async () => null },
          reader: {
            ...reader,
            readSlice: async (query, tolerant) => {
              const slice = await reader.readSlice(query, tolerant)
              if (query.aggregateId === aggregateId) read += slice.facts.length
              return slice
            },
            readPage: async (query, upper, after, tolerant, content) => {
              const page = await reader.readPage(query, upper, after, tolerant, content)
              if (query.aggregateId === aggregateId) read += page.facts.length
              return page
            },
          },
        })
        await detail(workflowId)
        await runs.update(workflowId, (run) => ({ ...run, label: "grown" }))
        read = 0
        expect((await detail(workflowId))?.title).toBe("grown")
        return read
      } finally { store.close() }
    }
    expect(await factsReadAfterGrowth(40)).toBe(await factsReadAfterGrowth(2))
  })

  test("definition drift preserves Resume and publishes only safe component identities", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmp("workflow-drift-detail-")))
    try {
      for (const event of workflowLaunchEvents("child-flow", 0)) store.append(event)
      register(store)
      const read = detailReader(store)
      const first = await read("child-flow")
      expect(first?.admittedActions).toContain("workflow.resume")
      const rejection = buildDefinitionDriftRejectedFact({ workflowId: "fixture-workflow", latestSeq: 2, changes: [
        { component: "graph", definitionId: "fixture-workflow", recorded: "a".repeat(64), current: "b".repeat(64) },
        { component: "skill", skillId: "fixture-step", recorded: "c".repeat(64), current: "null" },
      ] })
      store.append({ aggregateId: "workflow:child-flow", sessionId: "child-flow", timestamp: 1, ...rejection })
      const rejected = await read("child-flow")
      expect(rejected?.admittedActions).toEqual(first?.admittedActions)
      expect(rejected?.definitionDrift).toEqual({ workflowDefinitionId: "fixture-workflow", changes: [{ component: "graph" }, { component: "skill", id: "fixture-step" }] })
      expect(Schema.decodeUnknownSync(runtimeQueryResultSchema("workflowDetail"))({ snapshotPosition: 0, view: rejected })).toEqual({ snapshotPosition: 0, view: rejected })
    } finally { store.close() }
  })

  test("unreadable saved progress offers Restart from its recorded request, never Resume", async () => {
    const dbFile = resolveEventStoreDbFile(tmp("workflow-restart-detail-"))
    const store = createSqliteEventStore(dbFile)
    try {
      store.append({ aggregateId: "workflow:child-flow", sessionId: "child-flow", type: "context.input.seeded", version: 1, timestamp: 0, actor: "flywheel", payload: { workflowDefinitionId: "fixture-workflow", userRequest: "Do the work" } })
      store.append(workflowControlInitializedEvent("child-flow", 0))
      state(store, "paused", 99)
      register(store)
      const detail = await detailReader(store)("child-flow")
      expect(detail?.admittedActions).toContain("workflow.restart")
      expect(detail?.admittedActions).not.toContain("workflow.resume")
      expect(detail?.readability).toBe("unavailable")
      const db = new Database(dbFile)
      try { db.run("update event set payload = ? where type = ?", ["{", "queue.created"]) } finally { db.close() }
      const damaged = await detailReader(store)("child-flow")
      expect(damaged?.readability).toBe("unavailable")
      expect(damaged?.admittedActions).toContain("workflow.restart")
      expect(damaged?.admittedActions).toContain("workflow.stop")
    } finally { store.close() }
  })

  test.each([2, 40])("damaged detail recovery advances after renames with %i retained settings changes", async (updates) => {
    const root = tmp("workflow-damaged-detail-growth-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    try {
      store.append(workflowControlInitializedEvent("child-flow", 0))
      state(store, "paused", 99)
      const reader = asAsyncEventReadSurface(store)
      const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
      await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
      register(store)
      const runs = workflowRunWriter(reader, manager.commitWorkflow)
      for (let index = 0; index < updates; index++) await runs.update("child-flow", run => ({ ...run, label: `label ${index}` }))
      const counter = countStateRequests(reader)
      const read = createWorkflowDetailReader({ projectRoot: root, manager: { read: async () => null }, reader: counter.reader })
      expect((await read("child-flow"))?.admittedActions).toContain("workflow.restart")
      counter.take()
      for (const label of ["renamed", "renamed again"]) {
        await runs.update("child-flow", run => ({ ...run, label }))
        const detail = await read("child-flow")
        expect(detail?.title).toBe(label)
        expect(detail?.admittedActions).toContain("workflow.restart")
        const requests = counter.take()
        expect(factsRead(requests)).toBeLessThanOrEqual(8)
        expect(requests.filter(({ method, query }) => method === "readSlice" && query?.types === undefined && query?.afterPosition === undefined)).toHaveLength(0)
      }
      // New unreadable control invalidates the previously proved prefix.
      store.append({ aggregateId: "workflow:child-flow", sessionId: "child-flow", type: "workflow.control.committed", version: 99, timestamp: 0, actor: "flywheel", payload: {} })
      expect((await read("child-flow"))?.admittedActions).not.toContain("workflow.restart")
    } finally { store.close() }
  })
})
