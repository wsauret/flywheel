import { expect, test } from "bun:test"
import { readRetainedQuery } from "../../../../src/protocol/client/retained-query.js"

const unavailable = async (): Promise<number> => { throw new Error("Read failed") }

test("initial errors are readable results and a same-scope refresh preserves the last value", async () => {
  expect(await readRetainedQuery("session-a", unavailable)).toEqual({ key: "session-a", value: undefined, error: "Read failed" })
  const first = await readRetainedQuery("session-a", async () => 42)
  const failed = await readRetainedQuery("session-a", unavailable, first)
  expect(failed).toEqual({ key: "session-a", value: 42, error: "Read failed" })
  expect(await readRetainedQuery("session-a", async () => 43, failed)).toEqual({ key: "session-a", value: 43, error: undefined })
})

test("a failed read of another scope cannot reuse the previous scope's value", async () => {
  const first = await readRetainedQuery("session-a", async () => 42)
  expect(await readRetainedQuery("session-b", unavailable, first)).toEqual({ key: "session-b", value: undefined, error: "Read failed" })
})
