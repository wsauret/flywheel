import { expect, spyOn, test } from "bun:test"
import type { EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { createSessionChangesPublisher } from "../../../../src/orchestration/app-service/session-changes-publisher.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import type { RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { withStore } from "../session/file-mutation-recovery-fixture.js"
import type { SessionPlacement, SessionPlacements } from "../../../../src/orchestration/session/session-metadata-store.js"
import { entries, human, mutation, row } from "../session/_session-change-fixtures.js"

function event(type: string, sessionId = "s", aggregateId = `session:${sessionId}`): EventStoreAppend {
  return { type, sessionId, aggregateId, timestamp: 1, version: 1, actor: "flywheel", payload: {} }
}

/** Where sessions sit, without a store: each session names its kind and the session that launched it. */
function placements(tree: { readonly [id: string]: readonly [SessionPlacement["kind"], string?] } = {}): SessionPlacements & { observed: number } {
  const value = {
    observed: 0,
    async placement(id: string): Promise<SessionPlacement | null> {
      const place = tree[id]
      if (!place) return null
      const [kind, parentSessionId] = place
      const placement: SessionPlacement = { kind, ...(parentSessionId === undefined ? {} : { launchedFrom: { parentSessionId, conversationId: `${parentSessionId}-c`, toolUseId: `launch-${id}` } }) }
      return placement
    },
    observe() { value.observed++ },
  }
  return value
}

/** Lets the publisher's walk of the tree settle. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

test("one committed batch invalidates each affected session once without acquiring history", async () => {
  await withStore(async ({ store }) => {
    store.append(mutation(1, "old"))
    const read = spyOn(store, "read")
    const tolerant = spyOn(store, "readTolerant")
    const subscription = spyOn(store, "onStored")
    const sequencer = createRuntimeUiPatchSequencer()
    const patches: RuntimeUiPatch[] = []
    const tree = placements()
    const publisher = createSessionChangesPublisher({ onStored: store.onStored, publish: input => { patches.push(sequencer.publish(input)) }, sessionPlacements: tree })
    expect(subscription).toHaveBeenCalledTimes(1)
    expect(patches).toEqual([])
    const types = ["file.changed", "file.reviewed", "file.artifact.recorded", "tool.result.recorded"]
    store.appendBatch([...types.map(type => event(type)), event("file.changed", "other"), event("workflow.control.committed", "workflow", "workflow:workflow")])
    await settled()
    expect(tree.observed).toBe(1)
    expect(patches.map(patch => patch.cursor)).toEqual([
      { scope: "session", domain: "changes", sessionId: "s" },
      { scope: "session", domain: "changes", sessionId: "other" },
      { scope: "session", domain: "changes", sessionId: "workflow" },
    ])
    expect(patches.every(patch => JSON.stringify(patch.payload) === '{"kind":"changes.changed"}')).toBe(true)
    for (const type of types) store.append(event(type))
    await settled()
    expect(patches).toHaveLength(3 + types.length)
    for (const type of ["model.response_received", "memory.written", "skill.written", "chat.tree.created", "prompt.assembled", "child_run.created"]) store.append(event(type))
    store.append({ ...entries(1, [human(crypto.randomUUID())]), sessionId: "s" })
    store.append(event("workflow.control.committed", "s", "workflow:someone-else"))
    await settled()
    expect(patches).toHaveLength(3 + types.length)
    expect(store.appendBatchGuarded([event("file.changed"), { ...event("file.changed"), expectedSeq: 999 }])).toMatchObject({ kind: "conflict" })
    expect(patches).toHaveLength(3 + types.length)
    publisher.dispose()
    store.append(event("file.changed"))
    await settled()
    expect(patches).toHaveLength(3 + types.length)
    expect(read).not.toHaveBeenCalled()
    expect(tolerant).not.toHaveBeenCalled()
    read.mockRestore(); tolerant.mockRestore(); subscription.mockRestore()
  })
})

test("repeated paths and a cold Undo each invalidate once per commit", async () => {
  await withStore(async ({ store }) => {
    const patches: RuntimeUiPatch[] = []
    const sequencer = createRuntimeUiPatchSequencer()
    const publisher = createSessionChangesPublisher({ onStored: store.onStored, publish: input => { patches.push(sequencer.publish(input)) }, sessionPlacements: placements() })
    store.append(mutation(1, "first"))
    store.append(mutation(2, "second"))
    const undo = mutation(3, "undo")
    undo.payload.origin = { kind: "user_undo", reviewRevision: 2, fileId: "file:first", sourceMutationIds: ["m-1", "m-2"] }
    store.appendBatch([undo, row(4, "file.artifact.recorded", { mutationId: "m-3", artifactId: "undo-diff", ownerKind: "runtime", ownerId: "undo", artifactKind: "mutation_diff", path: "/root/a", mutation: { version: 1, files: [], omissions: [] } }, 3)])
    await settled()
    expect(patches).toHaveLength(3)
    expect(patches.map(patch => patch.prevPosition)).toEqual([0, 1, 2])
    publisher.dispose()
  })
})

test("a launched session's change also invalidates the review of every session that launched it, and a fork's stays apart", async () => {
  await withStore(async ({ store }) => {
    const patches: RuntimeUiPatch[] = []
    const sequencer = createRuntimeUiPatchSequencer()
    const tree = placements({ chat: ["chat"], agent: ["workflow-agent", "chat"], helper: ["subagent", "agent"], fork: ["chat", "chat"], forkHelper: ["subagent", "fork"] })
    const publisher = createSessionChangesPublisher({ onStored: store.onStored, publish: input => { patches.push(sequencer.publish(input)) }, sessionPlacements: tree })
    store.append(event("file.changed", "helper"))
    await settled()
    expect(patches.map(patch => patch.cursor.scope === "session" ? patch.cursor.sessionId : undefined)).toEqual(["helper", "agent", "chat"])
    patches.length = 0
    // A new link or title of a launched session changes the reviews that show its files.
    store.appendBatch([event("session.label.updated", "agent"), event("file.changed", "forkHelper")])
    await settled()
    expect(patches.map(patch => patch.cursor.scope === "session" ? patch.cursor.sessionId : undefined)).toEqual(["agent", "chat", "forkHelper", "fork"])
    publisher.dispose()
  })
})
