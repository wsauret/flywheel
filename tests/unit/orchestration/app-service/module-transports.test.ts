import { expect, test } from "bun:test"
import { createModuleTransports } from "../../../../src/orchestration/app-service/module-transports.js"

const listener = () => { throw new Error("Only the serving host builds a socket layer") }

test("transport registration follows server readiness and unregister joins its owned serving", async () => {
  const port = createModuleTransports()
  const calls: string[] = []
  const stopped = Promise.withResolvers<void>()
  const remove = port.addListener("synthetic", listener)
  expect(calls).toEqual([])
  await port.serve((kind, found) => {
    expect(found).toBe(listener)
    calls.push(kind)
    return { ready: Promise.resolve(), async dispose() { await stopped.promise; calls.push("closed") } }
  })
  expect(calls).toEqual(["synthetic"])
  let settled = false
  const closing = remove().then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  stopped.resolve()
  await closing
  await remove()
  expect(calls).toEqual(["synthetic", "closed"])
  await port.dispose()
})

test("late listeners start once, duplicate identity is refused, and shutdown closes admission", async () => {
  const port = createModuleTransports()
  let started = 0
  let stopped = 0
  await port.serve(() => ({ ready: Promise.resolve().then(() => { started++ }), async dispose() { stopped++ } }))
  const remove = port.addListener("late", listener)
  expect(() => port.addListener("late", listener)).toThrow("already has a listener")
  await Promise.resolve()
  expect(started).toBe(1)
  await port.dispose()
  await remove()
  await port.dispose()
  expect(stopped).toBe(1)
  expect(() => port.addListener("after close", listener)).toThrow("admission is closed")
})


test("failed listener activation releases its identity for another acquisition", async () => {
  const port = createModuleTransports()
  let fail = true
  await port.serve(() => {
    if (fail) throw new Error("activation failed")
    return { ready: Promise.resolve(), async dispose() {} }
  })
  expect(() => port.addListener("retry", listener)).toThrow("activation failed")
  fail = false
  const remove = port.addListener("retry", listener)
  await remove()
  await port.dispose()
})
