/** Which chat and card own a historical workflow after adoption, and which
 *  workflows a start examines. The input that waits in a workflow is the
 *  subject of `adopt-workflow-children-input.test.ts`. */

import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { adoptWorkflowChildren, workflowChildrenNeedAdoption } from "../../../../src/orchestration/modules/workflows/migrations/adopt-workflow-children.js"
import { recoverSessionMetadata } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { buildSessionChildLinkedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { CHILD_SESSION_DELETION_IN_FLIGHT_KIND, executeChildSessionDeletionPlan } from "../../../../src/orchestration/session/child-session-deletion.js"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { initialFacts } from "../../workflows/vm/host-test-support.js"
import { loadToolExecutionTimelineFromEvents, TOOL_EXECUTION_FACT_TYPES } from "../../../../src/orchestration/session/tool-execution-projection.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { createConversationMessageEntry } from "../../../../src/orchestration/session/conversation/conversation-tree.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { chatSessionActions, readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { historicalCompletionEntryId } from "../../../../src/orchestration/session/child-session-completion.js"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { createWorkflowDetailReader } from "../../../../src/orchestration/modules/workflows/detail.js"
import { createWorkflowViewProtocolReader } from "../../../../src/orchestration/modules/workflows/view-protocol.js"
import { convertWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions.js"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection.js"
import { deferredAgentMeta } from "../../../../src/infra/output/deferred-agent-meta.js"
import { acceptOlderFollowUp, adoptionCard, adoptionFixture, adoptionWarnings, branch, chat, described, launchCard, launchedWorkflow, launchingParent, owner, parentTurn, recordCompletedRun, previousWorkflowCreatedFact } from "./_workflow-adoption.js"

const temporary = temporaryDirectories()
const fixture = () => adoptionFixture(temporary("workflow-adoption-"))

test("adopts readable metadata without executable control and preserves bytes across reopen and repeat", () => {
  const f = fixture()
  f.workflow("orphan")
  const original = f.store.read({ aggregateId: "session:orphan" })
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(1)
  const reopened = createSqliteEventStore(f.dbFile)
  try {
    const child = recoverSessionMetadata(reopened, "orphan")
    expect(child?.launchedFrom?.toolUseId).toBeDefined()
    const parentId = child?.launchedFrom?.parentSessionId
    if (!parentId) throw new Error("missing adopter")
    // The adopting chat's id comes from the one session id generator.
    expect(parentId).toMatch(/^[0-9a-f]{12}$/)
    expect(recoverSessionMetadata(reopened, parentId)).toMatchObject({
      kind: "chat", authProfileId: "profile", executionCwd: f.cwd, lifecycleState: "inactive",
      childSessionIds: ["orphan"],
    })
    expect(reopened.read({ aggregateId: "session:orphan" }).slice(0, original.length)).toEqual(original)
    expect(reopened.read({ aggregateId: `session:${parentId}`, types: ["tool.runtime_invocation.recorded"] })).toHaveLength(1)
    // The adopted card names the run by its summary, as a live launch's card does.
    const card = loadToolExecutionTimelineFromEvents(reopened.read({ aggregateId: `session:${parentId}`, types: TOOL_EXECUTION_FACT_TYPES }))
      .find((entry) => entry.toolUseId === child?.launchedFrom?.toolUseId)
    expect(deferredAgentMeta("workflow", card?.input ?? {}, "Workflow")).toEqual({ containerKind: "workflow", label: "orphan", description: "", sentence: { name: "Ran workflow", detail: "orphan" } })
    const position = reopened.currentPosition()
    expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(0)
    expect(reopened.currentPosition()).toBe(position)
  } finally { reopened.close() }
})

test("a later start examines only the workflows created after the last complete pass", () => {
  const f = fixture()
  f.workflow("first")
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(1)
  // Unbacking the examined workflow out of band would make a full rescan
  // adopt it again; the watermark keeps the pass on the new workflow alone.
  const db = new Database(f.dbFile)
  try {
    db.exec("delete from event where type = 'session.child.linked'")
  } finally { db.close() }
  const store = createSqliteEventStore(f.dbFile)
  store.append(buildSessionMetadataAppend("second", previousWorkflowCreatedFact({
    kind: "workflow", command: "workflow", workflowDefinitionId: "test", label: "second",
    lifecycleState: "inactive", lastUpdated: f.now, createdAt: f.now, executionCwd: f.cwd, authProfileId: "profile",
  }), Date.parse(f.now)))
  store.close()

  expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(true)
  expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(1)
  expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
})

test("the adopting chat records a removed workflow directory as recorded", () => {
  // History keeps the meaning of its paths (ARCH-DIRECTORIES-007), and the
  // conversion never stops on a directory that is gone.
  const f = fixture()
  const removed = join(f.root, "removed-worktree")
  f.store.append(buildSessionMetadataAppend("gone", previousWorkflowCreatedFact({
    kind: "workflow", command: "workflow", workflowDefinitionId: "test", label: "gone",
    lifecycleState: "inactive", lastUpdated: f.now, createdAt: f.now, executionCwd: removed, authProfileId: "profile",
  }), Date.parse(f.now)))
  f.store.close()

  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 0 })
  const reopened = createSqliteEventStore(f.dbFile)
  try {
    const parentId = recoverSessionMetadata(reopened, "gone")?.launchedFrom?.parentSessionId
    if (!parentId) throw new Error("missing adopter")
    expect(recoverSessionMetadata(reopened, parentId)).toMatchObject({ kind: "chat", executionCwd: removed })
  } finally { reopened.close() }
})

test("does not rescue an admitted deletion target and isolates unknown metadata with one warning", () => {
  const f = fixture()
  f.workflow("target")
  f.workflow("healthy")
  f.store.putInFlight("target", CHILD_SESSION_DELETION_IN_FLIGHT_KIND, "target", {
    version: 1, rootSessionId: "target", edges: [],
  })
  f.store.append({ aggregateId: "session:unknown", sessionId: "unknown", type: "session.created", version: 99, actor: "flywheel", timestamp: 0, payload: { kind: "unknown" } })
  const unknown = f.store.read({ aggregateId: "session:unknown" })
  f.store.close()
  const warn = adoptionWarnings()
  try {
    expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(1)
    expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(0)
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual([{ sessionId: "unknown" }])
    expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
  } finally { warn.mockRestore() }
  const reopened = createSqliteEventStore(f.dbFile)
  try {
    expect(recoverSessionMetadata(reopened, "target")?.launchedFrom).toBeUndefined()
    expect(recoverSessionMetadata(reopened, "healthy")?.launchedFrom?.parentSessionId).toBeDefined()
    expect(reopened.read({ aggregateId: "session:unknown" })).toEqual(unknown)
  } finally { reopened.close() }
})

test.each(["unknown version", "invalid payload"] as const)("warns once for %s control without a follow-up and preserves its bytes", (unreadable) => {
  const f = fixture()
  f.workflow("absent")
  f.workflow("unreadable")
  const root = initialFacts()[0]!
  f.store.append({
    ...root, aggregateId: "workflow:unreadable", sessionId: "unreadable",
    ...(unreadable === "unknown version" ? { version: 99 } : { payload: {} }),
  })
  const original = f.store.read({ aggregateId: "workflow:unreadable" })
  f.store.close()
  const warn = adoptionWarnings()
  try {
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 2, failed: 0 })
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 0, failed: 0 })
    expect(warn.mock.calls).toEqual([[
      "workflow control unreadable during adoption; any pending follow-up stays in the workflow because its transfer could not be proven",
      { sessionId: "unreadable" },
    ]])
  } finally { warn.mockRestore() }
  const reopened = createSqliteEventStore(f.dbFile)
  try {
    expect(reopened.read({ aggregateId: "workflow:unreadable" })).toEqual(original)
    expect(recoverSessionMetadata(reopened, "unreadable")?.launchedFrom?.parentSessionId).toBeDefined()
    expect(recoverSessionMetadata(reopened, "absent")?.launchedFrom?.parentSessionId).toBeDefined()
  } finally { reopened.close() }
})

/** The workflow `session` that the chat `parent` backs with a card of the
 *  given kind, and the position of each parent turn. A launch writes its
 *  anchor just before its card, and adoption writes its anchor just after,
 *  so the turns `earlier` and `later` sit on either side of the card and
 *  its anchor. */
function backedWorkflow(f: ReturnType<typeof fixture>, card: "launch" | "adoption") {
  chat(f, "parent")
  launchedWorkflow(f, "session")
  const earlier = parentTurn(f, "earlier")
  if (card === "launch") {
    const anchor = parentTurn(f, "anchor")
    launchCard(f, "session")
    return { earlier, anchor, later: parentTurn(f, "later") }
  }
  adoptionCard(f, "session")
  const anchor = parentTurn(f, "anchor", "system")
  return { earlier, anchor, later: parentTurn(f, "later") }
}

/** Makes the row at `position` unreadable to every reader. */
function corrupt(dbFile: string, position: number) {
  const db = new Database(dbFile)
  try { db.query("update event set payload = 'not json' where position = ?").run(position) } finally { db.close() }
}

test.each([
  ["launch", "no turn"],
  ["launch", "a later turn"],
  ["adoption", "an earlier turn"],
] as const)("leaves a workflow that its %s card backs unchanged when %s of the parent chat is unreadable", (card, unreadable) => {
  const f = fixture()
  const turns = backedWorkflow(f, card)
  f.store.close()
  // The unreadable turn sits next to the card but holds nothing that the
  // card needs, so it must not disprove the anchor.
  if (unreadable === "a later turn") corrupt(f.dbFile, turns.later)
  if (unreadable === "an earlier turn") corrupt(f.dbFile, turns.earlier)
  const rows = () => {
    const store = createSqliteEventStore(f.dbFile)
    try {
      return store.readTolerant().filter((fact) => fact instanceof Error || fact.type !== "workspace.facts.checked").map((fact) => fact instanceof Error ? fact.message : fact)
    } finally { store.close() }
  }
  const before = rows()
  expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 0, failed: 0 })
  // The pass records only its own watermark.
  expect(rows()).toEqual(before)
})

test.each(["launch", "adoption"] as const)("gives a workflow a new card in the same chat when its %s card's anchor is unreadable", (card) => {
  const f = fixture()
  const turns = backedWorkflow(f, card)
  f.store.close()
  corrupt(f.dbFile, turns.anchor)
  expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(true)
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    // A card whose anchor no reader can parse has no row to show at, so the
    // workflow is reachable only through the new card.
    const { binding } = owner(store, "session")
    expect(binding.parentSessionId).toBe("parent")
    expect(binding.toolUseId).not.toBe("session")
    expect(store.read({ types: ["tool.runtime_invocation.recorded"] }).map((fact) => fact.payload.toolUseId)).toEqual(["session", binding.toolUseId])
  } finally { store.close() }
})

test("isolates duplicate invocation evidence while converting siblings sharing the same parent", () => {
  const f = fixture()
  launchingParent(f)
  for (const id of ["duplicate", "unbound", "healthy"]) launchedWorkflow(f, id)
  for (const id of ["duplicate", "duplicate", "healthy"]) launchCard(f, id)
  const duplicateBytes = f.store.read({ aggregateId: "session:duplicate" })
  f.store.close()
  // The shared-start admission reads the same unreadable evidence and must
  // answer, so a joining start reports the ownership conflict.
  expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(true)
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 2, failed: 0 })
  const reopened = createSqliteEventStore(f.dbFile)
  try {
    expect(reopened.read({ aggregateId: "session:duplicate" }).slice(0, duplicateBytes.length)).toEqual(duplicateBytes)
    expect(recoverSessionMetadata(reopened, "healthy")?.launchedFrom?.toolUseId).toBe("healthy")
    expect(recoverSessionMetadata(reopened, "unbound")?.launchedFrom?.toolUseId).not.toBe("unbound")
    // The unreadable binding is not repaired in place: the workflow moves to
    // its own adopting chat, whose card reaches it.
    const adopter = recoverSessionMetadata(reopened, "duplicate")?.launchedFrom
    expect(adopter?.parentSessionId).not.toBe("parent")
    if (!adopter?.toolUseId) throw new Error("duplicate was not adopted")
    expect(recoverSessionMetadata(reopened, adopter.parentSessionId)).toMatchObject({ kind: "chat", childSessionIds: ["duplicate"] })
    expect(recoverSessionMetadata(reopened, "parent")?.childSessionIds).not.toContain("duplicate")
    expect(reopened.read({ aggregateId: `session:${adopter.parentSessionId}`, types: ["tool.runtime_invocation.recorded"] }).map((fact) => fact.payload.toolUseId)).toEqual([adopter.toolUseId])
    expect(reopened.read({ aggregateId: "session:parent", types: ["tool.runtime_invocation.recorded"] })).toHaveLength(4)
    const position = reopened.currentPosition()
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 0, failed: 0 })
    expect(reopened.currentPosition()).toBe(position)
    expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
  } finally { reopened.close() }
})

test("retains a safe unbound parent and adopts an excluded survivor away from a doomed parent", async () => {
  const f = fixture()
  chat(f, "live")
  chat(f, "doomed")
  f.workflow("unbound", "live")
  f.workflow("survivor", "doomed")
  f.store.append(buildSessionMetadataAppend("doomed", buildSessionChildLinkedFact("survivor", f.now), Date.parse(f.now)))
  f.store.putInFlight("doomed", CHILD_SESSION_DELETION_IN_FLIGHT_KIND, "doomed", { version: 1, rootSessionId: "doomed", edges: [] })
  const deletion = f.store.readInFlight("doomed", CHILD_SESSION_DELETION_IN_FLIGHT_KIND)
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 2, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(recoverSessionMetadata(store, "unbound")?.launchedFrom?.parentSessionId).toBe("live")
    expect(recoverSessionMetadata(store, "survivor")?.launchedFrom?.parentSessionId).not.toBe("doomed")
    expect(store.readInFlight("doomed", CHILD_SESSION_DELETION_IN_FLIGHT_KIND)).toEqual(deletion)
    expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
    const manager = createSessionManager({ projectRoot: f.root, executionCwd: f.root, store })
    const plan = await manager.admitDeletion("doomed")
    expect(plan.targets).toEqual([{ kind: "root", rootSessionId: "doomed", sessionId: "doomed" }])
    await executeChildSessionDeletionPlan({
      projectRoot: f.root, reader: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store),
      writer: asAsyncEventWriter(store), read: manager.read, finalizeDeletionTarget: manager.finalizeDeletionTarget,
    }, plan)
    expect(await manager.read("doomed")).toBeNull()
    const survivingParent = (await manager.read("survivor"))?.launchedFrom?.parentSessionId
    if (!survivingParent) throw new Error("survivor lost its adopter")
    expect((await manager.read(survivingParent))?.kind).toBe("chat")
  } finally { store.close() }
})

test("an unreadable retained deletion keeps its root's children where they are and blocks no other adoption, even below a fork of its root", () => {
  const f = fixture()
  chat(f, "doomed")
  f.workflow("held", "doomed")
  f.store.append(buildSessionMetadataAppend("doomed", buildSessionChildLinkedFact("held", f.now), Date.parse(f.now)))
  chat(f, "fork")
  f.store.append(buildSessionMetadataAppend("doomed", buildSessionChildLinkedFact("fork", f.now), Date.parse(f.now)))
  f.workflow("forked", "fork")
  f.store.append(buildSessionMetadataAppend("fork", buildSessionChildLinkedFact("forked", f.now), Date.parse(f.now)))
  f.workflow("healthy")
  f.store.putInFlight("doomed", CHILD_SESSION_DELETION_IN_FLIGHT_KIND, "doomed", { version: 9, rootSessionId: "doomed", edges: [] })
  const deletion = f.store.readInFlight("doomed", CHILD_SESSION_DELETION_IN_FLIGHT_KIND)
  f.store.close()
  const warn = adoptionWarnings()
  try {
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 2, failed: 0 })
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual([{ sessionId: "doomed", error: "Session doomed has a recursive deletion operation of unknown version 9" }])
    expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
  } finally { warn.mockRestore() }
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(recoverSessionMetadata(store, "held")?.launchedFrom).toEqual({ parentSessionId: "doomed" })
    // A fork outlives its origin's deletion, so its workflow is adopted.
    expect(recoverSessionMetadata(store, "forked")?.launchedFrom).toMatchObject({ parentSessionId: "fork", toolUseId: expect.any(String) })
    expect(recoverSessionMetadata(store, "healthy")?.launchedFrom?.parentSessionId).toBeDefined()
    expect(store.readInFlight("doomed", CHILD_SESSION_DELETION_IN_FLIGHT_KIND)).toEqual(deletion)
  } finally { store.close() }
})

test.each(["stopped", "cancelled"] as const)("mirrors %s provenance onto the adopted binding as settled history", async (outcome) => {
  const f = fixture()
  chat(f, "old")
  f.store.append(buildSessionMetadataAppend("stopped-child", previousWorkflowCreatedFact({
    kind: "workflow", command: "workflow", workflowDefinitionId: "test", label: "stopped",
    executionCwd: f.cwd, lifecycleState: "inactive", lastUpdated: f.now,
    launchedFrom: { parentSessionId: "old", toolUseId: "original" },
  }), Date.parse(f.now)))
  const facts = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.result.recorded", { tool_use_id: "original", outcome, content: [{ type: "text", text: "Stopped" }] }))
  f.store.appendBatch(facts.map((fact) => ({ ...fact, sessionId: "old", aggregateId: "session:old", timestamp: Date.now() })))
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(1)
  const store = createSqliteEventStore(f.dbFile)
  try {
    const { binding, parent } = owner(store, "stopped-child")
    expect(loadToolExecutionTimelineFromEvents(store.read({ aggregateId: `session:${binding.parentSessionId}`, types: TOOL_EXECUTION_FACT_TYPES })).find((entry) => entry.toolUseId === binding.toolUseId)?.resultOutcome).toBe(outcome)
    expect(branch(store, parent.conversationId).map((entry) => entry.id).at(-1)).toBe(historicalCompletionEntryId("stopped-child"))
    // The parent's next start owes no Stop notification either.
    const position = store.currentPosition()
    await reconcileChildSessionCompletions({ parentSessionId: binding.parentSessionId, reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    expect(store.currentPosition()).toBe(position)
    expect(store.readInFlight(binding.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
  } finally { store.close() }
})

test("production workspace preparation refuses a live owner before converting then adopts exclusively", () => {
  const directories = testDirectories(temporary("workflow-adoption-startup-"))
  const held = prepareWorkspaceState(directories)
  const store = createSqliteEventStore(held.dbFile)
  try {
    store.append(buildSessionMetadataAppend("old-workflow", previousWorkflowCreatedFact({
      kind: "workflow", command: "workflow", workflowDefinitionId: "test", label: "Old workflow",
      lifecycleState: "inactive", lastUpdated: "2026-10-02T00:00:00.000Z", executionCwd: directories.executionCwd,
    }), Date.now()))
    const position = store.currentPosition()
    expect(() => prepareWorkspaceState(directories)).toThrow("while another process owns")
    expect(store.currentPosition()).toBe(position)
  } finally { store.close(); held.generation.release() }
  const prepared = prepareWorkspaceState(directories)
  const reopened = createSqliteEventStore(prepared.dbFile)
  try {
    expect(recoverSessionMetadata(reopened, "old-workflow")).toBeNull()
    expect(reopened.read({ aggregateId: "workflow:old-workflow", types: ["workflow.run.registered"] })[0]?.payload).toMatchObject({ launchedFrom: { parentSessionId: expect.any(String) } })
  } finally { reopened.close(); prepared.generation.release() }
})

test("one refused transaction leaves that workflow untouched and still converts its healthy sibling", () => {
  const f = fixture()
  f.workflow("bad")
  f.workflow("good")
  const before = f.store.read({ aggregateId: "session:bad" })
  f.store.close()
  const db = new Database(f.dbFile)
  try {
    db.exec("create trigger reject_bad_adoption before insert on event when NEW.session_id = 'bad' and NEW.type = 'session.ownership.adopted' begin select raise(abort, 'injected migration failure'); end")
  } finally { db.close() }
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 1 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(store.read({ aggregateId: "session:bad" })).toEqual(before)
    expect(recoverSessionMetadata(store, "good")?.launchedFrom?.parentSessionId).toBeDefined()
    expect(store.read({ types: ["tool.runtime_invocation.recorded"] })).toHaveLength(1)
  } finally { store.close() }
})

/** A chat whose last turn the model answered. */
function answeredChat(f: ReturnType<typeof fixture>, id: string) {
  chat(f, id)
  f.store.appendBatch(ConversationTreeStorage.prepareAppend({
    conversationId: `${id}-conversation`, sessionId: id, expectedSeq: 1, committed: {},
    entries: [
      createConversationMessageEntry({ kind: "user", content: "hello", origin: "human" }, "u1", null, f.now),
      createConversationMessageEntry({ kind: "assistant", content: [{ type: "text", text: "hi" }] }, "a1", "u1", f.now),
    ],
  }))
}

test.each([
  ["terminal", "new"],
  ["terminal", "answered live"],
  ["unfinished", "new"],
  ["unfinished", "answered live"],
] as const)("adopts a %s workflow into a %s chat as settled history that offers no Resume and wakes no model", async (state, parent) => {
  const f = fixture()
  if (parent === "answered live") answeredChat(f, "live")
  // A slash launch before tool bindings: a parent and no call to answer.
  f.workflow("session", parent === "answered live" ? "live" : undefined)
  if (state === "terminal") await recordCompletedRun(f, false)
  else f.store.appendBatch(initialFacts())
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    const { binding, parent: adopter } = owner(store, "session")
    if (parent === "answered live") expect(binding.parentSessionId).toBe("live")
    const reader = asAsyncEventReadSurface(store)
    const turnEnd = await readChatTurnEnd(reader, adopter.conversationId)
    expect(turnEnd).toEqual({ end: { reason: "settled" }, recorded: true })
    expect(chatSessionActions("chat", "inactive", turnEnd)).not.toContain("chat.resume")
    const entries = branch(store, adopter.conversationId)
    expect(entries.slice(0, parent === "answered live" ? 2 : 0).map((entry) => entry.id)).toEqual(parent === "answered live" ? ["u1", "a1"] : [])
    // A person sees the notice as a launch acknowledgement reads. The card states the result, so the completion shows no row.
    expect(projectBlocksFromEntries(entries, { executionCwd: f.root }).flatMap((block) => block.kind === "system" ? [block.message] : [])).toEqual(["Adopted the test workflow into this chat: session"])
    const result = loadToolExecutionTimelineFromEvents(store.read({ aggregateId: `session:${binding.parentSessionId}`, types: TOOL_EXECUTION_FACT_TYPES }))
      .find((entry) => entry.toolUseId === binding.toolUseId)
    const completions = entries.filter((entry) => entry.id.includes("workflow-completion:"))
    if (state === "terminal") {
      expect(result?.resultOutcome).toBe("ok")
      expect(completions.map((entry) => entry.id)).toEqual([historicalCompletionEntryId("session")])
    } else {
      expect(result?.resultOutcome).toBeUndefined()
      expect(completions).toEqual([])
    }
    // The parent's next start finds the completion delivered: no held
    // notification, and nothing more written.
    const position = store.currentPosition()
    await reconcileChildSessionCompletions({ parentSessionId: binding.parentSessionId, reader, writer: asAsyncEventWriter(store) })
    expect(store.currentPosition()).toBe(position)
    expect(store.readInFlight(binding.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
  } finally { store.close() }
})

// A call of an older build named the workflow in `workflow_definition_id`;
// a call of this build names it in `source`, registered or by path.
test.each([
  ["an older build's registered call", { workflow_definition_id: "test", description: "Build it" }],
  ["a registered call", { source: { kind: "registered", definition_id: "test" }, description: "Build it" }],
  ["a path call", { source: { kind: "path", path: "scratch/workflows/test.workflow.yaml" }, description: "Build it" }],
])("leaves a model-launched child of %s unchanged", (_name, input) => {
  const f = fixture()
  chat(f, "parent")
  f.store.append(buildSessionMetadataAppend("model-child", previousWorkflowCreatedFact({
    kind: "workflow", command: "workflow", workflowDefinitionId: "test", label: "work",
    executionCwd: f.cwd, lifecycleState: "inactive", lastUpdated: f.now,
    launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "model-call", workflowDefinitionId: "test", description: "Build it" },
  }), Date.parse(f.now)))
  f.store.append(buildSessionMetadataAppend("parent", buildSessionChildLinkedFact("model-child", f.now), Date.parse(f.now)))
  const evidence = contentEvidence(JSON.stringify(input))
  f.store.append(prepareSessionFactAppend("parent", {
    type: "tool.input.completed", version: 1, actor: "agent",
    payload: {
      toolUseId: "model-call", toolName: "workflow", input,
      inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
      executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request",
    },
  }))
  const before = f.store.read()
  f.store.close()
  expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 0, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try { expect(store.read().filter((fact) => fact.type !== "workspace.facts.checked")).toEqual(before) } finally { store.close() }
})

test("adopts again what an older build orphaned or gave a follow-up after an earlier pass, then writes nothing", async () => {
  const f = fixture()
  f.workflow("session")
  await recordCompletedRun(f, false)
  f.workflow("other")
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 2, failed: 0 })

  // A downgrade to v0.0.12: it deletes a chat without its workflow children,
  // and accepts a follow-up into an adopted, completed workflow.
  const older = createSqliteEventStore(f.dbFile)
  const firstAdopter = recoverSessionMetadata(older, "other")?.launchedFrom?.parentSessionId
  if (!firstAdopter) throw new Error("missing first adopter")
  const sessionBinding = owner(older, "session").binding
  older.append(buildSessionMetadataAppend(firstAdopter, { type: "session.deleted", version: 1, actor: "flywheel", payload: { lastUpdated: f.now } }, Date.parse(f.now)))
  acceptOlderFollowUp(older, "and the docs?")
  older.close()

  expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(true)
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 2, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    const rescuer = recoverSessionMetadata(store, "other")?.launchedFrom?.parentSessionId
    expect([undefined, firstAdopter]).not.toContain(rescuer)
    // The card that the first pass wrote backs `session`, so its follow-up
    // moves to that chat, and only the rescue of `other` writes a card.
    expect(owner(store, "session").binding).toEqual(sessionBinding)
    expect(store.read({ types: ["tool.runtime_invocation.recorded"] }).map((fact) => fact.payload.operation)).toEqual([
      { kind: "adoption", workflowSessionId: "session", workflowDefinitionId: "test", summary: "session" },
      { kind: "adoption", workflowSessionId: "other", workflowDefinitionId: "test", summary: "other" },
      { kind: "adoption", workflowSessionId: "other", workflowDefinitionId: "test", summary: "other" },
    ])
    expect(replayWorkflowControl(store.read({ aggregateId: "workflow:session" }))).toMatchObject({ status: "completed", followUp: { pendingInput: null } })
    expect(branch(store, owner(store, "session").parent.conversationId).map(described).slice(-2)).toEqual([
      "user/human:and the docs?",
      "user/system:The runtime interrupted this turn before it finished, at a planned stop.",
    ])
    const position = store.currentPosition()
    expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 0, failed: 0 })
    expect(store.currentPosition()).toBe(position)
  } finally { store.close() }
})

test("a workflow whose control is degraded stays reachable from its adopting chat's card with its gaps visible", async () => {
  const f = fixture()
  f.workflow("degraded")
  f.store.append({ aggregateId: "workflow:degraded", sessionId: "degraded", type: "queue.created", version: 9, actor: "flywheel", timestamp: 0, payload: { queue: "malformed" } })
  const original = f.store.read({ aggregateId: "workflow:degraded" })
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(store.read({ aggregateId: "workflow:degraded" })).toEqual(original)
    const manager = createSessionManager({ projectRoot: f.root, executionCwd: f.root, store })
    const binding = (await manager.read("degraded"))?.launchedFrom
    if (!binding?.toolUseId) throw new Error("missing binding")
    const card = loadToolExecutionTimelineFromEvents(store.read({ aggregateId: `session:${binding.parentSessionId}`, types: TOOL_EXECUTION_FACT_TYPES }))
      .find((entry) => entry.toolUseId === binding.toolUseId)
    expect(card?.runtimeOrigin?.operation).toEqual({ kind: "adoption", workflowSessionId: "degraded", workflowDefinitionId: "test", summary: "degraded" })
    expect(card?.resultOutcome).toBeUndefined()
    expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)
    const reader = asAsyncEventReadSurface(store)
    const detail = createWorkflowDetailReader({ projectRoot: f.root, manager, reader })
    await expect(detail("degraded")).resolves.toMatchObject({
      workflowId: "degraded", launchedFrom: { parentSessionId: binding.parentSessionId, toolUseId: binding.toolUseId }, readability: "unavailable",
    })
    await expect(createWorkflowViewProtocolReader(reader)("degraded")).resolves.toMatchObject({ attemptsStatus: "unavailable" })
  } finally { store.close() }
})

test("a later pass reads a workflow whose representation the agent-session conversion retired as converted, not unreadable", () => {
  const f = fixture()
  f.workflow("converted")
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(1)
  expect(convertWorkflowAgentSessions(f.dbFile).converted).toBe(1)
  const warn = adoptionWarnings()
  try {
    // The conversion unlinks the workflow from its chat after the adoption
    // watermark, so the next start examines it again.
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 0, failed: 0 })
    expect(warn.mock.calls).toEqual([])
    expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(false)
  } finally { warn.mockRestore() }
})
