import { describe, expect, it, vi } from "vitest"
import { createHeadlessStore } from "../src/orchestration/headless/headless-store"

describe("HeadlessStore", () => {
  it("startWorkflow stores description and sets initial modelActivity", () => {
    const store = createHeadlessStore()
    store.startWorkflow("test workflow")
    const state = store.getState()
    expect(state.modelActivity).toBe("idle")
  })

  it("getState returns modelActivity and outputBlocks undefined", () => {
    const store = createHeadlessStore()
    store.startWorkflow("test")
    const state = store.getState()
    expect(state).toHaveProperty("modelActivity")
    expect(state.outputBlocks).toBeUndefined()
  })

  it("getState returns valid ModelActivity before startWorkflow is called", () => {
    const store = createHeadlessStore()
    const state = store.getState()
    // Must always return a valid ModelActivity, never undefined
    expect(state.modelActivity).toBe("idle")
  })

  it("subscribe fires callback on state change", () => {
    const store = createHeadlessStore()
    const cb = vi.fn()
    store.subscribe(cb)
    store.startWorkflow("test")
    expect(cb).toHaveBeenCalled()
  })

  it("subscribe returns an unsubscribe function", () => {
    const store = createHeadlessStore()
    const cb = vi.fn()
    const unsub = store.subscribe(cb)
    unsub()
    store.startWorkflow("test")
    expect(cb).not.toHaveBeenCalled()
  })

  it("subscribeExecution fires callback on execution state change", () => {
    const store = createHeadlessStore()
    const cb = vi.fn()
    store.subscribeExecution(cb)
    store.startWorkflow("test")
    expect(cb).toHaveBeenCalled()
  })

  it("subscribeExecution returns an unsubscribe function", () => {
    const store = createHeadlessStore()
    const cb = vi.fn()
    const unsub = store.subscribeExecution(cb)
    unsub()
    store.startWorkflow("test")
    expect(cb).not.toHaveBeenCalled()
  })
})
