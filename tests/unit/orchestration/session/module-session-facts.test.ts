import { expect, expectTypeOf, test } from "bun:test"
import { Schema } from "effect"
import { defineFact } from "../../../../src/infra/event-registry.js"
import { composeModules } from "../../../../src/infra/module-descriptor.js"
import type { FirstPartyModule } from "../../../../src/orchestration/modules.js"
import type { ModuleSessionFact } from "../../../../src/orchestration/module-seams.js"
import { createSessionFactParser } from "../../../../src/orchestration/session/session-fact-registry.js"
import type { SessionFact } from "../../../../src/orchestration/session/session-fact-writer.js"

const ProbeFact = defineFact({ type: "probe.recorded", version: 1, actor: Schema.Literal("flywheel"), payload: Schema.Struct({ count: Schema.Int }) })
const fact = { type: "probe.recorded", version: 1, actor: "flywheel", payload: { count: 2 } } as const
function owner(id: string, sessionSchemas: Required<NonNullable<FirstPartyModule["facts"]>>["sessionSchemas"]): FirstPartyModule {
  return {
    id, dependencies: [], availability: { kind: "available" }, contributions: [], observers: [], transformers: [], gates: [],
    facts: { prefixes: ["probe."], sessionSchemas },
  }
}

test("an installed disabled owner's facts remain readable with strict payload and envelope decoding", () => {
  let loads = 0
  const catalog = [owner("probe", () => { loads++; return [ProbeFact] })]
  const parse = createSessionFactParser(() => catalog)
  expect(loads).toBe(0)
  expect(composeModules(catalog, { disabledModuleIds: ["probe"] }).enabledModuleIds).toEqual([])
  expect(parse(fact)).toEqual(fact)
  expect(parse(fact)).toEqual(fact)
  expect(loads).toBe(1)
  for (const malformed of [
    { ...fact, version: 2 },
    { ...fact, actor: "external" },
    { ...fact, payload: { count: "2" } },
    { ...fact, payload: { count: 2, unexpected: true } },
    { ...fact, unexpected: true },
  ]) expect(() => parse(malformed)).toThrow()
})

test("schema collisions refuse every read instead of publishing a partial parser", () => {
  const catalog = [owner("first", () => [ProbeFact]), owner("second", () => [ProbeFact])]
  const parse = createSessionFactParser(() => catalog)
  for (let attempt = 0; attempt < 2; attempt++) expect(() => parse(fact)).toThrow("probe.recorded@1 already defined")
})

test("a new installed catalog rebuilds the parser without retaining an absent owner's schema", () => {
  const initial = [owner("probe", () => [ProbeFact])]
  let catalog: readonly FirstPartyModule[] = initial
  const parse = createSessionFactParser(() => catalog)
  expect(parse(fact)).toEqual(fact)
  catalog = []
  expect(() => parse(fact)).toThrow("not registered")
  catalog = initial
  expect(parse(fact)).toEqual(fact)
})

test("the current writer union accepts module envelopes and rejects unknown facts at the parser", () => {
  expectTypeOf<string extends ModuleSessionFact["type"] ? true : false>().toEqualTypeOf<true>()
  expectTypeOf<string extends SessionFact["type"] ? true : false>().toEqualTypeOf<true>()
  expectTypeOf<Extract<SessionFact, { type: "not.registered" }>>().toEqualTypeOf<never>()
  expect(() => createSessionFactParser(() => [])({
    type: "not.registered", version: 1, actor: "flywheel", payload: {},
  })).toThrow("not registered")
})
