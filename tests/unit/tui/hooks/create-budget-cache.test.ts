import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { budgetCursor, type BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createBudgetCache } from "../../../../src/tui/hooks/create-budget-cache.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

type ReadyBudgetView = Extract<BudgetView, { readonly totalsLoading: false }>

function budget(overrides: Partial<Omit<ReadyBudgetView, "totalsLoading">> = {}): ReadyBudgetView {
  return { totalsLoading: false, tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0, ...overrides }
}

interface InitialBudgets {
  [sessionId: string]: BudgetView
}

function fakeAppService(initial: InitialBudgets = {}) {
  const sequencer = createRuntimeUiPatchSequencer()
  const snapshots = new Map(Object.entries(initial))
  let snapshotCalls = 0
  let listener: ((event: FrontendEvent) => void) | null = null
  let lastPatch: FrontendEvent & { type: "patch" } | null = null

  const query = runtimeQuery({
    budgetSnapshot: async (request) => {
      snapshotCalls += 1
      return { views: request.sessionIds.map((sessionId) => ({ sessionId, view: snapshots.get(sessionId) ?? null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["budget"] }) }
    },
  })
  const lanes = fakeLanes()
  const service = {
    query,
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { listener = null }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">

  return {
    service,
    setSnapshot: (sessionId: string, next: BudgetView) => { snapshots.set(sessionId, next) },
    snapshotCalls: () => snapshotCalls,
    live: (sessionId: string, next: BudgetView) => {
      lastPatch = { type: "patch", patch: sequencer.publish({ cursor: budgetCursor(sessionId), payload: { kind: "budget.updated", budget: next } }) }
      listener?.(lastPatch)
    },
    redeliverLastPatch: () => { if (lastPatch) listener?.(lastPatch) },
    /** The lane broke and a runtime answered the next attach. */
    reconnect: () => {
      lanes.end()
      listener?.({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } } })
      lanes.open()
    },
    skipThenLive: (sessionId: string, next: BudgetView) => {
      sequencer.publish({ cursor: budgetCursor(sessionId), payload: { kind: "budget.updated", budget: budget({ tokens: 1 }) } })
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: budgetCursor(sessionId), payload: { kind: "budget.updated", budget: next } }) })
    },
  }
}

describe("createBudgetCache", () => {
  it("replaces a loading snapshot as one whole budget when the ready patch arrives", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeAppService({ "chat-1": { totalsLoading: true } })
      const cache = createBudgetCache({ appService: fake.service })

      cache.ensure("chat-1")
      await Bun.sleep(0)
      expect(cache.view("chat-1")).toEqual({ totalsLoading: true })

      const ready = budget({ tokens: 25, cost: 0.25, billedCost: 0.1, contextPercent: 40, contextPromptTokens: 500 })
      fake.live("chat-1", ready)
      expect(cache.view("chat-1")).toEqual(ready)
      dispose()
    })
  })

  it("keeps a known budget under a loading view until a ready one replaces it", () => {
    createRoot((dispose) => {
      const fake = fakeAppService()
      const cache = createBudgetCache({ appService: fake.service })
      const known = budget({ tokens: 25, cost: 0.25, contextPromptTokens: 500 })

      fake.live("chat-1", known)
      fake.live("chat-1", { totalsLoading: true })
      expect(cache.view("chat-1")).toEqual(known)

      const next = budget({ tokens: 40, cost: 0.5, contextPromptTokens: 800 })
      fake.live("chat-1", next)
      expect(cache.view("chat-1")).toEqual(next)
      dispose()
    })
  })

  it("keeps a known budget through a reconnect whose runtime is still loading it", async () => {
    await createRoot(async (dispose) => {
      const known = budget({ tokens: 25, cost: 0.25, contextPercent: 15, contextPromptTokens: 500 })
      const fake = fakeAppService({ "chat-1": known })
      const cache = createBudgetCache({ appService: fake.service })
      cache.ensure("chat-1")
      await Bun.sleep(0)

      fake.setSnapshot("chat-1", { totalsLoading: true })
      fake.reconnect()
      await Bun.sleep(1)

      expect(fake.snapshotCalls()).toBeGreaterThan(1)
      expect(cache.view("chat-1")).toEqual(known)
      dispose()
    })
  })

})
