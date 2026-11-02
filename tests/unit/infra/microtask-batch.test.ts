import { describe, expect, test } from "bun:test"
import { createMicrotaskBatch } from "../../../src/infra/microtask-batch.js"

describe("microtask batch", () => {
  test("flush starts the open batch's load at once, and a later request opens a new batch", async () => {
    const loads: string[][] = []
    const load = createMicrotaskBatch(async (keys: readonly string[]) => {
      loads.push([...keys])
      return new Map(keys.map((key) => [key, key.toUpperCase()]))
    })

    const early = [load("a"), load("b"), load("a")]
    load.flush()
    expect(loads).toEqual([["a", "b"]])
    const late = load("c")
    load.flush()
    load.flush()

    expect(await Promise.all([...early, late])).toEqual(["A", "B", "A", "C"])
    expect(loads).toEqual([["a", "b"], ["c"]])
  })
})
