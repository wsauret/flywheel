import { Effect, Schema, SchemaTransformation } from "effect"
import { ProviderRequestOptionsSchema } from "./llm/provider-options.js"
import { canonicalModelId } from "./llm/model-id.js"

export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max", "ultra"] as const

export const EffortSchema = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
  Schema.Literal("xhigh"),
  Schema.Literal("max"),
  Schema.Literal("ultra"),
])

export type Effort = typeof EffortSchema.Type

/** Fixed model choices of one workflow launch, keyed by agent record id.
 *  Each entry sets a model, an effort, or both; an omitted field keeps the
 *  agent's default. The protocol launch, the retained launch operation, and the
 *  recorded launch invocation all carry this one shape. */
export const WorkflowLaunchAgentModelsSchema = Schema.Record(Schema.NonEmptyString,
  Schema.Union([
    Schema.Struct({ model: Schema.NonEmptyString, effort: Schema.optionalKey(EffortSchema) }),
    Schema.Struct({ model: Schema.optionalKey(Schema.NonEmptyString), effort: EffortSchema }),
  ]),
)

export type WorkflowLaunchAgentModels = typeof WorkflowLaunchAgentModelsSchema.Type

// User-authored workflow and agent config (external boundary): an absent tier config means
// "no overrides".
const CanonicalModelIdSchema = Schema.String.pipe(Schema.decodeTo(
  Schema.String,
  SchemaTransformation.transform({
    decode: canonicalModelId,
    encode: canonicalModelId,
  }),
))

export const TierConfigSchema = Schema.Struct({
  model: Schema.optionalKey(CanonicalModelIdSchema.pipe(Schema.annotate({ description: "Select the model id for this role." }))),
  effort: Schema.optionalKey(EffortSchema.pipe(Schema.annotate({ description: "Select the reasoning effort for this role." }))),
  provider_options: Schema.optionalKey(ProviderRequestOptionsSchema.pipe(Schema.annotate({ description: "Set provider-specific request options for this role." }))),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed({})))

const TOOL_ACTIONS = [
  "handoff_write",
  "file_read",
  "search",
  "web_search",
  "list",
  "shell_exec",
  "file_write",
  "file_edit",
  "ask_user",
  "task_subagent",
  "ui_meta",
  "benchmark_run",
] as const

export type ToolAction = (typeof TOOL_ACTIONS)[number]
export const ToolActionSchema = Schema.Literals(TOOL_ACTIONS)


// The retired `toolScoping` key of an agent record (ARCH-CONTEXT-018): every agent now
// gets the same tools, and the loader drops the key from a workflow file.
// These schemas decode the facts that builds before 2026-10-13 recorded.
// No key grants `ask_user`: only a root chat asks the person (PI-AGENT-024).
const ToolScopingFields = {
  read: Schema.Boolean,
  bash: Schema.Boolean,
  search: Schema.Boolean,
  list: Schema.Boolean,
  write: Schema.Boolean,
  edit: Schema.Boolean,
  subagent: Schema.Boolean,
}


const defaultFalse = Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false)))

// An authored scope stated only what it granted, so each flag defaults to false.
const AuthoredToolScopingFields = {
  read: defaultFalse,
  bash: defaultFalse,
  search: defaultFalse,
  list: defaultFalse,
  write: defaultFalse,
  edit: defaultFalse,
  subagent: defaultFalse,
} satisfies { readonly [K in keyof typeof ToolScopingFields]: typeof defaultFalse }

export const ToolScopingSchema = Schema.Struct(AuthoredToolScopingFields)

export const CanonicalToolScopingSchema = Schema.Struct(ToolScopingFields)

export type ToolScoping = typeof CanonicalToolScopingSchema.Type
