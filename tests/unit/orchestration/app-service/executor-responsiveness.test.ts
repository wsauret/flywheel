import { describe, expect, test } from "bun:test"
import { watchExecutorResponsiveness, type ExecutorWedgeProof } from "../../../../src/orchestration/app-service/executor-responsiveness.js"

/** The executor's heartbeat period, which is also the period of each check. */
const PERIOD_MS = 1_000
/** The account proves an executor wedged at this many missed periods in a row, never sooner. */
const WEDGED_AFTER_PERIODS = 30

/** A clock the test moves by hand, with the timers that clock fires. */
function manualClock() {
  let now = 0
  const timers = new Set<{ at: number; fire: () => void }>()
  return {
    now: () => now,
    setTimer(fire: () => void, delayMs: number) {
      const timer = { at: now + delayMs, fire }
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!next) break
        timers.delete(next)
        now = next.at
        next.fire()
      }
      now = until
    },
    /** The host sleeps, or this process stalls: the clock jumps, and every
     *  timer that fell due in the gap fires once, late. */
    jump(ms: number) {
      now += ms
      for (const timer of [...timers].filter((due) => due.at <= now)) {
        timers.delete(timer)
        timer.fire()
      }
    },
    pending: () => timers.size,
  }
}

/** The I/O turn each check waits for, which the test lets run by hand. */
function ioTurns() {
  const pending: (() => void)[] = []
  return {
    yieldToIo: () => new Promise<void>((resolve) => { pending.push(resolve) }),
    /** Runs the I/O that is due, then lets the check settle. */
    async run() {
      for (const resolve of pending.splice(0)) resolve()
      for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    },
  }
}

function watch() {
  const clock = manualClock()
  const records: string[] = []
  const proofs: ExecutorWedgeProof[] = []
  const io = ioTurns()
  const responsiveness = watchExecutorResponsiveness({
    log: {
      warn: (message, fields) => { records.push(`warn ${message} ${JSON.stringify(fields)}`) },
      info: (message, fields) => { records.push(`info ${message} ${JSON.stringify(fields)}`) },
    },
    periodMs: PERIOD_MS, now: clock.now, setTimer: clock.setTimer, yieldToIo: io.yieldToIo,
  })
  responsiveness.onWedged((proof) => { proofs.push(proof) })
  /** Lets `count` checks fire, one each period, with no heartbeat between them. */
  const checks = async (count: number): Promise<void> => {
    for (let check = 0; check < count; check++) {
      clock.advance(PERIOD_MS)
      await io.run()
    }
  }
  /** One heartbeat, and the check that finds it. */
  const heard = async (): Promise<void> => {
    responsiveness.beat()
    await checks(1)
  }
  return { responsiveness, clock, records, proofs, io, checks, heard }
}

describe("executor responsiveness", () => {
  test("thirty checks in a row with no heartbeat prove the executor wedged, twenty-nine do not, and a heartbeat sets the count back to zero", async () => {
    const { responsiveness, proofs, checks, heard } = watch()
    responsiveness.start()
    await heard()
    await checks(WEDGED_AFTER_PERIODS - 1)
    expect(proofs).toEqual([])
    await heard()
    await checks(WEDGED_AFTER_PERIODS - 1)
    expect(proofs).toEqual([])
    await checks(1)
    // The silence is the time since the last heartbeat, which the check after it found.
    expect(proofs).toEqual([{ missedPeriods: WEDGED_AFTER_PERIODS, silentMs: 31_000 }])
    // Each later check that still finds no heartbeat proves it again.
    await checks(1)
    expect(proofs.map((proof) => proof.missedPeriods)).toEqual([WEDGED_AFTER_PERIODS, WEDGED_AFTER_PERIODS + 1])
    responsiveness.dispose()
  })

  test("a host sleep counts as one missed period, however long it lasts", async () => {
    // Bun timers read a monotonic clock that counts sleep on macOS, so the
    // one check that was due fires at the wake, before the executor's first
    // heartbeat after it.
    const { responsiveness, clock, records, proofs, io, checks, heard } = watch()
    responsiveness.start()
    for (let period = 0; period < 5; period++) await heard()
    clock.jump(60_000)
    await io.run()
    expect(clock.pending()).toBe(1)
    expect(proofs).toEqual([])
    expect(records).toEqual([])
    await checks(WEDGED_AFTER_PERIODS - 2)
    expect(proofs).toEqual([])
    await checks(1)
    expect(proofs.map((proof) => proof.missedPeriods)).toEqual([WEDGED_AFTER_PERIODS])
    responsiveness.dispose()
  })

  test("a check that fires late after an account stall counts no missed period when a heartbeat waits behind the I/O", async () => {
    const { responsiveness, clock, proofs, io, checks, heard } = watch()
    responsiveness.start()
    await heard()
    await checks(WEDGED_AFTER_PERIODS - 1)
    // This process was itself busy: the check that would be the thirtieth
    // fires five periods late, and the executor's heartbeat is due on the
    // socket behind it.
    clock.jump(5 * PERIOD_MS)
    responsiveness.beat()
    await io.run()
    expect(proofs).toEqual([])
    await checks(WEDGED_AFTER_PERIODS - 1)
    expect(proofs).toEqual([])
    await checks(1)
    expect(proofs).toEqual([{ missedPeriods: WEDGED_AFTER_PERIODS, silentMs: WEDGED_AFTER_PERIODS * PERIOD_MS }])
    responsiveness.dispose()
  })

  test("counting begins at the launch, so an executor that never sends a heartbeat is proven wedged at the thirtieth check, with no stall record", async () => {
    const { responsiveness, records, proofs, checks } = watch()
    await checks(WEDGED_AFTER_PERIODS)
    expect(proofs).toEqual([])
    responsiveness.start()
    await checks(WEDGED_AFTER_PERIODS - 1)
    expect(proofs).toEqual([])
    await checks(1)
    expect(proofs).toEqual([{ missedPeriods: WEDGED_AFTER_PERIODS, silentMs: WEDGED_AFTER_PERIODS * PERIOD_MS }])
    expect(responsiveness.heartbeats).toBe(0)
    // Missed periods before the first heartbeat belong to the start, not to a stall.
    expect(records).toEqual([])
    responsiveness.dispose()
  })

  test("a stall is recorded once, at three missed periods after the first heartbeat, and its length when a heartbeat ends it", async () => {
    const { responsiveness, records, checks, heard } = watch()
    responsiveness.start()
    await heard()
    await checks(2)
    expect(records).toEqual([])
    await checks(1)
    expect(records).toEqual([`warn executor heartbeat stalled ${JSON.stringify({ missedPeriods: 3, silentMs: 4_000 })}`])
    await checks(5)
    expect(records).toHaveLength(1)
    await heard()
    expect(records[1]).toBe(`info executor heartbeat resumed ${JSON.stringify({ stallMs: 9_000 })}`)
    expect(responsiveness.heartbeats).toBe(2)
    // The next stall is recorded again.
    await checks(3)
    expect(records).toHaveLength(3)
    responsiveness.dispose()
  })

  test("the silence reports the missed periods and the time since the last heartbeat, at the moment it is read", async () => {
    const { responsiveness, clock, checks, heard } = watch()
    responsiveness.start()
    await heard()
    await checks(4)
    clock.advance(PERIOD_MS / 2)
    // The heartbeat came at the start; the check after it found it.
    expect(responsiveness.silence()).toEqual({ missedPeriods: 4, silentMs: 5_500 })
    responsiveness.beat()
    expect(responsiveness.silence()).toEqual({ missedPeriods: 0, silentMs: 0 })
    responsiveness.dispose()
  })

  test("checks stop while the lifecycle channel is detached, count from zero after the reattach, and leave no timer after dispose", async () => {
    const { responsiveness, clock, proofs, io, checks, heard } = watch()
    responsiveness.start()
    await heard()
    await checks(10)
    // A check that was already due when the channel detached counts nothing.
    clock.advance(PERIOD_MS)
    responsiveness.pause()
    await io.run()
    expect(clock.pending()).toBe(0)
    await checks(2 * WEDGED_AFTER_PERIODS)
    expect(proofs).toEqual([])
    responsiveness.resume()
    await checks(WEDGED_AFTER_PERIODS - 1)
    expect(proofs).toEqual([])
    await checks(1)
    expect(proofs).toEqual([{ missedPeriods: WEDGED_AFTER_PERIODS, silentMs: WEDGED_AFTER_PERIODS * PERIOD_MS }])
    responsiveness.dispose()
    expect(clock.pending()).toBe(0)
    await checks(1)
    expect(proofs).toHaveLength(1)
  })
})
