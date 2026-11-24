import { Schema } from "effect"
import { RUNTIME_EVENT_DEFINITIONS, type RuntimeEvent } from "../../src/infra/runtime-facts/runtime-event-types.js"

/** Decodes untyped event data with the schema of its runtime event definition,
 *  as a value read across a process boundary is decoded. Throws on data that
 *  the schema refuses. */
export function decodeRuntimeEvent<T extends RuntimeEvent["type"]>(type: T, data: unknown): Extract<RuntimeEvent, { type: T }> {
  const definition = RUNTIME_EVENT_DEFINITIONS.find((candidate) => candidate.type === type)
  if (definition === undefined) throw new Error(`No runtime event definition registered for ${type}`)
  const decoded: unknown = Schema.decodeUnknownSync(definition.data)(data)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the definition list erases the correlation of a type and its decoded data
  return { type, data: decoded } as Extract<RuntimeEvent, { type: T }>
}
