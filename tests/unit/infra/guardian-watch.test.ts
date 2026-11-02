import { describe, expect, spyOn, test } from "bun:test"

import { posixGuardianReads, watchGuardian } from "../../../src/infra/guardian-watch.js"
import { Log } from "../../../src/infra/log.js"
import type { ProcessIdentity } from "../../../src/infra/process-container.js"

describe("guardian watch", () => {
  const GUARDIAN = "4242 4242 1700000000.000001"
  const watchProbe = (answers: { alive: boolean; identity: ProcessIdentity }) => {
    const losses: string[] = []
    const cancel = watchGuardian({
      pid: 4242,
      identity: GUARDIAN,
      alive: () => answers.alive,
      identify: () => answers.identity,
      onLost: () => { losses.push("lost") },
      intervalMs: 1,
    })
    return { losses, cancel }
  }

  test("holds the container while the guardian it was launched behind is still there", async () => {
    const probe = watchProbe({ alive: true, identity: { kind: "process", identity: GUARDIAN } })

    await Bun.sleep(10)
    probe.cancel()

    expect(probe.losses).toEqual([])
  })

  test("holds the container while the guardian's identity probe does not answer", async () => {
    // A probe that did not answer proves nothing. Reading it as a replaced
    // guardian is what ended live executors under load.
    const probe = watchProbe({ alive: true, identity: { kind: "unproven" } })

    await Bun.sleep(10)
    probe.cancel()

    expect(probe.losses).toEqual([])
  })

  test("ends the container when the guardian's pid is gone", async () => {
    const probe = watchProbe({ alive: false, identity: { kind: "absent" } })

    await Bun.sleep(10)
    probe.cancel()

    expect(probe.losses).toEqual(["lost"])
  })

  test("ends the container when the kernel proves the guardian exited, though its pid is still held", async () => {
    // An exited guardian its parent has not reaped still holds its pid, so a
    // signal-zero check alone reads it as alive.
    const probe = watchProbe({ alive: true, identity: { kind: "absent" } })

    await Bun.sleep(10)
    probe.cancel()

    expect(probe.losses).toEqual(["lost"])
  })

  test("ends the container when the pid is alive but is no longer the guardian", async () => {
    // Pid reuse: something else now holds the number the guardian had. Watching
    // the pid alone would keep this container running behind a stranger.
    const probe = watchProbe({ alive: true, identity: { kind: "process", identity: "4242 4242 1700000999.000001" } })

    await Bun.sleep(10)
    probe.cancel()

    expect(probe.losses).toEqual(["lost"])
  })

  test("reports the loss once and then stops watching", async () => {
    const probe = watchProbe({ alive: false, identity: { kind: "absent" } })

    await Bun.sleep(20)

    expect(probe.losses).toEqual(["lost"])
  })
})

describe("a guardian identity probe that does not answer", () => {
  const GUARDIAN = "4242 4242 1700000000.000001"
  const UNPROVEN: ProcessIdentity = { kind: "unproven" }
  const GUARDIAN_ITSELF: ProcessIdentity = { kind: "process", identity: GUARDIAN }
  const UNANSWERED = "the process guardian's identity probe did not answer; the container stays and the next check asks again"
  const UNANSWERED_AGAIN = "the process guardian's identity probe did not answer again"

  /** Watches a guardian whose identity probe gives `answers` in turn, then
   *  the guardian's own identity, and resolves once every answer was read.
   *  The watch's records are collected from its log's warnings. */
  async function watchAnswering(answers: readonly ProcessIdentity[]) {
    const warn = spyOn(Log.create({ service: "command-supervisor" }), "warn")
    const losses: string[] = []
    const read = Promise.withResolvers<void>()
    let next = 0
    const cancel = watchGuardian({
      pid: 4242,
      identity: GUARDIAN,
      alive: () => true,
      identify: () => {
        const answer = answers[next] ?? GUARDIAN_ITSELF
        next += 1
        if (next >= answers.length) read.resolve()
        return answer
      },
      onLost: () => { losses.push("lost") },
      intervalMs: 1,
    })
    await read.promise
    return {
      losses,
      records: () => warn.mock.calls,
      stop() {
        cancel()
        warn.mockRestore()
      },
    }
  }

  test("records its first unanswered check once, naming the guardian it asked about, and ends nothing", async () => {
    const watch = await watchAnswering([UNPROVEN, UNPROVEN, UNPROVEN, UNPROVEN, UNPROVEN, GUARDIAN_ITSELF])
    try {
      expect(watch.records()).toEqual([[UNANSWERED, { guardianPid: 4242, expectedIdentity: GUARDIAN }]])
      expect(watch.losses).toEqual([])
    } finally {
      watch.stop()
    }
  })

  test("records a probe that alternates between no answer and an answer once, not once for each alternation", async () => {
    const watch = await watchAnswering(Array.from({ length: 10 }, (_, check) => check % 2 === 0 ? UNPROVEN : GUARDIAN_ITSELF))
    try {
      expect(watch.records()).toEqual([[UNANSWERED, { guardianPid: 4242, expectedIdentity: GUARDIAN }]])
      expect(watch.losses).toEqual([])
    } finally {
      watch.stop()
    }
  })

  test("reports the count of the repeats when the watch stops", async () => {
    const watch = await watchAnswering([UNPROVEN, UNPROVEN, UNPROVEN, UNPROVEN, UNPROVEN, GUARDIAN_ITSELF])
    const records = watch.records()
    watch.stop()

    expect(records).toEqual([
      [UNANSWERED, { guardianPid: 4242, expectedIdentity: GUARDIAN }],
      [UNANSWERED_AGAIN, { guardianPid: 4242, count: 4, windowMs: expect.any(Number) }],
    ])
  })
})

describe("POSIX guardian reads", () => {
  const failKill = (code: string) => () => { throw Object.assign(new Error(code), { code }) }

  test("reads the guardian's pid as free only when signal zero proves it", () => {
    const kill = spyOn(process, "kill")
    try {
      kill.mockImplementation(failKill("EPERM"))
      expect(posixGuardianReads.alive(4242)).toBe(true)
      kill.mockImplementation(failKill("ESRCH"))
      expect(posixGuardianReads.alive(4242)).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })

  test.skipIf(process.platform === "win32")("identifies the guardian from the kernel, and a free pid as absent", () => {
    expect(posixGuardianReads.identify(process.pid).kind).toBe("process")
    // A pid no process holds: pid_max on every supported platform is far below it.
    expect(posixGuardianReads.identify(2_000_000_000)).toEqual({ kind: "absent" })
  })
})
