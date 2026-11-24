import { expect, expectTypeOf, test } from "bun:test"
import type { ModuleSessionFact } from "../../../../src/orchestration/module-seams.js"
import { parseSessionFact } from "../../../../src/orchestration/session/persistence/session-fact-registry.js"
import type { SessionFact } from "../../../../src/orchestration/session/persistence/session-fact-writer.js"

const fact = {
  type: "papercut.recorded",
  version: 1,
  actor: "agent",
  payload: { observation: "flaky test", conversationId: "conversation-1", modelRequestId: "request-1", toolUseId: "tool-1" },
} as const

test("an installed module's facts decode through the installed catalog with strict payload and envelope decoding", () => {
  expect(parseSessionFact(fact)).toEqual(fact)
  for (const malformed of [
    { ...fact, version: 2 },
    { ...fact, actor: "external" },
    { ...fact, payload: { ...fact.payload, observation: 2 } },
    { ...fact, payload: { ...fact.payload, unexpected: true } },
    { ...fact, unexpected: true },
  ]) expect(() => parseSessionFact(malformed)).toThrow()
})

test("the current writer union accepts module envelopes and rejects unknown facts at the parser", () => {
  expectTypeOf<string extends ModuleSessionFact["type"] ? true : false>().toEqualTypeOf<true>()
  expectTypeOf<string extends SessionFact["type"] ? true : false>().toEqualTypeOf<true>()
  expectTypeOf<Extract<SessionFact, { type: "not.registered" }>>().toEqualTypeOf<never>()
  expect(() => parseSessionFact({
    type: "not.registered", version: 1, actor: "flywheel", payload: {},
  })).toThrow("not registered")
})
