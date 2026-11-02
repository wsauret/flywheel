import { describe, expect, test } from "bun:test"
import { createEventProjection } from "../../../src/infra/event-projection.js"
import { heldProjection, pinHeldProjection, releaseHeldProjections } from "../../../src/infra/projection-registry.js"
import { asAsyncEventReadSurface, type EventReader, type StoredFact } from "../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js"

function facts(count: number, from = 0): StoredFact[] {
  return Array.from({ length: count }, (_, i) => ({
    position: from + i + 1,
    id: `evt_${from + i}`,
    aggregateId: "session:s1",
    seq: from + i + 1,
    type: "noted",
    version: 1,
    timestamp: 1,
    actor: "flywheel",
    sessionId: "s1",
    payload: {},
  }))
}

const counting = { initialState: () => ({ n: 0 }), reduce: (state: { n: number }) => ({ n: state.n + 1 }) }

/** A reader that records every read starting from position zero, which is the
 *  cost the registry exists to stop paying more than once. */
function countingReader(events: StoredFact[]) {
  const base = inMemoryEventReader(events)
  let foldsFromZero = 0
  return {
    reader: asAsyncEventReadSurface({
      ...base,
      read: (query) => {
        if ((query?.afterPosition ?? 0) === 0) foldsFromZero += 1
        return base.read(query)
      },
    } satisfies EventReader),
    foldsFromZero: () => foldsFromZero,
  }
}

describe("projection registry", () => {
  test("a second ask reuses the first projection instead of refolding", async () => {
    const events = facts(5)
    const { reader, foldsFromZero } = countingReader(events)
    const build = () => heldProjection(reader, "counting:s1", () => createEventProjection(reader, counting))

    const first = build()
    expect(foldsFromZero()).toBe(0)
    await first.replay()
    expect(first.getState().n).toBe(5)
    const afterFirst = foldsFromZero()

    for (let i = 0; i < 10; i += 1) expect(build()).toBe(first)
    expect(foldsFromZero()).toBe(afterFirst)
  })

  test("a reused projection still folds facts committed since it was built", async () => {
    const events = facts(3)
    const { reader } = countingReader(events)
    const build = () => heldProjection(reader, "counting:s1", () => createEventProjection(reader, counting))

    expect((await build().replay()).n).toBe(3)
    events.push(...facts(2, 3))
    // replay, not getState: the registry owns lifetime, so asking for current
    // state is what folds the suffix.
    expect((await build().replay()).n).toBe(5)
  })

  test("different keys never share a projection", () => {
    const { reader } = countingReader(facts(2))
    const a = heldProjection(reader, "counting:a", () => createEventProjection(reader, counting))
    const b = heldProjection(reader, "counting:b", () => createEventProjection(reader, counting))
    expect(a).not.toBe(b)
  })

  test("different readers never share a projection", () => {
    const one = countingReader(facts(2))
    const two = countingReader(facts(2))
    const a = heldProjection(one.reader, "counting:s1", () => createEventProjection(one.reader, counting))
    const b = heldProjection(two.reader, "counting:s1", () => createEventProjection(two.reader, counting))
    expect(a).not.toBe(b)
  })

  test("releasing makes the next ask build fresh, which is a fresh reader's case", () => {
    const { reader } = countingReader(facts(4))
    const build = () => heldProjection(reader, "counting:s1", () => createEventProjection(reader, counting))
    const first = build()
    releaseHeldProjections(reader)
    expect(build()).not.toBe(first)
  })

  test("eviction under pressure is safe: a dropped entry rebuilds correctly", async () => {
    const events = facts(4)
    const { reader } = countingReader(events)
    const build = (key: string) => heldProjection(reader, key, () => createEventProjection(reader, counting))

    const first = build("counting:keep")
    // Push well past the hold limit so the first entry is evicted.
    for (let i = 0; i < 100; i += 1) build(`counting:filler-${i}`)
    const rebuilt = build("counting:keep")

    expect(rebuilt).not.toBe(first)
    // Never wrong, only slower: the rebuild folds the same history.
    expect((await rebuilt.replay()).n).toBe(4)
  })

  test("a pinned key survives churn past its family's bound until its last pin is released", () => {
    const { reader } = countingReader(facts(2))
    const build = (key: string) => heldProjection(reader, key, () => createEventProjection(reader, counting))
    const churn = (round: number) => { for (let i = 0; i < 12; i += 1) build(`conversation-tree:filler-${round}-${i}`) }

    const unpinned = build("conversation-tree:unpinned")
    const releaseFirst = pinHeldProjection(reader, "conversation-tree:pinned")
    const releaseSecond = pinHeldProjection(reader, "conversation-tree:pinned")
    const pinned = build("conversation-tree:pinned")
    churn(0)
    expect(build("conversation-tree:pinned")).toBe(pinned)
    expect(build("conversation-tree:unpinned")).not.toBe(unpinned)

    // A release is idempotent, so a second call of the first release does not
    // take the other holder's pin.
    releaseFirst()
    releaseFirst()
    churn(1)
    expect(build("conversation-tree:pinned")).toBe(pinned)

    releaseSecond()
    churn(2)
    expect(build("conversation-tree:pinned")).not.toBe(pinned)
  })

  test("a pin that drops on its last release leaves the next ask a fresh build", () => {
    const { reader } = countingReader(facts(2))
    const build = () => heldProjection(reader, "counting:s1", () => createEventProjection(reader, counting))
    const releaseFirst = pinHeldProjection(reader, "counting:s1", { dropOnLastRelease: true })
    const releaseSecond = pinHeldProjection(reader, "counting:s1", { dropOnLastRelease: true })
    const first = build()
    releaseFirst()
    expect(build()).toBe(first)
    releaseSecond()
    expect(build()).not.toBe(first)
  })

  test("a heavy family is held to a tighter bound than a light one", () => {
    // Measured on a real workspace: a budget projection is 10 KB and a
    // conversation tree 5 MB, so one count across both is either wasteful or
    // hundreds of megabytes. The key's family is what carries that difference.
    const { reader } = countingReader(facts(2))
    const build = (key: string) => heldProjection(reader, key, () => createEventProjection(reader, counting))

    const firstHeavy = build("conversation-tree:c0")
    for (let i = 1; i <= 12; i += 1) build(`conversation-tree:c${i}`)
    // Past the heavy bound of eight, so the first one is gone.
    expect(build("conversation-tree:c0")).not.toBe(firstHeavy)

    const firstLight = build("budget:s0")
    for (let i = 1; i <= 12; i += 1) build(`budget:s${i}`)
    // Well inside the default bound, so the same projection comes back.
    expect(build("budget:s0")).toBe(firstLight)
  })

  test("families never evict each other", () => {
    const { reader } = countingReader(facts(2))
    const build = (key: string) => heldProjection(reader, key, () => createEventProjection(reader, counting))

    const budget = build("budget:s1")
    // Churn a heavy family well past its bound; a different family is untouched.
    for (let i = 0; i < 40; i += 1) build(`conversation-tree:c${i}`)
    expect(build("budget:s1")).toBe(budget)
  })
})
