import { expect, expectTypeOf, spyOn, test } from "bun:test"
import { createEventProjection } from "../../../src/infra/event-projection.js"
import { asAsyncEventReadSurface, CorruptEventRowError, type StoredFact } from "../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js"

interface PositionState {
  positions: number[]
}

const fact = (position: number): StoredFact => ({
  position, id: `evt_${position}`, aggregateId: "session:s1", seq: position - 1,
  type: "wanted", version: 1, timestamp: 1, actor: "test", sessionId: "s1", payload: {},
})

test("folds corrupt history in sequence through the sanctioned reducer", async () => {
  const corrupt = new CorruptEventRowError({
    eventId: "bad", position: 2, aggregateId: "session:s1", sessionId: "s1",
    type: "wanted", version: 1, seq: 1, timestamp: 1, actor: "test", rawPayload: "bad",
  }, "invalid JSON")
  const local = inMemoryEventReader([fact(1), fact(3)])
  const projection = createEventProjection(asAsyncEventReadSurface({
    ...local,
    readTolerant: () => [fact(1), corrupt, fact(3)],
  }), {
    factTypes: ["wanted"],
    initialState: (): PositionState => ({ positions: [] }),
    reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
    reduceCorruptRow: (state, error) => ({ positions: [...state.positions, -error.position] }),
  })
  expect(await projection.apply(fact(3))).toEqual({ positions: [1, -2, 3] })
  expect(await projection.replay()).toEqual({ positions: [1, -2, 3] })
})

test("scoped corruption isolation is opt-in and preserves existing type-filtered reads", async () => {
  const reader = asAsyncEventReadSurface(inMemoryEventReader([
    fact(1), { ...fact(2), aggregateId: "workflow:one" }, { ...fact(3), type: "other" },
  ]))
  const pages = spyOn(reader, "readPage")
  for (const [scope, positions, tolerant] of [
    [{ factTypes: ["wanted"] }, [1, 2], true],
    [{}, [1, 2, 3], false],
    [{ aggregatePrefix: "workflow:", tolerateScopedCorruption: true, seed: () => ({ state: { positions: [] }, position: 0 }) }, [2], true],
    [{ aggregateId: "workflow:one", tolerateScopedCorruption: true }, [2], true],
  ] as const) {
    const projection = createEventProjection(reader, {
      ...scope,
      initialState: (): PositionState => ({ positions: [] }),
      reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
      reduceCorruptRow: (state) => state,
    })
    expect((await projection.replay()).positions).toEqual([...positions])
    expect(pages.mock.calls.at(-1)?.[3]).toBe(tolerant)
    expect(pages.mock.calls.at(-1)?.[0].types).toEqual("factTypes" in scope ? scope.factTypes : undefined)
  }
})

test("an untyped family projection starts from a captured position", () => {
  const reader = asAsyncEventReadSurface(inMemoryEventReader([]))
  const definition = {
    initialState: (): PositionState => ({ positions: [] }),
    reduce: (state: PositionState) => state,
  }
  type Definition = Parameters<typeof createEventProjection<PositionState>>[1]
  // A cold untyped family read walks every workspace row after its first page.
  const cold = { ...definition, aggregatePrefix: "workflow:" }
  expectTypeOf<typeof cold extends Definition ? true : false>().toEqualTypeOf<false>()
  // A seed that may decline also leaves the read cold.
  const declinable = { ...cold, seed: () => undefined }
  expectTypeOf<typeof declinable extends Definition ? true : false>().toEqualTypeOf<false>()
  createEventProjection(reader, { ...definition, aggregatePrefix: "workflow:", factTypes: ["wanted"] })
  createEventProjection(reader, { ...definition, aggregatePrefix: "workflow:", seed: async () => ({ state: { positions: [] }, position: await reader.capturePosition() }) })
})
