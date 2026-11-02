import { describe, expect, test } from "bun:test"
import { createExecutorLifecycleRequests } from "../../../../src/orchestration/app-service/executor-lifecycle-requests.js"

const never = new Promise<never>(() => {})

describe("account lifecycle requests of one executor generation", () => {
  test("a lost transport fails a capacity continuation in flight, so the wake asks again, and leaves a handoff waiting for its answer", async () => {
    const requests = createExecutorLifecycleRequests(undefined)
    const sent: unknown[] = []
    const send = async (message: unknown) => { sent.push(message) }
    const continuation = requests.continueCapacityWaits(send, never)
    const handoff = requests.handoff(send, "continue_after_replacement", "h1", never)
    await Bun.sleep(0)
    expect(sent).toEqual([{ kind: "continue_capacity_waits", id: 1 }, { kind: "continue_after_replacement", handoffId: "h1", id: 2 }])

    requests.detached(new Error("socket closed"))
    await expect(continuation).rejects.toThrow("socket closed")
    requests.hear({ kind: "handoff", id: 2, sessionIds: ["chat-1"] }, send)
    expect(await handoff).toEqual(["chat-1"])

    const again = requests.continueCapacityWaits(send, never)
    await Bun.sleep(0)
    requests.hear({ kind: "capacity_continued", id: 3, pending: 0, at: 1_000, next: 2_000 }, send)
    expect(await again).toEqual({ pending: 0, at: 1_000, next: 2_000 })
  })

  test("a capacity wake is answered once the account recorded it, and with the refusal when it could not", async () => {
    const recorded: (number | null)[] = []
    const requests = createExecutorLifecycleRequests(async (at) => {
      if (at === 2_000) throw new Error("account store busy")
      recorded.push(at)
    })
    const answers: unknown[] = []
    const send = async (message: unknown) => { answers.push(message) }
    requests.hear({ kind: "capacity_wake", id: 1, at: 1_000 }, send)
    requests.hear({ kind: "capacity_wake", id: 2, at: 2_000 }, send)
    await Bun.sleep(0)
    expect(recorded).toEqual([1_000])
    expect(answers).toEqual([
      { kind: "capacity_wake_recorded", id: 1 },
      { kind: "capacity_wake_recorded", id: 2, error: "account store busy" },
    ])
  })
})
