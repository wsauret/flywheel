import { describe, expect, test } from "bun:test"
import type { EventStoreAppend, EventStoreItemSettlement, EventStoreWriteItem, StoredFact } from "../../../../src/infra/event-store-types.js"
import { createEventStoreWriterLane } from "../../../../src/infra/event-store-writer-lane.js"
import { buildSessionContent, type SessionContentReference } from "../../../../src/infra/session-content.js"
import { createSessionRecoveryGate, settlingGuardReads, type OwedRecovery } from "../../../../src/orchestration/app-service/session-recovery-gate.js"

/** A lane over a writer that records each committed fact's type in order. */
function recordingLane() {
  const committed: string[] = []
  let position = 0
  const lane = createEventStoreWriterLane({
    commitItems(items: ReadonlyArray<EventStoreWriteItem>): EventStoreItemSettlement[] {
      return items.map((item) => ({
        kind: "stored",
        events: item.events.map((event): StoredFact => {
          committed.push(event.type)
          position += 1
          return { ...event, id: `fact-${position}`, position, seq: position, version: event.version, payload: event.payload, timestamp: event.timestamp }
        }),
      }))
    },
  })
  return { lane, committed }
}

function fact(sessionId: string, type: string): EventStoreAppend {
  return { aggregateId: `session:${sessionId}`, sessionId, type, version: 1, actor: "flywheel", timestamp: 1, payload: {} }
}

describe("session recovery gate", () => {
  test("a write to an owed session lands after that session's recovery, and the recovery's own writes pass", async () => {
    const { lane, committed } = recordingLane()
    const recovered: OwedRecovery[] = []
    const gate = createSessionRecoveryGate(async (owed) => {
      recovered.push(owed)
      await lane.append(fact(owed.sessionId, "crash.recorded"))
    })
    lane.admitWritesThrough(gate.admission)
    gate.owe([{ sessionId: "cut", cause: "crash" }])

    await lane.append(fact("other", "other.write"))
    await lane.append(fact("cut", "next.write"))
    await lane.append(fact("cut", "later.write"))

    expect(committed).toEqual(["other.write", "crash.recorded", "next.write", "later.write"])
    expect(recovered).toEqual([{ sessionId: "cut", cause: "crash" }])
    expect(gate.owed()).toEqual([])
  })

  test("a recovery that writes another owed session recovers it inside, even when that session's own recovery already waits", async () => {
    const { lane, committed } = recordingLane()
    const recoveries: string[] = []
    const gate = createSessionRecoveryGate(async ({ sessionId }) => {
      recoveries.push(sessionId)
      // The child delivers its result into its parent; the parent pauses the child.
      if (sessionId === "child") await lane.append(fact("parent", "child.result"))
      if (sessionId === "parent") await lane.append(fact("child", "child.paused"))
      await lane.append(fact(sessionId, `${sessionId}.crash`))
    })
    lane.admitWritesThrough(gate.admission)
    gate.owe([{ sessionId: "child", cause: "crash" }, { sessionId: "parent", cause: "crash" }])

    // The child's recovery starts first; the parent's waits behind it in the chain.
    const child = gate.settle(["child"])
    const parent = gate.settle(["parent"])
    await Promise.all([child, parent])

    expect(recoveries).toEqual(["child", "parent"])
    expect(committed).toEqual(["child.paused", "parent.crash", "child.result", "child.crash"])
    expect(gate.owed()).toEqual([])
  })

  test("a recovery whose shared read stages another owed session's content ends, because content staging never waits for a recovery", async () => {
    const { lane, committed } = recordingLane()
    // One read both recoveries join, as they join a held projection's
    // catch-up. Its normalization stages the parent's historical patch text,
    // as mutation evidence recovery does on a page of the parent's facts.
    let shared: Promise<SessionContentReference> | undefined
    function readParentHistory(): Promise<SessionContentReference> {
      shared ??= (async () => {
        await Promise.resolve()
        return await buildSessionContent("historical patch", (rows) => lane.stageSessionContentNodes("parent", rows))
      })()
      return shared
    }
    const gate = createSessionRecoveryGate(async ({ sessionId }) => {
      await readParentHistory()
      if (sessionId === "workflow") await lane.append(fact("parent", "child.result"))
      else await lane.append(fact(sessionId, `${sessionId}.crash`))
    })
    lane.admitWritesThrough(gate.admission)
    gate.owe([{ sessionId: "workflow", cause: "crash" }, { sessionId: "parent", cause: "crash" }])

    const settled = gate.settle(["workflow"]).then(() => "settled")
    expect(await Promise.race([settled, Bun.sleep(20).then(() => "held")])).toBe("settled")
    expect(committed).toEqual(["parent.crash", "child.result"])
    expect(gate.owed()).toEqual([])
  })

  test("a recovery that fails is reported and releases its session to later writes", async () => {
    const { lane, committed } = recordingLane()
    let attempts = 0
    const gate = createSessionRecoveryGate(async () => {
      attempts += 1
      throw new Error("history unreadable")
    })
    lane.admitWritesThrough(gate.admission)
    gate.owe([{ sessionId: "unreadable", cause: "crash" }])

    await lane.append(fact("unreadable", "first.write"))
    await lane.append(fact("unreadable", "second.write"))

    expect(attempts).toBe(1)
    expect(committed).toEqual(["first.write", "second.write"])
  })

  test("a sequence read of an owed session recovers it first, so a write guarded by that read is not refused", async () => {
    const { lane, committed } = recordingLane()
    const sequences = new Map<string, number>()
    const gate = createSessionRecoveryGate(async ({ sessionId }) => {
      await lane.append(fact(sessionId, "crash.recorded"))
      sequences.set(`session:${sessionId}`, (sequences.get(`session:${sessionId}`) ?? 0) + 1)
    })
    lane.admitWritesThrough(gate.admission)
    gate.owe([{ sessionId: "cut", cause: "crash" }])
    const reader = settlingGuardReads({ aggregateSeq: async (aggregateId: string) => sequences.get(aggregateId) ?? 0 }, gate)

    expect(await reader.aggregateSeq("session:cut")).toBe(1)
    expect(await reader.aggregateSeq("project:any")).toBe(0)
    expect(committed).toEqual(["crash.recorded"])
    expect(gate.owed()).toEqual([])
  })

  test("a lane that admits writes through a gate serves no leases", () => {
    const { lane } = recordingLane()
    lane.admitWritesThrough(createSessionRecoveryGate(async () => {}).admission)
    expect(() => lane.lease({ kind: "session", sessionId: "s" })).toThrow("serves no leases")
  })
})
