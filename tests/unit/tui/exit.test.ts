import { expect, it, mock, spyOn } from "bun:test"
import { exitTUI, leaveTerminal, registerPreExitCleanup, setExitHandler, setLaunchStateCapture, setRendererHandoff } from "../../../src/tui/exit.js"
import type { LaunchState } from "../../../src/infra/launch-state.js"

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

it("waits for every registered cleanup before leaving the TUI", async () => {
  const registered = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()
  const exitObserved = Promise.withResolvers<void>()
  const exited = mock(() => { exitObserved.resolve() })
  registerPreExitCleanup(() => registered.promise)
  registerPreExitCleanup(() => second.promise)
  setExitHandler(exited)

  exitTUI()
  await flush()
  expect(exited).not.toHaveBeenCalled()

  registered.resolve()
  await flush()
  expect(exited).not.toHaveBeenCalled()

  second.resolve()
  await exitObserved.promise
  expect(exited).toHaveBeenCalledTimes(1)
  const forceExit = spyOn(process, "exit").mockImplementation(() => { throw new Error("terminal restoration bypassed") })
  try {
    expect(() => exitTUI()).not.toThrow()
    expect(forceExit).not.toHaveBeenCalled()
    expect(exited).toHaveBeenCalledTimes(1)
  } finally { forceExit.mockRestore() }
})

it("observes rejected cleanup and still leaves the TUI", async () => {
  const rejected = Promise.withResolvers<void>()
  const exitObserved = Promise.withResolvers<void>()
  const exited = mock(() => { exitObserved.resolve() })
  setExitHandler(exited)

  registerPreExitCleanup(() => rejected.promise)
  exitTUI()
  rejected.reject(new Error("runtime closed"))
  await exitObserved.promise

  expect(exited).toHaveBeenCalledTimes(1)
})

it("captures the place before it suspends the renderer, keeps exits off the handed-over terminal, and resumes on failure", async () => {
  const events: string[] = []
  const place: LaunchState = { version: 3, projectRoot: "/p", foreground: "s", tabs: ["s"], scroll: {}, disclosure: {}, drafts: {}, questionDrafts: {}, modal: { kind: "none" } }
  const exited = mock(() => { events.push("exit") })
  setExitHandler(exited)
  setLaunchStateCapture(() => { events.push("capture"); return place })
  const resumed = Promise.withResolvers<void>()
  setRendererHandoff({ suspend: async () => { events.push("suspend") }, resume: async () => { await resumed.promise; events.push("resume") }, destroy: async () => { throw new Error("a resumed handoff must not destroy the renderer") } })

  const left = await leaveTerminal()
  expect(left.state).toBe(place)
  expect(events).toEqual(["capture", "suspend"])

  // A signal during the handoff must not reset a terminal the successor owns.
  const exits: unknown[] = []
  const exitSpy = spyOn(process, "exit").mockImplementation((code) => {
    exits.push(code)
    throw new Error("exited")
  })
  try {
    expect(() => exitTUI()).toThrow("exited")
  } finally {
    exitSpy.mockRestore()
  }
  expect(exited).not.toHaveBeenCalled()
  expect(exits).toEqual([0])

  const resuming = left.resume()
  await flush()
  expect(events).toEqual(["capture", "suspend"])
  resumed.resolve()
  await resuming
  expect(events).toEqual(["capture", "suspend", "resume"])
  exitTUI()
  await flush()
  expect(exited).toHaveBeenCalledTimes(1)
})
