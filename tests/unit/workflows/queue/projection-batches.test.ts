import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { InvariantViolation } from "../../../../src/infra/invariant.js"
import { createWorkflowContextProjection, contextFromProjection } from "../../../../src/workflows/context-bundle/context-projection.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { createLiveWorkflowView, createWorkflowQueueProjection } from "../../../../src/workflows/view/view-projection.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { initializedWorkflowRoot, recoveredWorkflowRoot, storedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"

const queueFacts = queueFactsForState(null, { attempts: [], tree: { nodes: [] }, cursor: 0, status: "idle", mutationLog: [] })
const factories = [createWorkflowQueueProjection, createWorkflowContextProjection]

describe("held workflow projection batches", () => {
  test.each(factories)("cold acquisition validates the root, re-acquisition and catch-up read no root, and replay folds a new one: %p", async (factory) => {
    let rootPayloadReads = 0
    const root = storedWorkflowFacts([initializedWorkflowRoot])[0]!
    const events = [
      { ...root, get payload() { rootPayloadReads += 1; return root.payload } },
      ...storedWorkflowFacts([...queueFacts, buildContextInputSeededFact("workflow", "old")], 1),
    ]
    const reader = inMemoryEventReader(events)
    const projectionReader = asAsyncEventReadSurface(reader)
    const projection = factory(projectionReader, "session")
    await projection.replay()
    // The cold probe validates the newest root, and the first page, which
    // carries that root, checks it again as the page's reset boundary.
    const initialReads = rootPayloadReads
    expect(initialReads).toBe(2)
    for (let index = 0; index < 100; index += 1) expect(factory(projectionReader, "session")).toBe(projection)
    events.push(...storedWorkflowFacts([buildContextInputSeededFact("workflow", "later"), ...queueFacts], 4))
    await projection.replay()
    expect(projection.getPosition()).toBeGreaterThan(40)
    expect(rootPayloadReads).toBe(initialReads)
    events.push(...storedWorkflowFacts([
      recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 11),
      ...queueFacts,
      buildContextInputSeededFact("workflow", "new"),
    ], 7))
    expect(factory(projectionReader, "session")).toBe(projection)
    await projection.replay()
    expect(projection.getPosition()).toBeGreaterThan(80)
  })

  // A launch commits its root in the same append as its first control facts,
  // so only history written before roots existed is rootless.
  test.each(factories)("cold acquisition rejects a rootless aggregate, and a held empty projection folds a later launch: %p", async (factory) => {
    const rootless = asAsyncEventReadSurface(inMemoryEventReader(storedWorkflowFacts(queueFacts)))
    await expect(factory(rootless, "session").replay()).rejects.toThrow(InvariantViolation)
    const events: StoredFact[] = []
    const projectionReader = asAsyncEventReadSurface(inMemoryEventReader(events))
    await factory(projectionReader, "session").replay()
    events.push(...storedWorkflowFacts([initializedWorkflowRoot, ...queueFacts]))
    await expect(factory(projectionReader, "session").replay()).resolves.toBeDefined()
  })

  test.each(factories)("held replay rejects malformed and unsupported newest roots: %p", async (factory) => {
    for (const version of [1, 99]) {
      const events = storedWorkflowFacts([initializedWorkflowRoot, ...queueFacts])
      const reader = inMemoryEventReader(events)
      const projectionReader = asAsyncEventReadSurface(reader)
      await factory(projectionReader, "session").replay()
      events.push({ ...storedWorkflowFacts([recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 4)], 3)[0]!, version, payload: {} })
      await expect(factory(projectionReader, "session").replay()).rejects.toThrow(InvariantViolation)
    }
  })

  test("live first read freshens held state, then reads without SQL and reads no root for a rootless batch", async () => {
    const events = storedWorkflowFacts([initializedWorkflowRoot, ...queueFacts])
    const base = inMemoryEventReader(events)
    let rootReads = 0
    let positions = 0
    const direct = asAsyncEventReadSurface(base)
    const reader: AsyncEventStateReadSurface = {
      ...direct,
      readSlice: async (query, tolerant) => {
        if (tolerant) rootReads += 1
        return direct.readSlice(query, tolerant)
      },
      capturePosition: async () => {
        positions += 1
        return direct.capturePosition()
      },
    }
    await createLiveWorkflowView(reader, "session").read()
    const batch = storedWorkflowFacts(Array.from({ length: 100 }, () => ({
      type: "queue.state.changed" as const, version: 1 as const, actor: "flywheel",
      payload: { status: "paused" as const, cursor: 0 },
    })), 3)
    events.push(...batch)
    const live = createLiveWorkflowView(reader, "session")
    expect((await live.read())?.status).toBe("paused")
    const acquisitions = positions
    for (let index = 0; index < 100; index += 1) await live.read()
    expect(positions).toBe(acquisitions)
    const next = batch.map((fact) => ({ ...fact, position: fact.position + 1000, seq: fact.seq + 100 }))
    events.push(...next)
    rootReads = 0
    await live.apply(next)
    expect(rootReads).toBe(0)
    // A recovery commits its root with the queue it starts from in one batch.
    const root = storedWorkflowFacts([recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 204 + queueFacts.length), ...queueFacts], 203)
    events.push(...root)
    await live.apply(root)
    expect((await live.read())?.status).toBe("idle")
  })

  test("context replay folds a replacement seed before push-fed access", async () => {
    const events = storedWorkflowFacts([initializedWorkflowRoot, buildContextInputSeededFact("workflow", "old")])
    const reader = inMemoryEventReader(events)
    const projectionReader = asAsyncEventReadSurface(reader)
    await createWorkflowContextProjection(projectionReader, "session").replay()
    events.push(...storedWorkflowFacts([
      recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 4),
      buildContextInputSeededFact("workflow", "new"),
    ], 2))
    expect(contextFromProjection(await createWorkflowContextProjection(projectionReader, "session").replay()).request?.original).toBe("new")
  })
})
