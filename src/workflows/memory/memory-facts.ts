import { Schema } from "effect"
import { defineFact } from "../../infra/event-registry.js"
import { LearningScopeSchema } from "../../infra/learning-scope.js"

// memory.written records one mutation of a bounded memory store through the
// memory tool. `target` is the learning reach (ARCH-LEARNING-005): project memory or
// global memory. The file is the durable artifact; the fact is the audit
// trail: who wrote (origin), what kind of mutation, and the content identity
// of the whole store after the write, so any store state can be traced to the
// session that produced it.
const MemoryWriteOriginSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("review"), reviewRunId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("agent"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("user") }),
])

/** Identity of one recorded mutation. `recorded` is the only case a writer may
 *  produce: the writer-prepared identity of this one append. The audit journal
 *  carries it with the fact before the bytes are published, so a replay after
 *  a crash recognizes the append the event store already accepted instead of
 *  recording the same write twice. `adopted_v1` is the explicit statement that
 *  a fact predates journalled write identities, so a reader never has to tell
 *  an unrecorded identity from a missing field. */
const MemoryWrittenIdentitySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("recorded"), mutationId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("adopted_v1") }),
])

const MemoryWrittenFactSchema = defineFact({
  type: "memory.written",
  version: 3,
  actor: Schema.Union([Schema.Literal("agent"), Schema.Literal("user")]),
  payload: Schema.Struct({
    target: LearningScopeSchema,
    action: Schema.Union([Schema.Literal("add"), Schema.Literal("replace"), Schema.Literal("remove"), Schema.Literal("batch")]),
    origin: MemoryWriteOriginSchema,
    identity: MemoryWrittenIdentitySchema,
    /** sha256 of the whole store content after the write. */
    contentHash: Schema.String,
  }),
})

export const MemoryFactSchemas = [MemoryWrittenFactSchema] as const

export type MemoryWrittenFact = typeof MemoryWrittenFactSchema.Type
