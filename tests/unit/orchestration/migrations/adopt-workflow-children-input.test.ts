/** What the adoption of historical workflows does with input that waits in a
 *  workflow: an accepted follow-up and the held input that belongs to it move
 *  to the owning chat, input of an unfinished step stays with that step, and
 *  input that no conversion can move stays in the workflow with one warning.
 *  The chat and card that own a workflow are the subject of
 *  `adopt-workflow-children.test.ts`. */

import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventInserter } from "../../../../src/infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../src/infra/sqlite-event-read-surface.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { adoptWorkflowChildren, prepareWorkflowAdoption, workflowChildrenNeedAdoption } from "../../../../src/orchestration/modules/workflows/migrations/adopt-workflow-children.js"
import { chatSessionActions, readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { historicalCompletionEntryId } from "../../../../src/orchestration/session/child-session-completion.js"
import { readConversationSnapshotSync } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { queuedUserInputPut, QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-user-inputs.js"
import { chatTurnEndOf, endsAtTurnEnd } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { recoverSessionMetadata } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { recoveredWorkflowRoot } from "../../../helpers/workflow-root-fixtures.js"
import { initialFacts } from "../../workflows/vm/host-test-support.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { acceptOlderFollowUp, adoptionFixture, adoptionWarnings, branch, chat, described, launchCard, launchedWorkflow, launchingParent, owner, recordCompletedRun } from "./_workflow-adoption.js"

const temporary = temporaryDirectories()
const fixture = () => adoptionFixture(temporary("workflow-adoption-input-"))

async function pendingFixture() {
  const f = fixture()
  f.workflow("session")
  await recordCompletedRun(f, true)
  for (const [key, text] of [["queued-a", "first"], ["queued-b", "second"]] as const) {
    const hold = queuedUserInputPut(key, { target: "workflow" }, { text, submissionIds: [key] })
    f.store.putInFlight("session", hold.kind, hold.key, hold.payload)
  }
  return f
}

test("transfers pending follow-up and ordered cells without running work and leaves explicit Resume evidence", async () => {
  const f = await pendingFixture()
  const old = f.store.read({ aggregateId: "workflow:session" })
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    const { parent } = owner(store, "session")
    const tree = readConversationSnapshotSync(store, parent.conversationId)
    const entries = Object.values(tree.entriesById)
    const accepted = entries.find((entry) => entry.kind === "message" && entry.message.kind === "user" && Array.isArray(entry.message.content))
    expect(accepted).toMatchObject({ message: { origin: "human", invocation: { label: "review", args: "arg" }, submissionIds: ["submission"], content: [{ type: "text", text: "accepted" }, { type: "image", mediaType: "image/png", data: "YWJj" }] } })
    expect(entries.filter((entry) => entry.kind === "message" && entry.message.kind === "user" && (entry.message.content === "first" || entry.message.content === "second")).map((entry) => entry.id)).toHaveLength(2)
    // The completion happened before the follow-up asked about it, so the
    // model reads the result first, and the batch ends at its interrupt.
    const ordered = branch(store, parent.conversationId)
    expect(ordered.map(described)).toEqual([
      "user/system:Adopted the test workflow into this chat: session",
      // Worded under the card's goal, as the live reconciler words it.
      expect.stringMatching(/^user\/system:Workflow completed: "session" \(workflow session\)/),
      "user/system:Unfinished input from workflow session, conversation conversation-1. Continue explicitly in this chat.",
      "user/human:accepted+image",
      "user/human:first",
      "user/human:second",
      "user/system:The runtime interrupted this turn before it finished, at a planned stop.",
    ])
    expect(ordered[1]?.id).toBe(historicalCompletionEntryId("session"))
    expect(endsAtTurnEnd(ordered)).toBe(true)
    expect(chatTurnEndOf(ordered)?.end).toEqual({ reason: "paused", pausedBy: "runtime" })
    expect(chatSessionActions("chat", "inactive", await readChatTurnEnd(asAsyncEventReadSurface(store), parent.conversationId))).toContain("chat.resume")
    const facts = store.read({ aggregateId: "workflow:session" })
    expect(facts.slice(0, old.length)).toEqual(old)
    expect(replayWorkflowControl(facts)).toMatchObject({ status: "completed", followUp: { identity: { kind: "identified", inputID: "accepted-input" }, pendingInput: null } })
    // The follow-up's interrupt left the queue view paused; the transfer
    // commit restates it from control, as every control commit does.
    expect(loadQueueFromEvents(facts)?.status).toBe("completed")
    expect(facts.find((fact) => fact.type === "follow_up.transferred")?.payload).toMatchObject({ queuedMappings: [{ sourceKey: "queued-a" }, { sourceKey: "queued-b" }] })
    expect(store.readInFlight("session", QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
    const position = store.currentPosition()
    expect(adoptWorkflowChildren(f.dbFile, f.root).adopted).toBe(0)
    expect(store.currentPosition()).toBe(position)
  } finally { store.close() }
})

// Control replays from its newest root, so a row that root supersedes may be
// unreadable. The queue the transfer restates is read the same way.
test("transfers a pending follow-up when a workflow fact its recovered root supersedes is unreadable", async () => {
  const f = fixture()
  f.workflow("session")
  await recordCompletedRun(f, true)
  const facts = f.store.read({ aggregateId: "workflow:session" })
  const queue = loadQueueFromEvents(facts)
  if (!queue) throw new Error("expected a queue")
  const companions = queueFactsForState(null, queue)
  const rootSeq = f.store.aggregateSeq("workflow:session") + 1
  const root = recoveredWorkflowRoot(replayWorkflowControl(facts), rootSeq + 1 + companions.length)
  f.store.appendBatch([root, ...companions].map((fact) => ({ ...fact, aggregateId: "workflow:session", sessionId: "session", timestamp: Date.now() })))
  f.store.close()
  const db = new Database(f.dbFile)
  try { db.query("update event set payload = 'not json' where position = ?").run(facts[1]?.position ?? -1) } finally { db.close() }
  const warn = adoptionWarnings()
  try {
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 0 })
    // A result is never invented from history this build cannot read whole,
    // so only the completion's words are left out.
    expect(warn.mock.calls).toEqual([[expect.stringMatching(/workflow result unreadable/), { sessionId: "session" }]])
  } finally { warn.mockRestore() }
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(store.readTolerant({ types: ["follow_up.transferred"] })).toHaveLength(1)
    expect(branch(store, owner(store, "session").parent.conversationId).map(described)).toContain("user/human:accepted+image")
  } finally { store.close() }
})

test.each(["sequence", "cell"] as const)("rolls back the whole prepared adoption on a stale %s", async (conflict) => {
  const f = await pendingFixture()
  f.store.close()
  const db = new Database(f.dbFile)
  try {
    const inserter = createSqliteEventInserter(db)
    const reader = createSqliteEventReadSurface(db)
    const workflow = recoverSessionMetadata(reader, "session")
    if (workflow?.kind !== "workflow") throw new Error("missing workflow")
    const prepared = prepareWorkflowAdoption(reader, "session", workflow, new Set(), f.root)
    if (conflict === "cell") inserter.writeInFlight("session", { op: "put", kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: "queued-a", payload: { target: "workflow", text: "changed" } })
    else inserter.insertEventRows([{ ...buildSessionMetadataAppend("session", { type: "session.lifecycle.changed", version: 1, actor: "flywheel", payload: { lifecycleState: "inactive", lastUpdated: f.now } }, Date.now()), id: crypto.randomUUID() }])
    const position = reader.currentPosition()
    const cells = reader.readInFlight("session", QUEUED_USER_INPUT_IN_FLIGHT_KIND)
    db.exec("BEGIN IMMEDIATE")
    try {
      expect(() => inserter.insertEventRows(prepared.events.map((event) => ({ ...event, id: crypto.randomUUID() })))).toThrow()
    } finally { db.exec("ROLLBACK") }
    expect(reader.currentPosition()).toBe(position)
    expect(reader.readInFlight("session", QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual(cells)
    expect(recoverSessionMetadata(reader, "session")?.launchedFrom).toBeUndefined()
    expect(reader.read({ types: ["follow_up.transferred", "tool.runtime_invocation.recorded"] })).toEqual([])
  } finally { db.close() }
})

test("leaves recovery-held operator input with its unfinished workflow's step", () => {
  const f = fixture()
  f.workflow("session")
  f.store.appendBatch(initialFacts())
  const hold = queuedUserInputPut("operator-text", { target: "workflow" }, { text: "continue with the plan", submissionIds: ["operator-text"] })
  f.store.putInFlight("session", hold.kind, hold.key, hold.payload)
  const cells = f.store.readInFlight("session", QUEUED_USER_INPUT_IN_FLIGHT_KIND)
  const control = f.store.read({ aggregateId: "workflow:session" })
  f.store.close()
  expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 1, failed: 0 })
  const store = createSqliteEventStore(f.dbFile)
  try {
    expect(store.readInFlight("session", QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual(cells)
    expect(store.read({ aggregateId: "workflow:session" })).toEqual(control)
    expect(branch(store, owner(store, "session").parent.conversationId).map(described)).toEqual(["user/system:Adopted the test workflow into this chat: session"])
  } finally { store.close() }
})

test.each([
  ["backed", "an unproven follow-up", /could not be proven/],
  ["backed", "held input", /held input retained/],
  ["refused, then degraded", "an unproven follow-up", /could not be proven/],
  ["refused, then degraded", "held input", /not transferred by a degraded adoption/],
] as const)("keeps the bytes and warns once across starts when a %s workflow keeps %s", async (path, input, warning) => {
  const f = fixture()
  if (path === "backed") {
    launchingParent(f)
    launchedWorkflow(f, "session")
    launchCard(f, "session")
  } else {
    chat(f, "live")
    f.workflow("session", "live")
  }
  await recordCompletedRun(f, false)
  if (input === "held input") {
    // v0.0.12 holds a person's text for a completed workflow when its resume
    // fails. A backed workflow keeps that text by design: it gets no
    // ownership fact and no transfer, so no fact of the conversion can carry
    // the move to the parent chat. A degraded adoption moves no input at all.
    const hold = queuedUserInputPut("operator", { target: "workflow" }, { text: "operator text", submissionIds: ["operator"] })
    f.store.putInFlight("session", hold.kind, hold.key, hold.payload)
  } else acceptOlderFollowUp(f.store, "and the docs?")
  f.store.close()
  const db = new Database(f.dbFile)
  try {
    // The older build's committed control row becomes unreadable.
    if (input !== "held input") db.exec("update event set payload = 'not json' where position = (select max(position) from event where aggregate_id = 'workflow:session')")
    // Only the ordinary conversion writes to the recorded parent, so the
    // store refuses it, and the pass retries as a degraded adoption.
    if (path !== "backed") db.exec("create trigger refuse_live before insert on event when NEW.session_id = 'live' begin select raise(abort, 'injected refusal'); end")
  } finally { db.close() }
  const retained = () => {
    const store = createSqliteEventStore(f.dbFile)
    try {
      return { control: store.readTolerant({ aggregateId: "workflow:session" }).map((fact) => fact instanceof Error ? fact.message : fact.id), cells: store.readInFlight("session", QUEUED_USER_INPUT_IN_FLIGHT_KIND) }
    } finally { store.close() }
  }
  const before = retained()
  const warn = adoptionWarnings()
  try {
    expect(workflowChildrenNeedAdoption(f.dbFile)).toBe(path !== "backed")
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: path === "backed" ? 0 : 1, failed: 0 })
    expect(adoptWorkflowChildren(f.dbFile, f.root)).toEqual({ adopted: 0, failed: 0 })
    const retry = /retrying as a degraded adoption/
    expect(warn.mock.calls.filter(([message]) => !retry.test(String(message)))).toEqual([[expect.stringMatching(warning), { sessionId: "session" }]])
  } finally { warn.mockRestore() }
  expect(retained()).toEqual(before)
})
