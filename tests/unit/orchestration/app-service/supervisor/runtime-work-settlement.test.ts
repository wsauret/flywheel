import { describe, expect, it } from "bun:test"
import { serveChatSettlement } from "../../../../../src/orchestration/app-service/supervisor/runtime-work-settlement.js"
import { runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { deferred } from "../../../../helpers/session-catalog.js"

describe("chat settlement query", () => {
  it("answers busy at once and a settled state only after the root's totals caught up", async () => {
    const totals = deferred<void>()
    let state: "busy" | "complete" = "busy"
    const served = serveChatSettlement({
      client: { query: runtimeQuery({}) },
      settlement: { read: async () => state, onChange: () => () => {} },
      currentTotals: () => totals.promise,
      turnEnding: () => ({ kind: "refused" }),
      bus: { publish: () => undefined },
    })
    expect(await served.query({ type: "chatSettlement", sessionId: "root" })).toEqual({ state: "busy" })
    state = "complete"
    let answered = false
    const answer = served.query({ type: "chatSettlement", sessionId: "root" }).then((result) => { answered = true; return result })
    await Promise.resolve()
    expect(answered).toBe(false)
    totals.resolve()
    expect(await answer).toEqual({ state: "complete", turnEnding: { kind: "refused" } })
    served.release()
  })

  it("wakes waiting clients once for a burst of ownership changes", async () => {
    const listeners = new Set<() => void>()
    const published: unknown[] = []
    const served = serveChatSettlement({
      client: { query: runtimeQuery({}) },
      settlement: { read: async () => "busy", onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
      currentTotals: async () => {}, turnEnding: () => undefined,
      bus: { publish: (patch) => { published.push(patch.payload); return undefined } },
    })
    for (let index = 0; index < 3; index++) for (const listener of listeners) listener()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(published).toEqual([{ kind: "settlement.changed" }])
    served.release()
    expect(listeners.size).toBe(0)
  })
})
