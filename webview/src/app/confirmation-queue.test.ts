import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createConfirmationQueue } from "./confirmation-queue.js"

test("confirmations present in FIFO order and stale answers cannot clear the next request", async () => {
  const mounted = createRoot(dispose => ({ queue: createConfirmationQueue(), dispose }))
  try {
    const first = mounted.queue.confirm({ title: "Account one", confirmLabel: "Log in again" })
    const second = mounted.queue.confirm({ title: "Account two", confirmLabel: "Log in again" })
    const third = mounted.queue.confirm({ title: "Delete session", confirmLabel: "Delete" })
    expect(mounted.queue.current()?.request.title).toBe("Account one")
    const oldAnswer = mounted.queue.current()!.settle
    oldAnswer(true)
    expect(await first).toBe(true)
    expect(mounted.queue.current()?.request.title).toBe("Account two")
    oldAnswer(false)
    expect(mounted.queue.current()?.request.title).toBe("Account two")
    mounted.queue.current()!.settle(false)
    expect(await second).toBe(false)
    expect(mounted.queue.current()?.request.title).toBe("Delete session")
    mounted.queue.current()!.settle(true)
    expect(await third).toBe(true)
    expect(mounted.queue.current()).toBeUndefined()
  } finally { mounted.dispose() }
})

test("abort skips withdrawn requests and removes only its own active or queued confirmation", async () => {
  const mounted = createRoot(dispose => ({ queue: createConfirmationQueue(), dispose }))
  try {
    const preaborted = new AbortController()
    preaborted.abort()
    expect(await mounted.queue.confirm({ title: "Never show", confirmLabel: "Yes" }, preaborted.signal)).toBe(false)
    expect(mounted.queue.current()).toBeUndefined()
    const active = new AbortController()
    const queued = new AbortController()
    const first = mounted.queue.confirm({ title: "First", confirmLabel: "Yes" }, active.signal)
    const second = mounted.queue.confirm({ title: "Withdrawn", confirmLabel: "Yes" }, queued.signal)
    const third = mounted.queue.confirm({ title: "Third", confirmLabel: "Yes" })
    queued.abort()
    expect(await second).toBe(false)
    expect(mounted.queue.current()?.request.title).toBe("First")
    active.abort()
    expect(await first).toBe(false)
    expect(mounted.queue.current()?.request.title).toBe("Third")
    mounted.queue.current()!.settle(true)
    expect(await third).toBe(true)
  } finally { mounted.dispose() }
})

test("app disposal withdraws all confirmations and refuses late requests", async () => {
  const mounted = createRoot(dispose => ({ queue: createConfirmationQueue(), dispose }))
  const answers: boolean[] = []
  const first = mounted.queue.confirm({ title: "First", confirmLabel: "Yes" }).then(answer => { answers.push(answer) })
  const stale = mounted.queue.current()!.settle
  const second = mounted.queue.confirm({ title: "Second", confirmLabel: "Yes" }).then(answer => { answers.push(answer) })
  mounted.dispose()
  await Promise.resolve()
  expect(answers).toEqual([false, false])
  await Promise.all([first, second])
  stale(true)
  expect(mounted.queue.current()).toBeUndefined()
  expect(await mounted.queue.confirm({ title: "Late", confirmLabel: "Yes" })).toBe(false)
})
