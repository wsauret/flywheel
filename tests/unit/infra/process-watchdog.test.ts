import { describe, expect, spyOn, test } from "bun:test"

import type { ProcessIdentity } from "../../../src/infra/process-container.js"
import { createProcessWatchdog, installProcessWatchdog } from "../../../src/infra/process-watchdog.js"
import { hardExitDecision, startWatchdogThread } from "../../helpers/process-watchdog-thread.js"

function recordingWorker() {
  const messages: unknown[] = []
  const listeners: ((event: MessageEvent) => void)[] = []
  const closeListeners: (() => void)[] = []
  let terminated = 0
  const worker = {
    postMessage(message: MessageEvent["data"]) {
      messages.push(message)
      if (typeof message === "object" && message !== null && "kind" in message && message.kind === "dispose") {
        queueMicrotask(() => { for (const listener of listeners) listener(new MessageEvent("message", { data: { kind: "disposed" } })) })
      }
    },
    addEventListener(type: "message" | "open" | "close", listener: (event: MessageEvent) => void) {
      if (type === "message") listeners.push(listener)
      if (type === "close") closeListeners.push(() => listener(new MessageEvent("close")))
    },
    terminate() {
      terminated += 1
      // The real Worker emits `close` once the thread has exited; the fake
      // joins immediately so awaited disposal settles without a timeout.
      for (const listener of closeListeners) listener()
    },
  }
  return {
    factory: () => worker,
    messages,
    terminateCalls: () => terminated,
    emit: (data: MessageEvent["data"]) => {
      for (const listener of listeners) listener(new MessageEvent("message", { data }))
    },
  }
}

describe("process watchdog", () => {
  test("watches the terminal parent and arms one independent hard-exit deadline with what armed it", () => {
    const recorded = recordingWorker()
    const watchdog = createProcessWatchdog({
      processPid: 123,
      parentPid: 45,
      containerPid: 44,
      hardExitMs: 25_000,
      createWorker: recorded.factory,
    })

    watchdog.arm("account stop")
    watchdog.arm()

    expect(recorded.messages).toEqual([
      { kind: "init", processPid: 123, parentPid: 45, containerPid: 44, hardExitMs: 25_000 },
      { kind: "arm", armedBy: "account stop" },
    ])
  })

  test("names a lone process as its own container, armed by its host's shutdown", () => {
    const recorded = recordingWorker()
    const watchdog = createProcessWatchdog({ processPid: 123, parentPid: 45, createWorker: recorded.factory })

    watchdog.arm()

    expect(recorded.messages).toEqual([
      { kind: "init", processPid: 123, parentPid: 45, containerPid: 123, hardExitMs: 30_000 },
      { kind: "arm", armedBy: "host requested shutdown" },
    ])
  })

  test("notifies the main thread once the parent dies so the graceful exit can run", () => {
    const recorded = recordingWorker()
    let deaths = 0
    createProcessWatchdog({
      processPid: 123,
      parentPid: 45,
      onParentDeath: () => { deaths += 1 },
      createWorker: recorded.factory,
    })

    recorded.emit({ kind: "parent-died" })
    recorded.emit("not-a-control-frame")

    expect(deaths).toBe(1)
  })

  test("terminates its Worker on clean process disposal", async () => {
    const recorded = recordingWorker()
    const watchdog = createProcessWatchdog({ createWorker: recorded.factory })

    await watchdog.dispose()
    await watchdog.dispose()

    expect(recorded.terminateCalls()).toBe(1)
  })

  test("rejects reinstall before disposing the installed watchdog", () => {
    const OriginalWorker = globalThis.Worker
    const recorded = recordingWorker()
    function FakeWorker(): object { return recorded.factory() }
    Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker })
    try {
      installProcessWatchdog()
      expect(() => installProcessWatchdog()).toThrow("already installed")
      expect(recorded.messages.filter((message) => typeof message === "object" && message !== null && "kind" in message && message.kind === "dispose")).toEqual([])
    } finally {
      Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: OriginalWorker })
    }
  })
})

/** Runs the watchdog's parent watch on this thread against a scripted probe.
 *
 *  The probe answers `answers` in order, the first at init, and reads the
 *  parent absent once they run out, so every watch ends and the test can read
 *  which identity read ended it. Signal zero fails with `signalZero` when one
 *  is given. No deadline is set, so no hard-exit clock is armed. */
async function watchParent(answers: readonly ProcessIdentity[], signalZero?: "EPERM" | "ESRCH"): Promise<{ readonly endedAtRead: number; readonly signalZeroCalls: number }> {
  let reads = 0
  let signalZeroCalls = 0
  const kill = spyOn(process, "kill").mockImplementation(() => {
    signalZeroCalls += 1
    if (signalZero === undefined) return true
    throw Object.assign(new Error(signalZero), { code: signalZero })
  })
  const thread = startWatchdogThread({ identify: () => answers[reads++] ?? { kind: "absent" } })
  try {
    thread.send({ kind: "init", processPid: 1234, parentPid: 4242, containerPid: 1234, hardExitMs: 0 })
    await thread.parentLost
    return { endedAtRead: reads, signalZeroCalls }
  } finally {
    thread.restore()
    kill.mockRestore()
  }
}

/** The fields of the termination decision in one record line. */
function decisionOf(line: string | undefined): { readonly [field: string]: unknown } | undefined {
  if (line === undefined) return undefined
  const record: unknown = JSON.parse(line)
  if (typeof record !== "object" || record === null || !("payload" in record)) return undefined
  const payload = record.payload
  return typeof payload === "object" && payload !== null ? { ...payload } : undefined
}

const PARENT: ProcessIdentity = { kind: "process", identity: "4242 4242 1" }
const STRANGER: ProcessIdentity = { kind: "process", identity: "4242 4242 2" }
const UNPROVEN: ProcessIdentity = { kind: "unproven" }

describe("process watchdog parent watch", () => {
  test("reports the parent lost when the kernel proves it exited, without asking signal zero", async () => {
    expect(await watchParent([PARENT, { kind: "absent" }])).toEqual({ endedAtRead: 2, signalZeroCalls: 0 })
  })

  test("keeps watching while no identity answers and signal zero is refused", async () => {
    // A refusal is a process that exists. Only the absence scripted after the
    // three unanswered checks ends the watch.
    expect(await watchParent([PARENT, UNPROVEN, UNPROVEN, UNPROVEN], "EPERM")).toEqual({ endedAtRead: 5, signalZeroCalls: 3 })
  })

  test("reports the parent lost when no identity answers and signal zero proves the pid free", async () => {
    expect(await watchParent([PARENT, UNPROVEN], "ESRCH")).toEqual({ endedAtRead: 2, signalZeroCalls: 1 })
  })

  test("reports the parent lost when its pid holds another process after it was identified", async () => {
    expect(await watchParent([PARENT, PARENT, STRANGER])).toEqual({ endedAtRead: 3, signalZeroCalls: 0 })
  })

  test("compares with the first identity that answered when none answered at init", async () => {
    expect(await watchParent([UNPROVEN, PARENT, STRANGER])).toEqual({ endedAtRead: 3, signalZeroCalls: 0 })
  })
})

describe("process watchdog hard-exit decision", () => {
  test("arms the clock with the termination decision it writes when the bound expires", () => {
    const line = hardExitDecision({ processPid: 1234, containerPid: 99, hardExitMs: 35_000, armedBy: "account stop" })

    expect(line?.endsWith("\n")).toBe(true)
    expect(decisionOf(line)).toEqual({
      service: "process-termination", message: "termination requested",
      senderPid: process.pid, container: 99, target: 1234, signal: "SIGKILL",
      reason: "shutdown bound expired", evidence: { boundMs: 35_000, armedBy: "account stop" },
    })
  })

  test("a lost parent arms the clock with a decision that names the lost parent", async () => {
    const thread = startWatchdogThread()
    try {
      thread.send({ kind: "init", processPid: 1234, parentPid: 4242, containerPid: 1234, hardExitMs: 30_000 })
      await thread.parentLost

      expect(decisionOf(thread.armedDecision())).toMatchObject({ container: 1234, target: 1234, reason: "shutdown bound expired", evidence: { boundMs: 30_000, armedBy: "parent process lost" } })
    } finally {
      thread.restore()
    }
  })
})
