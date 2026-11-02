import { Schema } from "effect"
import { createFactParser, defineFact, type AnyFactSchema } from "./event-registry.js"
import { SESSION_RUNTIME_FACT_DEFINITIONS, TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS, type SessionRuntimeFact, type ToolContentReferenceFact } from "./runtime-fact-types.js"
export type { SessionRuntimeFact } from "./runtime-fact-types.js"


export const SessionRuntimeFactSchemas = SESSION_RUNTIME_FACT_DEFINITIONS.map((definition) =>
  defineFact({
    type: definition.type,
    version: definition.version,
    actor: Schema.Literal(definition.actor),
    payload: definition.payload,
  })
) satisfies readonly AnyFactSchema[]

/** Stored-shape registrations for the reference-capable tool fact versions.
 *  They join the session write gate (session-fact-registry) so a producer can
 *  record them, but stay out of `parseSessionRuntimeFact`: projections parse
 *  only hydrated inline facts, and an un-hydrated version-2 row reaching a
 *  projection parser must fail loudly instead of leaking a reference object
 *  where consumers expect text. */
export const ToolContentReferenceFactSchemas = TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS.map((definition) =>
  defineFact({
    type: definition.type,
    version: definition.version,
    actor: Schema.Literal(definition.actor),
    payload: definition.payload,
  })
) satisfies readonly AnyFactSchema[]

const parseRuntimeFact = createFactParser(SessionRuntimeFactSchemas)

export function parseSessionRuntimeFact(value: unknown): SessionRuntimeFact {
  return parseRuntimeFact<SessionRuntimeFact>(value)
}

/** Every session runtime fact version that writers store: the inline
 *  versions and the reference-capable tool versions. */
export const StoredSessionRuntimeFactSchemas = [...SessionRuntimeFactSchemas, ...ToolContentReferenceFactSchemas] satisfies readonly AnyFactSchema[]

type StoredSessionRuntimeFact = SessionRuntimeFact | ToolContentReferenceFact

/** Decodes a stored session runtime fact without hydration. Use it for a
 *  reader that needs only fields outside tool text, such as `toolUseId`. A
 *  version-2 tool fact stays in its stored shape, so a text field can hold a
 *  content reference. A reader that needs the text hydrates the fact and
 *  uses `parseSessionRuntimeFact`. */
export const parseStoredSessionRuntimeFact: <T extends StoredSessionRuntimeFact = StoredSessionRuntimeFact>(value: unknown) => T = createFactParser(StoredSessionRuntimeFactSchemas)
