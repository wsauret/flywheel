import { describe, expect, it } from "bun:test"

import { resumeInput, type AgentLoopInput } from "../../../../src/infra/agent-loop-events.js"
import { createAgentLoopInputWaiter } from "../../../../src/orchestration/agent-runtime/agent-loop-input-consumer.js"
import type { PersonWait } from "../../../../src/orchestration/agent-runtime/agent-loop-state.js"
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox.js"
import { consumeAgentLoopMessageInput } from "../../../../src/orchestration/agent-runtime/agent-loop-input.js"

type WaiterInput = Parameters<typeof createAgentLoopInputWaiter>[0]
// The loop owns the person wait; this fake applies its hand-back transitions.
function waiter(overrides: Partial<WaiterInput> & { recordInterruption?: () => Promise<void>; personWait?: PersonWait } = {}) {
  const { recordInterruption, personWait: seeded, state, ...rest } = overrides
  let personWait = seeded
  const base = state ?? (() => ({ turnCount: 1, handoffWritten: false }))
  return createAgentLoopInputWaiter({
    prepareWaitForInput: () => {
      throw new Error("prepareWaitForInput not provided")
    },
    consume: async () => "continue",
    ...rest,
    state: () => ({ ...base(), ...(personWait ? { personWait } : {}) }),
    handBack: async (recordTurnEnd) => {
      personWait ??= { turnEnd: "unrecorded" }
      if (recordTurnEnd) { await recordInterruption?.(); personWait = { turnEnd: "recorded" } }
    },
  })
}

describe("agent loop input wait reservations", () => {
  it("expires each managed wait once at the rest of its deadline, states the requested duration, joins its reservation, and uses a fresh estimate on rewait", async () => {
    const mailbox = new ChatTurnMailbox()
    const timers: { seconds: number; expire: () => void; cleared: boolean }[] = []
    const consumed: AgentLoopInput[] = []
    // The wait asked for 7200 seconds, and 200 of them passed before this park.
    let openWait = { expiry: { seconds: 7200, deadlineMs: Date.now() + 7_000_000 }, replyWaitIds: [] }
    const parked = Promise.withResolvers<void>()
    const wait = waiter({
      state: () => ({ turnCount: 1, handoffWritten: false, wait: openWait }),
      prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
      scheduleWaitExpiry: (duration, expire) => {
        const timer = { seconds: duration, expire, cleared: false }
        timers.push(timer)
        parked.resolve()
        return () => { timer.cleared = true }
      },
      consume: async (raw) => { consumed.push(raw); return "continue" },
    })
    const first = wait(true, undefined)
    await parked.promise
    expect(timers[0]?.seconds).toBeCloseTo(7000, 0)
    timers[0]!.expire()
    await expect(first).resolves.toBe("continue")
    expect(mailbox.parked).toBe(false)
    expect(timers[0]?.cleared).toBe(true)
    expect(consumed).toEqual([expect.objectContaining({ kind: "message", origin: "silent-system", runtimeNotice: true, text: expect.stringContaining("wait_expired") })])
    expect(consumed[0]).toMatchObject({ text: expect.stringContaining("<seconds>7200</seconds>") })
    expect(timers).toHaveLength(1)

    openWait = { expiry: { seconds: 180, deadlineMs: Date.now() + 180_000 }, replyWaitIds: [] }
    const secondPark = Promise.withResolvers<void>()
    const second = waiter({
      state: () => ({ turnCount: 2, handoffWritten: false, wait: openWait }),
      prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
      consume: async (raw) => { consumed.push(raw); return "continue" },
      scheduleWaitExpiry: (duration, expire) => {
        const timer = { seconds: duration, expire, cleared: false }
        timers.push(timer)
        secondPark.resolve()
        return () => { timer.cleared = true }
      },
    })(true, undefined)
    await secondPark.promise
    expect(timers[1]?.seconds).toBeCloseTo(180, 0)
    mailbox.enqueueNextTurn("a person's message")
    timers[1]!.expire()
    await expect(second).resolves.toBe("continue")
    expect(timers[1]?.cleared).toBe(true)
    expect(timers).toHaveLength(2)
    expect(consumed).toHaveLength(2)
    expect(consumed[1]).toMatchObject({ kind: "message", text: "a person's message", origin: "human" })
    expect(consumed[1]).not.toHaveProperty("runtimeNotice")
  })

  it("cleans up expiry on abort and never times idle or interrupted parks", async () => {
    for (const mode of ["work", "idle", "interrupted"] as const) {
      const mailbox = new ChatTurnMailbox()
      const run = new AbortController()
      const parked = Promise.withResolvers<void>()
      let scheduled = 0
      let cleared = 0
      const wait = waiter({
        state: () => ({ turnCount: 1, handoffWritten: false, wait: { expiry: { seconds: 240, deadlineMs: Date.now() + 240_000 }, replyWaitIds: [] } }),
        runSignal: run.signal,
        prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
        onTurnParked: () => { parked.resolve() },
        scheduleWaitExpiry: () => {
          scheduled++
          return () => { cleared++ }
        },
        ...(mode === "interrupted" ? { personWait: { turnEnd: "recorded" as const } } : {}),
      })(mode === "work", run.signal)
      await parked.promise
      run.abort()
      await expect(wait).resolves.toBe("empty")
      expect(mailbox.parked).toBe(false)
      expect(scheduled).toBe(mode === "work" ? 1 : 0)
      expect(cleared).toBe(scheduled)
    }
  })

  it("cleans up expiry when the input reservation fails", async () => {
    const failure = new Error("input failed")
    let cleared = false
    const result = waiter({
      state: () => ({ turnCount: 1, handoffWritten: false, wait: { expiry: { seconds: 240, deadlineMs: Date.now() + 240_000 }, replyWaitIds: [] } }),
      prepareWaitForInput: () => ({
        commit: async () => { throw failure },
        cancel: async () => {},
      }),
      scheduleWaitExpiry: () => () => { cleared = true },
    })(true, undefined)
    await expect(result).rejects.toBe(failure)
    expect(cleared).toBe(true)
  })

  it("a reply-only park has no expiry and wakes on the reply or an interrupt", async () => {
    for (const interrupted of [false, true]) {
      const mailbox = new ChatTurnMailbox()
      const turn = new AbortController()
      const parked = Promise.withResolvers<void>()
      const takenBack = Promise.withResolvers<void>()
      let timers = 0
      let recorded = 0
      const consumed: AgentLoopInput[] = []
      const wait = waiter({
        state: () => ({ turnCount: 1, handoffWritten: false, wait: { replyWaitIds: ["ask"] } }),
        backgroundTasks: { waitableTaskCount: () => 1, awaitedTaskCount: () => 1, flushSettledNotifications: () => {} },
        prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
        onTurnParked: (context) => { (context.userResumeRequired ? takenBack : parked).resolve() },
        recordInterruption: async () => { recorded++ },
        scheduleWaitExpiry: () => { timers++; return () => {} },
        consume: async (raw) => { consumed.push(raw); return "continue" },
      })(true, turn.signal)
      await parked.promise
      if (interrupted) {
        turn.abort()
        await takenBack.promise
        mailbox.enqueueResume()
      } else mailbox.enqueueSilentSystem("parent replied")
      await expect(wait).resolves.toBe("continue")
      expect(timers).toBe(0)
      expect(recorded).toBe(interrupted ? 1 : 0)
      expect(consumed[0]).toMatchObject(interrupted ? { kind: "resume" } : { kind: "message", text: "parent replied" })
    }
  })

  it("reports every awaited background task, and a park that waits on background work, when the turn parks", async () => {
    // Awaited tasks, or a turn that parked on its background work with no
    // tracked task, each wait on work.
    for (const [awaited, parkedOnBackgroundWork] of [[2, false], [0, true]] as const) {
      let activeBackgroundCount: number | undefined
      let park: string | undefined
      const wait = waiter({
        backgroundTasks: { waitableTaskCount: () => awaited, awaitedTaskCount: () => awaited, flushSettledNotifications: () => {} },
        prepareWaitForInput: () => ({
          commit: async () => null,
          cancel: async () => {},
        }),
        onTurnParked: (context) => {
          activeBackgroundCount = context.activeBackgroundCount
          park = context.park
        },
      })

      await expect(wait(parkedOnBackgroundWork, undefined)).resolves.toBe("empty")
      expect(activeBackgroundCount).toBe(awaited)
      expect(park).toBe("waiting_on_work")
    }
  })

  it("joins reservation cleanup before propagating a durable park failure", async () => {
    const parkError = new Error("durable park failed")
    const cleanup = Promise.withResolvers<void>()
    const cancelStarted = Promise.withResolvers<void>()
    let commitCalls = 0
    let settled = false

    const wait = waiter({
      prepareWaitForInput: () => ({
        commit: async () => {
          commitCalls += 1
          return null
        },
        cancel: async () => {
          cancelStarted.resolve()
          await cleanup.promise
        },
      }),
      onTurnParked: async () => { throw parkError },
    })

    const result = wait(false, undefined)
    void result.then(() => { settled = true }, () => { settled = true })
    await cancelStarted.promise
    expect(settled).toBe(false)
    expect(commitCalls).toBe(0)

    cleanup.resolve()
    await expect(result).rejects.toBe(parkError)
  })

  it("cancels a woken mailbox reservation without consuming its input", async () => {
    const mailbox = new ChatTurnMailbox()
    const reservation = mailbox.prepareWaitForInput()
    expect(mailbox.parked).toBe(true)

    mailbox.enqueueNextTurn("kept for recovery")
    expect(mailbox.parked).toBe(false)
    await reservation.cancel()

    expect(mailbox.drainPending()).toEqual({ kind: "message", text: "kept for recovery", origin: "human" })
  })

  it("a person's Resume authorizes a loop parked after an interrupt and starts a logical turn", async () => {
    const mailbox = new ChatTurnMailbox()
    const consumed: { kind: string; startLogicalTurn: boolean | undefined }[] = []
    const wait = waiter({
      prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
      consume: async (input, options) => {
        consumed.push({ kind: input.kind, startLogicalTurn: options.startLogicalTurn })
        return "continue"
      },
    })

    const parked = wait(false, undefined, true)
    mailbox.enqueueResume()

    await expect(parked).resolves.toBe("continue")
    expect(consumed).toEqual([{ kind: "resume", startLogicalTurn: true }])
  })

  it("a background notification or a wake during an interrupted park folds into history, starts no turn, and the loop waits for the Resume", async () => {
    const mailbox = new ChatTurnMailbox()
    const consumed: { kind: string; startLogicalTurn: boolean | undefined }[] = []
    let resumed = 0
    const wait = waiter({
      prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
      onTurnResumed: () => { resumed += 1 },
      consume: async (input, options) => {
        consumed.push({ kind: input.kind, startLogicalTurn: options.startLogicalTurn })
        return "continue"
      },
    })

    mailbox.enqueueSilentSystem("A background task finished.")
    mailbox.enqueueWake()
    let settled = false
    const parked = wait(false, undefined, true).then((result) => { settled = true; return result })
    await Bun.sleep(1)
    expect(settled).toBe(false)
    expect(resumed).toBe(0)
    expect(consumed).toEqual([{ kind: "message", startLogicalTurn: false }, { kind: "wake", startLogicalTurn: false }])

    mailbox.enqueueResume()
    await expect(parked).resolves.toBe("continue")
    expect(resumed).toBe(1)
    expect(consumed.at(-1)).toEqual({ kind: "resume", startLogicalTurn: true })
  })

  it("after an interrupt, a message from a session and a message with no origin fold into history without a request, in both input sources", async () => {
    const fromParent = { text: "from the parent", producer: { kind: "session" as const, sessionId: "parent", conversationId: "parent-conversation", toolUseId: "call-1", hop: 0 } }
    const { WorkflowInjectionQueue } = await import("../../../../src/orchestration/workflow-host/injection-queue.js")
    const queue = new WorkflowInjectionQueue()
    const mailbox = new ChatTurnMailbox()
    const sources: readonly { readonly name: string; readonly source: Pick<ChatTurnMailbox, "prepareWaitForInput">; readonly enqueue: () => void }[] = [
      { name: "chat mailbox", source: mailbox, enqueue: () => { mailbox.enqueueNextTurn(fromParent) } },
      { name: "injection queue", source: queue, enqueue: () => { queue.enqueueMessage(fromParent); queue.enqueue("a visible nudge") } },
    ]
    for (const { name, source, enqueue } of sources) {
      const consumed: { kind: string; origin: string | undefined; startLogicalTurn: boolean | undefined }[] = []
      const wait = waiter({
        prepareWaitForInput: (signal) => source.prepareWaitForInput(signal),
        consume: async (input, options) => {
          consumed.push({ kind: input.kind, origin: input.kind === "message" ? input.origin : undefined, startLogicalTurn: options.startLogicalTurn })
          return "continue"
        },
      })
      enqueue()
      let settled = false
      const parked = wait(false, undefined, true).then((result) => { settled = true; return result })
      await Bun.sleep(1)
      expect({ name, settled }).toEqual({ name, settled: false })
      expect(consumed.every((input) => input.startLogicalTurn === false)).toBe(true)
      expect(consumed.length).toBeGreaterThan(0)
      ;(source === mailbox ? mailbox : queue).enqueueResume()
      await expect(parked).resolves.toBe("continue")
    }

    // A message that carries no origin at all is not a person's either.
    const unmarkedInputs: (AgentLoopInput | null)[] = [{ kind: "message", text: "no origin" }, resumeInput()]
    const unmarkedConsumed: (boolean | undefined)[] = []
    const unmarked = waiter({
      prepareWaitForInput: () => ({ commit: async () => unmarkedInputs.shift() ?? null, cancel: async () => {} }),
      consume: async (_input, options) => { unmarkedConsumed.push(options.startLogicalTurn); return "continue" },
    })
    await expect(unmarked(false, undefined, true)).resolves.toBe("continue")
    expect(unmarkedConsumed).toEqual([false, true])
  })

  it("a message from another session is visible, but it needs no reply and is never the person's turn, input, or recall", async () => {
    const producer = { kind: "session" as const, sessionId: "parent", conversationId: "parent-conversation", toolUseId: "call-1", hop: 0 }
    const origins: string[] = []
    const visible: boolean[] = []
    const effects = { cleared: 0, origins, visible, replies: 0 }
    const sink = {
      clearRequestContext: () => { effects.cleared += 1 },
      logicalTurnStarted: (origin: "user" | "background") => { effects.origins.push(origin) },
      pushUser: (_content: unknown, humanTyped: boolean) => { effects.visible.push(humanTyped) },
      admit: () => {},
      visibleReplyRequired: () => { effects.replies += 1 },
    }
    await consumeAgentLoopMessageInput({ kind: "message", text: "from the parent", origin: "session", producer }, true, false, sink)
    expect(effects).toEqual({ cleared: 0, origins: ["background"], visible: [true], replies: 0 })
    await consumeAgentLoopMessageInput({ kind: "message", text: "from the person", origin: "human" }, true, false, sink)
    expect(effects).toEqual({ cleared: 1, origins: ["background", "user"], visible: [true, true], replies: 1 })

    const mailbox = new ChatTurnMailbox()
    const personArrived = mailbox.observeUserInput()
    mailbox.enqueueNextTurn({ text: "from the parent", producer })
    expect(personArrived()).toBe(false)
    expect(mailbox.recallLastUserMessage()).toBeNull()
    expect(mailbox.drainUserMessages()).toEqual([])
    expect(mailbox.drainPending()).toMatchObject({ kind: "message", origin: "session", producer })

    // A message the hop limit holds never joins one that may wake the loop.
    mailbox.enqueueHeldMessage({ text: "held at the limit", producer })
    mailbox.enqueueNextTurn({ text: "may wake", producer })
    expect(mailbox.drainPending()).toMatchObject({ text: "held at the limit", held: true })
    expect(mailbox.drainPending()).not.toHaveProperty("held")
  })

  it("an answered park, and a park on background work, folds a message the hop limit holds into history and parks again", async () => {
    for (const parkedOnBackgroundWork of [false, true]) {
      const producer = { kind: "session" as const, sessionId: "peer", conversationId: "peer-conversation", toolUseId: "call-5", hop: 5 }
      const mailbox = new ChatTurnMailbox()
      const consumed: { text: string; startLogicalTurn: boolean | undefined; startsTurn: boolean }[] = []
      let resumed = 0
      const wait = waiter({
        prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
        onTurnResumed: () => { resumed += 1 },
        consume: async (input, options) => {
          if (input.kind === "message") consumed.push({ text: input.text, startLogicalTurn: options.startLogicalTurn, startsTurn: options.startsTurn })
          return "continue"
        },
      })
      mailbox.enqueueHeldMessage({ text: "held at the limit", producer })
      let settled = false
      const parked = wait(parkedOnBackgroundWork, undefined).then((result) => { settled = true; return result })
      await Bun.sleep(1)
      expect(settled).toBe(false)
      expect(resumed).toBe(0)
      expect(consumed).toEqual([{ text: "held at the limit", startLogicalTurn: false, startsTurn: false }])

      mailbox.enqueueNextTurn({ text: "the person" })
      await expect(parked).resolves.toBe("continue")
      expect(resumed).toBe(1)
      // A turn that waits on background work continues when it reads input.
      expect(consumed.at(-1)).toEqual({ text: "the person", startLogicalTurn: true, startsTurn: !parkedOnBackgroundWork })
    }
  })

  it("an interrupt records a turn end only for a park that waits on background work", async () => {
    for (const [activeTasks, expected, firstPark] of [[1, 1, "waiting_on_work"], [0, 0, "idle"]] as const) {
      const mailbox = new ChatTurnMailbox()
      const interrupt = new AbortController()
      let recorded = 0
      const parks: string[] = []
      const wait = waiter({
        runSignal: new AbortController().signal,
        prepareWaitForInput: (signal) => mailbox.prepareWaitForInput(signal),
        backgroundTasks: { waitableTaskCount: () => activeTasks, awaitedTaskCount: () => activeTasks, flushSettledNotifications: () => {} },
        recordInterruption: async () => { recorded += 1 },
        onTurnParked: ({ park }) => { parks.push(park) },
      })
      const parked = wait(false, interrupt.signal)
      await Bun.sleep(0)
      interrupt.abort()
      await Bun.sleep(0)
      // A park whose turn already ended has nothing to record, but the
      // person still holds the turn it gave back, even while its background
      // work still runs.
      expect(recorded).toBe(expected)
      expect(parks).toEqual([firstPark, "interrupted"])
      mailbox.enqueueResume()
      await expect(parked).resolves.toBe("continue")
    }
  })

  it("the injection queue hands a step worker the Resume ahead of later messages", async () => {
    const { WorkflowInjectionQueue } = await import("../../../../src/orchestration/workflow-host/injection-queue.js")
    const queue = new WorkflowInjectionQueue()
    queue.enqueueResume()
    queue.enqueueMessage("steer")
    expect(queue.drainPending()).toEqual(resumeInput())
    expect(queue.drainPending()).toMatchObject({ kind: "message", origin: "human" })
  })
})
