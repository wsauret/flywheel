import { Schema } from "effect"
import { TOOL_OUTCOME_VALUES } from "../../../infra/tool-outcome.js"
import { isJsonSchema } from "./descriptors.js"

// The messages between the executor (host) and one pooled invocation Worker
// (guest). A Worker runs one invocation at a time: `start` begins it,
// `result` ends it, and `reset` returns the Worker to the pool. Every value is
// structured-clone data: no function, port, or dispatch authority crosses.
// Both ends decode what they receive, because a malformed message is a defect
// in trusted code that must fail the invocation instead of reaching dispatch.

const Descriptor = Schema.Struct({
  name: Schema.String,
  path: Schema.Array(Schema.String),
  description: Schema.String,
  inputSchema: Schema.declare(isJsonSchema),
})

/** The bounds the guest enforces itself. Time is the host's alone. */
const GuestLimits = Schema.Struct({
  maxToolCalls: Schema.Number,
  maxLogBytes: Schema.Number,
  maxHeapDeltaBytes: Schema.Number,
  heapSampleMs: Schema.Number,
})

const CallReplySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ok"), outcome: Schema.Literals(TOOL_OUTCOME_VALUES), content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("refused"), message: Schema.String }),
])
export type CallReply = typeof CallReplySchema.Type

export const HostMessageSchema = Schema.Union([
  /** `bash` is whether the calling agent may run shell commands, which the
   *  heap-limit result names as the place for heavy computation. */
  Schema.Struct({ type: Schema.Literal("start"), source: Schema.String, descriptors: Schema.Array(Descriptor), limits: GuestLimits, bash: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("call-result"), id: Schema.Number, reply: CallReplySchema }),
  /** Drops the ended invocation's state, collects the Worker's heap, and
   *  takes the heap baseline the next invocation measures against. */
  Schema.Struct({ type: Schema.Literal("reset") }),
])
export type HostMessage = typeof HostMessageSchema.Type

/** How a program ended. Only `returned` leaves a Worker the host may reuse:
 *  the program ran to its own result or diagnostic. `heap-limit` means the
 *  heap watchdog stopped it, and `crashed` means the guest runtime failed. */
const Ending = Schema.Literals(["returned", "heap-limit", "crashed"])

export const GuestMessageSchema = Schema.Union([
  /** Console lines the guest newly retained, in order, and the current
   *  drop marker once the retention budget has dropped a line. */
  Schema.Struct({ type: Schema.Literal("log"), lines: Schema.Array(Schema.String), dropped: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("call"), id: Schema.Number, name: Schema.String, input: Schema.Unknown }),
  /** The final model text, already formatted and redacted. */
  Schema.Struct({ type: Schema.Literal("result"), outcome: Schema.Literals(["ok", "error"]), text: Schema.String, ending: Ending }),
  /** The reset finished. `heapBytes` is the collected heap that is now the
   *  baseline of the Worker's next invocation. */
  Schema.Struct({ type: Schema.Literal("ready"), heapBytes: Schema.Number }),
])
export type GuestMessage = typeof GuestMessageSchema.Type
