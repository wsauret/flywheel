import { Schema } from "effect"
import { exactStruct } from "../infra/exact-struct.js"
import type { CommandCatalogPatchPayload, CommandOutcome, RuntimeCommandCatalogResult, RuntimeCommandInvocation } from "./command-catalog-protocol-types.js"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const RuntimePositionSchema = Schema.Number

const CommandSurfaceTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("place"), place: Schema.Literal("authentication") }),
  Schema.Struct({ kind: Schema.Literal("transcript-in-view") }),
])
const CommandMenuPositionSchema = Schema.Struct({ group: Schema.Literals(["top", "chat", "more"]), rank: Schema.Number })
// Not strict: a client of an earlier release ignores `opens`, `target`,
// `menu`, and `reading` and asks the runtime, which answers the same surface.
const BuiltInCommandDescriptorSchema = Schema.Struct({
  id: Schema.String, title: Schema.String, description: Schema.String, aliases: Schema.Array(Schema.String),
  opens: Schema.optionalKey(Schema.String), target: Schema.optionalKey(CommandSurfaceTargetSchema), menu: Schema.optionalKey(CommandMenuPositionSchema),
  reading: Schema.optionalKey(Schema.Literal("context-window")),
})
const OffCommandDescriptorSchema = Schema.Struct({ id: Schema.String, aliases: Schema.Array(Schema.String), modules: Schema.Array(Schema.String) })
const RuntimeCommandCatalogSchema = Schema.Struct({
  revision: NonNegativeInt,
  builtInCommands: Schema.Array(BuiltInCommandDescriptorSchema),
  offCommands: Schema.Array(OffCommandDescriptorSchema),
})
export const RuntimeCommandCatalogResultSchema: Schema.Codec<RuntimeCommandCatalogResult> = RuntimeCommandCatalogSchema.pipe(Schema.fieldsAssign({ snapshotPosition: RuntimePositionSchema }))
export const CommandCatalogPatchPayloadSchema: Schema.Codec<CommandCatalogPatchPayload> = Schema.Struct({ kind: Schema.Literal("commands.updated"), catalog: RuntimeCommandCatalogSchema })

export const RuntimeCommandInvocationSchema: Schema.Codec<RuntimeCommandInvocation> = exactStruct(Schema.Struct({
  type: Schema.Literal("command.invoke"),
  id: Schema.NonEmptyString,
  revision: NonNegativeInt,
  sessionId: Schema.optionalKey(Schema.NonEmptyString),
  argument: Schema.optionalKey(Schema.String),
}))
export const CommandOutcomeSchema: Schema.Codec<CommandOutcome> = Schema.Union([
  exactStruct(Schema.Struct({ kind: Schema.Literal("none") })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("message"), message: Schema.String })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("warning"), message: Schema.String })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("open"), surface: Schema.NonEmptyString, sessionId: Schema.optionalKey(Schema.NonEmptyString) })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("focus-session"), sessionId: Schema.NonEmptyString })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("stale") })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("unavailable"), message: Schema.String })),
])
