import { describe, expect, it } from "bun:test"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { budgetCursor, isBudgetPayload, type BudgetView, type RuntimeBudgetSnapshotResult } from "../../../../src/protocol/budget-protocol-types.js"
import { createSessionReadingFamily } from "../../../../src/protocol/client/session-reading-family.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"

function budget(tokens: number, averageGenerationTokensPerSecond?: number): BudgetView {
  return { totalsLoading: false, tokens, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 1, contextPromptTokens: 1, ...(averageGenerationTokensPerSecond === undefined ? {} : { averageGenerationTokensPerSecond }) }
}

/** A budget family over a runtime whose reads wait for the test. */
function harness(options: { readonly readsOneSession?: boolean } = {}) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const reads: { readonly sessionIds: readonly string[]; readonly answer: (views: RuntimeBudgetSnapshotResult) => void }[] = []
  const views = new Map<string, BudgetView>()
  const family = createSessionReadingFamily({
    domain: "budget",
    cursor: budgetCursor,
    client: {
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      onLane: lanes.onLane,
    },
    query: (sessionIds) => new Promise<RuntimeBudgetSnapshotResult>((resolve) => { reads.push({ sessionIds, answer: resolve }) }),
    ...(options.readsOneSession ? { readsOneSession: true } : {}),
    isPayload: isBudgetPayload,
    payloadView: (payload) => (payload.kind === "budget.updated" ? payload.budget : null),
    views: {
      get: (sessionId) => views.get(sessionId),
      set: (sessionId, view) => { views.set(sessionId, view) },
      delete: (sessionId) => { views.delete(sessionId) },
      keys: () => views.keys(),
    },
  })
  const emit = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  return {
    family, reads, views,
    sent: () => reads.map((read) => read.sessionIds.join(",")),
    /** The runtime broadcasts a session's first budget, as it does for every running session. */
    broadcast(sessionId: string, tokens: number) {
      emit({ type: "patch", patch: { cursor: budgetCursor(sessionId), position: 1, prevPosition: 0, payload: { kind: "budget.updated", budget: budget(tokens) } } })
    },
    patch(sessionId: string, position: number, tokens: number | null) {
      emit({ type: "patch", patch: { cursor: budgetCursor(sessionId), position, prevPosition: position - 1, payload: tokens === null ? { kind: "budget.removed" } : { kind: "budget.updated", budget: budget(tokens) } } })
    },
    reconnect() { lanes.end(); emit(LANE_BREAK); lanes.open() },
  }
}

const settle = () => Bun.sleep(0)

describe("session reading family", () => {
  it("reads a session the client shows once on each lane, even when a broadcast patch already delivered its view", async () => {
    const h = harness()
    h.broadcast("child", 10)
    expect(h.views.get("child")).toEqual(budget(10))
    expect(h.sent()).toEqual([])

    h.family.ensure(["child"])
    await settle()
    expect(h.sent()).toEqual(["child"])
    h.reads[0]?.answer({ snapshotPosition: 1, views: [{ sessionId: "child", view: budget(10, 50) }] })
    await settle()
    expect(h.views.get("child")).toEqual(budget(10, 50))

    h.family.ensure(["child"])
    await settle()
    expect(h.sent()).toEqual(["child"])
    h.reconnect()
    expect(h.sent()).toEqual(["child", "child"])
    h.family.dispose()
  })

  it("sends every session asked for in one task as one read, or one read each for a domain that reads one session", async () => {
    const batched = harness()
    batched.family.ensure(["a"])
    batched.family.ensure(["b", "a"])
    await settle()
    expect(batched.sent()).toEqual(["a,b"])
    batched.family.dispose()

    const single = harness({ readsOneSession: true })
    single.family.ensure(["a", "b"])
    await settle()
    expect(single.sent()).toEqual(["a", "b"])
    single.family.dispose()
  })

  it("adopts an answer only for the newest read of a session that is still held", async () => {
    const h = harness()
    h.family.ensure(["a", "b"])
    await settle()
    h.family.retire("b")
    h.family.refresh(["a"])
    await settle()
    expect(h.sent()).toEqual(["a,b", "a"])
    h.reads[1]?.answer({ snapshotPosition: 2, views: [{ sessionId: "a", view: budget(2) }] })
    await settle()
    h.reads[0]?.answer({ snapshotPosition: 1, views: [{ sessionId: "a", view: budget(1) }, { sessionId: "b", view: budget(1) }] })
    await settle()
    expect(h.views.get("a")).toEqual(budget(2))
    expect(h.views.has("b")).toBe(false)
    h.family.dispose()
  })

  it("applies the view that follows a removal at once for a session read on this lane, with no read", async () => {
    const h = harness()
    h.family.ensure(["a"])
    await settle()
    h.reads[0]?.answer({ snapshotPosition: 1, views: [{ sessionId: "a", view: budget(1) }] })
    await settle()
    h.patch("a", 2, null)
    expect(h.views.has("a")).toBe(false)
    h.patch("a", 3, 3)
    expect(h.views.get("a")).toEqual(budget(3))
    await settle()
    expect(h.sent()).toEqual(["a"])
    h.family.dispose()
  })
})
