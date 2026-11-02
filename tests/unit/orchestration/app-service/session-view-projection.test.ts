import { describe, expect, mock, spyOn, test } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import {
  createSessionViewProjection,
  createSessionViewPublisher,
} from "../../../../src/orchestration/app-service/session-view-projection.js"
import { budgetCursor, type BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { entry, flush, sink, store } from "./_status-projection-fixtures.js"

// The engine is domain-agnostic; the tests ride the budget domain (its view is
// the smallest) and vary only `tokens`.
function view(tokens: number): BudgetView {
  return { totalsLoading: false, tokens, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0 }
}

function publisherConfig(out: ReturnType<typeof sink>) {
  return {
    publish: out.publish,
    cursor: budgetCursor,
    payloads: {
      updated: (budget: BudgetView) => ({ kind: "budget.updated", budget }) as const,
      removed: () => ({ kind: "budget.removed" }) as const,
    },
    same: (a: BudgetView, b: BudgetView) => a.totalsLoading === b.totalsLoading && (a.totalsLoading || b.totalsLoading || a.tokens === b.tokens),
  }
}

function tokenProjection(s: ReturnType<typeof store>, out: ReturnType<typeof sink>, departed?: (sessionId: string) => BudgetView | null) {
  return createSessionViewProjection<BudgetView>({
    ...publisherConfig(out),
    sessionStore: s.store,
    label: "test",
    view: (_id, e) => view(e.tokens),
    ...(departed ? { departed } : {}),
  })
}

describe("session view projection engine", () => {
  test("a change that leaves the view's inputs as they are derives nothing, and the next change of an input derives again", async () => {
    const s = store({ "chat-1": entry({ tokens: 5 }) })
    const out = sink()
    let derived = 0
    let pending: Promise<void> | undefined
    const derivationStarted = Promise.withResolvers<void>()
    const projection = createSessionViewProjection<BudgetView>({
      ...publisherConfig(out), sessionStore: s.store, label: "test",
      view: async (_id, e) => {
        derived++
        if (pending) {
          derivationStarted.resolve()
          await pending
        }
        return view(e.tokens)
      },
      inputs: (_id, e) => [e.tokens],
    })
    try {
      await projection.settled()
      s.set("chat-1", entry({ tokens: 5, streamingOutputChars: 10 }))
      s.set("chat-1", entry({ tokens: 5, streamingOutputChars: 20 }))
      await projection.settled()
      expect(await projection.project("chat-1", s.store.get("chat-1")!)).toEqual(view(5))
      expect(derived).toBe(1)

      s.set("chat-1", entry({ tokens: 6 }))
      await projection.settled()
      await flush()
      expect(derived).toBe(2)
      expect(out.patches.map((patch) => patch.payload)).toEqual([{ kind: "budget.updated", budget: view(6) }])
      expect(await projection.project("chat-1", s.store.get("chat-1")!, { fresh: true })).toEqual(view(6))
      expect(derived).toBe(3)

      const replacement = Promise.withResolvers<void>()
      pending = replacement.promise
      const liveEntry = entry({ tokens: 7 })
      s.set("chat-1", liveEntry)
      await derivationStarted.promise
      liveEntry.tokens = 6
      s.set("chat-1", liveEntry)
      pending = undefined
      replacement.resolve()
      await projection.settled()

      liveEntry.tokens = 7
      s.set("chat-1", liveEntry)
      await projection.settled()
      await flush()
      expect(out.patches.at(-1)?.payload).toEqual({ kind: "budget.updated", budget: view(7) })
    } finally {
      projection.dispose()
    }
  })

  test("seed baselines existing sessions without publishing", async () => {
    const s = store({ "chat-1": entry({ tokens: 5 }) })
    const out = sink()
    const projection = tokenProjection(s, out)
    await flush()

    expect(out.patches).toHaveLength(0)
    expect(await projection.snapshot("chat-1")).toEqual(view(5))
    projection.dispose()
  })

  test("a burst of changes publishes one coalesced patch per session", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const projection = tokenProjection(s, out)

    s.set("chat-1", entry({ tokens: 1 }))
    s.set("chat-1", entry({ tokens: 2 }))
    await flush()

    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]!.payload).toEqual({ kind: "budget.updated", budget: view(2) })
    projection.dispose()
  })

  test("a change that reverts within the batch window publishes nothing", async () => {
    const s = store({ "chat-1": entry({ tokens: 7 }) })
    const out = sink()
    const projection = tokenProjection(s, out)

    s.set("chat-1", entry({ tokens: 9 }))
    s.set("chat-1", entry({ tokens: 7 }))
    await flush()

    expect(out.patches).toHaveLength(0)
    projection.dispose()
  })

  test("a departed session publishes the removed payload and stops tracking", async () => {
    const s = store({ "chat-1": entry({ tokens: 3 }) })
    const out = sink()
    const projection = tokenProjection(s, out)

    s.delete("chat-1")
    await flush()

    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]!.payload).toEqual({ kind: "budget.removed" })

    s.set("other", entry())
    await flush()
    expect(out.patches.filter((patch) => patch.cursor.scope === "session" && patch.cursor.sessionId === "chat-1")).toHaveLength(1)
    projection.dispose()
  })

  test("the departed hook supplies the final view and the equality gate suppresses an unchanged one", async () => {
    const s = store({ "chat-1": entry({ tokens: 3 }) })
    const out = sink()
    const departures: string[] = []
    const projection = tokenProjection(s, out, (sessionId) => {
      departures.push(sessionId)
      return view(3)
    })

    s.delete("chat-1")
    await flush()

    expect(departures).toEqual(["chat-1"])
    expect(out.patches).toHaveLength(0)
    projection.dispose()
  })

  test("a view that fails in the seed or a sync is recorded at WARN, and a later change still publishes", async () => {
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    const s = store({ "chat-1": entry({ tokens: 1 }) })
    const out = sink()
    const projection = createSessionViewProjection<BudgetView>({
      ...publisherConfig(out),
      sessionStore: s.store,
      label: "test",
      view: (_id, e) => {
        if (e.tokens < 3) throw new Error(`view ${e.tokens} unreadable`)
        return view(e.tokens)
      },
    })
    try {
      s.set("chat-1", entry({ tokens: 2 }))
      await flush()
      s.set("chat-1", entry({ tokens: 3 }))
      await flush()

      expect(out.patches.map((patch) => patch.payload)).toEqual([{ kind: "budget.updated", budget: view(3) }])
      expect(record.mock.calls.map(([input]) => input).filter((input) => input.type === "log.warn" || input.type === "log.error")).toEqual([
        expect.objectContaining({ type: "log.warn", payload: expect.objectContaining({ message: "test view seed failed", error: "view 1 unreadable" }) }),
        expect.objectContaining({ type: "log.warn", payload: expect.objectContaining({ message: "test view sync failed", error: "view 2 unreadable" }) }),
      ])
    } finally {
      projection.dispose()
      mock.restore()
    }
  })

  test("dispose stops publishing queued patches", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const projection = tokenProjection(s, out)

    s.set("chat-1", entry({ tokens: 4 }))
    projection.dispose()
    await flush()

    expect(out.patches).toHaveLength(0)
  })
})

describe("session view publisher", () => {
  test("prime records delivery so an equal set publishes nothing and a later removal publishes", async () => {
    const out = sink()
    const publisher = createSessionViewPublisher<BudgetView>(publisherConfig(out))

    publisher.prime("chat-1", view(5))
    publisher.set("chat-1", view(5))
    await flush()
    expect(out.patches).toHaveLength(0)

    publisher.set("chat-1", null)
    await flush()
    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]!.payload).toEqual({ kind: "budget.removed" })
    publisher.dispose()
  })

  test("a prime between enqueue and flush suppresses the duplicate patch", async () => {
    const out = sink()
    const publisher = createSessionViewPublisher<BudgetView>(publisherConfig(out))

    publisher.set("chat-1", view(8))
    publisher.prime("chat-1", view(8))
    await flush()

    expect(out.patches).toHaveLength(0)
    publisher.dispose()
  })
})
