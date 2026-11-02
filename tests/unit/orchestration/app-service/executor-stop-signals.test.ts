import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { executorStopSignalOf, listenForExecutorStopSignals } from "../../../../src/orchestration/app-service/executor-stop-signals.js"
import type { ShutdownSignal } from "../../../../src/infra/shutdown-signals.js"

/** The process API as the listener sees it. A signal the process sends
 *  itself records the signal and how many listeners this process still had
 *  for it, and an exit records its code; the real ones end the process
 *  there, so the test only reads how the process ended. */
function signalProcess() {
  const listeners = new Map<ShutdownSignal, Set<() => void>>()
  const raised: { readonly signal: ShutdownSignal; readonly listening: number }[] = []
  const exits: number[] = []
  const pid = 4242
  return {
    process: {
      pid,
      on(signal: ShutdownSignal, listener: () => void) {
        const set = listeners.get(signal) ?? new Set()
        set.add(listener)
        listeners.set(signal, set)
      },
      off(signal: ShutdownSignal, listener: () => void) {
        listeners.get(signal)?.delete(listener)
      },
      kill(target: number, signal: ShutdownSignal) {
        if (target !== pid) throw new Error(`signal ${signal} sent to another process, ${target}`)
        raised.push({ signal, listening: listeners.get(signal)?.size ?? 0 })
      },
      exit(code: number) {
        exits.push(code)
      },
    },
    /** Delivers `signal` from outside this process. */
    deliver(signal: ShutdownSignal) {
      for (const listener of listeners.get(signal) ?? []) listener()
    },
    raised,
    exits,
  }
}

/** The executor's lifecycle channel: attached until the test detaches it. */
function lifecycleChannel(attached = true) {
  const detaches = new Set<(reason: Error) => void>()
  const channel = {
    attached,
    onDetach(handler: (reason: Error) => void) {
      detaches.add(handler)
      return () => { detaches.delete(handler) }
    },
    detach() {
      channel.attached = false
      for (const handler of detaches) handler(new Error("internal process endpoint peer closed"))
    },
  }
  return channel
}

/** The executor's ordered stop. Every call joins the one stop, which the
 *  test settles. */
function orderedStop() {
  const settled = Promise.withResolvers<void>()
  const calls: { readonly trigger: string; readonly clientsHold: boolean }[] = []
  return {
    stop(trigger: string, clientsHold: boolean): Promise<void> {
      calls.push({ trigger, clientsHold })
      return settled.promise
    },
    calls,
    resolve: () => { settled.resolve() },
    reject: (error: Error) => { settled.reject(error) },
  }
}

/** Lets every reaction to a settled stop run. */
const reactions = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

function listen(platform: NodeJS.Platform = "darwin") {
  const signals = signalProcess()
  const records: { readonly level: string; readonly message: string; readonly fields: unknown }[] = []
  const record = (level: string) => (message: string, fields?: unknown): void => { records.push({ level, message, fields }) }
  const listener = listenForExecutorStopSignals({
    platform,
    log: { warn: record("warn"), info: record("info"), debug: record("debug") },
    process: signals.process,
  })
  return { ...signals, listener, records }
}

let unhandled: unknown[] = []
const recordUnhandled = (reason: unknown): void => { unhandled.push(reason) }
beforeEach(() => {
  unhandled = []
  process.on("unhandledRejection", recordUnhandled)
})
afterEach(() => {
  process.off("unhandledRejection", recordUnhandled)
})

describe("executor stop signals", () => {
  test("a signal before the executor serves writes its receipt and ends the process by that signal at once", () => {
    const { deliver, raised, records } = listen()
    deliver("SIGTERM")
    expect(records).toEqual([{ level: "warn", message: "executor stop signal received", fields: { signal: "SIGTERM", orderedStop: false, why: "the executor does not serve yet" } }])
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGTERM"])
  })

  test("a signal while the lifecycle channel is detached writes its receipt and ends the process by that signal at once", () => {
    const { deliver, raised, records, listener } = listen()
    const stop = orderedStop()
    listener.serve({ stop: stop.stop, lifecycle: lifecycleChannel(false), finished: () => false })
    deliver("SIGHUP")
    expect(records).toEqual([{ level: "warn", message: "executor stop signal received", fields: { signal: "SIGHUP", orderedStop: false, why: "the lifecycle channel is detached" } }])
    expect(stop.calls).toEqual([])
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGHUP"])
  })

  test("a signal after the executor's stop finished cuts no work: its receipt is INFO and it ends the process at once", () => {
    const { deliver, raised, records, listener } = listen()
    const stop = orderedStop()
    listener.serve({ stop: stop.stop, lifecycle: lifecycleChannel(false), finished: () => true })
    deliver("SIGTERM")
    expect(records).toEqual([{ level: "info", message: "executor stop signal received", fields: { signal: "SIGTERM", orderedStop: false, why: "the executor's stop has finished" } }])
    expect(stop.calls).toEqual([])
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGTERM"])
  })

  test("a signal while the executor serves starts the ordered stop, which keeps every empty chat, and ends by that signal once the stop settles", async () => {
    const { deliver, raised, records, listener } = listen()
    const stop = orderedStop()
    listener.serve({ stop: stop.stop, lifecycle: lifecycleChannel(), finished: () => false })
    deliver("SIGTERM")
    expect(records).toEqual([{ level: "warn", message: "executor stop signal received", fields: { signal: "SIGTERM", orderedStop: true } }])
    expect(stop.calls).toEqual([{ trigger: "signal SIGTERM", clientsHold: true }])
    await reactions()
    expect(raised).toEqual([])
    stop.resolve()
    await reactions()
    expect(records.at(-1)).toEqual({ level: "info", message: "executor ends by its stop signal", fields: { signal: "SIGTERM", after: "stop settled" } })
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGTERM"])
  })

  test("a rejected stop records its failure and ends by the signal once, with no unhandled rejection", async () => {
    const { deliver, raised, records, listener } = listen()
    const stop = orderedStop()
    const lifecycle = lifecycleChannel()
    listener.serve({ stop: stop.stop, lifecycle, finished: () => false })
    deliver("SIGTERM")
    stop.reject(new Error("project executor shutdown blocked at sessions"))
    await reactions()
    lifecycle.detach()
    await reactions()
    expect(records.at(-1)).toEqual({ level: "warn", message: "executor ends by its stop signal", fields: { signal: "SIGTERM", after: "stop failed", error: "project executor shutdown blocked at sessions" } })
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGTERM"])
    expect(unhandled).toEqual([])
  })

  test("a second signal joins the running stop and writes a DEBUG record, and the process ends by the first", async () => {
    const { deliver, raised, records, listener } = listen()
    const stop = orderedStop()
    listener.serve({ stop: stop.stop, lifecycle: lifecycleChannel(), finished: () => false })
    deliver("SIGTERM")
    deliver("SIGINT")
    expect(stop.calls).toHaveLength(1)
    expect(records.slice(1)).toEqual([{ level: "debug", message: "executor stop signal joins the running stop", fields: { signal: "SIGINT", endsBy: "SIGTERM" } }])
    stop.resolve()
    await reactions()
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGTERM"])
  })

  test("a detach during the stop ends the process by the first signal before the stop settles, and only once", async () => {
    const { deliver, raised, records, listener } = listen()
    const stop = orderedStop()
    const lifecycle = lifecycleChannel()
    listener.serve({ stop: stop.stop, lifecycle, finished: () => false })
    deliver("SIGTERM")
    lifecycle.detach()
    expect(records.at(-1)).toEqual({ level: "info", message: "executor ends by its stop signal", fields: { signal: "SIGTERM", after: "lifecycle channel detached" } })
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGTERM"])
    stop.resolve()
    await reactions()
    expect(raised.map((raise) => raise.signal)).toEqual(["SIGTERM"])
  })

  test("on Windows, which gives a process's own signal no default action, the process exits with the code a shell reports for the signal", async () => {
    const early = listen("win32")
    early.deliver("SIGHUP")
    const ordered = listen("win32")
    const stop = orderedStop()
    ordered.listener.serve({ stop: stop.stop, lifecycle: lifecycleChannel(), finished: () => false })
    ordered.deliver("SIGINT")
    stop.resolve()
    await reactions()
    expect([...early.raised, ...ordered.raised]).toEqual([])
    expect([...early.exits, ...ordered.exits]).toEqual([129, 130])
  })

  test("the account reads the stop signal an executor ended by from its exit status, on POSIX and on Windows, and reads no other end as one", () => {
    const posix = listen()
    posix.deliver("SIGINT")
    const windows = listen("win32")
    windows.deliver("SIGHUP")
    expect(posix.raised.map(({ signal }) => executorStopSignalOf({ code: null, signal }, "darwin"))).toEqual(["SIGINT"])
    expect(windows.exits.map((code) => executorStopSignalOf({ code, signal: null }, "win32"))).toEqual(["SIGHUP"])
    expect([{ code: null, signal: "SIGKILL" }, { code: 0, signal: null }].map((exit) => executorStopSignalOf(exit, "linux"))).toEqual([undefined, undefined])
    expect([{ code: 1, signal: null }, { code: 137, signal: null }].map((exit) => executorStopSignalOf(exit, "win32"))).toEqual([undefined, undefined])
  })

  test("the listener for a signal is removed before that signal is raised again, so its default action ends the process", async () => {
    const at = listen()
    at.deliver("SIGINT")
    const ordered = listen()
    const stop = orderedStop()
    ordered.listener.serve({ stop: stop.stop, lifecycle: lifecycleChannel(), finished: () => false })
    ordered.deliver("SIGTERM")
    stop.resolve()
    await reactions()
    expect([...at.raised, ...ordered.raised]).toEqual([{ signal: "SIGINT", listening: 0 }, { signal: "SIGTERM", listening: 0 }])
  })
})
