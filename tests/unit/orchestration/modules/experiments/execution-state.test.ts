import { expect, test } from "bun:test"
import { ExperimentExecutionState } from "../../../../../src/orchestration/modules/experiments/execution-state.js"

test("owns idle, running, and pending transitions", () => {
  const state = new ExperimentExecutionState<{ metric: number }>()
  const observed: string[] = []
  const unsubscribe = state.subscribe((value) => observed.push(value.status))
  expect(state.start("measure")).toBe(true)
  expect(state.start("again")).toBe(false)
  expect(state.finish({ metric: 4 })).toBe(true)
  expect(state.finish({ metric: 5 })).toBe(false)
  expect(state.snapshot()).toEqual({ status: "pending", value: { metric: 4 } })
  state.clear()
  unsubscribe()
  expect(state.snapshot()).toEqual({ status: "idle" })
  expect(observed).toEqual(["running", "pending", "idle"])
})
