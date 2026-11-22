import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { RuntimeQuerySchema, runtimeQueryResultSchema } from "../../../src/protocol/runtime-protocol-schemas.js"

describe("chat settlement query", () => {
  test("roundtrips the query through the public codec", () => {
    const input = { type: "chatSettlement", sessionId: "chat" } as const
    const query = Schema.decodeUnknownSync(RuntimeQuerySchema)(input)
    expect(query).toEqual(input)
    expect(Schema.encodeSync(RuntimeQuerySchema)(query)).toEqual(input)
  })

  test.each([
    { state: "busy" },
    { state: "complete" },
    { state: "complete", turnEnding: { kind: "completed" } },
    { state: "complete", turnEnding: { kind: "refused" } },
    { state: "failed", turnEnding: { kind: "failed", failure: "context_overflow" } },
    { state: "input_required" },
    { state: "incomplete" },
  ])("roundtrips the answer %j", (result) => {
    const codec = runtimeQueryResultSchema("chatSettlement")
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toEqual(result)
  })

  test.each([
    { state: "complete", turnEnding: { kind: "failed", failure: "aborted" } },
    { state: "done" },
  ])("rejects the answer %j", (result) => {
    expect(() => Schema.decodeUnknownSync(runtimeQueryResultSchema("chatSettlement"))(result)).toThrow()
  })
})
