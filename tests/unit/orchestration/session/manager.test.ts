import { afterEach, describe, expect, it } from "bun:test"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { buildSessionMetadataAppend, createSessionMetadataStore } from "../../../../src/orchestration/session/session-metadata-store"
import { cleanupTmpRoot, makeTmpDir, minimalSession } from "./_session-manager-fixtures"


const ownedStores: EventStore[] = []
afterEach(() => {
  for (const store of ownedStores.splice(0)) store.close()
  cleanupTmpRoot()
})

function makeStore(baseDir: string): ReturnType<typeof createSessionMetadataStore> {
  const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  ownedStores.push(eventStore)
  return createSessionMetadataStore({ reader: asAsyncEventReadSurface(eventStore), writer: asAsyncEventWriter(eventStore) })
}

// The production delete shape (SessionManager.delete): an unconditional
// tombstone appended without reading current state, so a corrupt session
// never blocks its own removal.
function deletedTombstone(id: string) {
  return buildSessionMetadataAppend(id, {
    type: "session.deleted",
    version: 1,
    actor: "flywheel",
    payload: { lastUpdated: new Date().toISOString() },
  })
}

// SessionMetadataStore — Theme 2: idempotent for missing aggregates.
//
// Writes against a missing session row return `false`. Real failures (e.g.
// invalid kind for chat metadata) still throw. This lets callers stop wrapping
// every metadata write in try/catch — the producer is the source of truth.

describe("SessionMetadataStore idempotent writes for missing aggregates", () => {
  it("updateLabel returns false when the session row does not exist", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)

    const result = await store.updateLabel("non-existent", { label: "L", shortLabel: "S" }, "generated")

    expect(result).toBe(false)
  })

  it("updateLabel returns false when the new labels match the existing row (no-op)", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)
    const id = await store.create(minimalSession({ label: "Same", name: "Same", shortLabel: "Sm" }))

    const result = await store.updateLabel(id, { label: "Same", shortLabel: "Sm" }, "generated")

    expect(result).toBe(false)
  })

  it("a user rename marks the session user-named and refuses later generated titles", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)
    const id = await store.create(minimalSession())

    expect(await store.updateLabel(id, { label: "My Chat", shortLabel: "My" }, "user")).toBe(true)
    expect((await store.readOrThrow(id)).userNamed).toBe(true)

    expect(await store.updateLabel(id, { label: "Generated Title", shortLabel: "Gen" }, "generated")).toBe(false)
    expect((await store.readOrThrow(id)).label).toBe("My Chat")
  })

  it("a user rename to the already-current labels still marks the session user-named", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)
    const id = await store.create(minimalSession({ label: "Same", name: "Same", shortLabel: "Sm" }))

    expect(await store.updateLabel(id, { label: "Same", shortLabel: "Sm" }, "user")).toBe(true)
    expect((await store.readOrThrow(id)).userNamed).toBe(true)

    // A repeat of the identical user rename is now a true no-op.
    expect(await store.updateLabel(id, { label: "Same", shortLabel: "Sm" }, "user")).toBe(false)
  })

  it("the projection refuses a generated label fact that committed after a user rename", async () => {
    // Simulates the async-writer race: a generated title fact lands in the log
    // AFTER the user rename (bypassing updateLabel's pre-append gate). The
    // reducer must refuse it at apply and replay time -- user naming wins.
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)
    const id = await store.create(minimalSession())
    await store.updateLabel(id, { label: "My Chat", shortLabel: "My" }, "user")

    await store.appendFacts([{
      aggregateId: `session:${id}`,
      type: "session.label.updated",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: id,
      payload: { label: "Generated Title", shortLabel: "Gen", name: "Generated Title", lastUpdated: new Date().toISOString() },
    }])

    expect((await store.readOrThrow(id)).label).toBe("My Chat")
  })

  it("updateChatMetadata returns false when the session row does not exist", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)

    const result = await store.updateChatMetadata("non-existent", { providerConversationId: "c-1" })

    expect(result).toBe(false)
  })

  it("transitionLifecycle reports missing when the session row does not exist", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)

    const result = await store.transitionLifecycle("non-existent", "inactive")

    expect(result.kind).toBe("missing")
  })

  it("transitionLifecycle reports the transition when the row exists and lifecycle changed", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)
    const id = await store.create(minimalSession({ lifecycleState: "active" }))

    const result = await store.transitionLifecycle(id, "inactive")

    expect(result).toEqual({ kind: "transitioned", from: "active", to: "inactive" })
    expect((await store.readOrThrow(id)).lifecycleState).toBe("inactive")
  })

  it("transitionLifecycle reports noop for a same-state request without appending", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)
    const id = await store.create(minimalSession({ lifecycleState: "active" }))

    const result = await store.transitionLifecycle(id, "active")

    expect(result.kind).toBe("noop")
  })

  it("transitionLifecycle is atomic: two concurrent transitions from the same state -- exactly one wins", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)
    const id = await store.create(minimalSession({ lifecycleState: "active" }))

    // Both race from "active". active->inactive is valid; active->active is a
    // noop. If validation read a stale snapshot across the append's await, both
    // could observe "active" and both treat their request as fresh. The atomic
    // critical section guarantees the second sees the first's committed state.
    const [a, b] = await Promise.all([
      store.transitionLifecycle(id, "inactive"),
      store.transitionLifecycle(id, "inactive"),
    ])

    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(["noop", "transitioned"])
    expect((await store.readOrThrow(id)).lifecycleState).toBe("inactive")
  })

  it("transitionLifecycle carries its transition past another fact of the session that lands during it", async () => {
    const baseDir = makeTmpDir()
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    ownedStores.push(eventStore)
    const store = createSessionMetadataStore({ reader: asAsyncEventReadSurface(eventStore), writer: asAsyncEventWriter(eventStore) })
    const id = await store.create(minimalSession({ lifecycleState: "active" }))

    // The session's duration lands after the transition read the session's
    // sequence and before it appends, as a stop's close meets it.
    const transition = store.transitionLifecycle(id, "inactive")
    eventStore.append({ aggregateId: `session:${id}`, type: "session.duration.recorded", version: 1, timestamp: Date.now(), actor: "flywheel", sessionId: id, payload: { accumulatedActiveMs: 5 } })

    expect(await transition).toEqual({ kind: "transitioned", from: "active", to: "inactive" })
    expect((await store.readOrThrow(id)).lifecycleState).toBe("inactive")
  })

  it("a tombstone append for a never-existed session does not throw", async () => {
    const baseDir = makeTmpDir()
    const store = makeStore(baseDir)

    await expect(store.appendFacts([deletedTombstone("non-existent")])).resolves.toHaveLength(1)
  })

})
