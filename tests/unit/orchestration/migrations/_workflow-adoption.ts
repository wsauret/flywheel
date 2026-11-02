/** The stores, chats, and older-build histories that the workflow adoption
 *  suites stage, and the readers their assertions use. The fixture is a
 *  module of its own because two suites consume it: the suite of the chat
 *  and card that own a workflow, and the suite of the input that waits in a
 *  workflow. It registers no hook, because a hook in a shared module binds
 *  only to the first suite that imports it. Each suite passes in a
 *  directory that it owns. */

import { expect, spyOn } from "bun:test"
import { join } from "node:path"
import { canonicalDirectory } from "../../../../src/infra/directory-authorities.js"
import type { EventStore } from "../../../../src/infra/event-store-types.js"
import { Log } from "../../../../src/infra/log.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { buildRuntimeWorkflowInvocationAppend } from "../../../../src/orchestration/session/child-session-publication.js"
import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types.js"
import { readConversationSnapshotSync } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage.js"
import { createConversationMessageEntry } from "../../../../src/orchestration/session/conversation/conversation-tree.js"
import { buildSessionChildLinkedFact, buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { recoverSessionMetadata } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { replayDecodedWorkflow, transitionDecodedWorkflow } from "../../../../src/workflows/vm/transition.js"
import { createMemoryStore, initialFacts, recordHistoricalFollowUp, testHost } from "../../workflows/vm/host-test-support.js"
import type { ReplayedSession } from "../../../../src/orchestration/session/schemas.js"

export function previousWorkflowCreatedFact(payload: Extract<ReplayedSession, { kind: "workflow" }>) {
  return { type: "session.created" as const, version: 5 as const, actor: "flywheel" as const, payload }
}

/** A store in `root` and a writer of workflow metadata into it. */
export function adoptionFixture(root: string) {
  const dbFile = join(root, "events.sqlite")
  const store = createSqliteEventStore(dbFile)
  const now = "2026-10-02T00:00:00.000Z"
  const cwd = canonicalDirectory(root, "test")
  const workflow = (id: string, parentSessionId?: string) => store.append(buildSessionMetadataAppend(id, previousWorkflowCreatedFact({
    kind: "workflow", command: "workflow", workflowDefinitionId: "test", label: id,
    lifecycleState: "inactive", lastUpdated: now, createdAt: now, executionCwd: cwd,
    authProfileId: "profile",
    ...(parentSessionId ? { launchedFrom: { parentSessionId } } : {}),
  }), Date.parse(now)))
  return { root, dbFile, store, now, cwd, workflow }
}

type AdoptionFixture = ReturnType<typeof adoptionFixture>

/** Silences the adoption pass's warnings and records them until `mockRestore`. */
export function adoptionWarnings() {
  return spyOn(Log.create({ service: "workflow-child-adoption" }), "warn").mockImplementation(() => {})
}

export function chat(f: AdoptionFixture, id: string) {
  f.store.append(buildSessionMetadataAppend(id, buildSessionCreatedFact({
    kind: "chat", command: "chat", conversationId: `${id}-conversation`,
    label: id, executionCwd: f.cwd, lifecycleState: "inactive", lastUpdated: f.now,
  }), Date.parse(f.now)))
  f.store.appendBatch(ConversationTreeStorage.prepareCreate({ conversationId: `${id}-conversation`, sessionId: id, createdAt: f.now }))
}

/** The chat `parent`, holding the entry that a direct launch's card anchors
 *  to. Adoption reads only that the entry exists. */
export function launchingParent(f: AdoptionFixture) {
  chat(f, "parent")
  parentTurn(f, "anchor")
}

/** Appends the turn `id` after the leaf of `parent`'s chat, in a batch of
 *  its own, and returns the position of that batch. */
export function parentTurn(f: AdoptionFixture, id: string, origin: "human" | "system" = "human"): number {
  const tree = readConversationSnapshotSync(f.store, "parent-conversation")
  f.store.appendBatch(ConversationTreeStorage.prepareAppend({
    conversationId: "parent-conversation", sessionId: "parent", expectedSeq: f.store.aggregateSeq("conversation:parent-conversation") + 1, committed: tree.entriesById,
    entries: [createConversationMessageEntry({ kind: "user", content: id, origin }, id, tree.leafId, f.now)],
  }))
  return f.store.currentPosition()
}

/** A workflow that `parent` launched and linked through the call named by the workflow's id. */
export function launchedWorkflow(f: AdoptionFixture, id: string) {
  f.store.append(buildSessionMetadataAppend(id, previousWorkflowCreatedFact({
    kind: "workflow", command: "workflow", workflowDefinitionId: "test", label: id,
    executionCwd: f.cwd, lifecycleState: "inactive", lastUpdated: f.now,
    launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: id, workflowDefinitionId: "test", description: "work" },
  }), Date.parse(f.now)))
  f.store.append(buildSessionMetadataAppend("parent", buildSessionChildLinkedFact(id, f.now), Date.parse(f.now)))
}

/** The card of a direct launch from `parent` through the call `toolUseId`. */
export function launchCard(f: AdoptionFixture, toolUseId: string) {
  f.store.append(buildRuntimeWorkflowInvocationAppend("parent", {
    initiator: "person", toolUseId, parentConversationId: "parent-conversation", parentEntryId: "anchor",
    operation: { kind: "launch", input: { workflowDefinitionId: "test", description: "work" } },
  }, Date.parse(f.now)))
}

/** The card through which an earlier adoption pass gave `parent` the
 *  workflow `workflowId`, on the call named by the workflow's id. That
 *  build recorded version 1, whose adoption has no words. */
export function adoptionCard(f: AdoptionFixture, workflowId: string) {
  f.store.append({
    aggregateId: "session:parent", sessionId: "parent", type: "tool.runtime_invocation.recorded", version: 1, actor: "flywheel", timestamp: Date.parse(f.now),
    payload: {
      initiator: "migration", toolUseId: workflowId, parentConversationId: "parent-conversation", parentEntryId: "anchor",
      operation: { kind: "adoption", workflowSessionId: workflowId },
    },
  })
}

/** Records a completed run of the host fixture's workflow `session`, and
 *  the person's accepted follow-up when asked, as an older build stored it. */
export async function recordCompletedRun(f: AdoptionFixture, followUp: boolean) {
  const memory = createMemoryStore(initialFacts())
  const host = testHost(memory, {
    attemptRunner: { run: async (input, active) => ({
      kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
      handoff: { summary: "done" }, reassessment: null,
    }) },
  })
  try {
    expect((await host.run()).kind).toBe("completed")
  } finally { await host.dispose() }
  if (followUp) {
    await recordHistoricalFollowUp(memory, {
      identity: { kind: "identified", inputID: "accepted-input" },
      input: { text: "accepted", origin: "human", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "YWJj" }], invocation: { label: "review", args: "arg" }, submissionIds: ["submission"] },
    }, { pausedReason: "paused for migration" })
  }
  f.store.appendBatch(memory.events.map(({ type, version, actor, payload, timestamp, sessionId, aggregateId }) => ({ type, version, actor, payload, timestamp, sessionId, aggregateId })))
}

/** Commits a follow-up into the completed workflow `session` as v0.0.12
 *  does: the request and its committed control, at v0.0.12's version. */
export function acceptOlderFollowUp(store: EventStore, text: string) {
  const completed = replayWorkflowControl(store.read({ aggregateId: "workflow:session" }))
  const requested = transitionDecodedWorkflow(replayDecodedWorkflow(completed), {
    type: "FOLLOW_UP_REQUESTED", input: { text, origin: "human" }, identity: { kind: "identified", inputID: "older-input" },
    conversationId: "conversation-1", requestSequence: 1,
  }, 4)
  if (requested.command.kind !== "commit") throw new Error("expected a follow-up commit")
  store.appendBatch(requested.command.proposal.facts.map((fact) => ({ ...fact, aggregateId: "workflow:session", sessionId: "session", timestamp: Date.now() })))
}

/** The entries of the conversation's current branch, oldest first. */
export function branch(store: EventStore, conversationId: string): ConversationEntry[] {
  const tree = readConversationSnapshotSync(store, conversationId)
  const entries: ConversationEntry[] = []
  for (let id = tree.leafId; id !== null;) {
    const entry = tree.entriesById[id]
    if (!entry) throw new Error(`branch entry ${id} is missing`)
    entries.unshift(entry)
    id = entry.parentId
  }
  return entries
}

/** The workflow's adopted binding and the chat that owns it. */
export function owner(store: EventStore, workflowId: string) {
  const binding = recoverSessionMetadata(store, workflowId)?.launchedFrom
  const parent = binding ? recoverSessionMetadata(store, binding.parentSessionId) : null
  if (!binding?.toolUseId || parent?.kind !== "chat") throw new Error(`${workflowId} has no owning chat`)
  return { binding: { ...binding, toolUseId: binding.toolUseId }, parent }
}

/** The text a message entry shows, or its id for any other entry. */
export function described(entry: ConversationEntry): string {
  if (entry.kind !== "message") return entry.id
  const { message } = entry
  if (message.kind !== "user" && message.kind !== "assistant") return message.kind
  const content = typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : block.type).join("+")
  return `${message.kind}/${message.kind === "user" ? message.origin ?? "" : ""}:${content}`
}
