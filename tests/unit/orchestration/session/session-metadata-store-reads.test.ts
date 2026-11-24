import { describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/store/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/store/sqlite-event-store.js"
import { buildSessionMetadataAppend, createSessionMetadataStore, createSessionPlacements } from "../../../../src/orchestration/session/metadata/catalog/session-metadata-store.js"
import { buildSessionCreatedFact, buildSessionOwnershipAdoptedFact } from "../../../../src/orchestration/session/metadata/session-metadata-facts.js"
import { createSessionMetadataProjection, createSessionPlacementProjection, sessionMetadataStateOf } from "../../../../src/orchestration/session/metadata/session-metadata-projection.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { entriesVisited } from "../../../helpers/entries-visited.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"
import { minimalSession } from "./_session-persistence-fixtures.js"

const temporary = temporaryDirectories()

describe("SessionMetadataStore targeted reads", () => {
  it("read the changed session's new facts only, whatever the session count", async () => {
    const factsPerChange = async (sessions: number) => {
      const root = temporary("metadata-store-reads-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(root))
      try {
        const { reader, take } = countStateRequests(asAsyncEventReadSurface(store))
        const metadata = createSessionMetadataStore({ reader, writer: asAsyncEventWriter(store) })
        const ids: string[] = []
        for (let index = 0; index < sessions; index++) {
          ids.push(await metadata.create(minimalSession({ label: `s${index}` })))
        }
        await metadata.list()
        const perChange: number[] = []
        // Each change names the next session in turn, as the agents of one
        // workflow do, and its reader then reads that session.
        for (let change = 0; change < sessions * 2; change++) {
          const id = ids[change % sessions]!
          store.append(buildSessionMetadataAppend(id, { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: `change-${change}`, shortLabel: `change-${change}`, name: `change-${change}`, lastUpdated: "2026-01-01T00:00:00.000Z" } }))
          take()
          expect((await metadata.read(id))?.label).toBe(`change-${change}`)
          perChange.push(factsRead(take()))
        }
        return Math.max(...perChange.slice(sessions))
      } finally {
        store.close()
      }
    }
    // Eighty sessions exceeds the sixty-four single-session projections the registry holds.
    expect(await factsPerChange(80)).toBe(await factsPerChange(4))
  })

  it("serves placements without a durable read until a placement fact commits, and sees an adoption after skipped batches", async () => {
    const root = temporary("metadata-store-placements-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    try {
      const base = asAsyncEventReadSurface(store)
      const metadata = createSessionMetadataStore({ reader: base, writer: asAsyncEventWriter(store) })
      const first = await metadata.create(minimalSession({ label: "first" }))
      const second = await metadata.create(minimalSession({ label: "second" }))
      const child = await metadata.create({ ...minimalSession({ label: "child" }), kind: "subagent", command: "subagent", launchedFrom: { parentSessionId: first, conversationId: "first-conversation", toolUseId: "dispatch" } })
      const { reader, take } = countStateRequests(base)
      const placements = createSessionPlacements(reader)
      expect((await placements.placement(child))?.launchedFrom?.parentSessionId).toBe(first)
      take()
      // A running child commits on every step; none of it moves the child.
      for (let change = 0; change < 5; change++) {
        placements.observe([store.append(buildSessionMetadataAppend(child, { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: `step-${change}`, shortLabel: `step-${change}`, name: `step-${change}`, lastUpdated: "2026-01-01T00:00:00.000Z" } }))])
        expect((await placements.placement(child))?.launchedFrom?.parentSessionId).toBe(first)
      }
      expect(take()).toEqual([])
      placements.observe([store.append(buildSessionMetadataAppend(child, buildSessionOwnershipAdoptedFact(second, "second-conversation", "adopt", "2026-01-02T00:00:00.000Z")))])
      expect((await placements.placement(child))?.launchedFrom?.parentSessionId).toBe(second)
      expect(take().length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it("folds a placement change through the same entries whatever the session count", async () => {
    // Every adoption, retirement, and deletion folds into the held
    // placements: a fold that copied every session made each move cost the
    // whole workspace.
    const visitsPerChange = async (sessions: number) => {
      const root = temporary("metadata-store-placement-cost-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(root))
      try {
        const reader = asAsyncEventReadSurface(store)
        const metadata = createSessionMetadataStore({ reader, writer: asAsyncEventWriter(store) })
        const ids: string[] = []
        for (let index = 0; index < sessions; index++) ids.push(await metadata.create(minimalSession({ label: `s${index}` })))
        const [first, second] = ids
        if (first === undefined || second === undefined) throw new Error("the workspace holds fewer than two sessions")
        const child = await metadata.create({ ...minimalSession({ label: "child" }), kind: "subagent", command: "subagent", launchedFrom: { parentSessionId: first, conversationId: "first-conversation", toolUseId: "dispatch" } })
        const placements = createSessionPlacements(reader)
        expect((await placements.placement(child))?.launchedFrom?.parentSessionId).toBe(first)
        return await entriesVisited(async () => {
          placements.observe([store.append(buildSessionMetadataAppend(child, buildSessionOwnershipAdoptedFact(second, "second-conversation", "adopt", "2026-01-02T00:00:00.000Z")))])
          expect((await placements.placement(child))?.launchedFrom?.parentSessionId).toBe(second)
        }, { state: createSessionPlacementProjection(reader).getState() })
      } finally {
        store.close()
      }
    }
    expect(await visitsPerChange(40)).toBe(await visitsPerChange(4))
  })

  it("a catch-up that changes 1 of 5,000 sessions visits the entries of 1 of 4 and leaves the other 4,999 identical by reference", async () => {
    // The workspace catalog folds on every metadata commit of any session; a
    // catch-up that copied every session made each label change cost the
    // whole workspace.
    const catchUp = async (sessions: number) => {
      const root = temporary("metadata-catalog-copy-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(root))
      try {
        const ids = Array.from({ length: sessions }, (_, index) => `s${index}`)
        store.appendBatch(ids.map((id) => buildSessionMetadataAppend(id, buildSessionCreatedFact(minimalSession({ label: id })))))
        const catalog = createSessionMetadataProjection(asAsyncEventReadSurface(store))
        const before = await catalog.replay()
        const visits = await entriesVisited(async () => {
          store.append(buildSessionMetadataAppend("s0", { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: "changed", shortLabel: "changed", name: "changed", lastUpdated: "2026-01-01T00:00:00.000Z" } }))
          await catalog.replay()
        }, { state: before })
        const after = catalog.getState()
        expect(sessionMetadataStateOf(after, "s0").sessions.s0?.label).toBe("changed")
        expect(ids.slice(1).filter((id) => sessionMetadataStateOf(after, id) !== sessionMetadataStateOf(before, id))).toEqual([])
        return visits
      } finally {
        store.close()
      }
    }
    expect(await catchUp(5_000)).toBe(await catchUp(4))
  })

  it("sees a placement that another process committed once it observes a later batch", async () => {
    const root = temporary("metadata-store-foreign-placement-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    // A headless run shares the project's store through its own connection,
    // whose commits this connection never announces.
    const other = createSqliteEventStore(resolveEventStoreDbFile(root))
    try {
      const reader = asAsyncEventReadSurface(store)
      const metadata = createSessionMetadataStore({ reader, writer: asAsyncEventWriter(store) })
      const first = await metadata.create(minimalSession({ label: "first" }))
      const second = await metadata.create(minimalSession({ label: "second" }))
      const child = await metadata.create({ ...minimalSession({ label: "child" }), kind: "subagent", command: "subagent", launchedFrom: { parentSessionId: first, conversationId: "first-conversation", toolUseId: "dispatch" } })
      const placements = createSessionPlacements(reader)
      expect((await placements.placement(child))?.launchedFrom?.parentSessionId).toBe(first)
      other.append(buildSessionMetadataAppend(child, buildSessionOwnershipAdoptedFact(second, "second-conversation", "adopt", "2026-01-02T00:00:00.000Z")))
      placements.observe([store.append(buildSessionMetadataAppend(child, { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: "after", shortLabel: "after", name: "after", lastUpdated: "2026-01-03T00:00:00.000Z" } }))])
      expect((await placements.placement(child))?.launchedFrom?.parentSessionId).toBe(second)
    } finally {
      other.close()
      store.close()
    }
  })
})
