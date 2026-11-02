import { describe, expect, jest, test } from "bun:test"

import { projectExecutorFatal } from "../../../../src/orchestration/app-service/project-executor-main.js"
import type { RuntimeComposition } from "../../../../src/orchestration/app-service/project-execution-runtime.js"

/** A log that records the order of its records beside the case's other steps. */
function orderedLog(order: string[]) {
  return {
    warn: (message: unknown) => { order.push(`warn ${String(message)}`) },
    error: (message: unknown) => { order.push(`error ${String(message)}`) },
  }
}

describe("a project executor's fatal path", () => {
  test("records the failure, flushes the durable writers of the runtime composed by then, and only then exits 1", async () => {
    const order: string[] = []
    let flushed = (): void => {}
    let runtime: Pick<RuntimeComposition, "flushDurableState"> | undefined = undefined
    let exited = (_code: number): void => {}
    const exit = new Promise<number>((resolve) => { exited = resolve })
    const fatal = projectExecutorFatal({ log: orderedLog(order), runtime: () => runtime, exit: (code) => { order.push(`exit ${code}`); exited(code) } })
    // The runtime is composed after the policy is installed.
    runtime = {
      flushDurableState: () => {
        order.push("flush")
        return new Promise<void>((resolve) => { flushed = resolve })
      },
    }

    void fatal(new Error("store lost"), "unhandled rejection")
    await Promise.resolve()
    expect(order).toEqual(["error unhandled rejection", "flush"])
    flushed()

    expect(await exit).toBe(1)
    expect(order).toEqual(["error unhandled rejection", "flush", "exit 1"])
  })

  test("exits 1 one second after a flush that never settles, with one WARN", async () => {
    jest.useFakeTimers()
    try {
      const order: string[] = []
      let exited = (_code: number): void => {}
      const exit = new Promise<number>((resolve) => { exited = resolve })
      const fatal = projectExecutorFatal({ log: orderedLog(order), runtime: () => ({ flushDurableState: () => new Promise<void>(() => {}) }), exit: (code) => { order.push(`exit ${code}`); exited(code) } })

      void fatal(new Error("store lost"), "uncaught exception")
      jest.advanceTimersByTime(999)
      await Promise.resolve()
      expect(order).toEqual(["error uncaught exception"])
      jest.advanceTimersByTime(1)

      expect(await exit).toBe(1)
      expect(order).toEqual(["error uncaught exception", "warn the step before a fatal exit ran past its bound", "exit 1"])
    } finally {
      jest.useRealTimers()
    }
  })

  test("exits 1 without a flush when the failure comes before the runtime is composed", async () => {
    const order: string[] = []
    let exited = (_code: number): void => {}
    const exit = new Promise<number>((resolve) => { exited = resolve })
    const fatal = projectExecutorFatal({ log: orderedLog(order), runtime: () => undefined, exit: (code) => { order.push(`exit ${code}`); exited(code) } })

    void fatal(new Error("initialization lost"), "unhandled rejection")

    expect(await exit).toBe(1)
    expect(order).toEqual(["error unhandled rejection", "exit 1"])
  })
})
