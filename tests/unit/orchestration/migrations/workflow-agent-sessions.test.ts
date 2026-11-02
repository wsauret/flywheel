import { expect, test } from "bun:test"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { legacyWorkflowFixture } from "../../../helpers/workflow-agent-legacy-fixtures.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { recoverSessionMetadata } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js"
import { createWorkflowRunReader } from "../../../../src/orchestration/modules/workflows/run-record.js"
import { convertWorkflowAgentSessions, workflowAgentSessionsNeedConversion } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions.js"
import { Database } from "bun:sqlite"
import { recoverWorkflowControl, workflowRecoveryBasis } from "../../../../src/workflows/vm/recovery.js"
import { recoverProject } from "../../../helpers/project-recovery.js"
import { appendOutputSeamCorpusFacts, parseOutputSeamCorpus } from "../../../../scripts/regenerate-output-seam-corpus.js"
import { resolveEventStoreDbFile, resolveSessionSummaryDbFile } from "../../../../src/infra/paths.js"
import { acquireSessionSummaryIndex } from "../../../../src/orchestration/session/session-summary-index.js"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { createdFact, linkedFact, usageV4Fact } from "../../../fixtures/session-summary-history.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { readSessionMetadata } from "../../../../src/orchestration/session/session-metadata-store.js"
import { readWorkflowUsage } from "../../../../src/orchestration/workflow-host/member-totals.js"
import { historicalWorkflowPublicationFacts } from "../../../release/fixtures/historical-workflow-publication.js"

const temporary = temporaryDirectories()

async function chatTotal(root: string, store: ReturnType<typeof createSqliteEventStore>, chatId: string) {
  const index = acquireSessionSummaryIndex(resolveSessionSummaryDbFile(root), asAsyncEventReadSurface(store), { shared: false })
  try {
    await index.replay()
    const result = await index.readImmediate([chatId])
    expect(result.status).toBe("ready")
    return result.summaries.get(chatId)?.budget
  } finally { await index.dispose() }
}

test("the launching chat's total keeps a converted workflow's residual and unadopted nested usage once", async () => {
  const root = temporary("workflow-conversion-totals-")
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const f = legacyWorkflowFixture(root)
  const appendFact = ({ position: _position, id: _id, seq: _seq, ...fact }: StoredFact) => f.store.append(fact)
  // The nested child records no launching conversation, so no member can adopt it.
  appendFact(createdFact(1, "nested", "subagent", "old"))
  appendFact(linkedFact(2, "old", "nested"))
  appendFact(usageV4Fact(3, "old", "old-request", 3))
  appendFact(usageV4Fact(4, "nested", "nested-request", 5))
  expect(await chatTotal(root, f.store, "parent")).toMatchObject({ totalCost: 8, totalTokens: 220 })
  f.store.close()
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(recoverSessionMetadata(store, "nested")?.launchedFrom?.parentSessionId).toBe("old")
    expect(await chatTotal(root, store, "parent")).toMatchObject({ totalCost: 8, totalTokens: 220 })
    const usage = await readWorkflowUsage(asAsyncEventReadSurface(store), "old")
    expect(usage.policy).toMatchObject({ totalCost: 3, totalInputTokens: 100 })
    expect(usage.display).toMatchObject({ totalCost: 8, totalInputTokens: 200 })
  } finally { store.close() }
})

test("previous embedded subagent cards move with their agent and cumulative usage remains exact", async () => {
  const root = temporary("historical-agent-cards-")
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const corpus = parseOutputSeamCorpus(await Bun.file(new URL("../../../fixtures/output-seam-corpus/corpus.json", import.meta.url)).json())
  const previous = corpus.cases.find(row => row.id === "workflow-workers")!
  const dbFile = resolveEventStoreDbFile(root)
  let store = createSqliteEventStore(dbFile)
  appendOutputSeamCorpusFacts(store, previous)
  for (const inputTokens of [10, 20]) store.append({
    aggregateId: `session:${previous.sessionId}`, sessionId: previous.sessionId, type: "model.usage.measured", version: 3, actor: "provider", timestamp: inputTokens,
    payload: { totalCostUsd: 0.15, billedCostUsd: 0.15, inputTokens, outputTokens: 8, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0, budgetStreamId: "previous-stream" },
  })
  const original = store.read({ aggregateId: `session:${previous.sessionId}`, types: ["child_run.created", "subagent.completed"] })
  store.close()
  prepareWorkspaceState(testDirectories(root)).generation.release()
  store = createSqliteEventStore(dbFile)
  try {
    const reader = asAsyncEventReadSurface(store)
    const members = await workflowMembershipReader(reader).list(previous.sessionId)
    expect(members).toHaveLength(3)
    const projection = createSessionDetailProjection({
      projectRoot: root, reader, projectionReader: reader, sessionStore: { get: () => undefined },
      manager: { read: id => readSessionMetadata(reader, id) },
    })
    const outputs = await Promise.all(members.map(member => projection.outputRange(member.sessionId, { anchor: { kind: "tail" }, maxBlocks: 1000, maxBytes: 1024 * 1024 })))
    const cards = outputs.flatMap(output => output.kind === "ok" ? output.blocks : [])
    expect(cards.find(block => block.kind === "agentGroup" && block.id === "alias-3-195")).toMatchObject({ kind: "agentGroup", duration: 46044, totalTokens: 2778, totalToolCount: 6 })
    const moved = store.read({ types: ["child_run.created", "subagent.completed"] })
    expect(moved.map(({ sessionId: _owner, aggregateId: _aggregate, seq: _seq, ...row }) => row))
      .toEqual(original.map(({ sessionId: _owner, aggregateId: _aggregate, seq: _seq, ...row }) => row))
    expect((await readWorkflowUsage(reader, previous.sessionId)).policy).toMatchObject({ totalCost: 0.15, totalInputTokens: 20, totalOutputTokens: 8 })
  } finally { store.close() }
})

test("workspace conversion publishes generation sessions, preserves history, and repeats no work", async () => {
  const root = temporary("workflow-generations-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  expect(recoverSessionMetadata(f.store, "old")).toMatchObject({ kind: "workflow", label: "Renamed" })
  const original = f.store.read({ aggregateId: "conversation:generation-one" })
  f.store.close()
  const preparation = prepareWorkspaceState(testDirectories(root))
  preparation.generation.release()
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(workflowRecoveryBasis(store.read({ aggregateId: "workflow:old" }))?.attempts[0]?.conversationId).toBe("generation-two")
    expect(recoverSessionMetadata(store, "old")).toBeNull()
    const reader = asAsyncEventReadSurface(store)
    const members = await workflowMembershipReader(reader).list("old")
    expect(members).toHaveLength(2)
    expect(members.map(({ membership }) => membership.kind)).toEqual(["historical-generation", "attempt"])
    for (const member of members) {
      expect(recoverSessionMetadata(store, member.sessionId)).toMatchObject({
        kind: "workflow-agent", lifecycleState: "inactive", launchedFrom: { parentSessionId: "parent" },
        importedResources: { workflowId: "old", conversationId: member.conversationId },
      })
      // The run owns the profile its agents run on; the agents hold no copy.
      expect(recoverSessionMetadata(store, member.sessionId)?.authProfileId).toBeUndefined()
    }
    const moved = store.read({ aggregateId: "conversation:generation-one" })
    expect(moved.map(({ sessionId: _owner, ...fact }) => fact)).toEqual(original.map(({ sessionId: _owner, ...fact }) => fact))
    expect(moved[0]?.sessionId).toBe(members[0]?.sessionId)
    expect(await createWorkflowRunReader(reader).read("old")).toMatchObject({ label: "Renamed", userNamed: true, authProfileId: "Personal" })
    expect(await createWorkflowRunReader(reader).readCreationRequest("old")).toBe("Original request")
    expect(recoverSessionMetadata(store, "parent")?.childSessionIds).toEqual(members.map(({ sessionId }) => sessionId))
  } finally { store.close() }
  const second = prepareWorkspaceState(testDirectories(root))
  second.generation.release()
  const before = createSqliteEventStore(f.dbFile)
  const position = before.currentPosition()
  before.close()
  const third = prepareWorkspaceState(testDirectories(root))
  third.generation.release()
  const after = createSqliteEventStore(f.dbFile)
  expect(after.currentPosition()).toBe(position)
  after.close()
})

test("workspace conversion retains a request-less workflow beside a healthy sibling", async () => {
  const root = temporary("workflow-missing-request-")
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const f = legacyWorkflowFixture(root)
  for (const fact of historicalWorkflowPublicationFacts({
    childSessionId: "healthy", parentSessionId: "parent", description: "Healthy request", projectRoot: root,
    timestamp: Date.parse("2026-10-16T00:00:00.000Z"), completed: false,
  })) f.store.append(fact)
  const history = f.store.read({ aggregateId: "conversation:generation-one" })
  f.store.close()
  const db = new Database(f.dbFile)
  try {
    db.run("update event set version = 4, payload = json_remove(payload, '$.label') where aggregate_id = 'session:old' and type = 'session.created'")
    db.run("delete from event where aggregate_id = 'workflow:old' and type = 'context.input.seeded'")
  } finally { db.close() }
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const store = createSqliteEventStore(f.dbFile)
  try {
    const reader = asAsyncEventReadSurface(store)
    const runs = createWorkflowRunReader(reader)
    expect(store.read({ types: ["workflow.run.registered"] })).toHaveLength(2)
    expect(await runs.read("old")).toMatchObject({ label: "Renamed", userNamed: true, authProfileId: "Personal" })
    expect(await runs.readCreationRequest("old")).toBeNull()
    expect(await runs.readRequest("old")).toBeNull()
    expect(await workflowMembershipReader(reader).list("old")).toHaveLength(2)
    expect(store.read({ aggregateId: "conversation:generation-one" }).map(({ sessionId: _owner, ...fact }) => fact))
      .toEqual(history.map(({ sessionId: _owner, ...fact }) => fact))
    expect(await runs.read("healthy")).toMatchObject({ label: "Healthy request" })
    expect(await runs.readRequest("healthy")).toBe("Healthy request")
  } finally { store.close() }
})

test("a workflow from before control facts converts to a degraded run and the workspace still opens", async () => {
  const root = temporary("workflow-rootless-")
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const f = legacyWorkflowFixture(root)
  const usage = f.store.append({ aggregateId: "session:old", sessionId: "old", type: "model.usage.measured", version: 3, actor: "provider", timestamp: 4,
    payload: JSON.parse('{"totalCostUsd":0.1,"billedCostUsd":0.1,"inputTokens":10,"outputTokens":5,"cacheReadTokens":0,"cacheCreateTokens":0,"reasoningTokens":0,"budgetStreamId":"shared"}') })
  f.store.putInFlight("old", "session.planned_continuation", "old", JSON.parse('{"version":2,"sessionId":"old","kind":"workflow","handoffId":"planned-handoff"}'))
  f.store.close()
  // Releases before 2026-07-22 kept workflow progress in the session
  // aggregate and wrote no workflow control facts.
  const db = new Database(f.dbFile)
  try { db.run("delete from event where aggregate_id = 'workflow:old'") } finally { db.close() }
  prepareWorkspaceState(testDirectories(root)).generation.release()
  const store = createSqliteEventStore(f.dbFile)
  try {
    const reader = asAsyncEventReadSurface(store)
    // No generation can own execution history, so it stays with the workflow, and its recovery cells still convert.
    expect(store.read({ positions: [usage.position] })).toEqual([usage])
    expect(store.readInFlight("old", "session.planned_continuation")[0]?.payload).toEqual({ version: 3, target: { kind: "workflow", workflowId: "old" }, handoffId: "planned-handoff" })
    expect(await createWorkflowRunReader(reader).read("old")).toMatchObject({ label: "Renamed" })
    expect(recoverWorkflowControl(store.read({ aggregateId: "workflow:old" }))).toMatchObject({ executable: false, reasons: [{ kind: "missing_root" }] })
    const recovery = await recoverProject({ directories: testDirectories(root), reader, writer: asAsyncEventWriter(store) }, "ownerless")
    expect(recovery.degraded).toEqual([])
  } finally { store.close() }
})

test("a failed conversion rolls back only its cross-owner publication, keeps an earlier conversion, and retries once", () => {
  const root = temporary("workflow-conversion-rollback-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const seedStore = createSqliteEventStore(resolveEventStoreDbFile(root))
  for (const fact of historicalWorkflowPublicationFacts({
    childSessionId: "healthy", parentSessionId: "parent", description: "Healthy request", projectRoot: root,
    timestamp: Date.parse("2026-10-16T00:00:00.000Z"), completed: false,
  })) seedStore.append(fact)
  seedStore.close()
  const f = legacyWorkflowFixture(root)
  const before = f.store.read({ sessionId: "old" })
  const creations = f.store.read({ types: ["session.created"] })
  const db = new Database(f.dbFile)
  db.exec("create trigger refuse_disposition before insert on event when new.type = 'session.representation.retired' and new.session_id = 'old' begin select raise(abort, 'interrupted conversion'); end")
  expect(() => convertWorkflowAgentSessions(f.dbFile)).toThrow("interrupted conversion")
  expect(f.store.read({ sessionId: "old" })).toEqual(before)
  expect(f.store.read({ types: ["session.created"] })).toEqual(creations)
  expect(recoverSessionMetadata(f.store, "healthy")).toBeNull()
  expect(f.store.read({ types: ["workflow.run.registered"] }).map(row => row.sessionId)).toEqual(["healthy"])
  expect(workflowAgentSessionsNeedConversion(f.dbFile)).toBe(true)
  db.exec("drop trigger refuse_disposition")
  expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)
  expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(0)
  expect(workflowAgentSessionsNeedConversion(f.dbFile)).toBe(false)
  f.store.append({ aggregateId: "session:parent", sessionId: "parent", actor: "flywheel", type: "telemetry.probe", version: 1, timestamp: 0, payload: {} })
  expect(workflowAgentSessionsNeedConversion(f.dbFile)).toBe(false)
  db.close()
  f.store.close()
})

test("workspace conversion retains a damaged generation and converts its readable sibling", async () => {
  const root = temporary("workflow-damaged-generation-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  f.store.close()
  const db = new Database(f.dbFile)
  try { db.run("update event set payload = ? where aggregate_id = ? and type = ?", ["{", "conversation:generation-one", "chat.tree.created"]) } finally { db.close() }
  const prepared = prepareWorkspaceState(testDirectories(root))
  prepared.generation.release()
  const store = createSqliteEventStore(f.dbFile)
  try {
    const members = await workflowMembershipReader(asAsyncEventReadSurface(store)).list("old")
    expect(members.map(member => member.conversationId)).toEqual(["generation-two"])
    expect(await createWorkflowRunReader(asAsyncEventReadSurface(store)).read("old")).not.toBeNull()
    const retired = store.read({ aggregateId: "session:old", types: ["session.representation.retired"] })[0]
    expect(retired?.payload.recovery).toEqual([expect.objectContaining({ kind: "unreadable-conversation" })])
    const raw = new Database(f.dbFile, { readonly: true })
    try { expect(raw.query("select payload from event where aggregate_id = ? and type = ?").get("conversation:generation-one", "chat.tree.created")).toEqual({ payload: "{" }) } finally { raw.close() }
  } finally { store.close() }
})

test("admitted deletion retains its old plan and prevents conversion or foreign wait closure", () => {
  const root = temporary("workflow-conversion-deletion-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  try {
    f.store.putInFlight("old", "session.subagent_recursive_deletion", "old", JSON.parse('{"version":1,"rootSessionId":"old","edges":[]}'))
    const before = f.store.read({ sessionId: "old" })
    const held = f.store.readInFlight("old", "session.subagent_recursive_deletion")
    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(0)
    expect(f.store.read({ sessionId: "old" })).toEqual(before)
    expect(f.store.readInFlight("old", "session.subagent_recursive_deletion")).toEqual(held)
    expect(recoverSessionMetadata(f.store, "old")?.kind).toBe("workflow")
  } finally { f.store.close() }
})

test("a previous follow-up has historical provenance without an invented attempt", async () => {
  const root = temporary("workflow-conversion-followup-")
  const empty = prepareWorkspaceState(testDirectories(root))
  empty.generation.release()
  const f = legacyWorkflowFixture(root)
  try {
    f.store.append({ aggregateId: "workflow:old", sessionId: "old", timestamp: 3, actor: "flywheel", type: "follow_up.requested", version: 1,
      payload: JSON.parse('{"prompt":"Retained follow-up","conversationId":"old-follow-up","requestSequence":2}') })
    f.store.append({ aggregateId: "conversation:old-follow-up", sessionId: "old", timestamp: 4, actor: "flywheel", type: "chat.tree.created", version: 1,
      payload: JSON.parse('{"conversationId":"old-follow-up","createdAt":"2026-10-16T00:00:00.000Z"}') })
    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)
    const rows = await workflowMembershipReader(asAsyncEventReadSurface(f.store)).list("old")
    const historical = rows.find(row => row.conversationId === "old-follow-up")!
    expect(historical.membership).toEqual({ kind: "historical-follow-up", workflowId: "old", followUpId: "2" })
    expect(recoverSessionMetadata(f.store, historical.sessionId)?.lifecycleState).toBe("inactive")
  } finally { f.store.close() }
})
