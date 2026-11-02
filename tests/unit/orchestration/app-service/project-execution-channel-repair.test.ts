import { describe, expect, spyOn, test } from "bun:test"
import { Log } from "../../../../src/infra/log.js"
import { connectProjectExecutionChannel } from "../../../../src/orchestration/app-service/project-execution-channel.js"
import { deferred, deliverGaps, endpointPair, manualClock } from "./project-execution-channel-fixtures.js"

describe("project execution output repair", () => {
  test("gaps during a repair coalesce into exactly one serial follow-up", async () => {
    const [peer, endpoint] = endpointPair()
    const client = connectProjectExecutionChannel(endpoint)
    const gates = [deferred<void>(), deferred<void>()]
    let repairs = 0
    let active = 0
    let maxActive = 0
    client.onOutputGap(async () => {
      const gate = gates[repairs++]
      active += 1
      maxActive = Math.max(maxActive, active)
      try { await gate?.promise } finally { active -= 1 }
    })
    try {
      await deliverGaps(peer, client, 1)
      await deliverGaps(peer, client, 3)
      expect(repairs).toBe(1)
      gates[0]!.resolve()
      await deliverGaps(peer, client, 0)
      expect(repairs).toBe(2)
      expect(maxActive).toBe(1)
      gates[1]!.resolve()
      await deliverGaps(peer, client, 0)
      expect(repairs).toBe(2)
      expect(active).toBe(0)
    } finally {
      for (const gate of gates) gate.resolve()
      await client.close()
      peer.close()
    }
  })

  test("failed repairs keep one retry timer even when more gaps arrive, and record the first failure and one count", async () => {
    const warn = spyOn(Log.create({ service: "project-execution-channel" }), "warn").mockImplementation(() => {})
    const [peer, endpoint] = endpointPair()
    const timers = manualClock()
    const client = connectProjectExecutionChannel(endpoint, { clock: timers.clock })
    let gate = deferred<void>()
    let repairs = 0
    let failing = true
    client.onOutputGap(async () => {
      repairs += 1
      await gate.promise
      if (failing) throw new Error("repair unavailable")
    })
    try {
      await deliverGaps(peer, client, 1)
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await deliverGaps(peer, client, 3)
        expect(repairs).toBe(attempt)
        gate.resolve()
        await deliverGaps(peer, client, 0)
        expect(timers.pendingTimers()).toBe(1)
        await deliverGaps(peer, client, 3)
        expect(repairs).toBe(attempt)
        expect(timers.pendingTimers()).toBe(1)
        gate = deferred<void>()
        timers.expireAll()
        expect(repairs).toBe(attempt + 1)
      }
      expect(warn.mock.calls).toEqual([["project execution output repair failed; retrying", { error: "repair unavailable", retryMs: 1_000 }]])
      failing = false
      gate.resolve()
      await deliverGaps(peer, client, 0)
      expect(warn.mock.calls.slice(1)).toEqual([["project execution output repair failed again", expect.objectContaining({ error: "repair unavailable", count: 2 })]])
    } finally {
      warn.mockRestore()
      await client.close()
      gate.resolve()
      timers.expireAll()
      peer.close()
    }
  })
})
